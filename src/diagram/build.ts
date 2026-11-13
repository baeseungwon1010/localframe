import { generateNKeysBetween } from 'fractional-indexing';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportedFile, type SceneNode, type TextRun, type TextStyle } from '../../shared/schema.ts';
import { settleLine } from '../engine/connectors.ts';
import { CONNECTOR_COLOR, DIAGRAM_COLORS, DIAGRAM_TEXT } from '../engine/diagramColors.ts';
import { SceneDoc } from '../engine/doc.ts';
import { lineFromEnds, linePoints } from '../engine/geometry.ts';
import { heightForLabel } from '../engine/labels.ts';
import { createNode, solid } from '../engine/nodes.ts';
import { layoutText } from '../engine/text.ts';
import { shapeVector } from '../engine/vector.ts';
import { type Diagram, type Role, type SpecNode, readSpec } from './spec.ts';

/**
 * Turns a diagram spec into a localframe file: boxes sized to their words, laid out in layers
 * along the flow (a simple Sugiyama layout), connectors that route around boxes with their labels
 * on them, and one set of type sizes and colours for every diagram. The look is decided here,
 * once, so a diagram reads well however it was described.
 */

/** The type scale: four sizes, so the order of importance is plain. */
export const TYPE = {
  title: { size: 40, weight: 700 },
  subtitle: { size: 18, weight: 400 },
  group: { size: 18, weight: 700 },
  node: { size: 20, weight: 600 },
  note: { size: 15, weight: 400 },
  edge: { size: 15, weight: 500 },
} as const;

const MUTED_TEXT = '#55595F';
const FONT = 'Inter';
const BACKGROUND = '#F7F7F5';
const PAD = 24; // inside a box, around its words
const NODE_MIN = { width: 150, height: 64 };
const NODE_MAX_WIDTH = 300;
const ROW_GAP = 40; // between boxes in one layer
const LAYER_GAP = 64; // between layers, before room for edge labels
const GROUP_PAD = 28;
const GROUP_TITLE = 34; // room above a group's boxes for its title
const MARGIN = 48;

const color = (id: string) => DIAGRAM_COLORS.find((c) => c.id === id)!;
/** Colours mean something: plain boxes are white, and a role colours a box only when it says something. */
const ROLE_COLORS: Record<Role, { fill: string; stroke: string }> = {
  default: { fill: '#FFFFFF', stroke: '#9D9D98' },
  primary: color('blue'),
  ok: color('green'),
  warning: color('yellow'),
  danger: color('red'),
  muted: color('grey'),
  external: color('violet'),
};

/** How much of a shape's width its words may use (the middle of a diamond is narrow). */
const WIDTH_USE: Partial<Record<SpecNode['shape'], number>> = { diamond: 0.55, ellipse: 0.72, chevron: 0.7, parallelogram: 0.7 };

export type Built = {
  file: ExportedFile;
  doc: SceneDoc;
  /** The layer made for each node, edge and group of the spec. */
  ids: { nodes: Map<string, string>; edges: string[]; groups: Map<string, string> };
  diagram: Diagram;
};

const textStyle = (characters: string, size: number, weight: number, extra: Partial<TextStyle> = {}): TextStyle => ({
  characters,
  fontFamily: FONT,
  fontWeight: weight,
  fontSize: size,
  lineHeight: null,
  letterSpacing: 0,
  align: 'center',
  autoResize: 'height',
  ...extra,
});

/** A box's words: its text, and its note smaller and quieter on the lines below. */
function nodeLabel(n: SpecNode): TextStyle {
  if (!n.note) return textStyle(n.text, TYPE.node.size, TYPE.node.weight);
  const characters = `${n.text}\n${n.note}`;
  const runs: TextRun[] = [{ start: n.text.length + 1, end: characters.length, fontSize: TYPE.note.size, fontWeight: TYPE.note.weight, color: MUTED_TEXT }];
  return textStyle(characters, TYPE.node.size, TYPE.node.weight, { runs });
}

// ------------------------------------------------------------------ layout

type Placed = { id: string; layer: number; x: number; y: number; width: number; height: number };

/** Layers along the flow: every edge goes from an earlier layer to a later one, loops aside. */
function layers(d: Diagram): { layer: Map<string, number>; back: Set<number> } {
  const out = new Map(d.nodes.map((n) => [n.id, [] as { to: string; i: number }[]]));
  d.edges.forEach((e, i) => out.get(e.from)!.push({ to: e.to, i }));
  // edges that close a loop are turned round for layering (depth-first, in the order given)
  const back = new Set<number>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const { to, i } of out.get(id)!) {
      if (state.get(to) === 1) back.add(i);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of d.nodes) if (!state.has(n.id)) visit(n.id);
  // longest path from the starts
  const layer = new Map(d.nodes.map((n) => [n.id, 0]));
  const forward = d.edges.map((e, i) => (back.has(i) ? { from: e.to, to: e.from } : e));
  for (let pass = 0; pass < d.nodes.length; pass++) {
    let changed = false;
    for (const e of forward) {
      const next = layer.get(e.from)! + 1;
      if (next > layer.get(e.to)!) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { layer, back };
}

/** The order of boxes in each layer: fewer crossings (barycentres), and a group's boxes kept together. */
function orderLayers(d: Diagram, layer: Map<string, number>): string[][] {
  const count = Math.max(...layer.values()) + 1;
  const rows: string[][] = Array.from({ length: count }, () => []);
  for (const n of d.nodes) rows[layer.get(n.id)!].push(n.id);
  const groupOf = new Map(d.nodes.map((n) => [n.id, n.group]));
  const input = new Map(d.nodes.map((n, i) => [n.id, i]));
  const neighbours = (id: string, dir: -1 | 1) =>
    d.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])).filter((o) => layer.get(o) === layer.get(id)! + dir);
  const place = (row: string[], pos: Map<string, number>, dir: -1 | 1) => {
    const bary = (id: string) => {
      const ns = neighbours(id, dir).filter((o) => pos.has(o));
      return ns.length ? ns.reduce((s, o) => s + pos.get(o)!, 0) / ns.length : null;
    };
    const key = new Map(row.map((id, i) => [id, bary(id) ?? i]));
    row.sort((a, b) => key.get(a)! - key.get(b)! || input.get(a)! - input.get(b)!);
    // a group's boxes side by side, where its first box falls
    const seen: string[] = [];
    for (const id of row) {
      const g = groupOf.get(id);
      if (g && seen.some((s) => groupOf.get(s) === g)) {
        const last = seen.map((s) => groupOf.get(s)).lastIndexOf(g);
        seen.splice(last + 1, 0, id);
      } else seen.push(id);
    }
    row.splice(0, row.length, ...seen);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? rows.map((_, i) => i).slice(1) : rows.map((_, i) => i).slice(0, -1).reverse();
    for (const r of range) {
      const pos = new Map(rows[r + (down ? -1 : 1)].map((id, i) => [id, i]));
      place(rows[r], pos, down ? -1 : 1);
    }
  }
  return rows;
}

// ------------------------------------------------------------------ build

/** Builds the file for a spec (checked with readSpec first). Throws on a spec that doesn't hold together. */
export function buildDiagram(input: unknown): Built {
  const d = readSpec(input);
  const doc = new SceneDoc();
  const across = d.direction === 'right';

  // boxes, sized to their words
  const nodeIds = new Map<string, string>();
  const made = new Map<string, SceneNode>();
  for (const n of d.nodes) {
    const label = nodeLabel(n);
    const use = WIDTH_USE[n.shape] ?? 1;
    const natural = Math.max(...label.characters.split('\n').map((line, i) => layoutText({ ...label, characters: line, ...(i > 0 && n.note ? { fontSize: TYPE.note.size, fontWeight: TYPE.note.weight } : {}), runs: undefined }, null).width));
    const width = Math.round(Math.min(NODE_MAX_WIDTH / use, Math.max(NODE_MIN.width, natural / use + PAD * 2)));
    const node = makeNode(doc, n, label, width);
    nodeIds.set(n.id, node.id);
    made.set(n.id, node);
  }

  const { layer, back } = layers(d);
  const rows = orderLayers(d, layer);
  const groupOf = new Map(d.nodes.map((n) => [n.id, n.group]));

  // boxes in one layer share their size along the flow, so the layers line up
  for (const row of rows) {
    const along = Math.max(...row.map((id) => (across ? made.get(id)!.width : made.get(id)!.height)));
    for (const id of row) {
      const n = made.get(id)!;
      if (across && n.type !== 'ELLIPSE') made.set(id, resized(n, along, n.height));
    }
  }

  // room between layers for the words on the edges that cross the gap
  const edgeLabelWidth = (e: Diagram['edges'][number]) =>
    e.label ? layoutText(textStyle(e.label, TYPE.edge.size, TYPE.edge.weight, { autoResize: 'width' }), null).width : 0;
  const gaps = rows.map((_, r) => {
    const crossing = d.edges.filter((e) => Math.min(layer.get(e.from)!, layer.get(e.to)!) === r && Math.abs(layer.get(e.from)! - layer.get(e.to)!) === 1);
    // words on a fan of edges sit on the last half of the gap (after the shared trunk), so they need twice the room
    const fanned = (e: Diagram['edges'][number]) => d.edges.filter((o) => o.from === e.from).length > 1 || d.edges.filter((o) => o.to === e.to).length > 1;
    const words = Math.max(0, ...crossing.map((e) => (across ? edgeLabelWidth(e) : TYPE.edge.size * 1.3) * (fanned(e) ? 2 : 1) + (fanned(e) ? 40 : 0)));
    // leaving or entering a group: room for the frames on both sides
    const groupsIn = (row: string[] | undefined) => [...new Set((row ?? []).map((id) => groupOf.get(id) ?? ''))].sort().join('|');
    const frames = groupsIn(rows[r]) !== groupsIn(rows[r + 1]) || groupsIn(rows[r]) !== '' ? GROUP_PAD * 2 + (across ? 0 : GROUP_TITLE) : 0;
    const sameGroup = groupsIn(rows[r]) === groupsIn(rows[r + 1]) && groupsIn(rows[r]) !== '' && !groupsIn(rows[r]).includes('|');
    return Math.max(LAYER_GAP, words + 48) + (sameGroup ? 0 : frames);
  });

  // place: layers along the flow, boxes across it, each layer centred
  const placed = new Map<string, Placed>();
  let along = 0;
  rows.forEach((row, r) => {
    const size = (id: string) => (across ? made.get(id)!.height : made.get(id)!.width);
    const thick = Math.max(...row.map((id) => (across ? made.get(id)!.width : made.get(id)!.height)));
    const spans: number[] = [];
    let acrossAt = 0;
    row.forEach((id, i) => {
      const g = groupOf.get(id);
      const prev = i > 0 ? groupOf.get(row[i - 1]) : undefined;
      // a new group needs room for its frame and title
      // (a group's title sits above its boxes, so it takes room across the flow only when that is down the page)
      const title = across && g ? GROUP_TITLE : 0;
      if (i > 0) acrossAt += ROW_GAP + (g !== prev ? GROUP_PAD * 2 + title : 0);
      else acrossAt += title;
      spans.push(acrossAt);
      acrossAt += size(id);
    });
    const shift = -acrossAt / 2;
    row.forEach((id, i) => {
      const n = made.get(id)!;
      const a = spans[i] + shift;
      const offset = (thick - (across ? n.width : n.height)) / 2;
      const [x, y] = across ? [along + offset, a] : [a, along + offset];
      placed.set(id, { id, layer: r, x, y, width: n.width, height: n.height });
    });
    along += thick + gaps[r];
  });

  // move everything so the top left of the content is at the margin, below the title
  const head = (d.title ? TYPE.title.size * 1.3 : 0) + (d.subtitle ? TYPE.subtitle.size * 1.5 + 8 : 0) + (d.title || d.subtitle ? 40 : 0);
  const boxes = [...placed.values()];
  const groupFrames = groupRects(d, placed);
  const all = [...boxes, ...groupFrames.map((g) => g.rect)];
  const minX = Math.min(...all.map((b) => b.x));
  const minY = Math.min(...all.map((b) => b.y));
  const dx = MARGIN - minX;
  const dy = MARGIN + head - minY;
  for (const p of boxes) {
    const n = made.get(p.id)!;
    doc.set({ ...n, x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
  }

  // groups: a soft frame behind their boxes, with a title above
  const groupIds = new Map<string, string>();
  const behind: SceneNode[] = [];
  for (const g of groupFrames) {
    const c = ROLE_COLORS[d.groups.find((o) => o.id === g.id)!.role];
    const rect = createNode(doc, 'RECTANGLE', null, { x: Math.round(g.rect.x + dx), y: Math.round(g.rect.y + dy), width: Math.round(g.rect.width), height: Math.round(g.rect.height) });
    const frame: SceneNode = {
      ...rect,
      name: g.title ?? g.id,
      fills: [solid(c.fill, 0.55)],
      strokes: [solid(c.stroke)],
      strokeWeight: 1.5,
      strokeDash: [6, 4],
      radii: [16, 16, 16, 16],
    };
    behind.push(frame);
    groupIds.set(g.id, frame.id);
    if (g.title) {
      const t = textNode(doc, g.title, TYPE.group.size, TYPE.group.weight, DIAGRAM_TEXT);
      behind.push({ ...t, x: frame.x + 16, y: frame.y + 10 });
    }
  }
  for (const n of behind) doc.set(n);

  // connectors, bound to their boxes and routed around the rest
  const edgeIds: string[] = [];
  d.edges.forEach((e, i) => {
    const a = doc.get(nodeIds.get(e.from)!)!;
    const b = doc.get(nodeIds.get(e.to)!)!;
    const la = layer.get(e.from)!;
    const lb = layer.get(e.to)!;
    // forward edges leave the far side and arrive at the near one; loops go round underneath
    const [sa, sb] =
      la === lb ? (['auto', 'auto'] as const) : back.has(i) || la > lb ? (across ? (['bottom', 'bottom'] as const) : (['right', 'right'] as const)) : across ? (['right', 'left'] as const) : (['bottom', 'top'] as const);
    const base = createNode(doc, 'LINE', null, { x: a.x, y: a.y, width: 1, height: 0 });
    let line: SceneNode = lineFromEnds(base, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    line = {
      ...line,
      name: `${d.nodes.find((n) => n.id === e.from)!.text} → ${d.nodes.find((n) => n.id === e.to)!.text}`,
      strokes: [solid(CONNECTOR_COLOR)],
      strokeWeight: 2,
      strokeDash: e.dashed ? [6, 4] : [],
      arrowStart: e.arrow === 'both',
      arrowEnd: e.arrow !== 'none',
      elbow: true,
      startBind: { nodeId: a.id, anchor: sa },
      endBind: { nodeId: b.id, anchor: sb },
      ...(e.label ? { label: textStyle(e.label, TYPE.edge.size, TYPE.edge.weight, { autoResize: 'width' }), labelColor: '#3C4043' } : {}),
    };
    doc.set(line);
    doc.set(settleLine(doc, line));
    edgeIds.push(line.id);
  });
  // where several edges leave (or reach) one box they share a trunk, so their words go on their
  // own last (or first) stretch instead of the middle
  const fan = (key: 'from' | 'to') => new Map(d.edges.map((e) => [e[key], d.edges.filter((o) => o[key] === e[key]).length]));
  const fanOut = fan('from');
  const fanIn = fan('to');
  d.edges.forEach((e, i) => {
    const line = doc.get(edgeIds[i])!;
    if (!e.label || (fanOut.get(e.from)! < 2 && fanIn.get(e.to)! < 2)) return;
    const pts = linePoints(line);
    const lens = pts.slice(1).map((p, k) => Math.hypot(p.x - pts[k].x, p.y - pts[k].y));
    const total = lens.reduce((s, l) => s + l, 0);
    if (total <= 0 || lens.length < 2) return;
    const at = fanOut.get(e.from)! >= 2 ? (total - lens[lens.length - 1] / 2) / total : lens[0] / 2 / total;
    doc.set({ ...line, labelAt: Math.round(at * 1000) / 1000 });
  });

  // title and subtitle, top left
  const heading: SceneNode[] = [];
  if (d.title) heading.push({ ...textNode(doc, d.title, TYPE.title.size, TYPE.title.weight, DIAGRAM_TEXT), x: MARGIN, y: MARGIN });
  if (d.subtitle) {
    const y = MARGIN + (d.title ? TYPE.title.size * 1.3 + 8 : 0);
    heading.push({ ...textNode(doc, d.subtitle, TYPE.subtitle.size, TYPE.subtitle.weight, MUTED_TEXT), x: MARGIN, y: Math.round(y) });
  }
  for (const n of heading) doc.set(n);

  // stacking: group frames at the back, then connectors, boxes and the heading
  const stack = [...behind.map((n) => n.id), ...edgeIds, ...d.nodes.map((n) => nodeIds.get(n.id)!), ...heading.map((n) => n.id)];
  const keys = generateNKeysBetween(null, null, stack.length);
  stack.forEach((id, i) => doc.set({ ...doc.get(id)!, order: keys[i] }));

  const nodes = stack.map((id) => doc.get(id)!);
  const file: ExportedFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    name: d.title ?? 'Diagram',
    background: BACKGROUND,
    pages: [{ id: 'page-1', name: 'Page 1', background: BACKGROUND }],
    nodes,
  };
  return { file, doc, ids: { nodes: nodeIds, edges: edgeIds, groups: groupIds }, diagram: d };
}

function resized(n: SceneNode, width: number, height: number): SceneNode {
  const next = { ...n, width, height };
  return next.shape ? { ...next, vector: shapeVector(next.shape, width, height) } : next;
}

/** One box of the spec as a layer, its height grown to fit its words. */
function makeNode(doc: SceneDoc, n: SpecNode, label: TextStyle, width: number): SceneNode {
  const c = ROLE_COLORS[n.role];
  const minH = n.shape === 'diamond' ? 110 : n.shape === 'cylinder' ? 96 : n.shape === 'bubble' ? 84 : NODE_MIN.height;
  const kind = n.shape === 'ellipse' ? 'ELLIPSE' : n.shape === 'box' || n.shape === 'pill' || n.shape === 'note' ? 'RECTANGLE' : 'VECTOR';
  let node: SceneNode = {
    ...createNode(doc, kind, null, { x: 0, y: 0, width, height: minH }),
    name: n.text,
    fills: [solid(c.fill)],
    strokes: [solid(c.stroke)],
    strokeWeight: n.role === 'default' ? 1.5 : 2,
    strokeAlign: 'inside',
    strokeDash: n.role === 'muted' ? [6, 4] : [],
    label,
    labelColor: DIAGRAM_TEXT,
  };
  if (kind === 'VECTOR') node = { ...node, shape: { kind: n.shape as 'diamond', count: 4, ratio: 0.5 } };
  if (n.shape === 'box') node = { ...node, radii: [12, 12, 12, 12] };
  if (n.shape === 'note') {
    node = { ...node, sticky: true, fills: [solid(color('yellow').sticky)], strokes: [], radii: [6, 6, 6, 6], label: { ...label, align: 'left' } };
  }
  const height = Math.max(minH, heightForLabel(node) + 16);
  node = resized(node, width, height);
  // a pill is round at both ends whatever its height
  if (n.shape === 'pill') node = { ...node, radii: [height / 2, height / 2, height / 2, height / 2] };
  doc.set(node);
  return node;
}

function textNode(doc: SceneDoc, characters: string, size: number, weight: number, fill: string): SceneNode {
  const style = textStyle(characters, size, weight, { align: 'left', autoResize: 'width' });
  const l = layoutText(style, null);
  return { ...createNode(doc, 'TEXT', null, { x: 0, y: 0, width: Math.ceil(l.width) + 2, height: Math.ceil(l.height) }), name: characters, fills: [solid(fill)], text: style };
}

/** Each group's frame around its boxes (before the final move), with room above for its title. */
function groupRects(d: Diagram, placed: Map<string, Placed>) {
  return d.groups.flatMap((g) => {
    const members = d.nodes.filter((n) => n.group === g.id).map((n) => placed.get(n.id)!);
    if (!members.length) return [];
    const x = Math.min(...members.map((m) => m.x)) - GROUP_PAD;
    const y = Math.min(...members.map((m) => m.y)) - GROUP_PAD - (g.title ? GROUP_TITLE : 0);
    const right = Math.max(...members.map((m) => m.x + m.width)) + GROUP_PAD;
    const bottom = Math.max(...members.map((m) => m.y + m.height)) + GROUP_PAD;
    return [{ id: g.id, title: g.title, rect: { x, y, width: right - x, height: bottom - y } }];
  });
}
