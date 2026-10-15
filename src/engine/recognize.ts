import type { Point, Rect } from './math.ts';

/**
 * Hand-drawn shapes to clean ones, as on a whiteboard: a stroke that is nearly straight becomes a
 * line, a closed stroke a rectangle, ellipse, diamond or triangle when it is close enough to one.
 * Anything else stays a drawing (null).
 */

export type Recognized = { kind: 'line'; from: Point; to: Point } | { kind: 'rect' | 'ellipse' | 'diamond' | 'triangle'; box: Rect };

/** How far off (mean distance as a share of the shape's size) a closed shape may be. */
const FIT = { rect: 0.05, ellipse: 0.09, diamond: 0.07, triangle: 0.06 };
const MIN_SIZE = 16;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Points spread evenly along the stroke, so slow and fast parts count the same. */
function resample(points: Point[], count: number): Point[] {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  if (total === 0) return [points[0]];
  const step = total / (count - 1);
  const out = [points[0]];
  let need = step;
  for (let i = 1; i < points.length && out.length < count; i++) {
    let a = points[i - 1];
    const b = points[i];
    let seg = dist(a, b);
    while (seg >= need && out.length < count) {
      const t = need / seg;
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(a);
      seg = dist(a, b);
      need = step;
    }
    need -= seg;
  }
  while (out.length < count) out.push(points[points.length - 1]);
  return out;
}

/** Mean distance from the points to a closed outline (as a list of corners), over `size`. */
function polygonError(pts: Point[], corners: Point[], size: number): number {
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < corners.length; i++) best = Math.min(best, distToSegment(p, corners[i], corners[(i + 1) % corners.length]));
    sum += best;
  }
  return sum / pts.length / size;
}

/** The three corners that enclose the most of the stroke (the farthest-apart points). */
function triangleCorners(pts: Point[]): Point[] {
  let a = pts[0];
  let b = pts[0];
  let best = -1;
  for (let i = 0; i < pts.length; i += 2)
    for (let j = i + 1; j < pts.length; j += 2) {
      const d = dist(pts[i], pts[j]);
      if (d > best) {
        best = d;
        a = pts[i];
        b = pts[j];
      }
    }
  let c = pts[0];
  best = -1;
  for (const p of pts) {
    const d = distToSegment(p, a, b);
    if (d > best) {
      best = d;
      c = p;
    }
  }
  return [a, b, c];
}

export function recognizeStroke(raw: Point[]): Recognized | null {
  if (raw.length < 4) return null;
  const pts = resample(raw, 64);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const size = Math.max(w, h);
  if (size < MIN_SIZE) return null;
  let length = 0;
  for (let i = 1; i < raw.length; i++) length += dist(raw[i - 1], raw[i]);
  const first = raw[0];
  const last = raw[raw.length - 1];

  // nearly straight: a line
  const chord = dist(first, last);
  if (chord > 30 && chord > 0.92 * length && Math.max(...pts.map((p) => distToSegment(p, first, last))) < 0.08 * chord) {
    return { kind: 'line', from: first, to: last };
  }
  // the rest must close on itself and not be a thin sliver
  if (chord > 0.25 * size || Math.min(w, h) < 0.15 * size || length < 2.2 * size) return null;

  const box = { x: x0, y: y0, width: w, height: h };
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const norm = Math.min(w, h);
  const errors: [Recognized['kind'], number][] = [];
  errors.push(['rect', polygonError(pts, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], norm) / FIT.rect]);
  errors.push(['diamond', polygonError(pts, [{ x: cx, y: y0 }, { x: x1, y: cy }, { x: cx, y: y1 }, { x: x0, y: cy }], norm) / FIT.diamond]);
  let e = 0;
  for (const p of pts) e += Math.abs(Math.hypot((p.x - cx) / (w / 2), (p.y - cy) / (h / 2)) - 1);
  errors.push(['ellipse', e / pts.length / FIT.ellipse]);
  errors.push(['triangle', polygonError(pts, triangleCorners(pts), norm) / FIT.triangle]);
  errors.sort((p, q) => p[1] - q[1]);
  const [kind, score] = errors[0];
  if (score > 1) return null;
  return { kind, box } as Recognized;
}
