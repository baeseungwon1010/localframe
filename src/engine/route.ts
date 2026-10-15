import type { Point, Rect } from './math.ts';

/**
 * Elbow connectors that go around shapes. The path runs on a grid made of the start, the end and
 * lines just outside every shape; the cheapest path is the shortest with the fewest bends.
 */

/** Space kept between a connector and the shapes it passes. */
export const CLEARANCE = 12;
/** A bend costs as much as this much extra length. */
const BEND = 40;
/** At most this many shapes are considered, the nearest first (keeps dragging smooth). */
const MAX_OBSTACLES = 40;
const MAX_ROUTE_POINTS = 8;

const inside = (r: Rect, p: Point) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

/** Does the axis-aligned segment p-q cross the inside of r? */
function crosses(r: Rect, p: Point, q: Point): boolean {
  if (p.y === q.y) {
    const [x1, x2] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
    return p.y > r.y && p.y < r.y + r.height && x2 > r.x && x1 < r.x + r.width;
  }
  const [y1, y2] = p.y < q.y ? [p.y, q.y] : [q.y, p.y];
  return p.x > r.x && p.x < r.x + r.width && y2 > r.y && y1 < r.y + r.height;
}

const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + d * 2, height: r.height + d * 2 });

/** Does a path (any segments, axis-aligned or not) cross any of the rectangles? */
export function pathBlocked(points: Point[], rects: Rect[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    for (const r of rects) {
      if (p.x === q.x || p.y === q.y) {
        if (crosses(r, p, q)) return true;
      } else {
        // a diagonal piece: sample it (connectors are elbows, so this is rare)
        for (let t = 0; t <= 1; t += 0.05) if (inside(r, { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })) return true;
      }
    }
  }
  return false;
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];
const dirIndex = (d: Point) => DIRS.findIndex((v) => v.x === Math.sign(d.x) && v.y === Math.sign(d.y));

/** Drops repeated points and points in the middle of a straight run. */
function tidy(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [p, q, r] = [out[i - 1], out[i], out[i + 1]];
    if (Math.abs((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)) < 0.01) out.splice(i, 1);
  }
  return out;
}

/**
 * A right-angle path from a to b around `obstacles` (world rectangles, the two connected shapes
 * included), leaving a along `da` for `padA` and reaching b from `db` for `padB`. Returns the
 * points between a and b, or null when there is no such path (or it needs too many bends).
 */
export function routeAround(obstacles: Rect[], a: Point, da: Point, padA: number, b: Point, db: Point, padB: number): Point[] | null {
  const s = { x: a.x + da.x * padA, y: a.y + da.y * padA };
  const e = { x: b.x + db.x * padB, y: b.y + db.y * padB };
  // the nearest shapes to the trip from s to e
  const cx = (s.x + e.x) / 2;
  const cy = (s.y + e.y) / 2;
  const near = [...obstacles]
    .sort((p, q) => Math.hypot(p.x + p.width / 2 - cx, p.y + p.height / 2 - cy) - Math.hypot(q.x + q.width / 2 - cx, q.y + q.height / 2 - cy))
    .slice(0, MAX_OBSTACLES);
  // blocking areas stop just short of the clearance lines, so paths may run along those lines
  const blocks = near.map((r) => grow(r, CLEARANCE - 1));
  if (blocks.some((r) => inside(r, s) || inside(r, e))) return null;

  const xs = new Set([s.x, e.x, cx]);
  const ys = new Set([s.y, e.y, cy]);
  for (const r of near) {
    xs.add(r.x - CLEARANCE).add(r.x + r.width + CLEARANCE);
    ys.add(r.y - CLEARANCE).add(r.y + r.height + CLEARANCE);
  }
  const X = [...xs].sort((p, q) => p - q);
  const Y = [...ys].sort((p, q) => p - q);
  const W = X.length;
  const key = (i: number, j: number, d: number) => (j * W + i) * 4 + d;
  const free = (i: number, j: number) => !blocks.some((r) => inside(r, { x: X[i], y: Y[j] }));
  const si = X.indexOf(s.x);
  const sj = Y.indexOf(s.y);
  const ei = X.indexOf(e.x);
  const ej = Y.indexOf(e.y);
  const startDir = dirIndex(da) < 0 ? 0 : dirIndex(da);
  // arriving at e we move toward b, so against b's outward direction
  const endDir = dirIndex({ x: -db.x, y: -db.y });

  // Dijkstra with an A* bound over (cell, direction); the grid is small, a sorted array will do
  const cost = new Map<number, number>();
  const prev = new Map<number, number>();
  const open: { k: number; i: number; j: number; d: number; g: number; f: number }[] = [];
  const h = (i: number, j: number) => Math.abs(X[i] - e.x) + Math.abs(Y[j] - e.y);
  const push = (i: number, j: number, d: number, g: number, from: number | null) => {
    const k = key(i, j, d);
    if ((cost.get(k) ?? Infinity) <= g) return;
    cost.set(k, g);
    if (from !== null) prev.set(k, from);
    const node = { k, i, j, d, g, f: g + h(i, j) };
    let lo = 0;
    let hi = open.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (open[mid].f > node.f) lo = mid + 1;
      else hi = mid;
    }
    open.splice(lo, 0, node);
  };
  push(si, sj, startDir, 0, null);
  let goal: number | null = null;
  let best = Infinity;
  let guard = 0;
  while (open.length && guard++ < 50_000) {
    const cur = open.pop()!;
    if (cur.g !== cost.get(cur.k) || cur.f >= best) continue;
    if (cur.i === ei && cur.j === ej) {
      const total = cur.g + (endDir >= 0 && cur.d !== endDir ? BEND : 0);
      if (total < best) {
        best = total;
        goal = cur.k;
      }
      continue;
    }
    for (let d = 0; d < 4; d++) {
      // never straight back the way it came
      if (d === (cur.d + 2) % 4) continue;
      const ni = cur.i + DIRS[d].x;
      const nj = cur.j + DIRS[d].y;
      if (ni < 0 || nj < 0 || ni >= W || nj >= Y.length || !free(ni, nj)) continue;
      const p = { x: X[cur.i], y: Y[cur.j] };
      const q = { x: X[ni], y: Y[nj] };
      if (blocks.some((r) => crosses(r, p, q))) continue;
      push(ni, nj, d, cur.g + Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + (d === cur.d ? 0 : BEND), cur.k);
    }
  }
  if (goal === null) return null;
  const cells: Point[] = [];
  for (let k: number | undefined = goal; k !== undefined; k = prev.get(k)) {
    const cell = Math.floor(k / 4);
    cells.push({ x: X[cell % W], y: Y[Math.floor(cell / W)] });
  }
  cells.reverse();
  const route = tidy([a, s, ...cells, e, b]).slice(1, -1);
  return route.length <= MAX_ROUTE_POINTS ? route : null;
}
