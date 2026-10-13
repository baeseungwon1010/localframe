import type { NodeType, SceneNode } from '../../shared/schema.ts';
import { SceneDoc, type Patch } from './doc.ts';
import {
  type Handle,
  type Guide,
  HANDLES,
  HANDLE_POS,
  applyBox,
  applyConstraints,
  lineEnds,
  lineFromEnds,
  reparentKeepWorld,
  resizeBox,
  rotateAboutCenter,
  snapAngle,
  snapRect,
} from './geometry.ts';
import { frameAt, hitDeepest, marqueeHits, pickTarget } from './hit.ts';
import {
  type Mat,
  type Point,
  type Rect,
  DEG,
  IDENTITY,
  apply,
  applyVector,
  boundsOfPoints,
  clamp,
  invert,
  localMatrix,
  multiply,
  rectsIntersect,
  round2,
  unionRects,
} from './math.ts';
import { canHaveChildren, createNode, keyAt, keyOnTop, keysAbove, keysOnTop, newId, nextName } from './nodes.ts';
import { layoutText } from './text.ts';

export type Tool = 'move' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text';
export type Viewport = { x: number; y: number; zoom: number };
export type Channel = 'doc' | 'selection' | 'view' | 'tool';

export type PointerInput = {
  sx: number;
  sy: number;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
};

export type KeyInput = { code: string; key: string; shift: boolean; alt: boolean; mod: boolean; repeat: boolean };

export type SelectionHandle =
  | { kind: 'resize'; handle: Handle }
  | { kind: 'rotate'; handle: Handle }
  | { kind: 'line-end'; end: 0 | 1 };

type HistoryEntry = { patches: Patch[]; selBefore: string[]; selAfter: string[] };

type Interaction =
  | { kind: 'none' }
  | { kind: 'pan'; start: Point; vp: Viewport }
  | {
      kind: 'pending';
      start: Point;
      startScreen: Point;
      target: string | null;
      wasSelected: boolean;
      shift: boolean;
      scope: string | null;
    }
  | { kind: 'move'; start: Point; ids: string[]; originals: Map<string, SceneNode>; bounds: Rect }
  | { kind: 'marquee'; start: Point; current: Point; scope: string | null; base: string[]; shift: boolean }
  | { kind: 'resize'; start: Point; handle: Handle; originals: Map<string, SceneNode>; ids: string[]; bounds: Rect }
  | { kind: 'rotate'; start: Point; id: string; original: SceneNode; center: Point }
  | { kind: 'line-end'; id: string; end: 0 | 1; original: SceneNode }
  | { kind: 'create'; tool: Tool; start: Point; startScreen: Point; nodeId: string | null; parentId: string | null };

const DRAG_THRESHOLD = 3; // screen px
const HANDLE_HIT = 6; // screen px
const ROTATE_ZONE = 16; // screen px beyond a corner
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

const TOOL_TYPE: Partial<Record<Tool, NodeType>> = {
  frame: 'FRAME',
  rect: 'RECTANGLE',
  ellipse: 'ELLIPSE',
  line: 'LINE',
  arrow: 'LINE',
  text: 'TEXT',
};

const CLIP_PREFIX = 'localframe-clipboard:';

export class Editor {
  readonly doc = new SceneDoc();
  tool: Tool = 'move';
  selection: string[] = [];
  hover: string | null = null;
  viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  viewSize = { width: 800, height: 600 };
  editingText: string | null = null;
  guides: Guide[] = [];
  dropTarget: string | null | undefined = undefined; // undefined = no drop in progress
  marquee: Rect | null = null;
  sizeBadge: { text: string; at: Point } | null = null;
  spaceDown = false;
  background = '#F3F3F1';

  private interaction: Interaction = { kind: 'none' };
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private tx: Map<string, SceneNode | null> | null = null;
  private txSelBefore: string[] = [];
  private listeners = new Map<Channel, Set<() => void>>();
  private commitListeners = new Set<(patches: Patch[]) => void>();
  readonly revs: Record<Channel, number> = { doc: 0, selection: 0, view: 0, tool: 0 };

  // ---------------------------------------------------------------- events

  subscribe(channel: Channel, fn: () => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Called with the patches of every committed change, undo and redo included. */
  onCommit(fn: (patches: Patch[]) => void): () => void {
    this.commitListeners.add(fn);
    return () => this.commitListeners.delete(fn);
  }

  emit(...channels: Channel[]) {
    for (const c of channels) {
      this.revs[c]++;
      this.listeners.get(c)?.forEach((fn) => fn());
    }
  }

  load(nodes: SceneNode[], background: string) {
    this.doc.load(nodes);
    this.background = background;
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit('doc', 'selection', 'view');
  }

  // ------------------------------------------------------------ coordinates

  toWorld(sx: number, sy: number): Point {
    const v = this.viewport;
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }

  toScreen(p: Point): Point {
    const v = this.viewport;
    return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
  }

  get viewMatrix(): Mat {
    const v = this.viewport;
    return [v.zoom, 0, 0, v.zoom, v.x, v.y];
  }

  setViewSize(width: number, height: number) {
    this.viewSize = { width, height };
    this.emit('view');
  }

  setViewport(vp: Viewport) {
    this.viewport = { x: vp.x, y: vp.y, zoom: clamp(vp.zoom, MIN_ZOOM, MAX_ZOOM) };
    this.emit('view');
  }

  zoomAt(factor: number, sx: number, sy: number) {
    const v = this.viewport;
    const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const w = this.toWorld(sx, sy);
    this.setViewport({ zoom, x: sx - w.x * zoom, y: sy - w.y * zoom });
  }

  zoomToRect(r: Rect | null, maxZoom = 1, padding = 64) {
    if (!r) return this.setViewport({ x: this.viewSize.width / 2, y: this.viewSize.height / 2, zoom: 1 });
    const { width, height } = this.viewSize;
    const zoom = clamp(
      Math.min((width - padding * 2) / Math.max(r.width, 1), (height - padding * 2) / Math.max(r.height, 1), maxZoom),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.setViewport({
      zoom,
      x: width / 2 - (r.x + r.width / 2) * zoom,
      y: height / 2 - (r.y + r.height / 2) * zoom,
    });
  }

  contentBounds(): Rect | null {
    return unionRects(this.doc.children(null).filter((id) => this.doc.get(id)!.visible).map((id) => this.doc.worldBounds(id)));
  }

  zoomToFit() {
    this.zoomToRect(this.contentBounds(), 1);
  }

  zoomToSelection() {
    if (this.selection.length === 0) return this.zoomToFit();
    this.zoomToRect(this.selectionBounds(), 4);
  }

  zoomTo(zoom: number) {
    this.zoomAt(zoom / this.viewport.zoom, this.viewSize.width / 2, this.viewSize.height / 2);
  }

  // ------------------------------------------------------------- selection

  setSelection(ids: string[]) {
    const next = [...new Set(ids)].filter((id) => this.doc.has(id));
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.emit('selection', 'view');
  }

  selectedNodes(): SceneNode[] {
    return this.selection.map((id) => this.doc.get(id)!).filter(Boolean);
  }

  selectionBounds(): Rect | null {
    return unionRects(this.selection.map((id) => this.doc.worldBounds(id)));
  }

  setHover(id: string | null) {
    if (this.hover === id) return;
    this.hover = id;
    this.emit('view');
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.emit('tool', 'view');
  }

  // ----------------------------------------------------------- transactions

  private begin() {
    if (this.tx) return;
    this.tx = new Map();
    this.txSelBefore = [...this.selection];
  }

  private record(id: string) {
    if (this.tx && !this.tx.has(id)) this.tx.set(id, this.doc.get(id) ?? null);
  }

  /** Writes a node inside the current transaction. */
  put(node: SceneNode) {
    this.record(node.id);
    this.doc.set(node);
  }

  private drop(id: string) {
    this.record(id);
    this.doc.remove(id);
  }

  private end(): Patch[] {
    const tx = this.tx;
    this.tx = null;
    if (!tx) return [];
    const patches: Patch[] = [];
    for (const [id, before] of tx) {
      const after = this.doc.get(id) ?? null;
      if (before === after) continue;
      if (before && after && JSON.stringify(before) === JSON.stringify(after)) continue;
      patches.push({ id, before, after });
    }
    this.setSelection(this.selection.filter((id) => this.doc.has(id)));
    if (patches.length > 0) {
      this.undoStack.push({ patches, selBefore: this.txSelBefore, selAfter: [...this.selection] });
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
      this.commitListeners.forEach((fn) => fn(patches));
    }
    this.emit('doc', 'view');
    return patches;
  }

  private abort() {
    const tx = this.tx;
    this.tx = null;
    if (!tx) return;
    for (const [id, before] of tx) {
      if (before) this.doc.set(before);
      else this.doc.remove(id);
    }
    this.selection = this.txSelBefore.filter((id) => this.doc.has(id));
    this.emit('doc', 'selection', 'view');
  }

  /** Runs `fn` as one undoable step. */
  transact(fn: () => void) {
    const nested = this.tx !== null;
    this.begin();
    fn();
    if (!nested) this.end();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.interaction.kind !== 'none') return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.doc.applyPatches(entry.patches, true);
    this.redoStack.push(entry);
    this.selection = entry.selBefore.filter((id) => this.doc.has(id));
    this.commitListeners.forEach((fn) => fn(entry.patches));
    this.emit('doc', 'selection', 'view');
  }

  redo() {
    if (this.interaction.kind !== 'none') return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.doc.applyPatches(entry.patches);
    this.undoStack.push(entry);
    this.selection = entry.selAfter.filter((id) => this.doc.has(id));
    this.commitListeners.forEach((fn) => fn(entry.patches));
    this.emit('doc', 'selection', 'view');
  }

  // ---------------------------------------------------------- node updates

  /** Applies `fn` to each id as one undo step. */
  updateNodes(ids: string[], fn: (n: SceneNode) => SceneNode) {
    this.transact(() => {
      for (const id of ids) {
        const n = this.doc.get(id);
        if (n) this.put(fitText(fn(n)));
      }
    });
  }

  rename(id: string, name: string) {
    const trimmed = name.trim().slice(0, 500);
    if (!trimmed) return;
    this.updateNodes([id], (n) => ({ ...n, name: trimmed }));
  }

  /** Resizes a frame from the properties panel, applying its children's constraints. */
  setSize(id: string, width: number | null, height: number | null, keepAspect: boolean) {
    this.transact(() => {
      const n = this.doc.get(id);
      if (!n) return;
      let w = width ?? n.width;
      let h = height ?? n.height;
      if (keepAspect && n.width > 0 && n.height > 0) {
        if (width !== null && height === null) h = (n.height * w) / n.width;
        if (height !== null && width === null) w = (n.width * h) / n.height;
      }
      w = Math.max(0.01, round2(w));
      h = n.type === 'LINE' ? 0 : Math.max(0.01, round2(h));
      let next: SceneNode = { ...n, width: w, height: h };
      if (n.type === 'TEXT' && width !== null && n.text!.autoResize === 'width') {
        next = { ...next, text: { ...n.text!, autoResize: 'height' } };
      }
      if (n.type === 'TEXT' && height !== null) next = { ...next, text: { ...next.text!, autoResize: 'none' } };
      this.put(fitText(next));
      if (n.type === 'FRAME') this.applyFrameConstraints(n, n.width, n.height, w, h);
    });
  }

  private applyFrameConstraints(frame: SceneNode, w0: number, h0: number, w1: number, h1: number) {
    const kids = this.doc.children(frame.id).map((id) => this.doc.get(id)!);
    const next = applyConstraints(kids, w0, h0, w1, h1);
    next.forEach((c, i) => {
      const before = kids[i];
      this.put(fitText(c));
      if (c.type === 'FRAME' && (c.width !== before.width || c.height !== before.height)) {
        this.applyFrameConstraints(c, before.width, before.height, c.width, c.height);
      }
    });
  }

  setRotation(ids: string[], rotation: number) {
    this.updateNodes(ids, (n) => rotateAboutCenter(n, rotation));
  }

  // ------------------------------------------------------------- structure

  deleteSelection() {
    if (this.selection.length === 0) return;
    this.transact(() => {
      for (const id of this.selection) {
        if (!this.doc.has(id)) continue;
        for (const d of this.doc.descendants(id)) this.drop(d);
        this.drop(id);
      }
      this.selection = [];
    });
    this.emit('selection');
  }

  /** Top-most selected ids (drops ids whose ancestor is also selected), in tree order. */
  private selectionRoots(): string[] {
    const set = new Set(this.selection);
    return this.selection.filter((id) => !this.doc.ancestors(id).some((a) => set.has(a)));
  }

  private cloneSubtree(rootId: string, parentId: string | null, order: string, map: Map<string, string>): SceneNode[] {
    const out: SceneNode[] = [];
    const walk = (id: string, pid: string | null, ord: string) => {
      const n = this.doc.get(id)!;
      const nid = newId();
      map.set(id, nid);
      out.push({ ...n, id: nid, parentId: pid, order: ord });
      for (const c of this.doc.children(id)) walk(c, nid, this.doc.get(c)!.order);
    };
    walk(rootId, parentId, order);
    return out;
  }

  duplicateSelection(offset?: Point) {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    this.transact(() => {
      const created: string[] = [];
      for (const id of roots) {
        const n = this.doc.get(id)!;
        const map = new Map<string, string>();
        const clones = this.cloneSubtree(id, n.parentId, keyOnTop(this.doc, n.parentId), map);
        const root = clones[0];
        let dx = offset?.x ?? 0;
        let dy = offset?.y ?? 0;
        if (!offset && n.parentId === null && n.type === 'FRAME') dx = n.width + 40; // place new frames beside
        clones[0] = { ...root, x: round2(root.x + dx), y: round2(root.y + dy) };
        for (const c of clones) this.put(c);
        created.push(clones[0].id);
      }
      this.selection = created;
    });
    this.emit('selection');
  }

  copyToText(): string | null {
    const roots = this.selectionRoots();
    if (roots.length === 0) return null;
    const nodes: SceneNode[] = [];
    for (const id of roots) {
      const n = this.doc.get(id)!;
      // Roots are stored in page coordinates so they can be pasted into any parent.
      nodes.push({ ...reparentKeepWorld(n, this.doc.parentWorld(n), IDENTITY), parentId: null });
      for (const d of this.doc.descendants(id)) nodes.push(this.doc.get(d)!);
    }
    return CLIP_PREFIX + JSON.stringify({ roots, nodes });
  }

  cutToText(): string | null {
    const text = this.copyToText();
    if (text) this.deleteSelection();
    return text;
  }

  pasteText(text: string) {
    if (text.startsWith(CLIP_PREFIX)) {
      let data: { roots: string[]; nodes: SceneNode[] };
      try {
        data = JSON.parse(text.slice(CLIP_PREFIX.length));
      } catch {
        return;
      }
      if (!Array.isArray(data.roots) || !Array.isArray(data.nodes)) return;
      this.pasteNodes(data.roots, data.nodes);
      return;
    }
    const plain = text.slice(0, 20_000);
    if (!plain.trim()) return;
    // Plain text becomes a text layer in the middle of the view.
    const c = this.toWorld(this.viewSize.width / 2, this.viewSize.height / 2);
    this.transact(() => {
      const node = createNode(this.doc, 'TEXT', null, { x: round2(c.x), y: round2(c.y), width: 10, height: 10 });
      const t = fitText({ ...node, text: { ...node.text!, characters: plain } });
      this.put(t);
      this.selection = [t.id];
    });
    this.emit('selection');
  }

  private pasteNodes(roots: string[], nodes: SceneNode[]) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const sel = this.selectedNodes();
    let parentId: string | null = null;
    if (sel.length === 1 && canHaveChildren(sel[0]) && !roots.includes(sel[0].id)) parentId = sel[0].id;
    else if (sel.length > 0) parentId = sel[0].parentId;
    const parentWorld = parentId === null ? IDENTITY : this.doc.world(parentId);
    this.transact(() => {
      const keys = keysOnTop(this.doc, parentId, roots.length);
      const created: string[] = [];
      const children = new Map<string, SceneNode[]>();
      for (const n of nodes) {
        if (n.parentId === null) continue;
        const list = children.get(n.parentId);
        if (list) list.push(n);
        else children.set(n.parentId, [n]);
      }
      roots.forEach((rid, i) => {
        const root = byId.get(rid);
        if (!root) return;
        const map = new Map<string, string>();
        const walk = (n: SceneNode, pid: string | null, order: string, isRoot: boolean) => {
          const nid = newId();
          map.set(n.id, nid);
          const placed = isRoot ? reparentKeepWorld(n, IDENTITY, parentWorld) : n;
          this.put({ ...placed, id: nid, parentId: pid, order });
          for (const c of children.get(n.id) ?? []) walk(c, nid, c.order, false);
        };
        walk(root, parentId, keys[i], true);
        created.push(map.get(rid)!);
      });
      this.selection = created;
    });
    this.emit('selection');
  }

  selectAll() {
    const first = this.selectedNodes()[0];
    const parent = first ? first.parentId : null;
    this.setSelection(this.doc.children(parent).filter((id) => {
      const n = this.doc.get(id)!;
      return n.visible && !n.locked;
    }));
  }

  /** Moves nodes in the tree (layers panel). `index` counts from the bottom of the target's children. */
  moveInTree(ids: string[], parentId: string | null, index: number) {
    if (parentId !== null && (!canHaveChildren(this.doc.get(parentId)) || ids.some((id) => id === parentId || this.doc.isAncestor(id, parentId))))
      return;
    const moving = new Set(ids);
    const siblings = this.doc.children(parentId);
    // index is in the full sibling list; convert to the list without the moving nodes
    const before = siblings.slice(0, index).filter((id) => !moving.has(id)).length;
    const newParentWorld = parentId === null ? IDENTITY : this.doc.world(parentId);
    this.transact(() => {
      let at = before;
      for (const id of ids) {
        const n = this.doc.get(id);
        if (!n) continue;
        const order = keyAt(this.doc, this.doc.children(parentId), at, moving);
        const placed = n.parentId === parentId ? n : reparentKeepWorld(n, this.doc.parentWorld(n), newParentWorld);
        this.put({ ...placed, parentId, order });
        moving.delete(id);
        at++;
      }
    });
  }

  /** Bring forward / send backward (one step) or to front / back. */
  reorder(direction: 'forward' | 'backward' | 'front' | 'back') {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    this.transact(() => {
      const ordered = direction === 'forward' || direction === 'front' ? [...roots].reverse() : roots;
      for (const id of ordered) {
        const n = this.doc.get(id)!;
        const sibs = this.doc.children(n.parentId);
        const i = sibs.indexOf(id);
        let target: number;
        if (direction === 'front') target = sibs.length;
        else if (direction === 'back') target = 0;
        else if (direction === 'forward') target = Math.min(sibs.length, i + 2);
        else target = Math.max(0, i - 1);
        const order = keyAt(this.doc, sibs, target - (target > i ? 1 : 0), new Set([id]));
        this.put({ ...n, order });
      }
    });
  }

  toggleVisible(ids = this.selection) {
    const nodes = ids.map((id) => this.doc.get(id)!).filter(Boolean);
    const hide = nodes.some((n) => n.visible);
    this.updateNodes(ids, (n) => ({ ...n, visible: !hide }));
  }

  toggleLocked(ids = this.selection) {
    const nodes = ids.map((id) => this.doc.get(id)!).filter(Boolean);
    const lock = nodes.some((n) => !n.locked);
    this.updateNodes(ids, (n) => ({ ...n, locked: lock }));
    if (lock) this.setSelection([]);
  }

  /** Wraps the selection in a new frame that fits it (Ctrl/Cmd+Alt+G). */
  wrapInFrame() {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    const parentId = this.doc.get(roots[0])!.parentId;
    if (roots.some((id) => this.doc.get(id)!.parentId !== parentId)) return;
    const b = unionRects(roots.map((id) => this.doc.worldBounds(id)))!;
    const parentWorld = parentId === null ? IDENTITY : this.doc.world(parentId);
    const origin = apply(invert(parentWorld), { x: b.x, y: b.y });
    this.transact(() => {
      const sibs = this.doc.children(parentId);
      const topIndex = Math.max(...roots.map((id) => sibs.indexOf(id))) + 1;
      const frame = {
        ...createNode(this.doc, 'FRAME', parentId, {
          x: round2(origin.x),
          y: round2(origin.y),
          width: Math.max(1, round2(b.width)),
          height: Math.max(1, round2(b.height)),
        }),
        order: keyAt(this.doc, sibs, topIndex),
        fills: [],
        clipsContent: false,
      };
      this.put(frame);
      const frameWorld = multiply(parentWorld, localMatrix(frame.x, frame.y, 0));
      const keys = keysOnTop(this.doc, frame.id, roots.length);
      roots
        .slice()
        .sort((a, c) => sibs.indexOf(a) - sibs.indexOf(c))
        .forEach((id, i) => {
          const n = this.doc.get(id)!;
          this.put({ ...reparentKeepWorld(n, parentWorld, frameWorld), parentId: frame.id, order: keys[i] });
        });
      this.selection = [frame.id];
    });
    this.emit('selection');
  }

  /** Removes the selected frames and keeps their contents in place (Ctrl/Cmd+Shift+G). */
  unwrapFrames() {
    const frames = this.selectionRoots().filter((id) => this.doc.get(id)!.type === 'FRAME');
    if (frames.length === 0) return;
    this.transact(() => {
      const released: string[] = [];
      for (const fid of frames) {
        const f = this.doc.get(fid)!;
        const kids = this.doc.children(fid);
        const frameWorld = this.doc.world(fid);
        const parentWorld = this.doc.parentWorld(f);
        const keys = kids.length ? keysAbove(this.doc, fid, kids.length) : [];
        kids.forEach((cid, i) => {
          const c = this.doc.get(cid)!;
          this.put({ ...reparentKeepWorld(c, frameWorld, parentWorld), parentId: f.parentId, order: keys[i] });
          released.push(cid);
        });
        this.drop(fid);
      }
      this.selection = released;
    });
    this.emit('selection');
  }

  /** Aligns selected nodes to their common bounds (or a single node to its parent frame). */
  align(op: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    let target: Rect | null;
    if (roots.length === 1) {
      const n = this.doc.get(roots[0])!;
      if (n.parentId === null) return;
      target = this.doc.worldBounds(n.parentId);
    } else target = unionRects(roots.map((id) => this.doc.worldBounds(id)));
    if (!target) return;
    this.transact(() => {
      for (const id of roots) {
        const n = this.doc.get(id)!;
        const b = this.doc.worldBounds(id);
        let dx = 0;
        let dy = 0;
        if (op === 'left') dx = target!.x - b.x;
        if (op === 'hcenter') dx = target!.x + target!.width / 2 - (b.x + b.width / 2);
        if (op === 'right') dx = target!.x + target!.width - (b.x + b.width);
        if (op === 'top') dy = target!.y - b.y;
        if (op === 'vcenter') dy = target!.y + target!.height / 2 - (b.y + b.height / 2);
        if (op === 'bottom') dy = target!.y + target!.height - (b.y + b.height);
        const d = applyVector(invert(this.doc.parentWorld(n)), { x: dx, y: dy });
        this.put({ ...n, x: round2(n.x + d.x), y: round2(n.y + d.y) });
      }
    });
  }

  /** Spreads 3+ nodes so the gaps between them are equal. */
  distribute(axis: 'x' | 'y') {
    const roots = this.selectionRoots();
    if (roots.length < 3) return;
    const items = roots.map((id) => ({ id, b: this.doc.worldBounds(id) }));
    items.sort((a, c) => (axis === 'x' ? a.b.x - c.b.x : a.b.y - c.b.y));
    const size = (r: Rect) => (axis === 'x' ? r.width : r.height);
    const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
    const first = items[0].b;
    const last = items[items.length - 1].b;
    const total = start(last) + size(last) - start(first);
    const gap = (total - items.reduce((s, it) => s + size(it.b), 0)) / (items.length - 1);
    this.transact(() => {
      let cursor = start(first);
      for (const it of items) {
        const delta = cursor - start(it.b);
        const n = this.doc.get(it.id)!;
        const d = applyVector(invert(this.doc.parentWorld(n)), axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta });
        this.put({ ...n, x: round2(n.x + d.x), y: round2(n.y + d.y) });
        cursor += size(it.b) + gap;
      }
    });
  }

  nudge(dx: number, dy: number) {
    const roots = this.selectionRoots();
    this.transact(() => {
      for (const id of roots) {
        const n = this.doc.get(id)!;
        const d = applyVector(invert(this.doc.parentWorld(n)), { x: dx, y: dy });
        this.put({ ...n, x: round2(n.x + d.x), y: round2(n.y + d.y) });
      }
    });
  }

  // ----------------------------------------------------------- text editing

  startTextEdit(id: string) {
    const n = this.doc.get(id);
    if (!n || n.type !== 'TEXT' || this.doc.isEffectivelyLocked(id)) return;
    this.editingText = id;
    this.setSelection([id]);
    this.emit('view', 'tool');
  }

  /** Ends editing. Empty text removes the layer. Joins the creation step if the layer was just created. */
  commitTextEdit(characters: string) {
    const id = this.editingText;
    if (!id) return;
    this.editingText = null;
    const n = this.doc.get(id);
    if (n) {
      this.transact(() => {
        if (characters.trim() === '') {
          this.drop(id);
          this.selection = [];
        } else this.put(fitText({ ...n, text: { ...n.text!, characters } }));
      });
      this.mergeLastTwoIfSameNode(id);
    }
    this.emit('view', 'tool', 'selection');
  }

  private pendingTextCreate: string | null = null;

  /** A text layer created and typed into is one undo step, not two. */
  private mergeLastTwoIfSameNode(id: string) {
    if (this.pendingTextCreate !== id) return;
    this.pendingTextCreate = null;
    const last = this.undoStack.pop();
    const prev = this.undoStack.pop();
    if (!last || !prev) {
      if (prev) this.undoStack.push(prev);
      if (last) this.undoStack.push(last);
      return;
    }
    const before = new Map<string, SceneNode | null>();
    const after = new Map<string, SceneNode | null>();
    for (const p of [...prev.patches, ...last.patches]) {
      if (!before.has(p.id)) before.set(p.id, p.before);
      after.set(p.id, p.after);
    }
    const patches = [...before.keys()]
      .map((pid) => ({ id: pid, before: before.get(pid)!, after: after.get(pid)! }))
      .filter((p) => p.before !== null || p.after !== null);
    if (patches.length) this.undoStack.push({ patches, selBefore: prev.selBefore, selAfter: last.selAfter });
  }

  // ------------------------------------------------------------- handles

  private hitTolerance() {
    return 4 / this.viewport.zoom;
  }

  /** Screen positions of the selection handles. */
  handlePositions(): { handle: SelectionHandle; at: Point }[] {
    const sel = this.selectedNodes();
    if (sel.length === 0 || this.editingText) return [];
    if (sel.length === 1 && sel[0].type === 'LINE') {
      const m = multiply(this.viewMatrix, this.doc.world(sel[0].id));
      return [
        { handle: { kind: 'line-end', end: 0 }, at: apply(m, { x: 0, y: 0 }) },
        { handle: { kind: 'line-end', end: 1 }, at: apply(m, { x: sel[0].width, y: 0 }) },
      ];
    }
    const { m, w, h } = this.selectionFrame();
    return HANDLES.map((handle) => ({
      handle: { kind: 'resize' as const, handle },
      at: apply(m, { x: HANDLE_POS[handle].x * w, y: HANDLE_POS[handle].y * h }),
    }));
  }

  /** Screen matrix and size of the selection box (rotated for one node, axis-aligned for many). */
  selectionFrame(): { m: Mat; w: number; h: number } {
    const sel = this.selectedNodes();
    if (sel.length === 1) {
      return { m: multiply(this.viewMatrix, this.doc.world(sel[0].id)), w: sel[0].width, h: sel[0].height };
    }
    const b = this.selectionBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return { m: multiply(this.viewMatrix, [1, 0, 0, 1, b.x, b.y]), w: b.width, h: b.height };
  }

  handleAt(sx: number, sy: number): SelectionHandle | null {
    const handles = this.handlePositions();
    for (const { handle, at } of handles) {
      if (Math.abs(at.x - sx) <= HANDLE_HIT && Math.abs(at.y - sy) <= HANDLE_HIT) return handle;
    }
    // rotation zones just outside the corners (single, non-line node)
    const sel = this.selectedNodes();
    if (sel.length === 1 && sel[0].type !== 'LINE') {
      const { m, w, h } = this.selectionFrame();
      const center = apply(m, { x: w / 2, y: h / 2 });
      for (const corner of ['nw', 'ne', 'se', 'sw'] as Handle[]) {
        const at = apply(m, { x: HANDLE_POS[corner].x * w, y: HANDLE_POS[corner].y * h });
        const d = Math.hypot(sx - at.x, sy - at.y);
        const outward = (sx - at.x) * (at.x - center.x) + (sy - at.y) * (at.y - center.y) > 0;
        if (d <= ROTATE_ZONE && d > HANDLE_HIT && outward) return { kind: 'rotate', handle: corner };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  pointerDown(e: PointerInput) {
    if (this.editingText) return;
    const p = this.toWorld(e.sx, e.sy);
    if (e.button === 1 || (e.button === 0 && (this.tool === 'hand' || this.spaceDown))) {
      this.interaction = { kind: 'pan', start: { x: e.sx, y: e.sy }, vp: { ...this.viewport } };
      return;
    }
    if (e.button !== 0) return;

    if (TOOL_TYPE[this.tool]) {
      const parentId = frameAt(this.doc, p);
      this.interaction = {
        kind: 'create',
        tool: this.tool,
        start: this.snapPoint(p, new Set()),
        startScreen: { x: e.sx, y: e.sy },
        nodeId: null,
        parentId,
      };
      return;
    }

    // move tool
    const handle = this.handleAt(e.sx, e.sy);
    if (handle) return this.startHandleDrag(handle, p);

    const deepest = hitDeepest(this.doc, p, this.hitTolerance());
    let target: string | null = null;
    if (deepest) target = e.mod ? deepest : pickTarget(this.doc, deepest, this.selection);
    // Clicking inside the current selection box keeps the selection (so it can be dragged).
    if (!e.shift && this.selection.length > 1) {
      const b = this.selectionBounds();
      if (b && p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height) {
        if (!target || !this.selection.includes(target)) target = this.selection[0];
      }
    }
    // Dragging on the empty area of a top-level frame with children draws a marquee.
    if (target) {
      const t = this.doc.get(target)!;
      if (t.type === 'FRAME' && t.parentId === null && !this.selection.includes(target) && this.doc.children(target).length > 0 && deepest === target) {
        this.interaction = {
          kind: 'pending',
          start: p,
          startScreen: { x: e.sx, y: e.sy },
          target,
          wasSelected: false,
          shift: e.shift,
          scope: target,
        };
        return;
      }
    }
    const wasSelected = target !== null && this.selection.includes(target);
    if (target && !wasSelected) {
      this.setSelection(e.shift ? [...this.selection, target] : [target]);
    }
    if (!target && !e.shift) this.setSelection([]);
    this.interaction = {
      kind: 'pending',
      start: p,
      startScreen: { x: e.sx, y: e.sy },
      target,
      wasSelected,
      shift: e.shift,
      scope: null,
    };
  }

  private startHandleDrag(handle: SelectionHandle, p: Point) {
    const sel = this.selectedNodes();
    this.begin();
    if (handle.kind === 'line-end') {
      this.interaction = { kind: 'line-end', id: sel[0].id, end: handle.end, original: sel[0] };
    } else if (handle.kind === 'rotate') {
      const n = sel[0];
      const center = apply(this.doc.world(n.id), { x: n.width / 2, y: n.height / 2 });
      this.interaction = { kind: 'rotate', start: p, id: n.id, original: n, center };
    } else {
      const ids = this.selectionRoots();
      const originals = new Map<string, SceneNode>();
      for (const id of ids) {
        originals.set(id, this.doc.get(id)!);
        for (const d of this.doc.descendants(id)) originals.set(d, this.doc.get(d)!);
      }
      this.interaction = {
        kind: 'resize',
        start: p,
        handle: handle.handle,
        originals,
        ids,
        bounds: this.selectionBounds()!,
      };
    }
  }

  pointerMove(e: PointerInput): void {
    const p = this.toWorld(e.sx, e.sy);
    const it = this.interaction;
    switch (it.kind) {
      case 'none': {
        if (this.tool === 'move' && !this.editingText && !this.spaceDown) {
          const deepest = hitDeepest(this.doc, p, this.hitTolerance());
          this.setHover(deepest ? (e.mod ? deepest : pickTarget(this.doc, deepest, this.selection)) : null);
        } else this.setHover(null);
        return;
      }
      case 'pan':
        this.setViewport({ ...it.vp, x: it.vp.x + e.sx - it.start.x, y: it.vp.y + e.sy - it.start.y });
        return;
      case 'pending': {
        if (Math.hypot(e.sx - it.startScreen.x, e.sy - it.startScreen.y) < DRAG_THRESHOLD) return;
        if (it.scope !== null || !it.target) {
          this.interaction = {
            kind: 'marquee',
            start: it.start,
            current: p,
            scope: it.scope,
            base: it.shift ? [...this.selection] : [],
            shift: it.shift,
          };
          if (!it.shift) this.setSelection([]);
          return this.pointerMove(e);
        }
        // Alt-drag: duplicate and move the copies, as one undo step
        this.begin();
        if (e.alt) this.duplicateSelection({ x: 0, y: 0 });
        this.startMove(it.start);
        if (this.interaction.kind !== 'move') {
          this.end();
          return;
        }
        return this.pointerMove(e);
      }
      case 'marquee': {
        it.current = p;
        const r = boundsOfPoints([it.start, p]);
        this.marquee = r;
        const hits = marqueeHits(this.doc, r, it.scope);
        this.setSelection(it.shift ? [...new Set([...it.base, ...hits])] : hits);
        this.emit('view');
        return;
      }
      case 'move':
        return this.updateMove(it, p, e);
      case 'resize':
        return this.updateResize(it, p, e);
      case 'rotate': {
        const a0 = Math.atan2(it.start.y - it.center.y, it.start.x - it.center.x);
        const a1 = Math.atan2(p.y - it.center.y, p.x - it.center.x);
        let rot = it.original.rotation + (a1 - a0) / DEG;
        if (e.shift) rot = Math.round(rot / 15) * 15;
        this.put(rotateAboutCenter(it.original, rot));
        this.sizeBadge = { text: `${Math.round(this.doc.get(it.id)!.rotation)}°`, at: { x: e.sx + 16, y: e.sy + 16 } };
        this.emit('doc', 'view');
        return;
      }
      case 'line-end': {
        const n = it.original;
        const toParent = invert(this.doc.parentWorld(n));
        const ends = lineEnds(n);
        const fixed = ends[1 - it.end];
        let moving = apply(toParent, this.snapPoint(p, new Set([n.id])));
        if (e.shift) moving = snapAngle(fixed, moving);
        const next = it.end === 1 ? lineFromEnds(n, fixed, moving) : lineFromEnds(n, moving, fixed);
        this.put(next);
        this.sizeBadge = { text: `${Math.round(next.width)}`, at: { x: e.sx + 16, y: e.sy + 16 } };
        this.emit('doc', 'view');
        return;
      }
      case 'create':
        return this.updateCreate(it, p, e);
    }
  }

  pointerUp(e: PointerInput) {
    const it = this.interaction;
    this.interaction = { kind: 'none' };
    this.guides = [];
    this.marquee = null;
    this.sizeBadge = null;
    switch (it.kind) {
      case 'pending':
        // a click (no drag) on a selected node in a multi-selection selects just that node
        if (it.target && it.wasSelected && !it.shift && it.scope === null) this.setSelection([it.target]);
        else if (it.target && it.wasSelected && it.shift) this.setSelection(this.selection.filter((id) => id !== it.target));
        else if (it.scope !== null) this.setSelection(it.shift ? [...this.selection, it.scope] : [it.scope]);
        break;
      case 'move': {
        this.finishMove(it);
        this.dropTarget = undefined;
        this.end();
        break;
      }
      case 'resize':
      case 'rotate':
      case 'line-end':
        this.end();
        break;
      case 'create':
        this.finishCreate(it, e);
        break;
    }
    this.emit('view');
  }

  /** Esc during a drag: put everything back. */
  cancelInteraction(): boolean {
    const it = this.interaction;
    if (it.kind === 'none') return false;
    this.interaction = { kind: 'none' };
    this.guides = [];
    this.marquee = null;
    this.sizeBadge = null;
    this.dropTarget = undefined;
    if (this.tx) this.abort();
    this.emit('view');
    return true;
  }

  get isInteracting() {
    return this.interaction.kind !== 'none';
  }

  get interactionKind() {
    return this.interaction.kind;
  }

  doubleClick(e: PointerInput) {
    if (this.tool !== 'move' || this.editingText) return;
    const p = this.toWorld(e.sx, e.sy);
    const deepest = hitDeepest(this.doc, p, this.hitTolerance());
    if (!deepest) return;
    const sel = this.selection.length === 1 ? this.selection[0] : null;
    if (sel) {
      const node = this.doc.get(sel)!;
      if (node.type === 'TEXT' && deepest === sel) return this.startTextEdit(sel);
      const chain = [...this.doc.ancestors(deepest), deepest];
      const idx = chain.indexOf(sel);
      if (idx >= 0 && idx < chain.length - 1) {
        const next = chain[idx + 1];
        this.setSelection([next]);
        return;
      }
    }
    const target = pickTarget(this.doc, deepest, this.selection);
    const t = this.doc.get(target)!;
    if (t.type === 'TEXT') this.startTextEdit(target);
    else this.setSelection([target]);
  }

  wheel(sx: number, sy: number, dx: number, dy: number, zoomGesture: boolean) {
    if (zoomGesture) {
      this.zoomAt(Math.exp(-dy * 0.01), sx, sy);
    } else {
      const v = this.viewport;
      this.setViewport({ ...v, x: v.x - dx, y: v.y - dy });
    }
  }

  // ---------------------------------------------------------------- move

  private startMove(start: Point) {
    const ids = this.selectionRoots().filter((id) => !this.doc.isEffectivelyLocked(id));
    if (ids.length === 0) return;
    const originals = new Map(ids.map((id) => [id, this.doc.get(id)!]));
    const bounds = unionRects(ids.map((id) => this.doc.worldBounds(id)))!;
    this.interaction = { kind: 'move', start, ids, originals, bounds };
    this.setHover(null);
  }

  private snapCandidates(exclude: Set<string>): Rect[] {
    const view: Rect = {
      ...this.toWorld(0, 0),
      width: this.viewSize.width / this.viewport.zoom,
      height: this.viewSize.height / this.viewport.zoom,
    };
    const out: Rect[] = [];
    const walk = (parentId: string | null) => {
      for (const id of this.doc.children(parentId)) {
        if (exclude.has(id)) continue;
        const n = this.doc.get(id)!;
        if (!n.visible) continue;
        const b = this.doc.worldBounds(id);
        if (rectsIntersect(b, view)) out.push(b);
        if (n.type === 'FRAME') walk(id);
      }
    };
    walk(null);
    return out;
  }

  private snapPoint(p: Point, exclude: Set<string>): Point {
    const s = snapRect({ x: p.x, y: p.y, width: 0, height: 0 }, this.snapCandidates(exclude), 6 / this.viewport.zoom);
    this.guides = s.guides;
    return { x: p.x + s.dx, y: p.y + s.dy };
  }

  private updateMove(it: Extract<Interaction, { kind: 'move' }>, p: Point, e: PointerInput) {
    let dx = p.x - it.start.x;
    let dy = p.y - it.start.y;
    if (e.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const exclude = new Set<string>();
    for (const id of it.ids) {
      exclude.add(id);
      for (const d of this.doc.descendants(id)) exclude.add(d);
    }
    const moved = { ...it.bounds, x: it.bounds.x + dx, y: it.bounds.y + dy };
    const snap = snapRect(moved, this.snapCandidates(exclude), 6 / this.viewport.zoom);
    if (!e.shift) {
      dx += snap.dx;
      dy += snap.dy;
      this.guides = snap.guides;
    } else this.guides = [];
    for (const id of it.ids) {
      const o = it.originals.get(id)!;
      const d = applyVector(invert(this.doc.parentWorld(o)), { x: dx, y: dy });
      this.put({ ...o, x: round2(o.x + d.x), y: round2(o.y + d.y) });
    }
    // drop target: the frame under the pointer
    const target = frameAt(this.doc, p, exclude);
    const parents = new Set(it.ids.map((id) => it.originals.get(id)!.parentId));
    this.dropTarget = parents.size === 1 && parents.has(target) ? undefined : target;
    this.emit('doc', 'view');
  }

  private finishMove(it: Extract<Interaction, { kind: 'move' }>) {
    const target = this.dropTarget;
    if (target === undefined) return;
    const targetWorld = target === null ? IDENTITY : this.doc.world(target);
    const keys = keysOnTop(this.doc, target, it.ids.length);
    it.ids.forEach((id, i) => {
      const n = this.doc.get(id)!;
      if (n.parentId === target) return;
      this.put({ ...reparentKeepWorld(n, this.doc.parentWorld(n), targetWorld), parentId: target, order: keys[i] });
    });
  }

  // -------------------------------------------------------------- resize

  private updateResize(it: Extract<Interaction, { kind: 'resize' }>, p: Point, e: PointerInput) {
    const delta = { x: p.x - it.start.x, y: p.y - it.start.y };
    const opts = { keepAspect: e.shift, fromCenter: e.alt };
    if (it.ids.length === 1) {
      const o = it.originals.get(it.ids[0])!;
      const world = multiply(this.doc.parentWorld(o), localMatrix(o.x, o.y, o.rotation));
      const local = applyVector(invert(world), delta);
      const keepAspect = opts.keepAspect;
      const box = resizeBox(o.width, o.height, it.handle, local, { ...opts, keepAspect });
      let next = applyBox(o, box);
      if (o.type === 'TEXT') {
        const horizontalOnly = it.handle === 'e' || it.handle === 'w';
        next = { ...next, text: { ...o.text!, autoResize: horizontalOnly ? 'height' : 'none' } };
        next = fitText(next);
      }
      // restore all descendants first so constraints start from the originals
      for (const [id, orig] of it.originals) if (id !== o.id) this.put(orig);
      this.put(next);
      if (o.type === 'FRAME') {
        if (e.mod) {
          // Ctrl/Cmd: children stay where they are on the page
          const oldWorld = world;
          const newWorld = multiply(this.doc.parentWorld(o), localMatrix(next.x, next.y, next.rotation));
          for (const cid of this.doc.children(o.id)) {
            const c = it.originals.get(cid)!;
            this.put(reparentKeepWorld(c, oldWorld, newWorld));
          }
        } else this.applyFrameConstraints(o, o.width, o.height, next.width, next.height);
      }
      this.sizeBadge = { text: `${round2(next.width)} × ${round2(next.height)}`, at: this.badgeAnchor() };
    } else {
      const b = it.bounds;
      const box = resizeBox(b.width, b.height, it.handle, delta, opts);
      const nl = Math.min(box.l, box.r);
      const nt = Math.min(box.t, box.b);
      const sx = b.width > 0 ? Math.abs(box.r - box.l) / b.width : 1;
      const sy = b.height > 0 ? Math.abs(box.b - box.t) / b.height : 1;
      const map = (q: Point): Point => ({ x: b.x + nl + (q.x - b.x) * sx, y: b.y + nt + (q.y - b.y) * sy });
      for (const id of it.ids) {
        const o = it.originals.get(id)!;
        const pw = this.doc.parentWorld(o);
        const toParent = invert(pw);
        if (o.type === 'LINE') {
          const ends = lineEnds(o).map((q) => apply(pw, q));
          this.put(lineFromEnds(o, apply(toParent, map(ends[0])), apply(toParent, map(ends[1]))));
          continue;
        }
        const ob = boundsOfPoints(
          [
            { x: 0, y: 0 },
            { x: o.width, y: 0 },
            { x: o.width, y: o.height },
            { x: 0, y: o.height },
          ].map((q) => apply(multiply(pw, localMatrix(o.x, o.y, o.rotation)), q)),
        );
        if (o.rotation === 0) {
          const tl = apply(toParent, map({ x: ob.x, y: ob.y }));
          let next: SceneNode = {
            ...o,
            x: round2(tl.x),
            y: round2(tl.y),
            width: Math.max(0.01, round2(o.width * sx)),
            height: Math.max(0.01, round2(o.height * sy)),
          };
          if (o.type === 'TEXT') next = fitText({ ...next, text: { ...o.text!, autoResize: 'height' } });
          this.put(next);
        } else {
          const c = map({ x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 });
          const cOld = { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 };
          const d = applyVector(toParent, { x: c.x - cOld.x, y: c.y - cOld.y });
          this.put({ ...o, x: round2(o.x + d.x), y: round2(o.y + d.y) });
        }
      }
      const nb = this.selectionBounds()!;
      this.sizeBadge = { text: `${round2(nb.width)} × ${round2(nb.height)}`, at: this.badgeAnchor() };
    }
    this.emit('doc', 'view');
  }

  private badgeAnchor(): Point {
    const b = this.selectionBounds();
    if (!b) return { x: 0, y: 0 };
    const s = this.toScreen({ x: b.x + b.width / 2, y: b.y + b.height });
    return { x: s.x, y: s.y + 10 };
  }

  // -------------------------------------------------------------- create

  private updateCreate(it: Extract<Interaction, { kind: 'create' }>, p: Point, e: PointerInput) {
    if (!it.nodeId && Math.hypot(e.sx - it.startScreen.x, e.sy - it.startScreen.y) < DRAG_THRESHOLD) return;
    const type = TOOL_TYPE[it.tool]!;
    if (!it.nodeId) {
      this.begin();
      const node = createNode(this.doc, type, it.parentId, { x: 0, y: 0, width: 1, height: 1 });
      const withArrow = it.tool === 'arrow' ? { ...node, arrowEnd: true, name: nextName(this.doc, 'Arrow') } : node;
      this.put(withArrow);
      it.nodeId = node.id;
      this.selection = [node.id];
      this.emit('selection');
    }
    const n = this.doc.get(it.nodeId)!;
    const toParent = invert(it.parentId === null ? IDENTITY : this.doc.world(it.parentId));
    let cur = this.snapPoint(p, new Set([n.id]));
    if (type === 'LINE') {
      if (e.shift) cur = snapAngle(it.start, cur);
      const next = lineFromEnds(n, apply(toParent, it.start), apply(toParent, cur));
      this.put(next);
      this.sizeBadge = { text: `${Math.round(next.width)}`, at: { x: e.sx + 16, y: e.sy + 16 } };
    } else {
      let w = cur.x - it.start.x;
      let h = cur.y - it.start.y;
      if (e.shift) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      let x0 = it.start.x;
      let y0 = it.start.y;
      if (e.alt) {
        x0 -= w;
        y0 -= h;
        w *= 2;
        h *= 2;
      }
      const r = boundsOfPoints([{ x: x0, y: y0 }, { x: x0 + w, y: y0 + h }]);
      const tl = apply(toParent, { x: r.x, y: r.y });
      let next: SceneNode = {
        ...n,
        x: round2(tl.x),
        y: round2(tl.y),
        width: Math.max(1, round2(r.width)),
        height: Math.max(1, round2(r.height)),
      };
      if (type === 'TEXT') next = { ...next, text: { ...n.text!, autoResize: 'height' } };
      this.put(next);
      this.sizeBadge = { text: `${round2(next.width)} × ${round2(next.height)}`, at: this.badgeAnchor() };
    }
    this.emit('doc', 'view');
  }

  private finishCreate(it: Extract<Interaction, { kind: 'create' }>, _e: PointerInput) {
    const type = TOOL_TYPE[it.tool]!;
    if (!it.nodeId) {
      // click without drag: default size at the click point
      this.begin();
      const toParent = invert(it.parentId === null ? IDENTITY : this.doc.world(it.parentId));
      const at = apply(toParent, it.start);
      let node = createNode(this.doc, type, it.parentId, {
        x: round2(at.x),
        y: round2(at.y),
        width: type === 'LINE' ? 100 : 100,
        height: type === 'LINE' ? 0 : 100,
      });
      if (it.tool === 'arrow') node = { ...node, arrowEnd: true, name: nextName(this.doc, 'Arrow') };
      if (type === 'TEXT') node = fitText({ ...node, y: round2(at.y - 10) });
      this.put(node);
      it.nodeId = node.id;
      this.selection = [node.id];
    } else if (type === 'TEXT') {
      const n = this.doc.get(it.nodeId)!;
      this.put(fitText(n));
    }
    this.end();
    this.setTool('move');
    if (type === 'TEXT' && it.nodeId) {
      this.pendingTextCreate = it.nodeId;
      this.startTextEdit(it.nodeId);
    }
    this.emit('selection', 'view');
  }

  // ------------------------------------------------------------ keyboard

  /** Returns true when the key was handled. Letters use `code`, so shortcuts work with any keyboard layout or IME. */
  keyDown(k: KeyInput): boolean {
    if (this.editingText) return false;
    const { code, shift, alt, mod } = k;
    if (code === 'Space') {
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.setHover(null);
        this.emit('view');
      }
      return true;
    }
    if (code === 'Escape') {
      if (this.cancelInteraction()) return true;
      if (this.tool !== 'move') {
        this.setTool('move');
        return true;
      }
      const first = this.selectedNodes()[0];
      if (first && first.parentId !== null && this.selection.length === 1) this.setSelection([first.parentId]);
      else this.setSelection([]);
      return true;
    }
    if (this.isInteracting) return false;

    if (mod) {
      switch (code) {
        case 'KeyZ':
          if (shift) this.redo();
          else this.undo();
          return true;
        case 'KeyY':
          this.redo();
          return true;
        case 'KeyD':
          this.duplicateSelection();
          return true;
        case 'KeyA':
          this.selectAll();
          return true;
        case 'KeyG':
          // Ctrl/Cmd+G (and +Alt) wrap in a frame; with Shift they remove the frame
          if (shift) this.unwrapFrames();
          else this.wrapInFrame();
          return true;
        case 'BracketRight':
          this.reorder(shift || alt ? 'front' : 'forward');
          return true;
        case 'BracketLeft':
          this.reorder(shift || alt ? 'back' : 'backward');
          return true;
        case 'KeyH':
          if (shift) {
            this.toggleVisible();
            return true;
          }
          return false;
        case 'KeyL':
          if (shift) {
            this.toggleLocked();
            return true;
          }
          return false;
        case 'Equal':
        case 'NumpadAdd':
          this.zoomAt(2, this.viewSize.width / 2, this.viewSize.height / 2);
          return true;
        case 'Minus':
        case 'NumpadSubtract':
          this.zoomAt(0.5, this.viewSize.width / 2, this.viewSize.height / 2);
          return true;
        case 'Digit0':
          this.zoomTo(1);
          return true;
      }
      return false;
    }

    if (shift && !alt) {
      if (code === 'Digit1') return this.zoomToFit(), true;
      if (code === 'Digit2') return this.zoomToSelection(), true;
      if (code === 'Digit0') return this.zoomTo(1), true;
      if (code === 'KeyL') return this.setTool('arrow'), true;
    }

    switch (code) {
      case 'KeyV':
        this.setTool('move');
        return true;
      case 'KeyF':
      case 'KeyA':
        this.setTool('frame');
        return true;
      case 'KeyR':
        this.setTool('rect');
        return true;
      case 'KeyO':
        this.setTool('ellipse');
        return true;
      case 'KeyL':
        this.setTool('line');
        return true;
      case 'KeyT':
        this.setTool('text');
        return true;
      case 'KeyH':
        this.setTool('hand');
        return true;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        return true;
      case 'Enter': {
        const sel = this.selectedNodes();
        if (sel.length === 1 && sel[0].type === 'TEXT' && !shift) {
          this.startTextEdit(sel[0].id);
          return true;
        }
        if (shift) {
          const parents = sel.map((n) => n.parentId).filter((p): p is string => p !== null);
          if (parents.length) this.setSelection([...new Set(parents)]);
        } else {
          const kids = sel.flatMap((n) => this.doc.children(n.id));
          if (kids.length) this.setSelection(kids);
        }
        return true;
      }
      case 'Tab': {
        const sel = this.selectedNodes();
        if (sel.length !== 1) return false;
        const sibs = this.doc.children(sel[0].parentId);
        // Tab goes down the layer list (towards the back), Shift+Tab up
        const i = sibs.indexOf(sel[0].id);
        const next = sibs[(i + (shift ? 1 : -1) + sibs.length) % sibs.length];
        this.setSelection([next]);
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (this.selection.length === 0) return false;
        const step = shift ? 10 : 1;
        const dx = code === 'ArrowLeft' ? -step : code === 'ArrowRight' ? step : 0;
        const dy = code === 'ArrowUp' ? -step : code === 'ArrowDown' ? step : 0;
        this.nudge(dx, dy);
        return true;
      }
    }
    return false;
  }

  keyUp(k: { code: string }) {
    if (k.code === 'Space' && this.spaceDown) {
      this.spaceDown = false;
      this.emit('view');
    }
  }

  /** Cursor for the current state at a screen point. */
  cursorAt(sx: number, sy: number): string {
    const it = this.interaction.kind;
    if (it === 'pan') return 'grabbing';
    if (this.spaceDown || this.tool === 'hand') return 'grab';
    if (this.tool === 'text') return 'text';
    if (this.tool !== 'move') return 'crosshair';
    const h = this.handleAt(sx, sy);
    if (!h) return 'default';
    if (h.kind === 'line-end') return 'crosshair';
    if (h.kind === 'rotate') return 'alias';
    const { m } = this.selectionFrame();
    const angle = (Math.atan2(m[1], m[0]) / DEG + 360) % 180;
    const base: Record<Handle, number> = { e: 0, w: 0, n: 90, s: 90, ne: 135, sw: 135, nw: 45, se: 45 };
    const a = (base[h.handle] + angle) % 180;
    const cursors = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
    return cursors[Math.round(a / 45) % 4];
  }
}

/** Recomputes a text layer's size from its content and auto-resize mode. */
export function fitText(n: SceneNode): SceneNode {
  if (n.type !== 'TEXT' || !n.text) return n;
  const t = n.text;
  if (t.autoResize === 'width') {
    const l = layoutText(t, null);
    return { ...n, width: Math.max(1, l.width), height: l.height };
  }
  if (t.autoResize === 'height') {
    const l = layoutText(t, n.width);
    return { ...n, height: l.height };
  }
  return n;
}
