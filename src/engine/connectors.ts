import type { Binding, SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { lineEnds, lineFromEnds } from './geometry.ts';
import { hitDeepest } from './hit.ts';
import { type Point, DEG, apply, invert, round2 } from './math.ts';

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

const SIDE_POS: Record<Side, Point> = {
  top: { x: 0.5, y: 0 },
  right: { x: 1, y: 0.5 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
};

/** Can a line end attach to this layer? Lines and containers can't. */
export function canBindTo(n: SceneNode | undefined): boolean {
  return !!n && n.visible && n.type !== 'LINE' && n.type !== 'FRAME' && n.type !== 'COMPONENT';
}

export function sidePoint(doc: SceneDoc, n: SceneNode, side: Side): Point {
  const p = SIDE_POS[side];
  return apply(doc.world(n.id), { x: p.x * n.width, y: p.y * n.height });
}

export function centerPoint(doc: SceneDoc, n: SceneNode): Point {
  return apply(doc.world(n.id), { x: n.width / 2, y: n.height / 2 });
}

/** The side of `n` whose midpoint is closest to `toward`. */
export function nearestSide(doc: SceneDoc, n: SceneNode, toward: Point): Side {
  let best: Side = 'top';
  let bestD = Infinity;
  for (const s of SIDES) {
    const q = sidePoint(doc, n, s);
    const d = Math.hypot(q.x - toward.x, q.y - toward.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** The layer a line end dropped at `p` attaches to, and which side (or auto). */
export function bindingAt(doc: SceneDoc, p: Point, tolerance: number, skip: Set<string>): Binding | null {
  const id = hitDeepest(doc, p, tolerance, skip);
  if (!id) return null;
  const n = doc.get(id)!;
  if (!canBindTo(n)) return null;
  // Dropped right on a side's midpoint: stick to that side. Anywhere else: follow the other end.
  for (const s of SIDES) {
    const q = sidePoint(doc, n, s);
    if (Math.hypot(q.x - p.x, q.y - p.y) <= tolerance * 3) return { nodeId: id, anchor: s };
  }
  return { nodeId: id, anchor: 'auto' };
}

/** World position (and side) of a bound end, or null if the layer is gone or hidden. */
function boundPoint(doc: SceneDoc, b: Binding, other: Point): { at: Point; side: Side } | null {
  const n = doc.get(b.nodeId);
  if (!n || !doc.isEffectivelyVisible(n.id)) return null;
  const side = b.anchor === 'auto' ? nearestSide(doc, n, other) : b.anchor;
  return { at: sidePoint(doc, n, side), side };
}

const SIDE_DIR: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const ELBOW_PAD = 20;

/** Outward direction for a free end: along the main axis, away from the other end. */
function freeDir(from: Point, toward: Point): Point {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
}

/**
 * Right-angle path from a to b, leaving a along `da` and arriving at b from `db` (both point
 * outward from their end). Returns the points between a and b.
 */
export function elbowRoute(a: Point, da: Point, padA: number, b: Point, db: Point, padB: number): Point[] {
  const s = { x: a.x + da.x * padA, y: a.y + da.y * padA };
  const e = { x: b.x + db.x * padB, y: b.y + db.y * padB };
  const hA = da.x !== 0;
  const hB = db.x !== 0;
  let mid: Point[];
  if (hA && hB) {
    const mx = (s.x + e.x) / 2;
    mid = [{ x: mx, y: s.y }, { x: mx, y: e.y }];
  } else if (!hA && !hB) {
    const my = (s.y + e.y) / 2;
    mid = [{ x: s.x, y: my }, { x: e.x, y: my }];
  } else if (hA) mid = [{ x: e.x, y: s.y }];
  else mid = [{ x: s.x, y: e.y }];
  const all = [a, s, ...mid, e, b];
  // drop repeated points and bends that sit on a straight run
  const out: Point[] = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [p, q, r] = [out[i - 1], out[i], out[i + 1]];
    if (Math.abs((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)) < 0.01) out.splice(i, 1);
  }
  return out.slice(1, -1);
}

/** Re-places a line so its bound ends sit on their layers. Returns the same object if nothing moved. */
export function settleLine(doc: SceneDoc, line: SceneNode): SceneNode {
  if (line.type !== 'LINE') return line;
  if (!line.elbow && line.route) line = { ...line, route: undefined };
  if (!line.startBind && !line.endBind && !line.elbow) return line;
  const pw = doc.parentWorld(line);
  const [a0, b0] = lineEnds(line).map((q) => apply(pw, q));
  const ref = (b: Binding | undefined, fallback: Point) => {
    const n = b ? doc.get(b.nodeId) : undefined;
    return n ? centerPoint(doc, n) : fallback;
  };
  const sa = line.startBind ? boundPoint(doc, line.startBind, ref(line.endBind, b0)) : null;
  const sb = line.endBind ? boundPoint(doc, line.endBind, ref(line.startBind, a0)) : null;
  const a = sa?.at ?? a0;
  const b = sb?.at ?? b0;
  const toParent = invert(pw);
  let next = lineFromEnds(line, apply(toParent, a), apply(toParent, b));
  if (line.elbow) {
    const world = elbowRoute(a, sa ? SIDE_DIR[sa.side] : freeDir(a, b), sa ? ELBOW_PAD : 0, b, sb ? SIDE_DIR[sb.side] : freeDir(b, a), sb ? ELBOW_PAD : 0);
    // into the line's own coordinates: parent space, then undo its position and rotation
    const r = -next.rotation * DEG;
    const route = world.slice(0, 8).map((w) => {
      const q = apply(toParent, w);
      const dx = q.x - next.x;
      const dy = q.y - next.y;
      return { x: round2(dx * Math.cos(r) - dy * Math.sin(r)), y: round2(dx * Math.sin(r) + dy * Math.cos(r)) };
    });
    next = { ...next, route: route.length ? route : undefined };
  }
  const same =
    next.x === line.x && next.y === line.y && next.width === line.width && next.rotation === line.rotation && JSON.stringify(next.route) === JSON.stringify(line.route);
  return same ? line : next;
}
