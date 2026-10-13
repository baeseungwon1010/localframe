import type { SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { type Point, type Rect, apply, distToSegment, invert, rectsIntersect } from './math.ts';

/** Is the world point on this node's own shape (children not included)? */
export function hitsShape(doc: SceneDoc, n: SceneNode, p: Point, tolerance: number): boolean {
  const local = apply(invert(doc.world(n.id)), p);
  if (n.type === 'LINE') {
    return distToSegment(local, { x: 0, y: 0 }, { x: n.width, y: 0 }) <= Math.max(n.strokeWeight / 2, tolerance);
  }
  if (n.type === 'ELLIPSE') {
    const rx = n.width / 2 + tolerance;
    const ry = n.height / 2 + tolerance;
    const dx = local.x - n.width / 2;
    const dy = local.y - n.height / 2;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  return (
    local.x >= -tolerance &&
    local.y >= -tolerance &&
    local.x <= n.width + tolerance &&
    local.y <= n.height + tolerance
  );
}

function insideBox(doc: SceneDoc, n: SceneNode, p: Point): boolean {
  const local = apply(invert(doc.world(n.id)), p);
  return local.x >= 0 && local.y >= 0 && local.x <= n.width && local.y <= n.height;
}

/** Deepest visible, unlocked node under the point, top-most first. */
export function hitDeepest(doc: SceneDoc, p: Point, tolerance: number, skip?: Set<string>): string | null {
  const visit = (parentId: string | null): string | null => {
    const kids = doc.children(parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = doc.get(kids[i])!;
      if (!n.visible || n.locked || skip?.has(n.id)) continue;
      if (n.type === 'FRAME') {
        if (n.clipsContent && !insideBox(doc, n, p)) continue;
        const inner = visit(n.id);
        if (inner) return inner;
      }
      if (hitsShape(doc, n, p, tolerance)) return n.id;
    }
    return null;
  };
  return visit(null);
}

/**
 * Which node a plain click selects, given the deepest hit and the current selection.
 * Children of top-level frames are selected directly; deeper levels need a double-click,
 * unless a sibling at that level is already selected.
 */
export function pickTarget(doc: SceneDoc, deepest: string, selection: Iterable<string>): string {
  const chain = [...doc.ancestors(deepest), deepest];
  const top = doc.get(chain[0])!;
  let level = top.type === 'FRAME' && chain.length > 1 ? 1 : 0;
  for (const s of selection) {
    const node = doc.get(s);
    if (!node) continue;
    const idx = chain.indexOf(s);
    if (idx >= 0) level = Math.max(level, idx);
    else if (node.parentId !== null) {
      const pIdx = chain.indexOf(node.parentId);
      if (pIdx >= 0) level = Math.max(level, pIdx + 1);
    }
  }
  return chain[Math.min(level, chain.length - 1)];
}

/** Deepest frame that contains the point and can take children (ignores `exclude` and their subtrees). */
export function frameAt(doc: SceneDoc, p: Point, exclude: Set<string> = new Set()): string | null {
  const visit = (parentId: string | null): string | null => {
    const kids = doc.children(parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = doc.get(kids[i])!;
      if (n.type !== 'FRAME' || !n.visible || n.locked || exclude.has(n.id)) continue;
      if (!insideBox(doc, n, p)) continue;
      return visit(n.id) ?? n.id;
    }
    return null;
  };
  return visit(null);
}

/** Nodes among `parentId`'s children touched by the marquee. Top-level frames must be fully inside. */
export function marqueeHits(doc: SceneDoc, rect: Rect, parentId: string | null): string[] {
  const out: string[] = [];
  for (const id of doc.children(parentId)) {
    const n = doc.get(id)!;
    if (!n.visible || n.locked) continue;
    const b = doc.worldBounds(id);
    if (n.type === 'FRAME' && parentId === null) {
      if (b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height)
        out.push(id);
    } else if (rectsIntersect(b, rect)) out.push(id);
  }
  return out;
}
