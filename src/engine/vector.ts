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

const KAPPA = 0.5522847498;

/**
 * The outline of a rectangle (with its corner radii), ellipse or line as path points in the layer's
 * own coordinates, so it can become an editable vector. Null for anything else.
 */
export function outlineVector(n: SceneNode, linePts?: Point[]): Vector | null {
  const w = n.width;
  const h = n.height;
  const P = (x: number, y: number, inn?: Point, out?: Point): VectorPoint => ({
    x: round2(x),
    y: round2(y),
    ...(inn ? { in: { x: round2(inn.x), y: round2(inn.y) } } : {}),
    ...(out ? { out: { x: round2(out.x), y: round2(out.y) } } : {}),
  });
  if (n.type === 'ELLIPSE') {
    const rx = w / 2;
    const ry = h / 2;
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return {
      closed: true,
      points: [
        P(rx, 0, { x: rx - kx, y: 0 }, { x: rx + kx, y: 0 }),
        P(w, ry, { x: w, y: ry - ky }, { x: w, y: ry + ky }),
        P(rx, h, { x: rx + kx, y: h }, { x: rx - kx, y: h }),
        P(0, ry, { x: 0, y: ry + ky }, { x: 0, y: ry - ky }),
      ],
    };
  }
  if (n.type === 'RECTANGLE') {
    const max = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = (n.radii ?? [0, 0, 0, 0]).map((r) => Math.max(0, Math.min(r, max)));
    const pts: VectorPoint[] = [];
    // each rounded corner is two points with handles; a square corner is one point
    const corner = (cx: number, cy: number, r: number, ax: number, ay: number, bx: number, by: number) => {
      if (r <= 0) return void pts.push(P(cx, cy));
      const a = { x: cx + ax * r, y: cy + ay * r };
      const b = { x: cx + bx * r, y: cy + by * r };
      pts.push(P(a.x, a.y, undefined, { x: a.x - ax * r * KAPPA, y: a.y - ay * r * KAPPA }));
      pts.push(P(b.x, b.y, { x: b.x - bx * r * KAPPA, y: b.y - by * r * KAPPA }));
    };
    corner(0, 0, tl, 0, 1, 1, 0);
    corner(w, 0, tr, -1, 0, 0, 1);
    corner(w, h, br, 0, -1, -1, 0);
    corner(0, h, bl, 1, 0, 0, -1);
    return { closed: true, points: pts };
  }
  if (n.type === 'LINE' && linePts) return { closed: false, points: linePts.map((q) => P(q.x, q.y)) };
  return null;
}

/** Drops points that sit within `epsilon` of the line through their neighbours (Ramer–Douglas–Peucker). */
export function simplifyPoints(pts: Point[], epsilon: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = pts[a];
    const pb = pts[b];
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      const d = len === 0 ? Math.hypot(p.x - pa.x, p.y - pa.y) : Math.abs((pb.x - pa.x) * (pa.y - p.y) - (pa.x - p.x) * (pb.y - pa.y)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > epsilon) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A smooth open path through the points (Catmull-Rom turned into curve handles). */
export function smoothPath(pts: Point[]): VectorPoint[] {
  const k = 1 / 6;
  return pts.map((p, i) => {
    const prev = pts[i - 1] ?? p;
    const next = pts[i + 1] ?? p;
    const dx = (next.x - prev.x) * k;
    const dy = (next.y - prev.y) * k;
    const out: VectorPoint = { x: round2(p.x), y: round2(p.y) };
    if (i > 0) out.in = { x: round2(p.x - dx), y: round2(p.y - dy) };
    if (i < pts.length - 1) out.out = { x: round2(p.x + dx), y: round2(p.y + dy) };
    return out;
  });
}

/** Points of a polygon or star filling a w × h box, first point at the top. */
export function shapeVector(shape: { kind: 'polygon' | 'star'; count: number; ratio: number }, w: number, h: number): Vector {
  const n = shape.kind === 'star' ? shape.count * 2 : shape.count;
  const unit: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = shape.kind === 'star' && i % 2 === 1 ? shape.ratio : 1;
    unit.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  // stretch so the outer points touch every side of the box
  const xs = unit.map((p) => p.x);
  const ys = unit.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return {
    closed: true,
    points: unit.map((p) => ({ x: round2(((p.x - x0) / (x1 - x0 || 1)) * w), y: round2(((p.y - y0) / (y1 - y0 || 1)) * h) })),
  };
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
