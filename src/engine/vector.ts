import type { SceneNode, Vector, VectorPoint } from '../../shared/schema.ts';
import { type Point, type Rect, apply, boundsOfPoints, localMatrix, round2 } from './math.ts';

type PathSink = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
};

function segment(sink: PathSink, a: VectorPoint, b: VectorPoint) {
  if (!a.out && !b.in) sink.lineTo(b.x, b.y);
  else {
    const c1 = a.out ?? a;
    const c2 = b.in ?? b;
    sink.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
  }
}

/** Adds the vector's outline to a canvas path or Path2D. */
export function tracePath(sink: PathSink, v: Vector) {
  const pts = v.points;
  if (pts.length === 0) return;
  sink.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) segment(sink, pts[i - 1], pts[i]);
  if (v.closed && pts.length > 1) {
    segment(sink, pts[pts.length - 1], pts[0]);
    sink.closePath();
  }
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);

export function svgPathData(v: Vector): string {
  const out: string[] = [];
  tracePath(
    {
      moveTo: (x, y) => out.push(`M${f(x)} ${f(y)}`),
      lineTo: (x, y) => out.push(`L${f(x)} ${f(y)}`),
      bezierCurveTo: (a, b, c, d, x, y) => out.push(`C${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(x)} ${f(y)}`),
      closePath: () => out.push('Z'),
    },
    v,
  );
  return out.join('');
}

/** Bounds of the points and handles (always contains the curve). */
export function vectorBounds(v: Vector): Rect {
  const pts: Point[] = [];
  for (const p of v.points) {
    pts.push(p);
    if (p.in) pts.push(p.in);
    if (p.out) pts.push(p.out);
  }
  return boundsOfPoints(pts);
}

export function scaleVector(v: Vector, sx: number, sy: number): Vector {
  const s = (p: Point) => ({ x: round2(p.x * sx), y: round2(p.y * sy) });
  return {
    closed: v.closed,
    points: v.points.map((p) => ({ ...s(p), ...(p.in ? { in: s(p.in) } : {}), ...(p.out ? { out: s(p.out) } : {}) })),
  };
}

function shift(v: Vector, dx: number, dy: number): Vector {
  const t = (p: Point) => ({ x: round2(p.x + dx), y: round2(p.y + dy) });
  return { closed: v.closed, points: v.points.map((p) => ({ ...t(p), ...(p.in ? { in: t(p.in) } : {}), ...(p.out ? { out: t(p.out) } : {}) })) };
}

/**
 * Moves the layer's origin to the top-left of its path, so its box fits the path again
 * (after drawing or editing points). The path stays where it is on the page.
 */
export function fitVector(n: SceneNode): SceneNode {
  if (!n.vector) return n;
  const b = vectorBounds(n.vector);
  const origin = apply(localMatrix(n.x, n.y, n.rotation), { x: b.x, y: b.y });
  return {
    ...n,
    x: round2(origin.x),
    y: round2(origin.y),
    width: Math.max(0.01, round2(b.width)),
    height: Math.max(0.01, round2(b.height)),
    vector: shift(n.vector, -b.x, -b.y),
  };
}

let hitCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;
function getHitCtx() {
  if (hitCtx !== undefined) return hitCtx;
  if (typeof OffscreenCanvas !== 'undefined') hitCtx = new OffscreenCanvas(1, 1).getContext('2d');
  else if (typeof document !== 'undefined') hitCtx = document.createElement('canvas').getContext('2d');
  else hitCtx = null;
  return hitCtx;
}

/** Is the local point on the path (inside it if filled, near its line otherwise)? */
export function hitsVector(n: SceneNode, p: Point, tolerance: number): boolean {
  const v = n.vector!;
  const ctx = getHitCtx();
  if (!ctx || typeof Path2D === 'undefined') {
    return p.x >= -tolerance && p.y >= -tolerance && p.x <= n.width + tolerance && p.y <= n.height + tolerance;
  }
  const path = new Path2D();
  tracePath(path, v);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const filled = n.fills.some((f) => f.visible);
  if (filled && ctx.isPointInPath(path, p.x, p.y)) return true;
  ctx.lineWidth = Math.max(n.strokeWeight, tolerance * 2);
  return ctx.isPointInStroke(path, p.x, p.y);
}
