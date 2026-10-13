import type { Binding, SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { lineEnds, lineFromEnds } from './geometry.ts';
import { hitDeepest } from './hit.ts';
import { type Point, apply, invert } from './math.ts';

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

/** World position of a bound end, or null if the layer is gone or hidden. */
function boundPoint(doc: SceneDoc, b: Binding, other: Point): Point | null {
  const n = doc.get(b.nodeId);
  if (!n || !doc.isEffectivelyVisible(n.id)) return null;
  const side = b.anchor === 'auto' ? nearestSide(doc, n, other) : b.anchor;
  return sidePoint(doc, n, side);
}

/** Re-places a line so its bound ends sit on their layers. Returns the same object if nothing moved. */
export function settleLine(doc: SceneDoc, line: SceneNode): SceneNode {
  if (line.type !== 'LINE' || (!line.startBind && !line.endBind)) return line;
  const pw = doc.parentWorld(line);
  const [a0, b0] = lineEnds(line).map((q) => apply(pw, q));
  const ref = (b: Binding | undefined, fallback: Point) => {
    const n = b ? doc.get(b.nodeId) : undefined;
    return n ? centerPoint(doc, n) : fallback;
  };
  const a = line.startBind ? (boundPoint(doc, line.startBind, ref(line.endBind, b0)) ?? a0) : a0;
  const b = line.endBind ? (boundPoint(doc, line.endBind, ref(line.startBind, a0)) ?? b0) : b0;
  const toParent = invert(pw);
  const next = lineFromEnds(line, apply(toParent, a), apply(toParent, b));
  return next.x === line.x && next.y === line.y && next.width === line.width && next.rotation === line.rotation ? line : next;
}
