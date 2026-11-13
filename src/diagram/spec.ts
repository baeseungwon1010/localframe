import { z } from 'zod';

/**
 * A diagram described by what it says, not where things go: boxes, what leads to what, which
 * boxes belong together and what each one is for. The layout, sizes and colours are worked out
 * from it (build.ts), so whoever writes one (a person or an AI) never places anything by hand.
 * See docs/diagram-spec.md.
 */

export const SHAPES = ['box', 'pill', 'ellipse', 'diamond', 'cylinder', 'document', 'chevron', 'parallelogram', 'bubble', 'note'] as const;
export const ROLES = ['default', 'primary', 'ok', 'warning', 'danger', 'muted', 'external'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

const NodeSpec = z.union([
  text(200),
  z
    .object({
      id: text(80),
      /** The words in the box; the id if left out. */
      text: z.string().trim().max(200).optional(),
      /** A smaller second line or two under the text. */
      note: z.string().trim().max(300).optional(),
      shape: z.enum(SHAPES).optional(),
      role: z.enum(ROLES).optional(),
      group: text(80).optional(),
    })
    .strict(),
]);

const EdgeSpec = z.union([
  text(300),
  z
    .object({
      from: text(80),
      to: text(80),
      label: z.string().trim().max(80).optional(),
      style: z.enum(['solid', 'dashed']).optional(),
      arrow: z.enum(['end', 'both', 'none']).optional(),
    })
    .strict(),
]);

const GroupSpec = z
  .object({
    id: text(80),
    title: z.string().trim().max(80).optional(),
    nodes: z.array(text(80)).max(200).optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict();

export const DiagramSpecSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    subtitle: z.string().trim().max(240).optional(),
    /** Which way the flow runs. */
    direction: z.enum(['right', 'down']).optional(),
    nodes: z.array(NodeSpec).min(1).max(200),
    edges: z.array(EdgeSpec).max(400).optional(),
    groups: z.array(GroupSpec).max(30).optional(),
  })
  .strict();

export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;
export type Shape = (typeof SHAPES)[number];
export type Role = (typeof ROLES)[number];

export type SpecNode = { id: string; text: string; note?: string; shape: Shape; role: Role; group?: string };
export type SpecEdge = { from: string; to: string; label?: string; dashed: boolean; arrow: 'end' | 'both' | 'none' };
export type SpecGroup = { id: string; title?: string; role: Role };
export type Diagram = {
  title?: string;
  subtitle?: string;
  direction: 'right' | 'down';
  nodes: SpecNode[];
  edges: SpecEdge[];
  groups: SpecGroup[];
};

/** "a -> b: label", with -> (arrow), --> (dashed arrow), <-> (both ways) or -- (no arrow). */
const EDGE = /^(.+?)\s*(<->|-->|->|--)\s*(.+?)(?:\s*:\s*(.*))?$/;

/** Checks a spec and spells out its shorthands. Throws an Error naming every problem found. */
export function readSpec(input: unknown): Diagram {
  const parsed = DiagramSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('\n'));
  }
  const spec = parsed.data;
  const problems: string[] = [];
  const nodes: SpecNode[] = [];
  const byId = new Map<string, SpecNode>();
  for (const raw of spec.nodes) {
    // "id: Text" names a node and gives its words
    const n =
      typeof raw === 'string'
        ? (() => {
            const at = raw.indexOf(':');
            return at > 0 ? { id: raw.slice(0, at).trim(), text: raw.slice(at + 1).trim() } : { id: raw };
          })()
        : raw;
    if (byId.has(n.id)) problems.push(`nodes: "${n.id}" is listed twice`);
    const node: SpecNode = {
      id: n.id,
      text: ('text' in n && n.text) || n.id,
      ...('note' in n && n.note ? { note: n.note } : {}),
      shape: ('shape' in n && n.shape) || 'box',
      role: ('role' in n && n.role) || 'default',
      ...('group' in n && n.group ? { group: n.group } : {}),
    };
    byId.set(node.id, node);
    nodes.push(node);
  }

  const groups: SpecGroup[] = [];
  for (const g of spec.groups ?? []) {
    if (groups.some((o) => o.id === g.id)) problems.push(`groups: "${g.id}" is listed twice`);
    groups.push({ id: g.id, ...(g.title ? { title: g.title } : {}), role: g.role ?? 'muted' });
    for (const id of g.nodes ?? []) {
      const n = byId.get(id);
      if (!n) problems.push(`groups.${g.id}: no node "${id}"`);
      else if (n.group && n.group !== g.id) problems.push(`node "${id}" is in two groups ("${n.group}" and "${g.id}")`);
      else n.group = g.id;
    }
  }
  for (const n of nodes) {
    if (n.group && !groups.some((g) => g.id === n.group)) groups.push({ id: n.group, title: n.group, role: 'muted' });
  }

  const edges: SpecEdge[] = [];
  for (const raw of spec.edges ?? []) {
    let e: SpecEdge;
    if (typeof raw === 'string') {
      const m = EDGE.exec(raw);
      if (!m) {
        problems.push(`edges: can't read "${raw}" (write "a -> b" or "a -> b: label")`);
        continue;
      }
      const [, from, op, to, label] = m;
      e = { from, to, ...(label ? { label } : {}), dashed: op === '-->', arrow: op === '<->' ? 'both' : op === '--' ? 'none' : 'end' };
    } else {
      e = { from: raw.from, to: raw.to, ...(raw.label ? { label: raw.label } : {}), dashed: raw.style === 'dashed', arrow: raw.arrow ?? 'end' };
    }
    for (const end of [e.from, e.to]) if (!byId.has(end)) problems.push(`edges: no node "${end}"`);
    if (e.from === e.to) problems.push(`edges: "${e.from}" leads to itself`);
    edges.push(e);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    direction: spec.direction ?? 'right',
    nodes,
    edges,
    groups,
  };
}
