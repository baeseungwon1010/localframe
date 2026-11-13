import type { SceneNode } from '../../shared/schema.ts';
import { linePoints } from '../engine/geometry.ts';
import { labelNode } from '../engine/labels.ts';
import { type Point, type Rect, apply } from '../engine/math.ts';
import type { Built } from './build.ts';

/**
 * What a reader would trip over, measured on the built diagram: words too small to read at the
 * size it will be seen, boxes on top of each other, connectors that cross or run through boxes,
 * boxes with too much in them, colour that no longer means anything. Each issue says what to change
 * in the spec, so whoever wrote it can fix it without looking at coordinates.
 */

export type Issue = { level: 'error' | 'warn' | 'info'; code: string; message: string; at?: string };

/** How wide the diagram is shown when it fits a screen or a slide. */
export const VIEW_WIDTH = 1600;
/** Smallest text size (px, as shown) that still reads comfortably. */
export const MIN_SHOWN = 12;
const MAX_TEXT = 40;
const MAX_NOTE = 90;
const MAX_LAYER = 7;

export function lintDiagram(b: Built): { issues: Issue[]; size: { width: number; height: number }; scale: number } {
  const { doc, diagram: d } = b;
  const issues: Issue[] = [];
  const all = [...doc.all()];
  const bounds = all.filter((n) => n.parentId === null).map((n) => doc.worldBounds(n.id));
  const right = Math.max(...bounds.map((r) => r.x + r.width));
  const bottom = Math.max(...bounds.map((r) => r.y + r.height));
  const size = { width: Math.ceil(right + 48), height: Math.ceil(bottom + 48) };
  const scale = Math.min(1, VIEW_WIDTH / size.width);

  // text too small once the whole diagram fits the view
  const sizes = all.flatMap((n) => [...(n.text ? [n.text.fontSize, ...(n.text.runs ?? []).map((r) => r.fontSize ?? n.text!.fontSize)] : []), ...(n.label ? [n.label.fontSize, ...(n.label.runs ?? []).map((r) => r.fontSize ?? n.label!.fontSize)] : [])]);
  const smallest = Math.min(...sizes);
  if (smallest * scale < MIN_SHOWN) {
    issues.push({
      level: 'warn',
      code: 'tiny-text',
      message: `The diagram is ${size.width}px wide, so at ${VIEW_WIDTH}px its ${smallest}px text shows at ${(smallest * scale).toFixed(1)}px. Split it into two diagrams, shorten the longest labels, or use direction "down" for a long chain.`,
    });
  }

  const box = (id: string) => doc.get(id)!;
  const specOf = new Map([...b.ids.nodes].map(([spec, id]) => [id, spec]));
  const boxes = [...b.ids.nodes.values()].map(box);

  // boxes on top of each other
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlap(boxes[i], boxes[j], 2)) issues.push({ level: 'error', code: 'overlap', message: `"${specOf.get(boxes[i].id)}" and "${specOf.get(boxes[j].id)}" overlap.`, at: specOf.get(boxes[i].id) });
    }
  }
  // group frames that run into each other
  const frames = [...b.ids.groups].map(([g, id]) => [g, box(id)] as const);
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      if (overlap(frames[i][1], frames[j][1], 0)) {
        issues.push({ level: 'warn', code: 'group-overlap', message: `Groups "${frames[i][0]}" and "${frames[j][0]}" overlap: their boxes share layers of the flow. Put each group's boxes in a run of steps of their own, or drop one of the groups.`, at: frames[i][0] });
      }
    }
  }

  // words that don't fit, and boxes that say too much
  for (const n of d.nodes) {
    const node = box(b.ids.nodes.get(n.id)!);
    const ln = labelNode(node);
    if (ln && ln.height > node.height + 1) issues.push({ level: 'error', code: 'overflow', message: `The words of "${n.id}" don't fit its box.`, at: n.id });
    if ([...n.text].length > MAX_TEXT) issues.push({ level: 'warn', code: 'long-text', message: `"${n.id}" has ${[...n.text].length} characters; keep a box's text under ${MAX_TEXT} and move detail into its note.`, at: n.id });
    if (n.note && [...n.note].length > MAX_NOTE) issues.push({ level: 'warn', code: 'long-note', message: `The note of "${n.id}" has ${[...n.note].length} characters; keep it under ${MAX_NOTE}, or make it a box of its own.`, at: n.id });
  }

  // connectors: through boxes, and across each other
  const paths = b.ids.edges.map((id) => worldPath(doc.get(id)!, doc));
  b.ids.edges.forEach((id, i) => {
    const line = box(id);
    const e = d.edges[i];
    const ends = new Set([line.startBind?.nodeId, line.endBind?.nodeId]);
    for (const other of boxes) {
      if (ends.has(other.id)) continue;
      if (pathHits(paths[i], shrink(other, 3))) {
        issues.push({ level: 'warn', code: 'edge-through-box', message: `The edge ${e.from} → ${e.to} runs through "${specOf.get(other.id)}". Reorder the nodes or edges, or split a long jump into steps.`, at: e.from });
      }
    }
  });
  let crossings = 0;
  const endsOf = b.ids.edges.map((id) => [box(id).startBind?.nodeId, box(id).endBind?.nodeId]);
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      // edges from or to the same box share a trunk where they fan out: not a crossing
      if (endsOf[i].some((id) => id && endsOf[j].includes(id))) continue;
      crossings += crossCount(paths[i], paths[j]);
    }
  }
  if (crossings > 0) {
    issues.push({ level: crossings > 2 ? 'warn' : 'info', code: 'crossings', message: `${crossings} place${crossings === 1 ? '' : 's'} where edges cross. Listing nodes in the order the flow visits them, or grouping related nodes, usually removes them.` });
  }

  // too much in one step of the flow
  const perLayer = new Map<number, string[]>();
  for (const n of d.nodes) {
    const node = box(b.ids.nodes.get(n.id)!);
    const key = Math.round(d.direction === 'right' ? node.x + node.width / 2 : node.y + node.height / 2);
    perLayer.set(key, [...(perLayer.get(key) ?? []), n.id]);
  }
  for (const ids of perLayer.values()) {
    if (ids.length > MAX_LAYER) issues.push({ level: 'warn', code: 'crowded-layer', message: `${ids.length} nodes side by side (${ids.slice(0, 3).join(', ')}, …). Group them, or split the diagram.`, at: ids[0] });
  }

  // colour that has stopped meaning something
  const coloured = d.nodes.filter((n) => n.role !== 'default' && n.role !== 'muted').length;
  if (d.nodes.length >= 5 && coloured / d.nodes.length > 0.6) {
    issues.push({ level: 'info', code: 'too-much-colour', message: `${coloured} of ${d.nodes.length} nodes have a role colour. Keep roles for the few nodes they single out (outcomes, warnings, the main path).` });
  }
  if (d.nodes.length > 40) issues.push({ level: 'warn', code: 'too-big', message: `${d.nodes.length} nodes is a lot for one diagram; split it by group.` });

  return { issues, size, scale };
}

function overlap(a: Rect, b: Rect, slack: number): boolean {
  return a.x + slack < b.x + b.width && b.x + slack < a.x + a.width && a.y + slack < b.y + b.height && b.y + slack < a.y + a.height;
}

const shrink = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, width: r.width - by * 2, height: r.height - by * 2 });

function worldPath(line: SceneNode, doc: Built['doc']): Point[] {
  const m = doc.world(line.id);
  return linePoints(line).map((p) => apply(m, p));
}

function pathHits(path: Point[], r: Rect): boolean {
  for (let i = 1; i < path.length; i++) if (segmentHitsRect(path[i - 1], path[i], r)) return true;
  return false;
}

function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  // clip the segment to the rectangle (Liang–Barsky)
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.width - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.height - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function crossCount(p: Point[], q: Point[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) if (segmentsCross(p[i - 1], p[i], q[j - 1], q[j])) n++;
  return n;
}

/** Proper crossings only: sharing an end (edges leaving the same box) doesn't count. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
