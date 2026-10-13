import type { SceneNode } from '../../shared/schema.ts';
import {
  type Mat,
  type Point,
  type Rect,
  IDENTITY,
  apply,
  boundsOfPoints,
  localMatrix,
  multiply,
  rectCorners,
} from './math.ts';

export type Patch = { id: string; before: SceneNode | null; after: SceneNode | null };

function byOrder(a: SceneNode, b: SceneNode) {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const pageKey = (pageId: string) => `\u0000page:${pageId}`;

/**
 * All layers of a file. `children(null)` means the top level of the current page.
 * Mutations go through set/remove/applyPatches so caches stay valid.
 */
export class SceneDoc {
  private nodes = new Map<string, SceneNode>();
  private childIndex: Map<string, string[]> | null = null;
  private worldCache = new Map<string, Mat>();
  version = 0;
  /** First page: where top-level layers without a page live. */
  defaultPage = 'page-1';
  currentPage = 'page-1';

  load(nodes: SceneNode[], defaultPage = this.defaultPage) {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.defaultPage = defaultPage;
    this.currentPage = defaultPage;
    this.touch();
  }

  setCurrentPage(pageId: string) {
    this.currentPage = pageId;
    this.version++;
  }

  /** Page a layer is on (top-level layers carry it; children inherit). */
  pageOf(id: string): string {
    let cur = this.nodes.get(id);
    let guard = 0;
    while (cur && cur.parentId !== null && guard++ < 10_000) cur = this.nodes.get(cur.parentId);
    return cur?.pageId ?? this.defaultPage;
  }

  /** Top-level layers of a page, bottom-most first. */
  pageChildren(pageId: string): string[] {
    this.children(null);
    return this.childIndex!.get(pageKey(pageId)) ?? [];
  }

  private touch() {
    this.childIndex = null;
    this.worldCache.clear();
    this.version++;
  }

  get(id: string): SceneNode | undefined {
    return this.nodes.get(id);
  }

  has(id: string) {
    return this.nodes.has(id);
  }

  all(): IterableIterator<SceneNode> {
    return this.nodes.values();
  }

  get size() {
    return this.nodes.size;
  }

  set(node: SceneNode) {
    const prev = this.nodes.get(node.id);
    this.nodes.set(node.id, node);
    if (prev && prev.parentId === node.parentId && prev.order === node.order && prev.pageId === node.pageId) {
      // same place in the tree: only positions may have changed
      this.worldCache.clear();
      this.version++;
    } else this.touch();
  }

  remove(id: string) {
    if (this.nodes.delete(id)) this.touch();
  }

  applyPatches(patches: Patch[], reverse = false) {
    const list = reverse ? [...patches].reverse() : patches;
    for (const p of list) {
      const next = reverse ? p.before : p.after;
      if (next) this.nodes.set(p.id, next);
      else this.nodes.delete(p.id);
    }
    this.touch();
  }

  /** Child ids of a parent (null = top level of the current page), bottom-most first. */
  children(parentId: string | null): string[] {
    if (!this.childIndex) {
      const groups = new Map<string, SceneNode[]>();
      for (const n of this.nodes.values()) {
        const key = n.parentId ?? pageKey(n.pageId ?? this.defaultPage);
        const list = groups.get(key);
        if (list) list.push(n);
        else groups.set(key, [n]);
      }
      this.childIndex = new Map();
      for (const [k, list] of groups) this.childIndex.set(k, list.sort(byOrder).map((n) => n.id));
    }
    return this.childIndex.get(parentId ?? pageKey(this.currentPage)) ?? [];
  }

  /** Ancestors from the top-level node down to the direct parent. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id);
    while (cur && cur.parentId !== null && out.length <= 10_000) {
      out.push(cur.parentId);
      cur = this.nodes.get(cur.parentId);
    }
    return out.reverse();
  }

  isAncestor(ancestorId: string, id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur && cur.parentId !== null) {
      if (cur.parentId === ancestorId) return true;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  /** All nodes under `id`, depth first (iterative, so deep trees cannot overflow the stack). */
  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...this.children(id)].reverse();
    while (stack.length) {
      const c = stack.pop()!;
      out.push(c);
      const kids = this.children(c);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  depth(id: string): number {
    return this.ancestors(id).length;
  }

  /** World transform of a node (maps its local box to page coordinates). */
  world(id: string): Mat {
    const cached = this.worldCache.get(id);
    if (cached) return cached;
    // Collect the uncached ancestors, then compose top-down (no recursion).
    const chain: SceneNode[] = [];
    let cur = this.nodes.get(id);
    let base: Mat = IDENTITY;
    const seen = new Set<string>();
    while (cur) {
      const c = this.worldCache.get(cur.id);
      if (c) {
        base = c;
        break;
      }
      if (seen.has(cur.id)) break; // a cycle; never valid, but don't hang
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId === null ? undefined : this.nodes.get(cur.parentId);
    }
    if (chain.length === 0) return base;
    let m = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      m = multiply(m, localMatrix(n.x, n.y, n.rotation));
      this.worldCache.set(n.id, m);
    }
    return m;
  }

  parentWorld(node: SceneNode): Mat {
    return node.parentId === null ? IDENTITY : this.world(node.parentId);
  }

  worldCorners(id: string): Point[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    const m = this.world(id);
    return rectCorners({ x: 0, y: 0, width: n.width, height: n.height }).map((p) => apply(m, p));
  }

  /** Axis-aligned world bounds of the node's box (lines: their two end points). */
  worldBounds(id: string): Rect {
    const n = this.nodes.get(id);
    if (!n) return { x: 0, y: 0, width: 0, height: 0 };
    if (n.type === 'LINE') {
      const m = this.world(id);
      return boundsOfPoints([apply(m, { x: 0, y: 0 }), apply(m, { x: n.width, y: 0 })]);
    }
    return boundsOfPoints(this.worldCorners(id));
  }

  isEffectivelyVisible(id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parentId === null ? undefined : this.nodes.get(cur.parentId);
    }
    return true;
  }

  isEffectivelyLocked(id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.locked) return true;
      cur = cur.parentId === null ? undefined : this.nodes.get(cur.parentId);
    }
    return false;
  }
}
