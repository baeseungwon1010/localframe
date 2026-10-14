import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import type { BooleanOp, SceneNode, Vector, VectorPoint } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { linePoints } from './geometry.ts';
import { type Mat, type Point, apply, localMatrix } from './math.ts';
import { outlineVector, vectorPaths } from './vector.ts';

/** Curves become this many straight pieces each. */
const CURVE_STEPS = 16;
/** Round joins and caps: pieces per full circle. */
const ROUND_STEPS = 24;
/** Above this many vertices the result is refused (a vector holds 50,000 points). */
const MAX_VERTICES = 40_000;

/** A path's points along its curves, as a polyline (closing point not repeated). */
export function flattenPath(points: VectorPoint[], closed: boolean): Point[] {
  const out: Point[] = [];
  if (!points.length) return out;
  out.push({ x: points[0].x, y: points[0].y });
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a.out && !b.in) {
      out.push({ x: b.x, y: b.y });
      continue;
    }
    const c1 = a.out ?? a;
    const c2 = b.in ?? b;
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  if (closed && out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) out.pop();
  }
  return out;
}

/** Coordinates on a 1/256 grid: the clipping maths stays robust when nearly equal points meet exactly. */
const snap = (v: number) => Math.round(v * 256) / 256;

const ring = (pts: Point[], m?: Mat): Ring => {
  const r: [number, number][] = [];
  for (const p of pts) {
    const q = m ? apply(m, p) : p;
    const x = snap(q.x);
    const y = snap(q.y);
    const last = r[r.length - 1];
    if (!last || last[0] !== x || last[1] !== y) r.push([x, y]);
  }
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (r.length) r.push(r[0]);
  return r;
};

/** The paths of a layer's outline in its own coordinates (null for what has no outline). */
function outlinePaths(n: SceneNode): { closed: boolean; points: VectorPoint[] }[] | null {
  if (n.type === 'VECTOR' && n.vector) return vectorPaths(n.vector);
  if (n.type === 'LINE') {
    const v = outlineVector(n, linePoints(n));
    return v ? [{ closed: false, points: v.points }] : null;
  }
  if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
    const v = outlineVector({ ...n, type: 'RECTANGLE' });
    return v ? [{ closed: true, points: v.points }] : null;
  }
  const v = outlineVector(n);
  return v ? [{ closed: v.closed, points: v.points }] : null;
}

/** The filled area of a layer (closed paths only), mapped by `m` (its own coordinates if none). */
export function fillArea(n: SceneNode, m?: Mat): MultiPolygon {
  const paths = outlinePaths(n);
  if (!paths) return [];
  const rings = paths
    .filter((p) => p.closed)
    .map((p) => ring(flattenPath(p.points, true), m))
    .filter((r) => r.length >= 4);
  if (!rings.length) return [];
  // each ring on its own, combined by the vector's fill rule (even-odd: overlaps cancel)
  const parts: Polygon[] = rings.map((r) => [r]);
  if (n.type === 'VECTOR' && n.vector?.fillRule === 'evenodd') return parts.slice(1).reduce<MultiPolygon>((acc, p) => polygonClipping.xor(acc, p), [parts[0]]);
  return unionAll(parts);
}

/** Union of many pieces; if the all-at-once sweep trips on a near-degenerate edge, one at a time. */
function unionAll(parts: Polygon[]): MultiPolygon {
  try {
    return polygonClipping.union(parts[0], ...parts.slice(1));
  } catch {
    let acc: MultiPolygon = [parts[0]];
    for (const p of parts.slice(1)) {
      try {
        acc = polygonClipping.union(acc, p);
      } catch {
        throw new Error('This shape could not be outlined.');
      }
    }
    return acc;
  }
}

function disc(c: Point, r: number): Polygon {
  const pts: Point[] = [];
  for (let i = 0; i < ROUND_STEPS; i++) {
    const a = (i / ROUND_STEPS) * Math.PI * 2;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return [ring(pts)];
}

/** The area a stroke covers along a polyline: segment bands, round joins, and the line's caps. */
function strokeAlong(pts: Point[], closed: boolean, half: number, cap: 'none' | 'round' | 'square'): Polygon[] {
  const parts: Polygon[] = [];
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    let a = pts[i];
    let b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    // square caps lengthen the first and last segments of an open line
    if (!closed && cap === 'square') {
      if (i === 0) a = { x: a.x - ux * half, y: a.y - uy * half };
      if (i === segs - 1) b = { x: b.x + ux * half, y: b.y + uy * half };
    }
    const nx = -uy * half;
    const ny = ux * half;
    parts.push([ring([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }])]);
  }
  // joins: round discs fill the gaps between segments (miter and bevel joins come out round too)
  const first = closed ? 0 : 1;
  const last = closed ? n : n - 1;
  for (let i = first; i < last; i++) parts.push(disc(pts[i], half));
  if (!closed && cap === 'round' && n > 0) parts.push(disc(pts[0], half), disc(pts[n - 1], half));
  return parts;
}

/**
 * The area a layer's stroke covers, in its own coordinates: every path's band, cut to the inside
 * or outside of the shape for inside and outside strokes. Empty when there is no stroke.
 */
export function strokeArea(n: SceneNode): MultiPolygon {
  const paths = outlinePaths(n);
  if (!paths || n.strokeWeight <= 0) return [];
  const align = n.type === 'LINE' || (n.type === 'VECTOR' && !n.vector?.closed) ? 'center' : n.strokeAlign;
  // inside and outside strokes are as wide as the weight on one side: a double-width band, then cut
  const half = align === 'center' ? n.strokeWeight / 2 : n.strokeWeight;
  const cap = n.strokeCap ?? (n.type === 'VECTOR' ? 'round' : 'none');
  const parts: Polygon[] = [];
  let vertices = 0;
  for (const p of paths) {
    const pts = flattenPath(p.points, p.closed);
    vertices += pts.length * 8;
    if (vertices > MAX_VERTICES * 4) throw new Error('This path is too detailed to outline.');
    parts.push(...strokeAlong(pts, p.closed, half, cap));
  }
  if (!parts.length) return [];
  const band = unionAll(parts);
  if (align === 'center') return band;
  const shape = fillArea(n);
  if (!shape.length) return band;
  return align === 'inside' ? polygonClipping.intersection(band, shape) : polygonClipping.difference(band, shape);
}

/** Area polygons as one vector: every ring (outer edges and holes) a closed path, filled even-odd. */
export function areaToVector(area: MultiPolygon): Vector | null {
  const paths: { closed: boolean; points: VectorPoint[] }[] = [];
  let vertices = 0;
  for (const poly of area) {
    for (const r of poly) {
      const pts = r.slice(0, -1).map(([x, y]) => ({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }));
      if (pts.length < 3) continue;
      vertices += pts.length;
      paths.push({ closed: true, points: pts });
    }
  }
  if (!paths.length) return null;
  if (vertices > MAX_VERTICES || paths.length > 201) throw new Error('The result is too detailed to keep as a vector.');
  return { closed: true, points: paths[0].points, extra: paths.length > 1 ? paths.slice(1) : undefined, fillRule: 'evenodd' };
}

/**
 * A boolean group's area in its own coordinates: its visible children (shapes, vectors and nested
 * booleans) combined from the bottom one up with its operation. Null if a child has no outline
 * (text, for example).
 */
export function booleanArea(doc: SceneDoc, n: SceneNode): MultiPolygon | null {
  const kids = doc.children(n.id).map((id) => doc.get(id)!).filter((k) => k.visible);
  let acc: MultiPolygon | null = null;
  for (const k of kids) {
    const m = localMatrix(k.x, k.y, k.rotation);
    let area: MultiPolygon | null;
    if (k.type === 'BOOLEAN') {
      const inner = booleanArea(doc, k);
      area = inner && inner.map((poly) => poly.map((r) => r.map(([x, y]) => { const q = apply(m, { x, y }); return [q.x, q.y] as [number, number]; })));
    } else if (k.type === 'TEXT' || k.type === 'GROUP' || k.type === 'COMPONENT_SET') area = null;
    else area = fillArea(k, m);
    if (!area) return null;
    if (acc === null) {
      acc = area;
      continue;
    }
    const op: BooleanOp = n.booleanOp ?? 'union';
    acc =
      op === 'union'
        ? polygonClipping.union(acc, area)
        : op === 'subtract'
          ? polygonClipping.difference(acc, area)
          : op === 'intersect'
            ? polygonClipping.intersection(acc, area)
            : polygonClipping.xor(acc, area);
  }
  return acc ?? [];
}
