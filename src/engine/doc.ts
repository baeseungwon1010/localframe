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

/** The node tree of one page. Mutations go through set/remove/applyPatches so caches stay valid. */
export class SceneDoc {
  private nodes = new Map<string, SceneNode>();
  private childIndex: Map<string | null, string[]> | null = null;
  private worldCache = new Map<string, Mat>();
  version = 0;

  load(nodes: SceneNode[]) {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.touch();
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
    this.nodes.set(node.id, node);
    this.touch();
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

  /** Child ids of a parent (null = page), bottom-most first. */
  children(parentId: string | null): string[] {
    if (!this.childIndex) {
      const groups = new Map<string | null, SceneNode[]>();
      for (const n of this.nodes.values()) {
        const list = groups.get(n.parentId);
        if (list) list.push(n);
        else groups.set(n.parentId, [n]);
      }
      this.childIndex = new Map();
      for (const [k, list] of groups) this.childIndex.set(k, list.sort(byOrder).map((n) => n.id));
    }
    return this.childIndex.get(parentId) ?? [];
  }

  /** Ancestors from the top-level node down to the direct parent. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id);
    while (cur && cur.parentId !== null) {
      out.unshift(cur.parentId);
      cur = this.nodes.get(cur.parentId);
    }
    return out;
  }

  isAncestor(ancestorId: string, id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur && cur.parentId !== null) {
      if (cur.parentId === ancestorId) return true;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const c of this.children(pid)) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }

  depth(id: string): number {
    return this.ancestors(id).length;
  }

  /** World transform of a node (maps its local box to page coordinates). */
  world(id: string): Mat {
    const cached = this.worldCache.get(id);
    if (cached) return cached;
    const n = this.nodes.get(id);
    if (!n) return IDENTITY;
    const local = localMatrix(n.x, n.y, n.rotation);
    const m = n.parentId === null ? local : multiply(this.world(n.parentId), local);
    this.worldCache.set(id, m);
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
