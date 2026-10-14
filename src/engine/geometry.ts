import type { SceneNode } from '../../shared/schema.ts';
import {
  type Mat,
  type Point,
  type Rect,
  DEG,
  apply,
  applyVector,
  invert,
  localMatrix,
  matRotation,
  multiply,
  normalizeDeg,
  round2,
} from './math.ts';

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Handle position in unit box coordinates (0..1). */
export const HANDLE_POS: Record<Handle, Point> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

export type Box = { l: number; t: number; r: number; b: number };

export type ResizeOptions = { keepAspect: boolean; fromCenter: boolean };

/**
 * New box (in the original node's local coordinates) after dragging `handle` by `delta`
 * (also in local coordinates). The box may come back flipped (l > r); see normalizeBox.
 */
export function resizeBox(width: number, height: number, handle: Handle, delta: Point, opts: ResizeOptions): Box {
  const box: Box = { l: 0, t: 0, r: width, b: height };
  const moveL = handle.includes('w');
  const moveR = handle.includes('e');
  const moveT = handle.startsWith('n');
  const moveB = handle.startsWith('s');
  if (moveL) box.l += delta.x;
  if (moveR) box.r += delta.x;
  if (moveT) box.t += delta.y;
  if (moveB) box.b += delta.y;
  if (opts.fromCenter) {
    if (moveL) box.r -= delta.x;
    if (moveR) box.l -= delta.x;
    if (moveT) box.b -= delta.y;
    if (moveB) box.t -= delta.y;
  }
  if (opts.keepAspect && width > 0 && height > 0) {
    const corner = (moveL || moveR) && (moveT || moveB);
    let sx = (box.r - box.l) / width;
    let sy = (box.b - box.t) / height;
    if (corner) {
      const s = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * s;
      sy = Math.sign(sy || 1) * s;
    } else if (moveL || moveR) {
      sy = Math.abs(sx);
    } else {
      sx = Math.abs(sy);
    }
    const newW = width * sx;
    const newH = height * sy;
    // Anchor: the opposite edge, or the centre; for edge handles the cross axis stays centred.
    if (opts.fromCenter || (!moveL && !moveR)) {
      const cx = opts.fromCenter ? width / 2 : (box.l + box.r) / 2;
      box.l = cx - newW / 2;
      box.r = cx + newW / 2;
    } else if (moveL) box.l = box.r - newW;
    else box.r = box.l + newW;
    if (opts.fromCenter || (!moveT && !moveB)) {
      const cy = opts.fromCenter ? height / 2 : (box.t + box.b) / 2;
      box.t = cy - newH / 2;
      box.b = cy + newH / 2;
    } else if (moveT) box.t = box.b - newH;
    else box.b = box.t + newH;
  }
  return box;
}

export function normalizeBox(b: Box): Box {
  return { l: Math.min(b.l, b.r), t: Math.min(b.t, b.b), r: Math.max(b.l, b.r), b: Math.max(b.t, b.b) };
}

/** Places `node` so its local box becomes `box` (given in its original local coordinates). */
export function applyBox(node: SceneNode, box: Box, minSize = 0.01): SceneNode {
  const nb = normalizeBox(box);
  const origin = apply(localMatrix(node.x, node.y, node.rotation), { x: nb.l, y: nb.t });
  return {
    ...node,
    x: round2(origin.x),
    y: round2(origin.y),
    width: Math.min(1e7, Math.max(minSize, round2(nb.r - nb.l))),
    height: Math.min(1e7, Math.max(minSize, round2(nb.b - nb.t))),
  };
}

/** Rotates a node about its centre to an absolute rotation. */
export function rotateAboutCenter(node: SceneNode, rotation: number): SceneNode {
  const c = { x: node.width / 2, y: node.height / 2 };
  const center = apply(localMatrix(node.x, node.y, node.rotation), c);
  const r = normalizeDeg(rotation);
  const offset = applyVector(localMatrix(0, 0, r), c);
  return { ...node, rotation: round2(r), x: round2(center.x - offset.x), y: round2(center.y - offset.y) };
}

/** Moves a node to a new parent without changing where it appears on the page. */
export function reparentKeepWorld(node: SceneNode, oldParentWorld: Mat, newParentWorld: Mat): SceneNode {
  const world = multiply(oldParentWorld, localMatrix(node.x, node.y, node.rotation));
  const local = multiply(invert(newParentWorld), world);
  return { ...node, x: round2(local[4]), y: round2(local[5]), rotation: round2(normalizeDeg(matRotation(local))) };
}

export function lineEnds(node: SceneNode): [Point, Point] {
  const r = node.rotation * DEG;
  return [
    { x: node.x, y: node.y },
    { x: node.x + node.width * Math.cos(r), y: node.y + node.width * Math.sin(r) },
  ];
}

/** A line's points in its own coordinates: the start, any elbow bends, the end. */
export function linePoints(n: SceneNode): Point[] {
  return [{ x: 0, y: 0 }, ...(n.elbow && n.route ? n.route : []), { x: n.width, y: 0 }];
}

/** Line geometry from two points in parent coordinates. */
export function lineFromEnds(node: SceneNode, a: Point, b: Point): SceneNode {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const rotation = len === 0 ? node.rotation : Math.atan2(b.y - a.y, b.x - a.x) / DEG;
  return { ...node, x: round2(a.x), y: round2(a.y), width: round2(len), height: 0, rotation: round2(normalizeDeg(rotation)) };
}

/** Snaps a direction to multiples of 45 degrees, keeping its length. */
export function snapAngle(from: Point, to: Point, stepDeg = 45): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const step = stepDeg * DEG;
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + len * Math.cos(a), y: from.y + len * Math.sin(a) };
}

/**
 * Children of a frame that changed size from (w0, h0) to (w1, h1), adjusted by their constraints.
 * Default constraints (left, top) leave a child unchanged.
 */
export function applyConstraints(
  children: SceneNode[],
  w0: number,
  h0: number,
  w1: number,
  h1: number,
): SceneNode[] {
  const dw = w1 - w0;
  const dh = h1 - h0;
  return children.map((c) => {
    const h = c.constraints?.horizontal ?? 'left';
    const v = c.constraints?.vertical ?? 'top';
    let { x, y, width, height } = c;
    if (h === 'right') x += dw;
    else if (h === 'center') x += dw / 2;
    else if (h === 'leftRight') width = Math.max(0.01, width + dw);
    else if (h === 'scale' && w0 > 0) {
      x *= w1 / w0;
      width *= w1 / w0;
    }
    if (v === 'bottom') y += dh;
    else if (v === 'center') y += dh / 2;
    else if (v === 'topBottom') height = Math.max(0.01, height + dh);
    else if (v === 'scale' && h0 > 0) {
      y *= h1 / h0;
      height *= h1 / h0;
    }
    return { ...c, x: round2(x), y: round2(y), width: round2(width), height: c.type === 'LINE' ? 0 : round2(height) };
  });
}

export type Guide = { axis: 'x' | 'y'; pos: number; from: number; to: number };

/**
 * Snaps a moving box to the edges and centres of other boxes.
 * Returns the offset to add and the guides to draw.
 */
export function snapRect(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const ys = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];
  let bestX: { d: number; pos: number } | null = null;
  let bestY: { d: number; pos: number } | null = null;
  for (const o of others) {
    const oxs = [o.x, o.x + o.width / 2, o.x + o.width];
    const oys = [o.y, o.y + o.height / 2, o.y + o.height];
    for (const a of xs)
      for (const b of oxs) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, pos: b };
      }
    for (const a of ys)
      for (const b of oys) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, pos: b };
      }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const moved = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };
  const guides: Guide[] = [];
  const eps = 0.01;
  if (bestX) {
    let from = moved.y;
    let to = moved.y + moved.height;
    for (const o of others) {
      if ([o.x, o.x + o.width / 2, o.x + o.width].some((v) => Math.abs(v - bestX!.pos) < eps)) {
        from = Math.min(from, o.y);
        to = Math.max(to, o.y + o.height);
      }
    }
    guides.push({ axis: 'x', pos: bestX.pos, from, to });
  }
  if (bestY) {
    let from = moved.x;
    let to = moved.x + moved.width;
    for (const o of others) {
      if ([o.y, o.y + o.height / 2, o.y + o.height].some((v) => Math.abs(v - bestY!.pos) < eps)) {
        from = Math.min(from, o.x);
        to = Math.max(to, o.x + o.width);
      }
    }
    guides.push({ axis: 'y', pos: bestY.pos, from, to });
  }
  return { dx, dy, guides };
}
