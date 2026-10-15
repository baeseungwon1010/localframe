import { generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod';
import {
  type Bindable,
  type Binding,
  type BooleanOp,
  type ComponentProp,
  type Vector,
  type VectorPoint,
  type Layout,
  type NodeType,
  type Override,
  type Page,
  type SceneNode,
  type Style,
  type TextStyle,
  type Variables,
  EMPTY_VARIABLES,
  MAX_COORD,
  MAX_DEPTH,
  MAX_NODES_PER_FILE,
  MAX_PAGES,
  SceneNodeSchema,
  validateTree,
} from '../../shared/schema.ts';
import {
  type StyleField,
  STYLE_KEY,
  applyStyleValue,
  boundField,
  resolveBindings,
  styleFrom,
  styleMatches,
} from './assets.ts';
import { bindingAt, settleLine } from './connectors.ts';
import { componentPropsOf, instanceDoc, namePath, variantName, variantOptions } from './instances.ts';
import { DEFAULT_LAYOUT, applyAutoLayout, autoLayoutIndex } from './layout.ts';
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
  linePoints,
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
import { canHaveChildren, createNode, fitText, keyAt, keyOnTop, keysAbove, keysOnTop, newId, nextName, solid } from './nodes.ts';
import { canvasMeasure } from './text.ts';
import { type RunProps, adjustRuns, styleRange } from './textRuns.ts';
import { fitVector, outlineVector, scaleVector, shapeVector, simplifyPoints, smoothPath } from './vector.ts';
import type * as PathOps from './pathOps.ts';

/** Outlining and boolean geometry (polygon clipping) load the first time they are needed. */
let pathOps: typeof PathOps | null = null;
const loadPathOps = async () => (pathOps ??= await import('./pathOps.ts'));
import { canHaveLabel, defaultLabel, heightForLabel } from './labels.ts';
import { STAMPS, type TemplateKind, templateBounds, templateItems } from './templates.ts';
import { type Recognized, recognizeStroke } from './recognize.ts';
import { tr } from './translate.ts';
import { importSvg } from './svgImport.ts';
import { CONNECTOR_COLOR, DEFAULT_SHAPE_COLOR, DEFAULT_STICKY_COLOR, DIAGRAM_COLORS, isDiagramItem, withDiagramColor } from './diagramColors.ts';

export { fitText };

export type DiagramShape = 'diamond' | 'parallelogram' | 'cylinder' | 'document' | 'chevron';
const DIAGRAM_SHAPES: readonly string[] = ['diamond', 'parallelogram', 'cylinder', 'document', 'chevron'];

export type Tool = DiagramShape | 'sticky' | 'stamp' | 'box' | 'move' | 'hand' | 'frame' | 'section' | 'slice' | 'pencil' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'arrow' | 'text' | 'pen' | 'comment';

/** Where a new comment goes: on the page, and inside the layer under it if there is one. */
export type CommentSpot = { x: number; y: number; nodeId?: string; offset?: Point };
export type Viewport = { x: number; y: number; zoom: number };
export type Channel = 'doc' | 'selection' | 'view' | 'tool' | 'hover' | 'pages';

export type PointerInput = {
  sx: number;
  sy: number;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  /** From a finger rather than a mouse or pen: things are easier to hit. */
  touch?: boolean;
};

export type KeyInput = { code: string; key: string; shift: boolean; alt: boolean; mod: boolean; repeat: boolean };

export type SelectionHandle =
  | { kind: 'resize'; handle: Handle }
  | { kind: 'rotate'; handle: Handle }
  | { kind: 'line-end'; end: 0 | 1 };

type HistoryEntry = {
  patches: Patch[];
  selBefore: string[];
  selAfter: string[];
  /** File-level state (pages, styles, variables) before and after, when it changed. */
  fileBefore?: FileState;
  fileAfter?: FileState;
  pageBefore?: string;
  pageAfter?: string;
};

export type FileState = { pages: Page[]; styles: Style[]; variables: Variables };
export type CommitInfo = { patches: Patch[]; pagesChanged: boolean; stylesChanged: boolean; variablesChanged: boolean };

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Equal as data, whatever the order of keys (storage may hand objects back reordered). */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function styledValueOf(n: SceneNode, f: StyleField): unknown {
  if (f === 'fill') return n.fills;
  if (f === 'stroke') return n.strokes;
  if (f === 'effect') return n.effects ?? [];
  return n.text ? [n.text.fontFamily, n.text.fontWeight, n.text.fontSize, n.text.lineHeight, n.text.letterSpacing] : null;
}

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
  | { kind: 'rotate-many'; start: Point; ids: string[]; originals: Map<string, SceneNode>; center: Point }
  | { kind: 'guide'; axis: 'x' | 'y'; index: number | null }
  | { kind: 'crop'; id: string; start: Point; original: { x: number; y: number; scale: number } }
  | { kind: 'line-end'; id: string; end: 0 | 1; original: SceneNode }
  | { kind: 'create'; tool: Tool; start: Point; startScreen: Point; nodeId: string | null; parentId: string | null }
  | { kind: 'pen-handle' }
  | { kind: 'quick-connect'; side: 'top' | 'right' | 'bottom' | 'left' }
  | { kind: 'stamp'; at: Point }
  | { kind: 'pencil'; nodeId: string | null; parentId: string | null; points: Point[] }
  | { kind: 'vec-point'; id: string; index: number; part: 'point' | 'in' | 'out'; start: Point; original: Vector };

/** A path being drawn with the pen tool (world coordinates until it is placed). */
type PenState = { nodeId: string; parentId: string | null; points: VectorPoint[] };

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
  section: 'FRAME',
  slice: 'FRAME',
  sticky: 'RECTANGLE',
  box: 'RECTANGLE',
  diamond: 'VECTOR',
  parallelogram: 'VECTOR',
  cylinder: 'VECTOR',
  document: 'VECTOR',
  chevron: 'VECTOR',
  polygon: 'VECTOR',
  star: 'VECTOR',
  text: 'TEXT',
};

const CLIP_PREFIX = 'localframe-clipboard:';
const PENCIL_MAX_POINTS = 4000;

/** A text layer's automatic name: its first line, shortened. */
function textName(characters: string): string {
  const line = characters.split('\n').find((l) => l.trim())?.trim() ?? 'Text';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** 32-bit FNV-1a as 8 hex digits. */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
const COPIED_FROM_KEY = 'localframe.copiedFrom';

/** Copied from in this tab (also kept when storage is unavailable). */
const copiedHere = new Set<string>();

/** Files this browser copied layers from (shared between tabs), newest first. */
function copiedFrom(): string[] {
  let stored: string[] = [];
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(COPIED_FROM_KEY) ?? '[]');
    if (Array.isArray(v)) stored = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* ignore */
  }
  return [...copiedHere, ...stored];
}

function rememberCopiedFrom(fileId: string) {
  copiedHere.add(fileId);
  try {
    globalThis.localStorage?.setItem(COPIED_FROM_KEY, JSON.stringify([fileId, ...copiedFrom().filter((x) => x !== fileId)].slice(0, 20)));
  } catch {
    /* storage unavailable: images just won't be copied */
  }
}
const ClipboardSchema = z
  .object({
    roots: z.array(z.string().max(64)).max(10_000),
    nodes: z.array(SceneNodeSchema).max(50_000),
    /** File the layers were copied from (images are copied over from it). */
    sourceFile: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    /** Main components of copied instances, so they can be rebuilt in another file. */
    components: z.array(SceneNodeSchema).max(50_000).optional(),
  })
  .strict();

/** Depth of the deepest pasted layer below its root (0 = roots only). */
function treeDepth(roots: string[], nodes: SceneNode[]): number {
  const kids = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId !== null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  let max = 0;
  const stack = roots.map((id) => ({ id, d: 0 }));
  while (stack.length) {
    const { id, d } = stack.pop()!;
    max = Math.max(max, d);
    for (const c of kids.get(id) ?? []) stack.push({ id: c, d: d + 1 });
  }
  return max;
}

const MAX_SIZE = 1e7;
/** Width of the rulers, in screen pixels. */
export const RULER = 20;

/** Thin rectangles along a frame's layout grid lines (for snapping and drawing). */
export function gridRects(n: SceneNode, b: Rect): Rect[] {
  const out: Rect[] = [];
  for (const g of n.grids ?? []) {
    if (!g.visible) continue;
    if (g.type === 'grid') {
      for (let x = b.x; x <= b.x + b.width + 0.01 && out.length < 2000; x += g.size) out.push({ x, y: b.y, width: 0, height: b.height });
      for (let y = b.y; y <= b.y + b.height + 0.01 && out.length < 4000; y += g.size) out.push({ x: b.x, y, width: b.width, height: 0 });
      continue;
    }
    const along = g.type === 'columns' ? b.width : b.height;
    const cell = (along - g.margin * 2 - g.gutter * (g.count - 1)) / g.count;
    if (cell <= 0) continue;
    for (let i = 0; i < g.count; i++) {
      const start = g.margin + i * (cell + g.gutter);
      out.push(g.type === 'columns' ? { x: b.x + start, y: b.y, width: cell, height: b.height } : { x: b.x, y: b.y + start, width: b.width, height: cell });
    }
  }
  return out;
}

/**
 * Keeps derived geometry inside the range the file format accepts. Layout, constraints and
 * connectors compute sizes and positions; a NaN or an out-of-range value would make every later
 * save fail, so it falls back to the previous value (or is clamped).
 */
function sanitize(n: SceneNode, prev: SceneNode | undefined): SceneNode {
  const fix = (v: number, fallback: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Number.isFinite(fallback) ? Math.min(hi, Math.max(lo, fallback)) : 0;
  const x = fix(n.x, prev?.x ?? 0, -MAX_COORD, MAX_COORD);
  const y = fix(n.y, prev?.y ?? 0, -MAX_COORD, MAX_COORD);
  const width = fix(n.width, prev?.width ?? 1, 0, MAX_SIZE);
  const height = fix(n.height, prev?.height ?? 1, 0, MAX_SIZE);
  const rotation = fix(n.rotation, prev?.rotation ?? 0, -360, 360);
  if (x === n.x && y === n.y && width === n.width && height === n.height && rotation === n.rotation) return n;
  return { ...n, x, y, width, height, rotation };
}


export class Editor {
  readonly doc = new SceneDoc();
  tool: Tool = 'move';
  selection: string[] = [];
  hover: string | null = null;
  /** Outline mode (Ctrl/Cmd+Y): every layer drawn as a thin outline. */
  outlineMode = false;
  /** Alt is held: hovering shows distances from the selection. */
  altDown = false;
  viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  viewSize = { width: 800, height: 600 };
  editingText: string | null = null;
  guides: Guide[] = [];
  dropTarget: string | null | undefined = undefined; // undefined = no drop in progress
  marquee: Rect | null = null;
  /** Layer a line end will attach to if released now. */
  bindTarget: string | null = null;
  /** Path being drawn with the pen tool. */
  pen: PenState | null = null;
  /** Pointer position for the pen's preview segment. */
  penCursor: Point | null = null;
  /** Vector layer whose points are being edited, and the selected point. */
  editingVector: string | null = null;
  vectorPoint: number | null = null;
  /** The file being edited (set by the UI; used for copying images between files). */
  fileId: string | null = null;
  /** Asks the UI to copy images used by pasted layers from another file. */
  onPastedImages: ((sourceFile: string, imageIds: string[]) => void) | null = null;
  /** The comment tool was clicked on the canvas. */
  onCommentAt: ((spot: CommentSpot, screen: Point) => void) | null = null;
  /** The Prototype tab is open: the canvas shows where interactions go. */
  prototypeView = false;
  /** Asks the UI to start a presentation (Ctrl+Alt+Enter). */
  onRequestPresent: (() => void) | null = null;
  /** Image layer being cropped. */
  cropping: string | null = null;
  showGrids = true;
  /** Pixel grid lines from 800% zoom. */
  showPixelGrid = true;
  /** Moving, resizing and drawing land on whole pixels. */
  snapToPixels = false;
  /** Draws the canvas at one device pixel per unit, scaled up without smoothing. */
  pixelPreview = false;
  showRulers = false;
  /** A guide being dragged (from a ruler, or an existing one): its axis and position. */
  guideDrag: { axis: 'x' | 'y'; pos: number; index: number | null; remove: boolean } | null = null;
  /** A layer inside an instance being edited (as overrides), shown with its own outline. */
  inner: { instanceId: string; sourceId: string } | null = null;
  sizeBadge: { text: string; at: Point } | null = null;
  spaceDown = false;
  pages: Page[] = [{ id: 'page-1', name: 'Page 1', background: '#F3F3F1' }];
  styles: Style[] = [];
  variables: Variables = EMPTY_VARIABLES;
  /** Viewport per page, so switching pages comes back to the same place. */
  private pageViews = new Map<string, Viewport>();
  /** Asks the UI to pick an image file (Ctrl/Cmd+Shift+K). */
  onRequestImage: (() => void) | null = null;

  private interaction: Interaction = { kind: 'none' };
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private tx: Map<string, SceneNode | null> | null = null;
  private txSelBefore: string[] = [];
  private txFileBefore: FileState | null = null;
  private txPageBefore = '';
  private listeners = new Map<Channel, Set<() => void>>();
  private commitListeners = new Set<(info: CommitInfo) => void>();
  readonly revs: Record<Channel, number> = { doc: 0, selection: 0, view: 0, tool: 0, hover: 0, pages: 0 };

  // ---------------------------------------------------------------- events

  subscribe(channel: Channel, fn: () => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Called with every committed change, undo and redo included. */
  onCommit(fn: (info: CommitInfo) => void): () => void {
    this.commitListeners.add(fn);
    return () => this.commitListeners.delete(fn);
  }

  emit(...channels: Channel[]) {
    for (const c of channels) {
      this.revs[c]++;
      this.listeners.get(c)?.forEach((fn) => fn());
    }
  }

  load(nodes: SceneNode[], pages: Page[] | string, styles: Style[] = [], variables: Variables = EMPTY_VARIABLES) {
    this.pages = typeof pages === 'string' ? [{ id: 'page-1', name: 'Page 1', background: pages }] : pages;
    this.styles = styles;
    this.variables = variables;
    this.doc.load(nodes, this.pages[0].id);
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.cropping = null;
    this.emit('doc', 'selection', 'view', 'pages');
  }

  get currentPage(): Page {
    return this.pages.find((p) => p.id === this.doc.currentPage) ?? this.pages[0];
  }

  /** Background of the current page. */
  get background(): string {
    return this.currentPage.background;
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
    if (this.inner && !next.includes(this.inner.instanceId)) this.inner = null;
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
    this.emit('view', 'hover');
  }

  setTool(tool: Tool) {
    if (this.pen && tool !== 'pen') this.finishPen();
    if (this.editingVector) this.exitVectorEdit();
    if (this.cropping) this.exitCrop();
    if (tool === 'comment' && this.selection.length) this.setSelection([]);
    this.tool = tool;
    this.emit('tool', 'view');
  }

  // ----------------------------------------------------------- transactions

  private begin() {
    if (this.tx) return;
    this.tx = new Map();
    this.txSelBefore = [...this.selection];
    this.txFileBefore = null;
    this.txPageBefore = this.doc.currentPage;
  }

  private record(id: string) {
    if (this.tx && !this.tx.has(id)) this.tx.set(id, this.doc.get(id) ?? null);
  }

  /** Writes a node inside the current transaction. Top-level layers get the current page. */
  put(node: SceneNode) {
    const prev = this.doc.get(node.id);
    let n = sanitize(node, prev);
    // snap to pixels: what the pointer moves, resizes or draws lands on whole pixels
    const k = this.interaction.kind;
    if (this.snapToPixels && n.rotation === 0 && n.type !== 'LINE' && (k === 'move' || k === 'resize' || k === 'create')) {
      const r = (v: number) => Math.round(v);
      if (n.x !== r(n.x) || n.y !== r(n.y) || n.width !== Math.max(1, r(n.width)) || n.height !== Math.max(1, r(n.height)))
        n = { ...n, x: r(n.x), y: r(n.y), width: Math.max(1, r(n.width)), height: n.type === 'TEXT' ? n.height : Math.max(1, r(n.height)) };
    }
    // a vector's points follow its box when it is resized (not when its points were edited)
    if (n.type === 'VECTOR' && prev?.vector && n.vector === prev.vector && (n.width !== prev.width || n.height !== prev.height)) {
      n = { ...n, vector: scaleVector(prev.vector, prev.width > 0 ? n.width / prev.width : 1, prev.height > 0 ? n.height / prev.height : 1) };
    }
    // polygons and stars are rebuilt from their settings; editing their points makes them plain vectors
    if (n.type === 'VECTOR' && n.shape) {
      if (!prev || prev.shape !== n.shape || n.width !== prev.width || n.height !== prev.height) n = { ...n, vector: shapeVector(n.shape, n.width, n.height) };
      else if (n.vector !== prev.vector) n = { ...n, shape: undefined };
    }
    // a section can only sit on the page; moved into anything else it becomes a plain frame
    if (n.section && n.parentId !== null) n = { ...n, section: undefined };
    if (n.parentId === null && n.pageId === undefined) n = { ...n, pageId: this.doc.currentPage };
    else if (n.parentId !== null && n.pageId !== undefined) {
      const { pageId: _drop, ...rest } = n;
      n = rest;
    }
    this.record(n.id);
    this.doc.set(n);
  }

  /** Changes the page list inside the current transaction. */
  private fileState(): FileState {
    return { pages: this.pages, styles: this.styles, variables: this.variables };
  }

  /** Changes file-level state (pages, styles, variables) inside the current transaction. */
  setFileState(patch: Partial<FileState>) {
    if (this.tx && !this.txFileBefore) this.txFileBefore = this.fileState();
    if (patch.pages) this.pages = patch.pages;
    if (patch.styles) this.styles = patch.styles;
    if (patch.variables) this.variables = patch.variables;
    this.emit('pages');
  }

  private setPages(pages: Page[]) {
    this.setFileState({ pages });
  }

  private drop(id: string) {
    this.record(id);
    this.doc.remove(id);
  }

  private end(): Patch[] {
    if (this.tx) this.settle();
    const tx = this.tx;
    this.tx = null;
    if (!tx) return [];
    const fileBefore = this.txFileBefore;
    this.txFileBefore = null;
    const pagesChanged = !!fileBefore && !sameJson(fileBefore.pages, this.pages);
    const stylesChanged = !!fileBefore && !sameJson(fileBefore.styles, this.styles);
    const variablesChanged = !!fileBefore && !sameJson(fileBefore.variables, this.variables);
    const fileChanged = pagesChanged || stylesChanged || variablesChanged;
    const patches: Patch[] = [];
    for (const [id, before] of tx) {
      const after = this.doc.get(id) ?? null;
      if (before === after) continue;
      if (before && after && JSON.stringify(before) === JSON.stringify(after)) continue;
      patches.push({ id, before, after });
    }
    this.setSelection(this.selection.filter((id) => this.doc.has(id)));
    if (patches.length > 0 || fileChanged) {
      this.undoStack.push({
        patches,
        selBefore: this.txSelBefore,
        selAfter: [...this.selection],
        ...(fileChanged ? { fileBefore: fileBefore!, fileAfter: this.fileState() } : {}),
        pageBefore: this.txPageBefore,
        pageAfter: this.doc.currentPage,
      });
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
      this.commitListeners.forEach((fn) => fn({ patches, pagesChanged, stylesChanged, variablesChanged }));
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
    if (this.txFileBefore) {
      this.pages = this.txFileBefore.pages;
      this.styles = this.txFileBefore.styles;
      this.variables = this.txFileBefore.variables;
    }
    this.txFileBefore = null;
    if (this.doc.currentPage !== this.txPageBefore) this.doc.setCurrentPage(this.txPageBefore);
    this.selection = this.txSelBefore.filter((id) => this.doc.has(id));
    this.emit('doc', 'selection', 'view', 'pages');
  }

  /** Runs `fn` as one undoable step. */
  transact(fn: () => void) {
    const nested = this.tx !== null;
    this.begin();
    try {
      fn();
    } catch (err) {
      // Never leave a half-applied step behind: roll it back and close the transaction.
      if (!nested) this.abort();
      throw err;
    }
    if (!nested) this.end();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  private commitOf(patches: Patch[], a?: FileState, b?: FileState): CommitInfo {
    return {
      patches,
      pagesChanged: !!a && !!b && !sameJson(a.pages, b.pages),
      stylesChanged: !!a && !!b && !sameJson(a.styles, b.styles),
      variablesChanged: !!a && !!b && !sameJson(a.variables, b.variables),
    };
  }

  /**
   * The undo and redo history, newest last, as plain data to keep across visits: at most `max`
   * steps each, dropping the oldest until it fits in `maxChars` of JSON.
   */
  historySnapshot(max = 100, maxChars = 8_000_000): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    let undo = this.undoStack.slice(-max);
    let redo = this.redoStack.slice(-max);
    const size = () => JSON.stringify({ undo, redo }).length;
    while ((undo.length || redo.length) && size() > maxChars) {
      if (undo.length >= redo.length) undo = undo.slice(1);
      else redo = redo.slice(1);
    }
    return { undo, redo };
  }

  /**
   * Takes back a saved undo history, if it still fits the file: every layer it touches must be as
   * its newest step left it (else the file changed elsewhere since, and the history is dropped).
   * Every layer in it is checked against the schema. Returns whether it was used.
   */
  restoreHistory(saved: unknown): boolean {
    const h = saved as { undo?: unknown; redo?: unknown } | null;
    if (!h || !Array.isArray(h.undo) || !Array.isArray(h.redo) || h.undo.length + h.redo.length > 1000) return false;
    const entryOk = (e: unknown): e is HistoryEntry => {
      const x = e as HistoryEntry;
      if (!x || !Array.isArray(x.patches) || !Array.isArray(x.selBefore) || !Array.isArray(x.selAfter) || x.patches.length > 100_000) return false;
      return x.patches.every(
        (p) =>
          p &&
          typeof p.id === 'string' &&
          (p.before === null || SceneNodeSchema.safeParse(p.before).success) &&
          (p.after === null || SceneNodeSchema.safeParse(p.after).success),
      );
    };
    if (!h.undo.every(entryOk) || !h.redo.every(entryOk)) return false;
    const undo = h.undo as HistoryEntry[];
    // every layer the history touches must be as its newest step left it; anything else means
    // the file changed elsewhere, and undoing would overwrite that change
    const latest = new Map<string, SceneNode | null>();
    for (const e of undo) for (const p of e.patches) latest.set(p.id, p.after);
    for (const [id, after] of latest) if (!sameData(this.doc.get(id) ?? null, after)) return false;
    // redo starts empty: it would need the same care in the other direction, for little use
    this.undoStack = undo;
    this.redoStack = [];
    this.emit('doc');
    return true;
  }

  undo() {
    if (this.interaction.kind !== 'none') return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.doc.applyPatches(entry.patches, true);
    this.redoStack.push(entry);
    if (entry.fileBefore) Object.assign(this, entry.fileBefore);
    this.showPage(entry.pageBefore);
    this.selection = entry.selBefore.filter((id) => this.doc.has(id));
    this.commitListeners.forEach((fn) => fn(this.commitOf(entry.patches, entry.fileAfter, entry.fileBefore)));
    this.emit('doc', 'selection', 'view', 'pages');
  }

  redo() {
    if (this.interaction.kind !== 'none') return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.doc.applyPatches(entry.patches);
    this.undoStack.push(entry);
    if (entry.fileAfter) Object.assign(this, entry.fileAfter);
    this.showPage(entry.pageAfter);
    this.selection = entry.selAfter.filter((id) => this.doc.has(id));
    this.commitListeners.forEach((fn) => fn(this.commitOf(entry.patches, entry.fileBefore, entry.fileAfter)));
    this.emit('doc', 'selection', 'view', 'pages');
  }

  // ------------------------------------------------------------ settling

  /**
   * Keeps derived geometry right after changes: auto layout frames re-place their children (deepest
   * first), instances follow their component's size, and connector lines follow the layers they are
   * attached to. Runs inside the open transaction, so the results are part of the same undo step.
   */
  private settle(freeze: Set<string> = new Set()) {
    const tx = this.tx;
    if (!tx) return;
    const doc = this.doc;

    // instances keep following a component whose box changed size, unless they were resized themselves
    for (const [id, before] of tx) {
      const now = doc.get(id);
      if (!before || !now || now.type !== 'COMPONENT') continue;
      if (before.width === now.width && before.height === now.height) continue;
      for (const n of doc.all()) {
        if (n.type === 'INSTANCE' && n.componentId === id && n.width === before.width && n.height === before.height)
          this.put({ ...n, width: now.width, height: now.height });
      }
    }

    this.fitGroups();

    this.applyAssets();

    // auto layout, bottom-up
    const frames = new Set<string>();
    const addChain = (pid: string | null | undefined) => {
      let cur = pid ? doc.get(pid) : undefined;
      while (cur && cur.layout) {
        frames.add(cur.id);
        cur = cur.parentId ? doc.get(cur.parentId) : undefined;
      }
    };
    for (const [id, before] of tx) {
      const now = doc.get(id);
      if (now?.layout) addChain(now.id);
      addChain(now?.parentId);
      addChain(before?.parentId);
    }
    const ordered = [...frames].filter((id) => doc.has(id)).sort((a, b) => doc.depth(b) - doc.depth(a));
    for (const fid of ordered) {
      const kids = doc.children(fid).map((k) => doc.get(k)!);
      if (kids.some((k) => freeze.has(k.id))) continue;
      const out = applyAutoLayout(doc.get(fid)!, kids);
      out.kids.forEach((k, i) => k !== kids[i] && this.put(k));
      if (out.frame !== doc.get(fid)) this.put(out.frame);
    }

    this.fitGroups();

    // connectors whose own line or bound layers (or their ancestors) changed
    const changed = new Set(tx.keys());
    const near = (id: string | undefined) => {
      if (!id) return false;
      if (!doc.has(id)) return true; // bound layer was deleted: let go
      let cur = doc.get(id);
      for (let guard = 0; cur && guard < 200; guard++) {
        if (changed.has(cur.id)) return true;
        cur = cur.parentId ? doc.get(cur.parentId) : undefined;
      }
      return false;
    };
    // elbow connectors also go around other shapes: a shape that moved, grew or went away near
    // one (where it is now, or where it was) re-routes it, on the same page only
    const moved: { rect: Rect; page: string }[] = [];
    const boxOf = (m: SceneNode): Rect => {
      const w = multiply(m.parentId && doc.has(m.parentId) ? doc.world(m.parentId) : IDENTITY, localMatrix(m.x, m.y, m.rotation));
      const pts = [
        { x: 0, y: 0 },
        { x: m.width, y: 0 },
        { x: 0, y: m.height },
        { x: m.width, y: m.height },
      ].map((q) => apply(w, q));
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    for (const id of changed) {
      if (moved.length >= 400) break;
      const now = doc.get(id);
      const before = tx.get(id);
      const page = now ? doc.pageOf(id) : before?.parentId && doc.has(before.parentId) ? doc.pageOf(before.parentId) : (before?.pageId ?? doc.defaultPage);
      for (const m of [now, before]) if (m && m.type !== 'LINE' && m.type !== 'TEXT') moved.push({ rect: boxOf(m), page });
    }
    const lineBox = (n: SceneNode): Rect => {
      const w = doc.world(n.id);
      const pts = linePoints(n).map((q) => apply(w, q));
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      return { x: Math.min(...xs) - 40, y: Math.min(...ys) - 40, width: Math.max(...xs) - Math.min(...xs) + 80, height: Math.max(...ys) - Math.min(...ys) + 80 };
    };
    const nearMoved = (n: SceneNode) => {
      if (!n.elbow || !moved.length) return false;
      const box = lineBox(n);
      if (!moved.some((m) => rectsIntersect(m.rect, box))) return false;
      const page = doc.pageOf(n.id);
      return moved.some((m) => m.page === page && rectsIntersect(m.rect, box));
    };
    for (const n of doc.all()) {
      if (n.type !== 'LINE' || (!n.startBind && !n.endBind && !n.elbow && !n.route)) continue;
      if (!changed.has(n.id) && !near(n.startBind?.nodeId) && !near(n.endBind?.nodeId) && !near(n.id) && !nearMoved(n)) continue;
      let line = n;
      const page = doc.pageOf(n.id);
      const valid = (b: Binding | undefined) => b && doc.has(b.nodeId) && b.nodeId !== n.id && doc.pageOf(b.nodeId) === page;
      if (line.startBind && !valid(line.startBind)) line = { ...line, startBind: undefined };
      if (line.endBind && !valid(line.endBind)) line = { ...line, endBind: undefined };
      line = settleLine(doc, line);
      if (line !== n) this.put(line);
    }
  }

  /**
   * Styles and variables: layers keep a copy of their style's value and of their variables' values.
   * A changed style or variable rewrites every layer that uses it; editing a styled or bound property
   * directly detaches it (as in Figma).
   */
  private applyAssets() {
    const tx = this.tx;
    if (!tx) return;
    const doc = this.doc;
    const before = this.txFileBefore;
    const stylesChanged = !!before && !sameJson(before.styles, this.styles);
    const variablesChanged = !!before && !sameJson(before.variables, this.variables);
    const styleById = new Map(this.styles.map((st) => [st.id, st]));
    const fields: StyleField[] = ['fill', 'stroke', 'text', 'effect'];

    // direct edits detach (only layers changed in this step, compared with how they were)
    for (const [id, prev] of [...tx]) {
      const n = doc.get(id);
      if (!n || !prev) continue;
      let next = n;
      for (const f of fields) {
        const key = STYLE_KEY[f];
        const sid = n[key];
        if (!sid || sid !== prev[key]) continue;
        const st = styleById.get(sid);
        if (st && !styleMatches(n, f, st) && !sameJson(styledValueOf(n, f), styledValueOf(prev, f))) next = { ...next, [key]: undefined };
      }
      if (n.bindings) {
        const kept = { ...n.bindings };
        for (const [prop, vid] of Object.entries(n.bindings) as [Bindable, string][]) {
          if (vid && vid === prev.bindings?.[prop] && !sameJson(boundField(n, prop), boundField(prev, prop))) delete kept[prop];
        }
        if (Object.keys(kept).length !== Object.keys(n.bindings).length) next = { ...next, bindings: Object.keys(kept).length ? kept : undefined };
      }
      if (next !== n) this.put(next);
    }

    // write style values
    const modesChanged = [...tx].some(([id, prev]) => !sameJson(doc.get(id)?.modes, prev?.modes) || doc.get(id)?.parentId !== prev?.parentId);
    const targets = stylesChanged || variablesChanged || modesChanged ? [...doc.all()] : [...tx.keys()].map((id) => doc.get(id)).filter((n): n is SceneNode => !!n);
    for (const n0 of targets) {
      let n = n0;
      for (const f of fields) {
        const sid = n[STYLE_KEY[f]];
        if (!sid) continue;
        const st = styleById.get(sid);
        if (!st) n = { ...n, [STYLE_KEY[f]]: undefined };
        else if (!styleMatches(n, f, st)) n = applyStyleValue(n, f, st);
      }
      if (n.bindings) n = resolveBindings(doc, this.variables, n);
      if (n !== n0 && !sameJson(n, n0)) this.put(n);
    }
  }

  // ---------------------------------------------------------------- styles

  createStyle(field: StyleField, fromId: string, name: string): string | null {
    const n = this.doc.get(fromId);
    if (!n) return null;
    const style = styleFrom(n, field, newId(), name.trim().slice(0, 200) || 'Style');
    if (!style) return null;
    this.transact(() => {
      this.setFileState({ styles: [...this.styles, style].slice(0, 500) });
      this.put({ ...this.doc.get(fromId)!, [STYLE_KEY[field]]: style.id });
    });
    return style.id;
  }

  applyStyle(ids: string[], field: StyleField, styleId: string | null) {
    const st = styleId ? this.styles.find((x) => x.id === styleId) : undefined;
    this.updateNodes(ids, (n) => (st ? { ...applyStyleValue(n, field, st), [STYLE_KEY[field]]: st.id } : { ...n, [STYLE_KEY[field]]: undefined }));
  }

  updateStyle(id: string, patch: { name?: string; value?: Style['value'] }) {
    this.transact(() =>
      this.setFileState({
        styles: this.styles.map((st) =>
          st.id === id ? ({ ...st, ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 200) || st.name } : {}), ...(patch.value ? { value: patch.value } : {}) } as Style) : st,
        ),
      }),
    );
  }

  /** Deleting a style leaves its layers looking the same, just no longer linked. */
  deleteStyle(id: string) {
    this.transact(() => this.setFileState({ styles: this.styles.filter((st) => st.id !== id) }));
  }

  // -------------------------------------------------------------- variables

  setVariables(next: Variables) {
    this.transact(() => this.setFileState({ variables: next }));
  }

  /** Binds a property of the given layers to a variable (or unbinds with null). */
  bind(ids: string[], prop: Bindable, varId: string | null) {
    this.updateNodes(ids, (n) => {
      const b = { ...(n.bindings ?? {}) };
      if (varId) b[prop] = varId;
      else delete b[prop];
      const next = { ...n, bindings: Object.keys(b).length ? b : undefined };
      return varId ? resolveBindings(this.doc, this.variables, next) : next;
    });
  }

  /** Chooses which mode of a collection a frame's content uses. */
  setMode(ids: string[], collectionId: string, modeId: string | null) {
    this.updateNodes(ids, (n) => {
      const m = { ...(n.modes ?? {}) };
      if (modeId) m[collectionId] = modeId;
      else delete m[collectionId];
      return { ...n, modes: Object.keys(m).length ? m : undefined };
    });
  }

  /** Groups always fit their children: refit the touched ones (deepest first); empty groups go away. */
  private fitGroups() {
    const tx = this.tx;
    if (!tx) return;
    const doc = this.doc;
    const groups = new Set<string>();
    const addChain = (id: string | null | undefined) => {
      let cur = id ? doc.get(id) : undefined;
      for (let guard = 0; cur && guard < 200; guard++) {
        if (cur.type === 'GROUP' || cur.type === 'BOOLEAN') groups.add(cur.id);
        cur = cur.parentId ? doc.get(cur.parentId) : undefined;
      }
    };
    for (const [id, before] of tx) {
      addChain(id);
      addChain(before?.parentId);
    }
    const ordered = [...groups].filter((id) => doc.has(id)).sort((a, b) => doc.depth(b) - doc.depth(a));
    for (const gid of ordered) {
      const g = doc.get(gid);
      if (!g) continue;
      const kids = doc.children(gid).map((k) => doc.get(k)!);
      if (kids.length === 0) {
        this.drop(gid);
        this.selection = this.selection.filter((s) => s !== gid);
        continue;
      }
      const pts = kids.flatMap((k) => {
        const m = localMatrix(k.x, k.y, k.rotation);
        const corners = k.type === 'LINE' ? [{ x: 0, y: 0 }, { x: k.width, y: 0 }] : [{ x: 0, y: 0 }, { x: k.width, y: 0 }, { x: k.width, y: k.height }, { x: 0, y: k.height }];
        return corners.map((c) => apply(m, c));
      });
      const b = boundsOfPoints(pts);
      const w = Math.max(0.01, round2(b.width));
      const h = Math.max(0.01, round2(b.height));
      if (Math.abs(b.x) < 0.005 && Math.abs(b.y) < 0.005 && w === g.width && h === g.height) continue;
      const origin = apply(localMatrix(g.x, g.y, g.rotation), { x: b.x, y: b.y });
      this.put({ ...g, x: round2(origin.x), y: round2(origin.y), width: w, height: h });
      for (const k of kids) this.put({ ...k, x: round2(k.x - b.x), y: round2(k.y - b.y) });
    }
  }

  /** Scales a layer's content in its own coordinates (for resizing groups). */
  private scaleContent(id: string, sx: number, sy: number) {
    for (const cid of this.doc.children(id)) {
      const c = this.doc.get(cid)!;
      if (c.type === 'LINE') {
        const [a, b] = lineEnds(c);
        this.put(lineFromEnds(c, { x: a.x * sx, y: a.y * sy }, { x: b.x * sx, y: b.y * sy }));
        continue;
      }
      const w = c.rotation === 0 ? c.width * sx : c.width;
      const h = c.rotation === 0 ? c.height * sy : c.height;
      let next: SceneNode = { ...c, x: round2(c.x * sx), y: round2(c.y * sy), width: Math.max(0.01, round2(w)), height: Math.max(0.01, round2(h)) };
      if (next.type === 'TEXT') next = fitText({ ...next, text: { ...next.text!, autoResize: 'height' } });
      this.put(next);
      if (c.type === 'GROUP') this.scaleContent(cid, sx, sy);
      else if (canHaveChildren(c) && !c.layout && c.rotation === 0) this.applyFrameConstraints(c, c.width, c.height, next.width, next.height);
    }
  }

  // ---------------------------------------------------------------- pages

  private showPage(pageId: string | undefined) {
    if (!this.pages.some((p) => p.id === this.doc.currentPage)) this.doc.setCurrentPage(this.pages[0].id);
    if (!pageId || pageId === this.doc.currentPage || !this.pages.some((p) => p.id === pageId)) return;
    this.pageViews.set(this.doc.currentPage, { ...this.viewport });
    this.doc.setCurrentPage(pageId);
    const v = this.pageViews.get(pageId);
    if (v) this.viewport = v;
    else {
      const b = this.contentBounds();
      if (b) this.zoomToRect(b, 1);
    }
  }

  switchPage(pageId: string) {
    if (pageId === this.doc.currentPage || this.isInteracting) return;
    if (this.editingText) return;
    this.showPage(pageId);
    this.selection = [];
    this.hover = null;
    this.emit('doc', 'selection', 'view', 'pages');
  }

  addPage(): string | null {
    if (this.pages.length >= MAX_PAGES) return null;
    const used = new Set(this.pages.map((p) => p.name));
    let i = this.pages.length + 1;
    while (used.has(`Page ${i}`)) i++;
    const page: Page = { id: newId(), name: `Page ${i}`, background: this.background };
    this.transact(() => this.setPages([...this.pages, page]));
    this.switchPage(page.id);
    return page.id;
  }

  renamePage(id: string, name: string) {
    const trimmed = name.trim().slice(0, 200);
    if (!trimmed) return;
    this.transact(() => this.setPages(this.pages.map((p) => (p.id === id ? { ...p, name: trimmed } : p))));
  }

  /** Top-level frames of the current page, in reading order (rows top to bottom, then left to right). */
  topFrames(): SceneNode[] {
    // frames inside sections are screens too; the sections themselves aren't
    const frames = this.doc
      .children(null)
      .flatMap((id) => (this.doc.get(id)!.section ? this.doc.children(id) : [id]))
      .map((id) => this.doc.get(id)!)
      // main components are building blocks, not screens
      .filter((n) => n.visible && !n.section && !n.slice && (n.type === 'FRAME' || n.type === 'INSTANCE'));
    return frames.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.height, b.height) / 2 ? a.y - b.y : a.x - b.x));
  }

  setPrototypeStart(frameId: string | null) {
    const id = this.doc.currentPage;
    this.transact(() => this.setPages(this.pages.map((p) => (p.id === id ? { ...p, prototypeStart: frameId ?? undefined } : p))));
    this.emit('view');
  }

  /** Tells the person something the canvas can't show (shown as a notice by the UI). */
  onNotice: ((text: string) => void) | null = null;

  /**
   * Ctrl/Cmd+Shift+O: a layer's stroke becomes a filled vector of the same look. A layer without a
   * fill turns into that vector; one with a fill keeps it and gets the outlined stroke above it.
   */
  async outlineStroke() {
    const { areaToVector, strokeArea } = await loadPathOps();
    const ids = this.selection.filter((id) => !this.doc.isEffectivelyLocked(id));
    const made: string[] = [];
    let failed = '';
    this.transact(() => {
      for (const id of ids) {
        const n = this.doc.get(id)!;
        if (!['RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE'].includes(n.type) || !n.strokes.some((p) => p.visible) || n.strokeWeight <= 0) continue;
        let vector: Vector | null;
        try {
          vector = areaToVector(strokeArea(n));
        } catch (e) {
          failed = e instanceof Error ? e.message : 'This stroke could not be outlined.';
          continue;
        }
        if (!vector) continue;
        const keepFill = n.type !== 'LINE' && n.fills.some((p) => p.visible);
        const base = {
          ...n,
          type: 'VECTOR' as const,
          vector,
          fills: n.strokes as SceneNode['fills'],
          strokes: [],
          strokeSides: undefined,
          strokeDash: [],
          radii: undefined,
          shape: undefined,
          arrowStart: undefined,
          arrowEnd: undefined,
          startBind: undefined,
          endBind: undefined,
          elbow: undefined,
          route: undefined,
          fillStyleId: n.strokeStyleId,
          strokeStyleId: undefined,
        };
        if (keepFill) {
          const sibs = this.doc.children(n.parentId);
          const above = sibs.indexOf(id) + 1;
          const out = fitVector({ ...base, id: newId(), name: `${n.name} stroke`, order: keyAt(this.doc, sibs, above), bindings: undefined });
          this.put({ ...n, strokes: [], strokeStyleId: undefined });
          this.put(out);
          made.push(out.id);
        } else {
          this.put(fitVector(base));
          made.push(id);
        }
      }
    });
    if (failed) this.onNotice?.(failed);
    if (made.length) this.setSelection(made);
  }

  /** Ctrl/Cmd+E: rectangles, ellipses, polygons, stars, lines and boolean groups become editable vectors that look the same. */
  async flattenSelection() {
    const needsOps = this.selectedNodes().some((n) => n.type === 'BOOLEAN');
    const ops = needsOps ? await loadPathOps() : pathOps;
    const ids = this.selection.filter((id) => !this.doc.isEffectivelyLocked(id));
    const changed: string[] = [];
    let skipped = false;
    this.transact(() => {
      for (const id of ids) {
        const n = this.doc.get(id)!;
        if (n.type === 'BOOLEAN') {
          let vector: Vector | null = null;
          try {
            const area = ops!.booleanArea(this.doc, n);
            vector = area && ops!.areaToVector(area);
          } catch {
            vector = null;
          }
          if (!vector) {
            skipped = true;
            continue;
          }
          for (const d of this.doc.descendants(id)) this.drop(d);
          const { booleanOp: _op, ...rest } = n;
          this.put(fitVector({ ...rest, type: 'VECTOR', vector, strokes: n.strokes }));
          changed.push(id);
          continue;
        }
        if (n.type === 'VECTOR') {
          if (n.shape) {
            this.put({ ...n, shape: undefined });
            changed.push(id);
          }
          continue;
        }
        const v = outlineVector(n, n.type === 'LINE' ? linePoints(n) : undefined);
        if (!v) continue;
        const {
          radii: _r,
          arrowStart: _as,
          arrowEnd: _ae,
          startBind: _sb,
          endBind: _eb,
          elbow: _el,
          route: _ro,
          strokeSides: _ss,
          ...rest
        } = n;
        let next: SceneNode = { ...rest, type: 'VECTOR', vector: v };
        if (n.type === 'LINE') next = fitVector({ ...next, strokeAlign: 'center' });
        this.put(next);
        changed.push(id);
      }
    });
    if (skipped) this.onNotice?.("Some boolean groups couldn't be flattened: text, groups and images inside them can't be, and very complex shapes may fail.");
    if (changed.length) this.emit('selection', 'view');
  }

  // -------------------------------------------------------------- libraries

  /** Version of a library component: a hash of its content (not where it sits). */
  static libraryVersion(doc: SceneDoc, componentId: string): string {
    const root = doc.get(componentId);
    if (!root) return '';
    const { x: _x, y: _y, parentId: _p, order: _o, pageId: _pg, ...look } = root;
    const json = JSON.stringify([look, ...doc.descendants(componentId).map((id) => doc.get(id))]);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0') + json.length.toString(16);
  }

  /** The local copy of a component from a library file, if there is one. */
  libraryCopy(fileId: string, componentId: string): SceneNode | undefined {
    for (const n of this.doc.all()) if (n.type === 'COMPONENT' && n.libraryRef?.fileId === fileId && n.libraryRef.componentId === componentId) return n;
    return undefined;
  }

  /**
   * Copies a component from another file (and the components its instances and swap properties
   * use) onto this file's "Library components" page, or brings an existing copy up to date. Layers
   * inside a copy keep the same ids from one update to the next, so instances keep their overrides.
   * References to the library file's own screens, styles and variables are dropped. Nothing changes
   * unless the result passes the same checks as a saved file. Returns the local component and the
   * images it needs from the library file.
   */
  importLibraryComponent(source: { fileId: string; nodes: SceneNode[] }, componentId: string): { id: string; images: string[] } | null {
    const src = new SceneDoc();
    src.load(source.nodes);
    if (src.get(componentId)?.type !== 'COMPONENT') return null;
    const isComp = (id: unknown): id is string => typeof id === 'string' && src.get(id)?.type === 'COMPONENT';
    // what a component needs: components of its instances, and of its swap properties' values
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (cid: string, depth: number) => {
      if (seen.has(cid) || depth > 50 || !isComp(cid)) return;
      seen.add(cid);
      for (const id of [cid, ...src.descendants(cid)]) {
        const n = src.get(id)!;
        if (n.type === 'INSTANCE' && n.componentId) visit(n.componentId, depth + 1);
        for (const v of Object.values(n.propValues ?? {})) if (isComp(v)) visit(v, depth + 1);
        for (const p of n.componentProps ?? []) if (p.type === 'INSTANCE_SWAP') visit(p.defaultValue, depth + 1);
      }
      order.push(cid);
    };
    visit(componentId, 0);
    const total = order.reduce((sum, cid) => sum + 1 + src.descendants(cid).length, 0);
    if (this.doc.size + total > MAX_NODES_PER_FILE) return null;

    // local ids: an existing copy keeps its own; layers inside derive theirs from the copy and the source
    const map = new Map<string, string>();
    for (const cid of order) map.set(cid, this.libraryCopy(source.fileId, cid)?.id ?? newId());
    const inner = (localRoot: string, sourceId: string) => `l${fnv(`${localRoot}:${sourceId}`, 0x811c9dc5)}${fnv(`${sourceId}:${localRoot}`, 0x01000193)}`;
    const localOf = (cid: string, sourceId: string) => (sourceId === cid ? map.get(cid)! : inner(map.get(cid)!, sourceId));

    let page = this.pages.find((p) => p.name === 'Library components');
    const newPage = !page;
    if (!page) {
      if (this.pages.length >= MAX_PAGES) return null;
      page = { id: newId(), name: 'Library components', background: this.background };
    }
    let bottom = Math.max(0, ...this.doc.pageChildren(page.id).map((id) => this.doc.worldBounds(id)).map((b) => b.y + b.height + 40));
    const out: SceneNode[] = [];
    const drops = new Set<string>();
    const images = new Set<string>();
    for (const cid of order) {
      const version = Editor.libraryVersion(src, cid);
      const existing = this.libraryCopy(source.fileId, cid);
      if (existing && existing.libraryRef?.version === version) continue;
      if (existing) for (const d of this.doc.descendants(existing.id)) drops.add(d);
      const root = src.get(cid)!;
      for (const sid of [cid, ...src.descendants(cid)]) {
        const n = src.get(sid)!;
        for (const p of n.fills) if (p.type === 'IMAGE') images.add(p.imageId);
        // the library file's styles, variables and screens don't exist here
        const {
          fillStyleId: _f,
          strokeStyleId: _s,
          textStyleId: _t,
          effectStyleId: _e,
          bindings: _b,
          modes: _m,
          libraryRef: _l,
          variant: _v,
          ...rest
        } = n;
        let copy: SceneNode = { ...rest, id: localOf(cid, sid), parentId: sid === cid ? null : localOf(cid, n.parentId!) };
        if (sid !== cid && n.variant) copy.variant = n.variant;
        if (copy.type === 'INSTANCE' && copy.componentId && map.has(copy.componentId)) {
          const target = copy.componentId;
          copy.componentId = map.get(target)!;
          // overrides are keyed by layers of the instance's component: those have local ids now
          if (copy.overrides)
            copy.overrides = Object.fromEntries(Object.entries(copy.overrides).map(([k, o]) => [localOf(target, k), o]));
        }
        if (copy.propValues)
          copy.propValues = Object.fromEntries(
            Object.entries(copy.propValues)
              .filter(([, v]) => !isComp(v) || map.has(v))
              .map(([k, v]) => [k, isComp(v) ? map.get(v)! : v]),
          );
        if (copy.componentProps)
          copy.componentProps = copy.componentProps.flatMap((p): ComponentProp[] =>
            p.type !== 'INSTANCE_SWAP' ? [p] : map.has(p.defaultValue) ? [{ ...p, defaultValue: map.get(p.defaultValue)! }] : [],
          );
        if (copy.reactions) {
          const kept = copy.reactions
            .filter((r) => r.action !== 'set-mode' && (!r.destinationId || src.isAncestor(cid, r.destinationId) || r.destinationId === cid))
            .map((r) => (r.destinationId ? { ...r, destinationId: localOf(cid, r.destinationId) } : r));
          copy.reactions = kept.length ? kept : undefined;
        }
        const bind = (b: SceneNode['startBind']) => (b && (src.isAncestor(cid, b.nodeId) || b.nodeId === cid) ? { ...b, nodeId: localOf(cid, b.nodeId) } : undefined);
        if (copy.startBind) copy.startBind = bind(copy.startBind);
        if (copy.endBind) copy.endBind = bind(copy.endBind);
        if (sid === cid) {
          copy = {
            ...copy,
            pageId: page.id,
            order: existing?.order ?? keyOnTop(this.doc, null),
            x: existing?.x ?? 0,
            y: existing?.y ?? bottom,
            libraryRef: { fileId: source.fileId, componentId: cid, version },
          };
          if (!existing) bottom += root.height + 40;
        }
        out.push(copy);
      }
    }
    // check the whole file as it would be before changing anything
    const replaced = new Set(out.map((n) => n.id));
    const pages = newPage ? [...this.pages, page] : this.pages;
    const after = [...[...this.doc.all()].filter((n) => !drops.has(n.id) && !replaced.has(n.id)), ...out];
    if (validateTree(after, pages)) return null;
    if (out.length) {
      this.transact(() => {
        if (newPage) this.setPages(pages);
        for (const d of drops) if (!replaced.has(d)) this.drop(d);
        for (const n of out) this.put(n);
      });
    }
    return { id: map.get(componentId)!, images: [...images] };
  }

  toggleOutlineMode() {
    this.outlineMode = !this.outlineMode;
    this.emit('view');
  }

  setPrototypeDevice(device: 'phone' | 'tablet' | 'desktop' | null) {
    const id = this.doc.currentPage;
    this.transact(() => this.setPages(this.pages.map((p) => (p.id === id ? { ...p, device: device ?? undefined } : p))));
  }

  setPrototypeView(on: boolean) {
    if (this.prototypeView === on) return;
    this.prototypeView = on;
    this.emit('view');
  }

  setPageBackground(id: string, background: string) {
    this.transact(() => this.setPages(this.pages.map((p) => (p.id === id ? { ...p, background } : p))));
    this.emit('view');
  }

  /** Gives every top-level layer an explicit page, so page order never moves layers around. */
  private pinPages() {
    for (const n of this.doc.all()) if (n.parentId === null && n.pageId === undefined) this.put({ ...n, pageId: this.doc.defaultPage });
  }

  duplicatePage(id: string) {
    if (this.pages.length >= MAX_PAGES) return;
    const src = this.pages.find((p) => p.id === id);
    if (!src) return;
    const page: Page = { id: newId(), name: `${src.name} copy`.slice(0, 200), background: src.background };
    this.transact(() => {
      this.pinPages();
      const idx = this.pages.findIndex((p) => p.id === id);
      this.setPages([...this.pages.slice(0, idx + 1), page, ...this.pages.slice(idx + 1)]);
      const roots = this.doc.pageChildren(id);
      const map = new Map<string, string>();
      const clones: SceneNode[] = [];
      for (const r of roots) clones.push(...this.cloneSubtree(r, null, this.doc.get(r)!.order, map));
      for (const c of this.remapClones(clones, map)) this.put(c.parentId === null ? { ...c, pageId: page.id } : c);
    });
    this.switchPage(page.id);
  }

  deletePage(id: string) {
    if (this.pages.length <= 1) return;
    this.transact(() => {
      this.pinPages();
      const roots = this.doc.pageChildren(id);
      const doomed = new Set<string>();
      for (const r of roots) {
        doomed.add(r);
        for (const d of this.doc.descendants(r)) doomed.add(d);
      }
      this.detachInstancesOfDeleted(doomed);
      for (const d of doomed) this.drop(d);
      const rest = this.pages.filter((p) => p.id !== id);
      this.setPages(rest);
      if (this.doc.defaultPage === id) this.doc.defaultPage = rest[0].id;
      if (this.doc.currentPage === id) this.showPage(rest[0].id);
      this.selection = [];
    });
    this.emit('selection', 'pages');
  }

  movePage(id: string, index: number) {
    const from = this.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    const list = this.pages.filter((p) => p.id !== id);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, this.pages[from]);
    this.transact(() => {
      this.pinPages();
      this.setPages(list);
    });
  }

  /** Moves the selected layers to the top level of another page, keeping their positions. */
  moveSelectionToPage(pageId: string) {
    if (pageId === this.doc.currentPage || !this.pages.some((p) => p.id === pageId)) return;
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    this.transact(() => {
      const top = this.doc.pageChildren(pageId);
      const last = top.length ? this.doc.get(top[top.length - 1])!.order : null;
      const keys = generateNKeysBetween(last, null, roots.length);
      roots.forEach((id, i) => {
        const n = this.doc.get(id)!;
        const placed = reparentKeepWorld(n, this.doc.parentWorld(n), IDENTITY);
        this.put({ ...placed, parentId: null, pageId, order: keys[i] });
      });
      this.selection = [];
    });
    this.emit('selection');
  }

  // ------------------------------------------------------------ components

  /** Turns the selected frame into a component, or wraps the selection in a new component. */
  createComponent() {
    const sel = this.selectedNodes();
    if (sel.length === 0) return;
    this.transact(() => {
      if (sel.length === 1 && sel[0].type === 'FRAME') {
        this.put({ ...sel[0], type: 'COMPONENT' });
        return;
      }
      if (sel.length === 1 && sel[0].type === 'COMPONENT') return;
      this.wrapInFrame();
      const f = this.doc.get(this.selection[0]);
      if (f) this.put({ ...f, type: 'COMPONENT', name: nextName(this.doc, 'Component'), fills: [] });
    });
  }

  /** Places a new instance of a component. Returns its id, or null if it would contain itself. */
  createInstance(componentId: string, at?: Point, parentId: string | null = null): string | null {
    const comp = this.doc.get(componentId);
    if (!comp || comp.type !== 'COMPONENT') return null;
    const sameParentId = parentId;
    const parentWorld = sameParentId === null ? IDENTITY : this.doc.world(sameParentId);
    let world: Point;
    if (at) world = { x: at.x - comp.width / 2, y: at.y - comp.height / 2 };
    else if (this.doc.pageOf(componentId) === this.doc.currentPage) {
      const b = this.doc.worldBounds(componentId);
      world = { x: b.x + b.width + 40, y: b.y };
    } else {
      const c = this.toWorld(this.viewSize.width / 2, this.viewSize.height / 2);
      world = { x: c.x - comp.width / 2, y: c.y - comp.height / 2 };
    }
    const local = apply(invert(parentWorld), world);
    const node: SceneNode = {
      ...createNode(this.doc, 'INSTANCE', sameParentId, {
        x: round2(local.x),
        y: round2(local.y),
        width: comp.width,
        height: comp.height,
      }),
      componentId,
      name: comp.name,
    };
    if (validateTree([...this.doc.all(), { ...node, pageId: sameParentId === null ? this.doc.currentPage : undefined }])) return null;
    this.transact(() => {
      this.put(node);
      this.selection = [node.id];
    });
    this.emit('selection');
    return node.id;
  }

  /** Every component in the file, on any page. */
  components(): SceneNode[] {
    return [...this.doc.all()].filter((n) => n.type === 'COMPONENT').sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Replaces instances with ordinary frames holding a copy of their content. */
  detachInstances(ids = this.selection) {
    const targets = ids.map((id) => this.doc.get(id)).filter((n): n is SceneNode => n?.type === 'INSTANCE');
    if (targets.length === 0) return;
    this.transact(() => {
      for (const inst of targets) this.materialize(inst);
    });
    this.emit('selection');
  }

  private materialize(inst: SceneNode) {
    const v = instanceDoc(this.doc, inst);
    const { componentId: _c, overrides: _o, ...base } = inst;
    if (!v) {
      this.put({ ...base, type: 'FRAME', radii: [0, 0, 0, 0], clipsContent: false });
      return;
    }
    const vroot = v.get(inst.id)!;
    this.put({
      ...base,
      type: 'FRAME',
      fills: vroot.fills,
      strokes: vroot.strokes,
      strokeWeight: vroot.strokeWeight,
      strokeAlign: vroot.strokeAlign,
      strokeDash: vroot.strokeDash,
      radii: vroot.radii ?? [0, 0, 0, 0],
      clipsContent: vroot.clipsContent ?? false,
      ...(vroot.layout ? { layout: vroot.layout } : {}),
    });
    const map = new Map<string, string>([[inst.id, inst.id]]);
    const vids = v.descendants(inst.id);
    for (const vidId of vids) map.set(vidId, newId());
    for (const vidId of vids) {
      const n = v.get(vidId)!;
      let copy: SceneNode = { ...n, id: map.get(vidId)!, parentId: map.get(n.parentId!)! };
      if (copy.startBind) copy = { ...copy, startBind: map.has(copy.startBind.nodeId) ? { ...copy.startBind, nodeId: map.get(copy.startBind.nodeId)! } : undefined };
      if (copy.endBind) copy = { ...copy, endBind: map.has(copy.endBind.nodeId) ? { ...copy.endBind, nodeId: map.get(copy.endBind.nodeId)! } : undefined };
      this.put(copy);
    }
  }

  /** Before deleting layers: instances elsewhere whose component is going away become frames. */
  private detachInstancesOfDeleted(doomed: Set<string>) {
    const comps = new Set([...doomed].filter((id) => this.doc.get(id)?.type === 'COMPONENT'));
    if (comps.size === 0) return;
    for (const n of [...this.doc.all()]) {
      if (n.type === 'INSTANCE' && n.componentId && comps.has(n.componentId) && !doomed.has(n.id)) this.materialize(n);
    }
  }

  goToMainComponent(instanceId: string) {
    const inst = this.doc.get(instanceId);
    const comp = inst?.componentId ? this.doc.get(inst.componentId) : undefined;
    if (!comp) return;
    this.switchPage(this.doc.pageOf(comp.id));
    this.setSelection([comp.id]);
    this.zoomToSelection();
  }

  setOverride(instanceId: string, sourceId: string, patch: Override | null) {
    this.updateNodes([instanceId], (n) => {
      const overrides = { ...(n.overrides ?? {}) };
      if (patch === null) delete overrides[sourceId];
      else overrides[sourceId] = { ...(overrides[sourceId] ?? {}), ...patch };
      return { ...n, overrides };
    });
  }

  resetOverrides(ids = this.selection) {
    this.updateNodes(
      ids.filter((id) => this.doc.get(id)?.type === 'INSTANCE'),
      (n) => ({ ...n, overrides: {} }),
    );
  }

  // -------------------------------------------------------------- variants

  /** Puts the selected components into one component set; each becomes a variant. */
  combineAsVariants() {
    const comps = this.selectionRoots().map((id) => this.doc.get(id)!).filter((n) => n.type === 'COMPONENT');
    if (comps.length === 0 || comps.length !== this.selectionRoots().length) return;
    const parentId = comps[0].parentId;
    if (comps.some((c) => c.parentId !== parentId)) return;
    this.transact(() => {
      comps.forEach((c, i) => {
        const variant = c.variant && Object.keys(c.variant).length ? c.variant : { 'Property 1': i === 0 ? 'Default' : `Variant${i + 1}` };
        this.put({ ...this.doc.get(c.id)!, variant, name: variantName(variant) });
      });
      this.wrapInFrame('FRAME');
      const f = this.doc.get(this.selection[0]);
      if (!f) return;
      const pad = 20;
      // breathing room around the variants, like a set on the canvas
      const set = createNode(this.doc, 'COMPONENT_SET', f.parentId, { x: f.x - pad, y: f.y - pad, width: f.width + pad * 2, height: f.height + pad * 2 });
      this.put({ ...set, id: f.id, order: f.order, name: comps[0].name.split('=')[0] === comps[0].name ? comps[0].name : 'Component 1' });
      for (const cid of this.doc.children(f.id)) {
        const c = this.doc.get(cid)!;
        this.put({ ...c, x: round2(c.x + pad), y: round2(c.y + pad) });
      }
      this.selection = [f.id];
    });
    this.emit('selection');
  }

  /** Adds a variant to a set by copying its last one, with new values. */
  addVariant(setId: string) {
    const set = this.doc.get(setId);
    if (!set || set.type !== 'COMPONENT_SET') return;
    const kids = this.doc.children(setId);
    const last = kids.length ? this.doc.get(kids[kids.length - 1]) : undefined;
    if (!last) return;
    this.transact(() => {
      const map = new Map<string, string>();
      const clones = this.remapClones(this.cloneSubtree(last.id, setId, keyOnTop(this.doc, setId), map), map);
      const props = variantOptions(this.doc, setId);
      const variant: Record<string, string> = {};
      for (const [k, values] of props) variant[k] = k === [...props.keys()][0] ? `Variant${values.length + 1}` : (last.variant?.[k] ?? values[0]);
      const root = clones[0];
      clones[0] = { ...root, variant, name: variantName(variant), y: round2(last.y + last.height + 20) };
      for (const c of clones) this.put(c);
      this.selection = [clones[0].id];
    });
    this.emit('selection');
  }

  /** Changes one variant value of a component (inside a set). */
  setVariantValue(componentId: string, prop: string, value: string) {
    const v = value.trim().slice(0, 100);
    if (!v) return;
    this.updateNodes([componentId], (n) => {
      const variant = { ...(n.variant ?? {}), [prop]: v };
      return { ...n, variant, name: variantName(variant) };
    });
  }

  /** Renames or adds a variant property across a set. */
  renameVariantProp(setId: string, from: string, to: string) {
    const name = to.trim().slice(0, 100);
    if (!name || name === from) return;
    this.transact(() => {
      for (const id of this.doc.children(setId)) {
        const c = this.doc.get(id)!;
        const entries = Object.entries(c.variant ?? {}).map(([k, v]) => [k === from ? name : k, v] as const);
        const variant = Object.fromEntries(entries);
        this.put({ ...c, variant, name: variantName(variant) });
      }
    });
  }

  addVariantProp(setId: string) {
    const existing = variantOptions(this.doc, setId);
    let i = existing.size + 1;
    while (existing.has(`Property ${i}`)) i++;
    const prop = `Property ${i}`;
    this.transact(() => {
      for (const id of this.doc.children(setId)) {
        const c = this.doc.get(id)!;
        const variant = { ...(c.variant ?? {}), [prop]: 'Default' };
        this.put({ ...c, variant, name: variantName(variant) });
      }
    });
  }

  /** Switches an instance to the variant with one property changed, keeping its overrides where layers match. */
  setVariant(instanceId: string, prop: string, value: string) {
    const inst = this.doc.get(instanceId);
    const comp = inst?.componentId ? this.doc.get(inst.componentId) : undefined;
    const set = comp?.parentId ? this.doc.get(comp.parentId) : undefined;
    if (!inst || !comp || set?.type !== 'COMPONENT_SET') return;
    const want = { ...(comp.variant ?? {}), [prop]: value };
    const variants = this.doc.children(set.id).map((id) => this.doc.get(id)!);
    const same = (v: Record<string, string> | undefined) => Object.entries(want).every(([k, val]) => v?.[k] === val);
    const target = variants.find((c) => same(c.variant)) ?? variants.find((c) => c.variant?.[prop] === value);
    if (!target || target.id === comp.id) return;
    // carry overrides over by layer path
    const byPath = new Map<string, string>();
    for (const d of this.doc.descendants(target.id)) byPath.set(namePath(this.doc, target.id, d), d);
    const overrides: Record<string, Override> = {};
    for (const [src, o] of Object.entries(inst.overrides ?? {})) {
      const to = byPath.get(namePath(this.doc, comp.id, src));
      if (to) overrides[to] = o;
    }
    const resized = inst.width !== comp.width || inst.height !== comp.height;
    this.updateNodes([instanceId], (n) => ({
      ...n,
      componentId: target.id,
      overrides,
      ...(resized ? {} : { width: target.width, height: target.height }),
    }));
    this.inner = null;
  }

  // ----------------------------------------------------- component properties

  addComponentProp(ownerId: string, type: ComponentProp['type']) {
    const owner = this.doc.get(ownerId);
    if (!owner || (owner.type !== 'COMPONENT' && owner.type !== 'COMPONENT_SET')) return;
    const list = owner.componentProps ?? [];
    if (list.length >= 50) return;
    let prop: ComponentProp;
    if (type === 'TEXT') prop = { id: newId(), name: `Text ${list.length + 1}`, type, defaultValue: 'Text' };
    else if (type === 'BOOLEAN') prop = { id: newId(), name: `Show ${list.length + 1}`, type, defaultValue: true };
    else {
      // instance swap: defaults to what the first nested instance shows, else any component
      const nested = this.doc.descendants(ownerId).map((id) => this.doc.get(id)!).find((n) => n.type === 'INSTANCE' && n.componentId);
      const any = [...this.doc.all()].find((n) => n.type === 'COMPONENT');
      const def = nested?.componentId ?? any?.id;
      if (!def) return;
      prop = { id: newId(), name: `Instance ${list.length + 1}`, type, defaultValue: def };
    }
    this.updateNodes([ownerId], (n) => ({ ...n, componentProps: [...list, prop] }));
  }

  updateComponentProp(ownerId: string, propId: string, patch: { name?: string; defaultValue?: string | boolean }) {
    this.updateNodes([ownerId], (n) => ({
      ...n,
      componentProps: (n.componentProps ?? []).map((p) => {
        if (p.id !== propId) return p;
        const name = patch.name !== undefined ? patch.name.trim().slice(0, 100) || p.name : p.name;
        if (p.type === 'TEXT') return { ...p, name, defaultValue: typeof patch.defaultValue === 'string' ? patch.defaultValue : p.defaultValue };
        if (p.type === 'INSTANCE_SWAP') {
          // a component can't show itself (or its own set's variants) inside itself
          const target = typeof patch.defaultValue === 'string' ? this.doc.get(patch.defaultValue) : undefined;
          const ok = target?.type === 'COMPONENT' && target.id !== ownerId && target.parentId !== ownerId && !this.doc.isAncestor(target.id, ownerId);
          return { ...p, name, defaultValue: ok ? target.id : p.defaultValue };
        }
        return { ...p, name, defaultValue: typeof patch.defaultValue === 'boolean' ? patch.defaultValue : p.defaultValue };
      }),
    }));
  }

  removeComponentProp(ownerId: string, propId: string) {
    this.transact(() => {
      const owner = this.doc.get(ownerId);
      if (!owner) return;
      this.put({ ...owner, componentProps: (owner.componentProps ?? []).filter((p) => p.id !== propId) });
      // unlink layers and drop instance values that used it
      for (const n of [...this.doc.all()]) {
        if (n.propRefs && (n.propRefs.characters === propId || n.propRefs.visible === propId || n.propRefs.swap === propId)) {
          const refs = { ...n.propRefs };
          if (refs.characters === propId) delete refs.characters;
          if (refs.visible === propId) delete refs.visible;
          if (refs.swap === propId) delete refs.swap;
          this.put({ ...n, propRefs: Object.keys(refs).length ? refs : undefined });
        }
        if (n.propValues && Object.hasOwn(n.propValues, propId)) {
          const values = { ...n.propValues };
          delete values[propId];
          this.put({ ...n, propValues: values });
        }
      }
    });
  }

  /** Links a layer's text or visibility to a property of the component it is in. */
  linkProp(layerId: string, field: 'characters' | 'visible' | 'swap', propId: string | null) {
    this.updateNodes([layerId], (n) => {
      const refs = { ...(n.propRefs ?? {}) };
      if (propId) refs[field] = propId;
      else delete refs[field];
      return { ...n, propRefs: Object.keys(refs).length ? refs : undefined };
    });
  }

  setPropValue(instanceId: string, propId: string, value: string | boolean) {
    const n = this.doc.get(instanceId);
    if (!n) return;
    const next = { ...n, propValues: { ...(n.propValues ?? {}), [propId]: value } };
    // a swap that would make a component show itself is refused
    if (typeof value === 'string' && this.doc.get(value)?.type === 'COMPONENT' && validateTree([...this.doc.all()].map((x) => (x.id === instanceId ? next : x)), this.pages)) return;
    this.updateNodes([instanceId], () => next);
  }

  /** The component (or set) whose properties a layer inside it can link to. */
  propOwnerOf(layerId: string): string | null {
    let cur = this.doc.get(layerId);
    while (cur && cur.parentId) {
      cur = this.doc.get(cur.parentId);
      if (cur?.type === 'COMPONENT') {
        const parent = cur.parentId ? this.doc.get(cur.parentId) : undefined;
        return parent?.type === 'COMPONENT_SET' ? parent.id : cur.id;
      }
    }
    return null;
  }

  componentPropsFor(layerId: string): ComponentProp[] {
    const owner = this.propOwnerOf(layerId);
    if (!owner) return [];
    const o = this.doc.get(owner)!;
    if (o.type === 'COMPONENT_SET') return o.componentProps ?? [];
    return componentPropsOf(this.doc, owner);
  }

  // ------------------------------------------------------- inside instances

  /** Picks the layer inside an instance under a screen point (Ctrl/Cmd-click or double-click). */
  selectInner(instanceId: string, sx: number, sy: number): boolean {
    const inst = this.doc.get(instanceId);
    if (!inst || inst.type !== 'INSTANCE') return false;
    const v = instanceDoc(this.doc, inst);
    if (!v) return false;
    const local = apply(invert(this.doc.world(instanceId)), this.toWorld(sx, sy));
    const hit = hitDeepest(v, local, this.hitTolerance());
    if (!hit || hit === instanceId) {
      this.inner = null;
      this.emit('view', 'selection');
      return false;
    }
    this.inner = { instanceId, sourceId: hit.slice(hit.indexOf('~') + 1) };
    this.selection = [instanceId];
    this.emit('view', 'selection');
    return true;
  }

  clearInner() {
    if (!this.inner) return;
    this.inner = null;
    this.emit('view', 'selection');
  }

  // ------------------------------------------------------------ auto layout

  /** Shift+A: adds auto layout to the selected frame, or wraps the selection in an auto layout frame. */
  addAutoLayout() {
    const sel = this.selectedNodes();
    if (sel.length === 0) return;
    this.transact(() => {
      let frame = sel.length === 1 && canHaveChildren(sel[0]) ? sel[0] : null;
      if (!frame) {
        this.wrapInFrame();
        frame = this.doc.get(this.selection[0]) ?? null;
        if (!frame) return;
      }
      if (frame.layout) return;
      const kids = this.doc.children(frame.id).map((id) => this.doc.get(id)!);
      // guess the direction from how the content is spread, and keep its visual order
      const spreadX = kids.length ? Math.max(...kids.map((k) => k.x)) - Math.min(...kids.map((k) => k.x)) : 0;
      const spreadY = kids.length ? Math.max(...kids.map((k) => k.y)) - Math.min(...kids.map((k) => k.y)) : 0;
      const mode: Layout['mode'] = spreadX > spreadY ? 'horizontal' : 'vertical';
      const sorted = [...kids].sort((a, b) => (mode === 'horizontal' ? a.x - b.x : a.y - b.y));
      const keys = generateNKeysBetween(null, null, sorted.length);
      sorted.forEach((k, i) => this.put({ ...k, order: keys[i] }));
      this.put({ ...this.doc.get(frame.id)!, layout: { ...DEFAULT_LAYOUT, mode } });
    });
  }

  removeAutoLayout(ids = this.selection) {
    this.updateNodes(
      ids.filter((id) => this.doc.get(id)?.layout),
      (n) => ({ ...n, layout: undefined }),
    );
    this.transact(() => {
      for (const id of ids)
        for (const c of this.doc.children(id)) {
          const k = this.doc.get(c)!;
          if (k.layoutChild) this.put({ ...k, layoutChild: undefined });
        }
    });
  }

  // ---------------------------------------------------------------- images

  /** Places an uploaded image as a rectangle with an image fill, at its natural size (scaled to fit the view). */
  insertImage(imageId: string, size: { width: number; height: number }, name: string, at?: Point): string {
    const center = at ?? this.toWorld(this.viewSize.width / 2, this.viewSize.height / 2);
    const maxW = (this.viewSize.width * 0.6) / this.viewport.zoom;
    const maxH = (this.viewSize.height * 0.6) / this.viewport.zoom;
    const s = Math.min(1, maxW / Math.max(1, size.width), maxH / Math.max(1, size.height));
    const w = Math.max(1, round2(size.width * s));
    const h = Math.max(1, round2(size.height * s));
    const parentId = at ? frameAt(this.doc, at) : null;
    const toParent = invert(parentId === null ? IDENTITY : this.doc.world(parentId));
    const tl = apply(toParent, { x: center.x - w / 2, y: center.y - h / 2 });
    const node: SceneNode = {
      ...createNode(this.doc, 'RECTANGLE', parentId, { x: round2(tl.x), y: round2(tl.y), width: w, height: h }),
      name: name.replace(/\.[A-Za-z0-9]+$/, '').trim().slice(0, 100) || 'Image',
      fills: [{ type: 'IMAGE', imageId, scaleMode: 'fill', opacity: 1, visible: true }],
    };
    this.transact(() => {
      this.put(node);
      this.selection = [node.id];
    });
    this.emit('selection');
    return node.id;
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
      w = clamp(round2(w), 0.01, MAX_SIZE);
      h = n.type === 'LINE' ? 0 : clamp(round2(h), 0.01, MAX_SIZE);
      let next: SceneNode = { ...n, width: w, height: h };
      if (n.layout) {
        // typing a size means the frame no longer hugs its content on that axis
        next = {
          ...next,
          layout: {
            ...n.layout,
            widthMode: width !== null ? 'fixed' : n.layout.widthMode,
            heightMode: height !== null ? 'fixed' : n.layout.heightMode,
          },
        };
      }
      if (n.type === 'TEXT' && width !== null && n.text!.autoResize === 'width') {
        next = { ...next, text: { ...n.text!, autoResize: 'height' } };
      }
      if (n.type === 'TEXT' && height !== null) next = { ...next, text: { ...next.text!, autoResize: 'none' } };
      this.put(fitText(next));
      if (canHaveChildren(n) && !n.layout) this.applyFrameConstraints(n, n.width, n.height, w, h);
    });
  }

  private applyFrameConstraints(frame: SceneNode, w0: number, h0: number, w1: number, h1: number) {
    const kids = this.doc.children(frame.id).map((id) => this.doc.get(id)!);
    const next = applyConstraints(kids, w0, h0, w1, h1);
    next.forEach((c, i) => {
      const before = kids[i];
      this.put(fitText(c));
      if (canHaveChildren(c) && !c.layout && (c.width !== before.width || c.height !== before.height)) {
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
      const doomed = new Set<string>();
      for (const id of this.selection) {
        if (!this.doc.has(id)) continue;
        doomed.add(id);
        for (const d of this.doc.descendants(id)) doomed.add(d);
      }
      this.detachInstancesOfDeleted(doomed);
      for (const d of doomed) this.drop(d);
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

  /** Connector ends follow copied layers when those were copied too; otherwise they let go. */
  private remapClones(clones: SceneNode[], map: Map<string, string>): SceneNode[] {
    return clones.map((c) => {
      if (c.type !== 'LINE' || (!c.startBind && !c.endBind)) return c;
      const remap = (b: Binding | undefined) => (b && map.has(b.nodeId) ? { ...b, nodeId: map.get(b.nodeId)! } : undefined);
      return { ...c, startBind: remap(c.startBind), endBind: remap(c.endBind) };
    });
  }

  duplicateSelection(offset?: Point) {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    this.transact(() => {
      const created: string[] = [];
      const map = new Map<string, string>();
      const all: SceneNode[] = [];
      for (const id of roots) {
        const n = this.doc.get(id)!;
        const clones = this.cloneSubtree(id, n.parentId, keyOnTop(this.doc, n.parentId), map);
        const root = clones[0];
        let dx = offset?.x ?? 0;
        let dy = offset?.y ?? 0;
        if (!offset && n.parentId === null && canHaveChildren(n)) dx = n.width + 40; // place new frames beside
        clones[0] = { ...root, x: round2(root.x + dx), y: round2(root.y + dy) };
        for (const c of clones) this.put(c); // put first so the next root gets a key above it
        all.push(...clones);
        created.push(clones[0].id);
      }
      for (const c of this.remapClones(all, map)) this.put(c);
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
    // main components of copied instances (and of instances inside them), for pasting into other files
    const components: SceneNode[] = [];
    const seen = new Set<string>();
    const queue = nodes.filter((n) => n.type === 'INSTANCE' && n.componentId).map((n) => n.componentId!);
    while (queue.length && components.length < 20_000) {
      const cid = queue.pop()!;
      if (seen.has(cid)) continue;
      seen.add(cid);
      const comp = this.doc.get(cid);
      if (!comp) continue;
      components.push({ ...comp, parentId: null, pageId: undefined });
      for (const d of this.doc.descendants(cid)) {
        const n = this.doc.get(d)!;
        components.push(n);
        if (n.type === 'INSTANCE' && n.componentId) queue.push(n.componentId);
      }
    }
    if (this.fileId) rememberCopiedFrom(this.fileId);
    return CLIP_PREFIX + JSON.stringify({ roots, nodes, sourceFile: this.fileId ?? undefined, components });
  }

  cutToText(): string | null {
    const text = this.copyToText();
    if (text) this.deleteSelection();
    return text;
  }

  pasteText(text: string) {
    if (text.startsWith(CLIP_PREFIX)) {
      let raw: unknown;
      try {
        raw = JSON.parse(text.slice(CLIP_PREFIX.length));
      } catch {
        return;
      }
      // Clipboard text can come from anywhere: validate it like an import before it touches the document.
      const parsed = ClipboardSchema.safeParse(raw);
      if (!parsed.success || validateTree(parsed.data.nodes)) return;
      const byId = new Map(parsed.data.nodes.map((n) => [n.id, n]));
      const roots = [...new Set(parsed.data.roots)].filter((id) => byId.get(id)?.parentId === null);
      if (roots.length === 0) return;
      if (this.doc.size + parsed.data.nodes.length > MAX_NODES_PER_FILE) return;
      const carried = parsed.data.components ?? [];
      const nodes = this.rebuildMissingInstances(parsed.data.nodes, carried.length && !validateTree(carried) ? carried : []);
      if (!nodes || this.doc.size + nodes.length > MAX_NODES_PER_FILE) return;
      this.pasteNodes(roots, nodes);
      // images come from the file they were copied from
      // only from a file this browser copied from: clipboard text alone can't pull images out of other files
      const src = parsed.data.sourceFile;
      if (src && src !== this.fileId && this.onPastedImages && copiedFrom().includes(src)) {
        const ids = new Set<string>();
        for (const n of nodes) for (const p of n.fills) if (p.type === 'IMAGE') ids.add(p.imageId);
        if (ids.size) this.onPastedImages(src, [...ids]);
      }
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

  /**
   * Instances whose main component isn't in this file become frames holding a copy of their
   * content, built from the components carried on the clipboard.
   */
  private rebuildMissingInstances(nodes: SceneNode[], components: SceneNode[]): SceneNode[] | null {
    const missing = new Set(nodes.filter((n) => n.type === 'INSTANCE' && n.componentId && !this.doc.get(n.componentId)));
    if (missing.size === 0) return nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const temp = new SceneDoc();
    temp.load([...components.filter((c) => !ids.has(c.id)), ...nodes]);
    // what the copies will add, before building any of them: stop if it can't fit in the file
    const room = MAX_NODES_PER_FILE - this.doc.size;
    const sizes = new Map<string, number>();
    let total = nodes.length;
    for (const n of missing) {
      const cid = n.componentId!;
      if (!sizes.has(cid)) sizes.set(cid, temp.has(cid) ? temp.descendants(cid).length : 0);
      total += sizes.get(cid)!;
      if (total > room) return null;
    }
    const out: SceneNode[] = [];
    for (const n of nodes) {
      if (!missing.has(n)) {
        out.push(n);
        continue;
      }
      const v = instanceDoc(temp, n);
      const { componentId: _c, overrides: _o, propValues: _p, ...base } = n;
      if (!v) {
        out.push({ ...base, type: 'FRAME', radii: [0, 0, 0, 0], clipsContent: false });
        continue;
      }
      const vroot = v.get(n.id)!;
      out.push({
        ...base,
        type: 'FRAME',
        fills: vroot.fills,
        strokes: vroot.strokes,
        strokeWeight: vroot.strokeWeight,
        strokeAlign: vroot.strokeAlign,
        strokeDash: vroot.strokeDash,
        radii: vroot.radii ?? [0, 0, 0, 0],
        clipsContent: vroot.clipsContent ?? false,
      });
      const map = new Map<string, string>([[n.id, n.id]]);
      for (const d of v.descendants(n.id)) map.set(d, newId());
      for (const d of v.descendants(n.id)) {
        const c = v.get(d)!;
        // nested instances whose components did come along stay instances only if this file has them
        const copy: SceneNode = { ...c, id: map.get(d)!, parentId: map.get(c.parentId!)!, startBind: undefined, endBind: undefined };
        if (copy.type === 'INSTANCE' && copy.componentId && !this.doc.get(copy.componentId)) {
          const { componentId: _cc, overrides: _oo, propValues: _pp, ...rest } = copy;
          out.push({ ...rest, type: 'FRAME', radii: [0, 0, 0, 0], clipsContent: false });
        } else out.push(copy);
      }
    }
    return out;
  }

  private pasteNodes(roots: string[], nodes: SceneNode[]) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const sel = this.selectedNodes();
    let parentId: string | null = null;
    if (sel.length === 1 && canHaveChildren(sel[0]) && !roots.includes(sel[0].id)) parentId = sel[0].id;
    else if (sel.length > 0) parentId = sel[0].parentId;
    if (parentId !== null && this.doc.depth(parentId) + 1 + treeDepth(roots, nodes) > MAX_DEPTH) parentId = null;
    const parentWorld = parentId === null ? IDENTITY : this.doc.world(parentId);
    try {
      this.transact(() => this.pasteInto(parentId, parentWorld, roots, nodes, byId));
    } catch {
      // the pasted layers would make an invalid file (e.g. a component inside its own instance); nothing changed
      return;
    }
    this.emit('selection');
  }

  private pasteInto(
    parentId: string | null,
    parentWorld: Mat,
    roots: string[],
    nodes: SceneNode[],
    byId: Map<string, SceneNode>,
  ) {
    {
      const keys = keysOnTop(this.doc, parentId, roots.length);
      const created: string[] = [];
      const map = new Map<string, string>();
      const pasted: SceneNode[] = [];
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
        const stack: { n: SceneNode; pid: string | null; order: string; isRoot: boolean }[] = [
          { n: root, pid: parentId, order: keys[i], isRoot: true },
        ];
        while (stack.length) {
          const { n, pid, order, isRoot } = stack.pop()!;
          if (map.has(n.id)) continue;
          const nid = newId();
          map.set(n.id, nid);
          const placed = isRoot ? reparentKeepWorld(n, IDENTITY, parentWorld) : n;
          const { pageId: _p, ...rest } = placed;
          const copy = { ...rest, id: nid, parentId: pid, order };
          this.put(copy);
          pasted.push(copy);
          if (canHaveChildren(n)) for (const c of children.get(n.id) ?? []) stack.push({ n: c, pid: nid, order: c.order, isRoot: false });
        }
        created.push(map.get(rid)!);
      });
      for (const c of this.remapClones(pasted, map)) this.put(c);
      const problem = validateTree(this.doc.all(), this.pages);
      if (problem) throw new Error(problem);
      this.selection = created;
    }
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
  /** Ctrl/Cmd+G: a group that fits the selection. */
  groupSelection() {
    this.wrapInFrame('GROUP');
  }

  /** Combines the selection into a boolean layer (union, subtract, intersect, exclude). */
  booleanSelection(op: BooleanOp) {
    const sel = this.selectedNodes();
    if (sel.length === 1 && sel[0].type === 'BOOLEAN') {
      this.updateNodes([sel[0].id], (n) => ({ ...n, booleanOp: op }));
      return;
    }
    if (this.selectionRoots().length < 2) return;
    const bottom = this.selectionRoots().map((id) => this.doc.get(id)!).sort((a, b) => (a.order < b.order ? -1 : 1))[0];
    this.transact(() => {
      this.wrapInFrame('BOOLEAN');
      const b = this.doc.get(this.selection[0]);
      if (!b) return;
      const fills = bottom.fills.length ? bottom.fills : b.fills;
      this.put({ ...b, booleanOp: op, fills, name: { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' }[op] });
    });
  }

  /** Ctrl/Cmd+Alt+M: one layer becomes (or stops being) a mask; several are grouped with the bottom one as the mask. */
  useAsMask() {
    const roots = this.selectionRoots();
    if (roots.length === 0) return;
    if (roots.length === 1) {
      this.updateNodes(roots, (n) => ({ ...n, isMask: n.isMask ? undefined : true }));
      return;
    }
    this.transact(() => {
      this.wrapInFrame('GROUP');
      const g = this.doc.get(this.selection[0]);
      if (!g) return;
      this.put({ ...g, name: 'Mask group' });
      const bottom = this.doc.children(g.id)[0];
      if (bottom) this.put({ ...this.doc.get(bottom)!, isMask: true });
    });
  }

  wrapInFrame(type: 'FRAME' | 'GROUP' | 'BOOLEAN' = 'FRAME') {
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
      const base = createNode(this.doc, type, parentId, {
        x: round2(origin.x),
        y: round2(origin.y),
        width: Math.max(1, round2(b.width)),
        height: Math.max(1, round2(b.height)),
      });
      const frame: SceneNode =
        type === 'FRAME'
          ? { ...base, order: keyAt(this.doc, sibs, topIndex), fills: [], clipsContent: false }
          : { ...base, order: keyAt(this.doc, sibs, topIndex) };
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

  /** Removes the selected groups or frames and keeps their contents in place (Ctrl/Cmd+Shift+G). */
  unwrapFrames() {
    const frames = this.selectionRoots().filter((id) => ['FRAME', 'GROUP'].includes(this.doc.get(id)!.type));
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

  /** The shape or connector whose text is being typed. */
  editingLabel: string | null = null;

  /**
   * Quick connect: with one shape selected, a "+" beyond each side (screen points). Unrotated
   * shapes only, so the new shape lines up.
   */
  quickConnectSpots(): { side: 'top' | 'right' | 'bottom' | 'left'; at: Point }[] {
    if (this.tool !== 'move' || this.selection.length !== 1 || this.isInteracting || this.editingLabel || this.editingText || this.editingVector || this.cropping) return [];
    const n = this.doc.get(this.selection[0]);
    // diagram shapes only: ordinary design layers don't sprout "+" buttons
    if (!n || n.type === 'LINE' || !isDiagramItem(n) || n.rotation !== 0 || this.doc.isEffectivelyLocked(n.id)) return [];
    const b = this.doc.worldBounds(n.id);
    const a = this.toScreen({ x: b.x, y: b.y });
    const w = b.width * this.viewport.zoom;
    const h = b.height * this.viewport.zoom;
    if (w < 24 || h < 24) return [];
    // further out for fingers, so a "+" and a side handle never share a touch
    const gap = this.coarse ? 36 : 22;
    return [
      { side: 'top', at: { x: a.x + w / 2, y: a.y - gap } },
      { side: 'right', at: { x: a.x + w + gap, y: a.y + h / 2 } },
      { side: 'bottom', at: { x: a.x + w / 2, y: a.y + h + gap } },
      { side: 'left', at: { x: a.x - gap, y: a.y + h / 2 } },
    ];
  }

  /** Adds the same shape (style and size, no text) beyond a side, joined by an elbow arrow, and starts its text. */
  quickConnect(side: 'top' | 'right' | 'bottom' | 'left') {
    const n = this.selectedNodes()[0];
    if (!n || !canHaveLabel(n) || n.type === 'LINE') return;
    const GAP = 80;
    const dx = side === 'right' ? n.width + GAP : side === 'left' ? -(n.width + GAP) : 0;
    const dy = side === 'bottom' ? n.height + GAP : side === 'top' ? -(n.height + GAP) : 0;
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
    const id = newId();
    this.transact(() => {
      const { label, ...rest } = n;
      const copy: SceneNode = {
        ...rest,
        id,
        // the next in its series: "Box 2" after "Box 1"
        name: nextName(this.doc, n.name.replace(/ \d+$/, '') || n.type),
        x: round2(n.x + dx),
        y: round2(n.y + dy),
        order: keyOnTop(this.doc, n.parentId),
        reactions: undefined,
        ...(label ? { label: { ...label, characters: '' } } : {}),
      };
      this.put(copy);
      const line = createNode(this.doc, 'LINE', n.parentId, { x: n.x, y: n.y, width: 1, height: 0 });
      this.put(
        settleLine(this.doc, {
          ...line,
          strokes: [{ color: CONNECTOR_COLOR, opacity: 1, visible: true }],
          strokeWeight: 2,
          name: nextName(this.doc, 'Arrow'),
          arrowEnd: true,
          elbow: true,
          startBind: { nodeId: n.id, anchor: side },
          endBind: { nodeId: id, anchor: opposite[side] },
        }),
      );
    });
    this.startLabelEdit(id);
  }

  /** The stamp the stamp tool drops. */
  stamp = STAMPS[0].glyph;

  setStamp(glyph: string) {
    if (!STAMPS.some((s) => s.glyph === glyph)) return;
    this.stamp = glyph;
    this.setTool('stamp');
  }

  /** Drops the current stamp centred on a point; the tool stays on for the next one. */
  placeStamp(p: Point) {
    const parentId = frameAt(this.doc, p);
    const local = apply(invert(parentId === null ? IDENTITY : this.doc.world(parentId)), p);
    const base = createNode(this.doc, 'TEXT', parentId, { x: 0, y: 0, width: 1, height: 1 });
    const n = fitText({ ...base, name: nextName(this.doc, 'Stamp'), text: { ...base.text!, characters: this.stamp, fontSize: 36, lineHeight: null, autoResize: 'width' } });
    this.transact(() => this.put({ ...n, x: round2(local.x - n.width / 2), y: round2(local.y - n.height / 2) }));
    this.emit('view');
  }

  /**
   * Adds a starting board (see templates.ts) in the middle of the view: sections, sticky notes and
   * shapes with their text, joined by connectors. Selects what it added.
   */
  insertTemplate(kind: TemplateKind) {
    const items = templateItems(kind);
    const box = templateBounds(items);
    const c = this.toWorld(this.viewSize.width / 2, this.viewSize.height / 2);
    const ox = Math.round(c.x - box.width / 2 - box.x);
    const oy = Math.round(c.y - box.height / 2 - box.y);
    const ids = new Map<string, string>();
    const top: string[] = [];
    this.transact(() => {
      for (const it of items) {
        if (it.kind === 'arrow') {
          const from = this.doc.get(ids.get(it.from)!)!;
          const line = createNode(this.doc, 'LINE', null, { x: 0, y: 0, width: 1, height: 0 });
          const n: SceneNode = {
            ...line,
            name: nextName(this.doc, 'Arrow'),
            strokes: [solid(CONNECTOR_COLOR)],
            strokeWeight: 2,
            arrowEnd: true,
            elbow: true,
            startBind: { nodeId: from.id, anchor: it.fromSide },
            endBind: { nodeId: ids.get(it.to)!, anchor: it.toSide },
          };
          const settled = settleLine(this.doc, it.text ? { ...n, label: { ...defaultLabel(n), characters: tr(it.text) } } : n);
          this.put(settled);
          top.push(settled.id);
          continue;
        }
        const parentId = 'parent' in it && it.parent ? ids.get(it.parent)! : null;
        const geom = { x: parentId ? it.x : ox + it.x, y: parentId ? it.y : oy + it.y, width: it.w, height: it.h };
        if (it.kind === 'section') {
          const s = { ...this.asShape(createNode(this.doc, 'FRAME', null, geom), 'section'), name: tr(it.name) };
          this.put(s);
          ids.set(it.key, s.id);
          top.push(s.id);
          continue;
        }
        const tool: Tool = it.kind === 'ellipse' ? 'ellipse' : it.kind;
        const type = it.kind === 'ellipse' ? 'ELLIPSE' : TOOL_TYPE[tool]!;
        let n = this.asShape(createNode(this.doc, type, parentId, geom), tool);
        if (it.kind === 'ellipse') {
          n = { ...n, name: nextName(this.doc, 'Circle'), strokes: [solid(DEFAULT_SHAPE_COLOR.stroke)], strokeWeight: 2, strokeAlign: 'inside', fills: [solid(DEFAULT_SHAPE_COLOR.fill)] };
        }
        const color = DIAGRAM_COLORS.find((d) => d.id === it.color);
        if (color) n = withDiagramColor(n, color);
        n = { ...n, label: { ...(n.label ?? defaultLabel(n)), characters: tr(it.text) } };
        n = { ...n, height: heightForLabel(n) };
        this.put(n);
        ids.set(it.key, n.id);
        if (!parentId) top.push(n.id);
      }
      if (kind === 'mindmap') this.tidyTree(ids.get('root'));
    });
    this.setTool('move');
    this.setSelection(top);
    const b = this.selectionBounds();
    if (b && (b.width * this.viewport.zoom > this.viewSize.width - 80 || b.height * this.viewport.zoom > this.viewSize.height - 160)) this.zoomToRect(b, 1, 96);
    this.emit('view', 'selection');
  }

  /** The shapes a diagram item's outgoing connectors lead to, as a tree (each shape once). */
  private treeFrom(rootId: string): Map<string, { child: string; line: string }[]> | null {
    const root = this.doc.get(rootId);
    if (!root || root.type === 'LINE') return null;
    const page = this.doc.pageOf(rootId);
    const out = new Map<string, { id: string; child: string }[]>();
    for (const n of this.doc.all()) {
      if (n.type !== 'LINE' || !n.startBind || !n.endBind || this.doc.pageOf(n.id) !== page) continue;
      const list = out.get(n.startBind.nodeId) ?? [];
      list.push({ id: n.id, child: n.endBind.nodeId });
      out.set(n.startBind.nodeId, list);
    }
    const tree = new Map<string, { child: string; line: string }[]>();
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length && seen.size < 2000) {
      const id = queue.shift()!;
      const kids: { child: string; line: string }[] = [];
      for (const e of out.get(id) ?? []) {
        const c = this.doc.get(e.child);
        // only shapes beside the root (same parent) can be laid out with it
        if (!c || seen.has(c.id) || c.parentId !== root.parentId || c.type === 'LINE') continue;
        seen.add(c.id);
        kids.push({ child: c.id, line: e.id });
        queue.push(c.id);
      }
      tree.set(id, kids);
    }
    return tree.get(rootId)?.length ? tree : null;
  }

  /** Can the selection be tidied as a tree (one shape with connectors leading on from it)? */
  canTidyTree(): boolean {
    return this.selection.length === 1 && this.treeFrom(this.selection[0]) !== null;
  }

  /**
   * Mind map tidy-up: the shapes the selected one leads to (through its connectors, and theirs)
   * are laid out as a tree to its right, each level in a column, each branch centred on its own
   * children. The root stays where it is; connectors run from right sides to left sides.
   */
  tidyTree(rootId = this.selection[0]): boolean {
    const tree = rootId ? this.treeFrom(rootId) : null;
    if (!tree) return false;
    const GAP_X = 80;
    const GAP_Y = 24;
    const node = (id: string) => this.doc.get(id)!;
    const span = new Map<string, number>();
    const spanOf = (id: string): number => {
      const kids = tree.get(id) ?? [];
      const sum = kids.reduce((t, k) => t + spanOf(k.child), 0) + GAP_Y * Math.max(0, kids.length - 1);
      const v = Math.max(node(id).height, sum);
      span.set(id, v);
      return v;
    };
    spanOf(rootId);
    // each level's column starts after the widest shape of the level before
    const depth = new Map<string, number>([[rootId, 0]]);
    const widest: number[] = [node(rootId).width];
    for (const [id, kids] of tree)
      for (const k of kids) {
        const d = depth.get(id)! + 1;
        depth.set(k.child, d);
        widest[d] = Math.max(widest[d] ?? 0, node(k.child).width);
      }
    const root = node(rootId);
    const colX = [root.x];
    for (let d = 1; d < widest.length; d++) colX[d] = colX[d - 1] + widest[d - 1] + GAP_X;
    this.transact(() => {
      const place = (id: string, top: number) => {
        const n = node(id);
        if (id !== rootId) this.put({ ...n, x: round2(colX[depth.get(id)!]), y: round2(top + (span.get(id)! - n.height) / 2) });
        const kids = tree.get(id) ?? [];
        const total = kids.reduce((t, k) => t + span.get(k.child)!, 0) + GAP_Y * Math.max(0, kids.length - 1);
        let y = top + (span.get(id)! - total) / 2;
        for (const k of kids) {
          const line = this.doc.get(k.line);
          if (line) this.put({ ...line, elbow: true, startBind: { nodeId: id, anchor: 'right' }, endBind: { nodeId: k.child, anchor: 'left' } });
          place(k.child, y);
          y += span.get(k.child)! + GAP_Y;
        }
      };
      place(rootId, root.y + root.height / 2 - span.get(rootId)! / 2);
    });
    this.emit('view');
    return true;
  }

  /**
   * Turns SVG text into editable layers (see svgImport.ts): a frame holding the drawing, centred
   * on `at` (world) or the middle of the view, selected. Throws with a message for the person
   * when the text isn't a usable SVG.
   */
  importSvgText(text: string, name: string, at?: Point): string {
    const nodes = importSvg(this.doc, text, { parentId: null, at: { x: 0, y: 0 }, name });
    const root = nodes[0];
    const c = at ?? this.toWorld(this.viewSize.width / 2, this.viewSize.height / 2);
    const placed = { ...root, x: round2(c.x - root.width / 2), y: round2(c.y - root.height / 2) };
    this.transact(() => {
      this.put(placed);
      for (const n of nodes.slice(1)) this.put(n);
    });
    this.setTool('move');
    this.setSelection([root.id]);
    this.emit('view', 'selection');
    return root.id;
  }

  /** Starts typing in a shape or on a connector (double-click or Enter), like FigJam. */
  startLabelEdit(id: string) {
    const n = this.doc.get(id);
    if (!n || !canHaveLabel(n) || this.doc.isEffectivelyLocked(id)) return;
    if (this.editingVector) this.exitVectorEdit();
    this.editingLabel = id;
    this.setSelection([id]);
    this.emit('view', 'tool');
  }

  /** Ends typing in a shape: the text is kept (an empty one removes the label). */
  commitLabelEdit(characters: string) {
    const id = this.editingLabel;
    this.editingLabel = null;
    const n = id ? this.doc.get(id) : undefined;
    if (n) {
      const text = characters.slice(0, 100_000);
      const before = n.label?.characters ?? '';
      if (text !== before) {
        this.transact(() => {
          if (!text.trim()) {
            const { label: _l, ...rest } = n;
            this.put(rest);
          } else {
            const next = { ...n, label: { ...(n.label ?? defaultLabel(n)), characters: text } };
            // the shape grows to hold its text
            this.put({ ...next, height: heightForLabel(next) });
          }
        });
      }
    }
    this.emit('view', 'tool', 'selection');
  }

  startTextEdit(id: string) {
    const n = this.doc.get(id);
    if (!n || n.type !== 'TEXT' || this.doc.isEffectivelyLocked(id)) return;
    this.editingText = id;
    this.setSelection([id]);
    this.emit('view', 'tool');
  }

  /** Ends editing. Empty text removes the layer. Joins the creation step if the layer was just created. */
  /** Selection in the text being edited, and the text typed so far (set by the text editor overlay). */
  textSelection: { start: number; end: number } | null = null;
  textDraft: string | null = null;

  setTextSelection(start: number, end: number, draft: string) {
    this.textDraft = draft;
    const next = end > start ? { start, end } : null;
    if (JSON.stringify(next) === JSON.stringify(this.textSelection)) return;
    this.textSelection = next;
    this.emit('selection');
  }

  /**
   * Makes paragraphs list items (or plain again): the paragraphs the text selection touches while
   * editing, otherwise every paragraph of the selected text layers. Toggles off when all already are.
   */
  setTextList(kind: 'bullet' | 'number') {
    const apply = (t: TextStyle, from: number, to: number): TextStyle => {
      const count = t.characters.split('\n').length;
      const first = t.characters.slice(0, from).split('\n').length - 1;
      const last = t.characters.slice(0, to).split('\n').length - 1;
      const lists = Array.from({ length: count }, (_, i) => t.lists?.[i] ?? null);
      const on = !lists.slice(first, last + 1).every((x) => x === kind);
      for (let i = first; i <= last; i++) lists[i] = on ? kind : null;
      return { ...t, lists: lists.some((x) => x) ? lists : undefined };
    };
    const editing = this.editingText ? this.doc.get(this.editingText) : undefined;
    if (editing?.text) {
      const draft = this.textDraft ?? editing.text.characters;
      const sel = this.textSelection ?? { start: draft.length, end: draft.length };
      this.transact(() => {
        const t = adjustRuns(editing.text!, draft);
        this.put(fitText({ ...editing, text: apply(t, sel.start, sel.end) }));
      });
      this.emit('view');
      return;
    }
    const ids = this.selection.filter((id) => this.doc.get(id)?.type === 'TEXT');
    this.updateNodes(ids, (n) => fitText({ ...n, text: apply(n.text!, 0, n.text!.characters.length) }));
  }

  /**
   * Styles text: the selected range while editing, otherwise the whole text of the selected layers.
   * While editing, the typed text is saved first so the range lines up.
   */
  styleText(patch: RunProps) {
    const editing = this.editingText ? this.doc.get(this.editingText) : undefined;
    if (editing?.text && this.textSelection) {
      const draft = this.textDraft ?? editing.text.characters;
      const sel = this.textSelection;
      this.transact(() => {
        const t = adjustRuns(editing.text!, draft);
        this.put(fitText({ ...editing, text: styleRange(t, sel.start, sel.end, patch) }));
      });
      return;
    }
    const ids = this.selection.filter((id) => this.doc.get(id)?.type === 'TEXT');
    this.updateNodes(ids, (n) => ({ ...n, text: styleRange(n.text!, 0, n.text!.characters.length, patch) }));
  }

  commitTextEdit(characters: string) {
    this.textSelection = null;
    this.textDraft = null;
    const id = this.editingText;
    if (!id) return;
    this.editingText = null;
    const n = this.doc.get(id);
    if (n) {
      this.transact(() => {
        if (characters.trim() === '') {
          this.drop(id);
          this.selection = [];
        } else {
          // a text layer is named after its text until someone renames it
          const auto = /^Text \d+$/.test(n.name) || n.name === textName(n.text!.characters);
          this.put(fitText({ ...n, name: auto ? textName(characters) : n.name, text: adjustRuns(n.text!, characters) }));
        }
      });
      this.mergeLastTwoIfSameNode(id);
    }
    this.emit('view', 'tool', 'selection');
  }

  // ------------------------------------------------------- find and replace

  /** Text layers on the page (or inside `within`) whose text contains `query`, with how often. */
  findText(query: string, opts: { matchCase: boolean; within?: string[] | null }): { id: string; count: number }[] {
    if (!query) return [];
    const needle = opts.matchCase ? query : query.toLocaleLowerCase();
    const page = this.doc.currentPage;
    const scope = opts.within ? new Set(opts.within.filter((id) => this.doc.has(id)).flatMap((id) => [id, ...this.doc.descendants(id)])) : null;
    const out: { id: string; count: number }[] = [];
    // in layer panel order, top to bottom
    const visit = (parentId: string | null) => {
      const kids = this.doc.children(parentId);
      for (let i = kids.length - 1; i >= 0; i--) {
        const n = this.doc.get(kids[i])!;
        if (parentId === null && this.doc.pageOf(n.id) !== page) continue;
        // text layers, and text inside shapes and on connectors
        const own = n.type === 'TEXT' ? n.text : n.label;
        if (own && (!scope || scope.has(n.id))) {
          const hay = opts.matchCase ? own.characters : own.characters.toLocaleLowerCase();
          let count = 0;
          for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count++;
          if (count) out.push({ id: n.id, count });
        }
        // instance content follows its component; it is edited there
        if (n.type !== 'INSTANCE') visit(n.id);
      }
    };
    visit(null);
    return out;
  }

  /** Replaces every match in one undo step. Styled parts of the text keep their style. Returns how many. */
  replaceText(query: string, replacement: string, opts: { matchCase: boolean; within?: string[] | null }): number {
    const found = this.findText(query, opts).filter((f) => !this.doc.isEffectivelyLocked(f.id));
    if (!found.length) return 0;
    let total = 0;
    this.transact(() => {
      for (const { id } of found) {
        const n = this.doc.get(id)!;
        let t = n.type === 'TEXT' ? n.text! : n.label!;
        const hay = opts.matchCase ? t.characters : t.characters.toLocaleLowerCase();
        const needle = opts.matchCase ? query : query.toLocaleLowerCase();
        const starts: number[] = [];
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) starts.push(at);
        // back to front, so earlier positions stay valid; one edit at a time keeps styled runs in place
        for (const at of starts.reverse()) {
          const next = t.characters.slice(0, at) + replacement + t.characters.slice(at + query.length);
          if (next.length > 100_000) break;
          t = adjustRuns(t, next);
          total++;
        }
        this.put(n.type === 'TEXT' ? fitText({ ...n, text: t }) : { ...n, label: t });
      }
    });
    this.emit('view');
    return total;
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

  /** The last press was a finger: handles, layers and "+" buttons take a bigger area. */
  coarse = false;

  /** How much bigger targets are for fingers. */
  private get reach() {
    return this.coarse ? 2.5 : 1;
  }

  private hitTolerance() {
    return (4 * this.reach) / this.viewport.zoom;
  }

  /** Screen positions of the selection handles. */
  handlePositions(): { handle: SelectionHandle; at: Point }[] {
    const sel = this.selectedNodes();
    if (sel.length === 0 || this.editingText || this.editingVector || this.cropping) return [];
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
      if (Math.hypot(at.x - sx, at.y - sy) <= HANDLE_HIT * this.reach) return handle;
    }
    // rotation zones just outside the corners (not for a single line)
    const sel = this.selectedNodes();
    if (sel.length > 1 || (sel.length === 1 && sel[0].type !== 'LINE')) {
      const { m, w, h } = this.selectionFrame();
      const center = apply(m, { x: w / 2, y: h / 2 });
      for (const corner of ['nw', 'ne', 'se', 'sw'] as Handle[]) {
        const at = apply(m, { x: HANDLE_POS[corner].x * w, y: HANDLE_POS[corner].y * h });
        const d = Math.hypot(sx - at.x, sy - at.y);
        const outward = (sx - at.x) * (at.x - center.x) + (sy - at.y) * (at.y - center.y) > 0;
        if (d <= ROTATE_ZONE * this.reach && d > HANDLE_HIT * this.reach && outward) return { kind: 'rotate', handle: corner };
      }
    }
    return null;
  }

  /** Top-level frame whose name label (drawn above it) is under the screen point. */
  frameLabelAt(sx: number, sy: number): string | null {
    // frames in sections are labelled too, and drawn above their section
    const ids = this.doc.children(null).flatMap((id) => (this.doc.get(id)!.section ? [id, ...this.doc.children(id)] : [id]));
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = this.doc.get(ids[i])!;
      if (!(canHaveChildren(n) || n.type === 'INSTANCE') || !n.visible || n.locked) continue;
      const at = this.toScreen(apply(this.doc.world(n.id), { x: 0, y: 0 }));
      const room = n.width * this.viewport.zoom;
      if (room < 24) continue;
      const w = Math.min(room, canvasMeasure(n.name, '500 11px "IBM Plex Sans", system-ui, sans-serif') + 4);
      if (sx >= at.x && sx <= at.x + w && sy >= at.y - 20 && sy <= at.y - 2) return n.id;
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  pointerDown(e: PointerInput) {
    if (this.coarse !== !!e.touch) {
      this.coarse = !!e.touch;
      this.emit('view');
    }
    if (this.editingText) return;
    const p = this.toWorld(e.sx, e.sy);
    if (e.button === 1 || (e.button === 0 && (this.tool === 'hand' || this.spaceDown))) {
      this.interaction = { kind: 'pan', start: { x: e.sx, y: e.sy }, vp: { ...this.viewport } };
      return;
    }
    if (e.button !== 0) return;
    if (this.tool === 'pen') return this.penDown(p, e);
    if (this.tool === 'pencil') {
      this.interaction = { kind: 'pencil', nodeId: null, parentId: frameAt(this.doc, p), points: [p] };
      return;
    }
    if (this.tool === 'stamp') {
      // dropped on release, so a press that turns into a pinch leaves nothing behind
      this.interaction = { kind: 'stamp', at: p };
      return;
    }
    if (this.tool === 'comment') {
      const id = hitDeepest(this.doc, p, this.hitTolerance());
      const spot: CommentSpot = { x: round2(p.x), y: round2(p.y) };
      if (id) {
        const local = apply(invert(this.doc.world(id)), p);
        spot.nodeId = id;
        spot.offset = { x: round2(local.x), y: round2(local.y) };
      }
      this.onCommentAt?.(spot, { x: e.sx, y: e.sy });
      return;
    }
    if (this.cropping) {
      const n = this.doc.get(this.cropping);
      const { paint } = n ? this.cropPaint(n) : { paint: null };
      if (n && paint && hitDeepest(this.doc, p, this.hitTolerance()) === n.id) {
        this.begin();
        this.interaction = { kind: 'crop', id: n.id, start: p, original: paint.crop ?? { x: 0, y: 0, scale: 1 } };
        return;
      }
      this.exitCrop();
    }
    if (this.editingVector) {
      const hit = this.vectorPartAt(e.sx, e.sy);
      if (hit) {
        const n = this.doc.get(this.editingVector)!;
        this.begin();
        this.vectorPoint = hit.index;
        this.interaction = { kind: 'vec-point', id: n.id, index: hit.index, part: hit.part, start: p, original: n.vector! };
        this.emit('view');
        return;
      }
      const n = this.doc.get(this.editingVector);
      if (n && hitDeepest(this.doc, p, this.hitTolerance()) === n.id) return;
      this.exitVectorEdit();
    }

    if (TOOL_TYPE[this.tool]) {
      const parentId = this.tool === 'section' ? null : frameAt(this.doc, p);
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
    const spot = this.quickConnectSpots().find((s) => Math.hypot(s.at.x - e.sx, s.at.y - e.sy) <= (this.coarse ? 16 : 10));
    // runs on release, so the new shape's text box keeps the focus
    if (spot) {
      this.interaction = { kind: 'quick-connect', side: spot.side };
      return;
    }
    const handle = this.handleAt(e.sx, e.sy);
    if (handle) return this.startHandleDrag(handle, p);
    const g = this.guideAt(e.sx, e.sy);
    if (g !== null) {
      const guide = (this.currentPage.guides ?? [])[g];
      this.interaction = { kind: 'guide', axis: guide.axis, index: g };
      this.guideDrag = { axis: guide.axis, pos: guide.pos, index: g, remove: false };
      return;
    }

    const label = this.frameLabelAt(e.sx, e.sy);
    const deepest = label ?? hitDeepest(this.doc, p, this.hitTolerance());
    let target: string | null = null;
    if (label) target = label;
    else if (deepest) target = e.mod ? deepest : pickTarget(this.doc, deepest, this.selection);
    // Ctrl/Cmd-click on an instance reaches into it
    if (e.mod && target && this.doc.get(target)?.type === 'INSTANCE' && this.selectInner(target, e.sx, e.sy)) {
      this.interaction = { kind: 'pending', start: p, startScreen: { x: e.sx, y: e.sy }, target, wasSelected: true, shift: false, scope: null };
      return;
    }
    if (this.inner && target !== this.inner.instanceId) this.inner = null;
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
      if (!label && canHaveChildren(t) && t.parentId === null && !this.selection.includes(target) && this.doc.children(target).length > 0 && deepest === target) {
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
      const loose: SceneNode = handle.end === 0 ? { ...sel[0], startBind: undefined } : { ...sel[0], endBind: undefined };
      this.put(loose);
      this.interaction = { kind: 'line-end', id: sel[0].id, end: handle.end, original: loose };
    } else if (handle.kind === 'rotate' && sel.length > 1) {
      const ids = this.selectionRoots();
      const b = this.selectionBounds()!;
      const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      this.interaction = { kind: 'rotate-many', start: p, ids, originals: new Map(ids.map((id) => [id, this.doc.get(id)!])), center };
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
      case 'pen-handle':
        return this.penDrag(p, e);
      case 'pencil': {
        const last = it.points[it.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * this.viewport.zoom < 1.5) return;
        // a stroke stops growing well under what a vector can hold (10,000 points)
        if (it.points.length >= PENCIL_MAX_POINTS) return;
        it.points.push(p);
        if (!it.nodeId) {
          this.begin();
          const node = createNode(this.doc, 'VECTOR', it.parentId, { x: 0, y: 0, width: 1, height: 1 });
          this.put({ ...node, name: nextName(this.doc, 'Drawing') });
          it.nodeId = node.id;
          this.selection = [node.id];
          this.emit('selection');
        }
        // the live preview redraws less often as the stroke grows (the final path is placed on release)
        const every = Math.max(1, Math.floor(it.points.length / 150));
        if (it.points.length % every === 0) this.placeStroke(it.nodeId, it.parentId, it.points.map((q) => ({ x: q.x, y: q.y })));
        return;
      }
      case 'crop': {
        const n = this.doc.get(it.id);
        if (!n) return;
        const d = applyVector(invert(this.doc.world(n.id)), { x: p.x - it.start.x, y: p.y - it.start.y });
        const { i } = this.cropPaint(n);
        if (i < 0) return;
        this.put({
          ...n,
          fills: n.fills.map((q, j) => (j === i && q.type === 'IMAGE' ? { ...q, crop: { ...it.original, x: round2(it.original.x + d.x), y: round2(it.original.y + d.y) } } : q)),
        });
        this.emit('doc', 'view');
        return;
      }
      case 'vec-point':
        return this.dragVectorPart(it, p, e);
      case 'none': {
        if (this.tool === 'pen') {
          this.penCursor = this.snapPoint(p, new Set(this.pen ? [this.pen.nodeId] : []));
          this.emit('view');
          return;
        }
        if (this.tool === 'move' && !this.editingText && !this.spaceDown) {
          const label = this.frameLabelAt(e.sx, e.sy);
          if (label) return this.setHover(label);
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
        this.settle();
        this.sizeBadge = { text: `${Math.round(this.doc.get(it.id)!.rotation)}°`, at: { x: e.sx + 16, y: e.sy + 16 } };
        this.emit('doc', 'view');
        return;
      }
      case 'rotate-many': {
        const a0 = Math.atan2(it.start.y - it.center.y, it.start.x - it.center.x);
        const a1 = Math.atan2(p.y - it.center.y, p.x - it.center.x);
        let delta = (a1 - a0) / DEG;
        if (e.shift) delta = Math.round(delta / 15) * 15;
        this.rotateMany(it, delta);
        this.settle();
        this.sizeBadge = { text: `${Math.round(delta)}°`, at: { x: e.sx + 16, y: e.sy + 16 } };
        this.emit('doc', 'view');
        return;
      }
      case 'guide': {
        const w = this.toWorld(e.sx, e.sy);
        const remove = it.axis === 'x' ? e.sx < RULER : e.sy < RULER;
        this.guideDrag = { axis: it.axis, pos: round2(it.axis === 'x' ? w.x : w.y), index: it.index, remove };
        this.emit('view');
        return;
      }
      case 'line-end': {
        const n = it.original;
        const toParent = invert(this.doc.parentWorld(n));
        const ends = lineEnds(n);
        const fixed = ends[1 - it.end];
        let moving = apply(toParent, this.snapPoint(p, new Set([n.id])));
        if (e.shift) moving = snapAngle(fixed, moving);
        const bind = e.mod ? null : bindingAt(this.doc, p, this.hitTolerance(), new Set([n.id]));
        this.bindTarget = bind?.nodeId ?? null;
        let next = it.end === 1 ? lineFromEnds(n, fixed, moving) : lineFromEnds(n, moving, fixed);
        if (bind) next = settleLine(this.doc, it.end === 1 ? { ...next, endBind: bind } : { ...next, startBind: bind });
        this.put(next);
        this.settle();
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
    if (it.kind === 'pen-handle') {
      this.emit('view');
      return;
    }
    if (it.kind === 'quick-connect') {
      this.quickConnect(it.side);
      return;
    }
    if (it.kind === 'stamp') {
      this.placeStamp(it.at);
      return;
    }
    if (it.kind === 'pencil') {
      // a click without a stroke draws nothing; a stroke is simplified and smoothed
      if (it.nodeId) {
        const shape = this.recognizeShapes && !e.shift ? recognizeStroke(it.points) : null;
        if (shape) this.placeRecognized(it.nodeId, it.parentId, shape);
        else this.placeStroke(it.nodeId, it.parentId, smoothPath(simplifyPoints(it.points, 1.5 / this.viewport.zoom)));
        this.end();
      }
      this.emit('view', 'selection');
      return;
    }
    if (it.kind === 'crop') {
      this.end();
      this.emit('view');
      return;
    }
    if (it.kind === 'vec-point') {
      const n = this.doc.get(it.id);
      if (n) this.put(fitVector(n));
      this.end();
      this.emit('view');
      return;
    }
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
        this.finishMove(it, this.toWorld(e.sx, e.sy));
        this.dropTarget = undefined;
        this.end();
        break;
      }
      case 'line-end': {
        const p = this.toWorld(e.sx, e.sy);
        const bind = e.mod ? null : bindingAt(this.doc, p, this.hitTolerance(), new Set([it.id]));
        const n = this.doc.get(it.id);
        if (n && bind) this.put(it.end === 1 ? { ...n, endBind: bind } : { ...n, startBind: bind });
        this.bindTarget = null;
        this.end();
        break;
      }
      case 'resize':
      case 'rotate':
      case 'rotate-many':
        this.end();
        break;
      case 'guide':
        this.finishGuide();
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
    this.bindTarget = null;
    this.guideDrag = null;
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
      if (deepest === sel && node.fills.some((f) => f.type === 'IMAGE')) return this.startCrop(sel);
      // shapes and connectors take text; plain vectors edit their points
      if (deepest === sel && canHaveLabel(node) && !(node.type === 'VECTOR' && !node.shape)) return this.startLabelEdit(sel);
      if (node.type === 'VECTOR' && deepest === sel) return this.startVectorEdit(sel);
      if (node.type === 'INSTANCE' && deepest === sel) {
        this.selectInner(sel, e.sx, e.sy);
        return;
      }
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
    else if (target === deepest && canHaveLabel(t) && !(t.type === 'VECTOR' && !t.shape) && !t.fills.some((f) => f.type === 'IMAGE')) this.startLabelEdit(target);
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

  // ----------------------------------------------------------------- pen

  private penDown(world: Point, e: PointerInput) {
    const p = this.snapPoint(world, new Set(this.pen ? [this.pen.nodeId] : []));
    if (!this.pen) {
      this.begin();
      const parentId = frameAt(this.doc, p);
      const node = createNode(this.doc, 'VECTOR', parentId, { x: 0, y: 0, width: 1, height: 1 });
      this.put(node);
      this.pen = { nodeId: node.id, parentId, points: [{ x: p.x, y: p.y }] };
      this.selection = [node.id];
      this.emit('selection');
    } else {
      const first = this.pen.points[0];
      const fs = this.toScreen(first);
      if (this.pen.points.length >= 2 && Math.hypot(fs.x - e.sx, fs.y - e.sy) <= 8) {
        this.placePen(true);
        this.finishPen();
        return;
      }
      this.pen.points.push({ x: p.x, y: p.y });
    }
    this.placePen(false);
    this.interaction = { kind: 'pen-handle' };
  }

  /** Dragging right after a click pulls out symmetric curve handles. */
  private penDrag(world: Point, e: PointerInput) {
    if (!this.pen) return;
    const last = this.pen.points[this.pen.points.length - 1];
    const dx = world.x - last.x;
    const dy = world.y - last.y;
    if (Math.hypot(dx, dy) * this.viewport.zoom < 2) return;
    this.pen.points[this.pen.points.length - 1] = {
      x: last.x,
      y: last.y,
      out: { x: world.x, y: world.y },
      in: e.alt ? last.in : { x: last.x - dx, y: last.y - dy },
    };
    this.placePen(false);
  }

  /** Writes a freehand stroke (world points) into its vector layer. */
  /** On a board, pencil strokes that look like shapes become them (see recognize.ts). */
  recognizeShapes = false;

  /**
   * Replaces a pencil stroke with the clean shape it looks like: a diagram box, ellipse, diamond
   * or triangle in the stroke's place, or a line, which connects the shapes its ends are on.
   */
  private placeRecognized(nodeId: string, parentId: string | null, shape: Recognized) {
    this.drop(nodeId);
    const toParent = invert(parentId === null ? IDENTITY : this.doc.world(parentId));
    let node: SceneNode;
    if (shape.kind === 'line') {
      const tol = this.hitTolerance();
      const skip = new Set<string>();
      const startBind = bindingAt(this.doc, shape.from, tol, skip) ?? undefined;
      const endBind = bindingAt(this.doc, shape.to, tol, skip) ?? undefined;
      const base = createNode(this.doc, 'LINE', parentId, { x: 0, y: 0, width: 1, height: 0 });
      const line = lineFromEnds(base, apply(toParent, shape.from), apply(toParent, shape.to));
      const bound = startBind || endBind;
      node = settleLine(this.doc, {
        ...line,
        name: nextName(this.doc, bound ? 'Arrow' : 'Line'),
        strokes: [solid(CONNECTOR_COLOR)],
        strokeWeight: 2,
        arrowEnd: !!bound,
        startBind,
        endBind,
      });
    } else {
      const tl = apply(toParent, { x: shape.box.x, y: shape.box.y });
      const geom = { x: round2(tl.x), y: round2(tl.y), width: round2(Math.max(8, shape.box.width)), height: round2(Math.max(8, shape.box.height)) };
      if (shape.kind === 'ellipse') {
        node = { ...createNode(this.doc, 'ELLIPSE', parentId, geom), name: nextName(this.doc, 'Circle') };
        node = { ...node, fills: [solid(DEFAULT_SHAPE_COLOR.fill)], strokes: [solid(DEFAULT_SHAPE_COLOR.stroke)], strokeWeight: 2, strokeAlign: 'inside', label: { ...defaultLabel(node), characters: '' } };
      } else if (shape.kind === 'triangle') {
        node = this.asShape(createNode(this.doc, 'VECTOR', parentId, geom), 'polygon');
        node = { ...node, name: nextName(this.doc, 'Triangle'), fills: [solid(DEFAULT_SHAPE_COLOR.fill)], strokes: [solid(DEFAULT_SHAPE_COLOR.stroke)], strokeWeight: 2, strokeAlign: 'inside', label: { ...defaultLabel(node), characters: '' } };
      } else {
        const tool: Tool = shape.kind === 'rect' ? 'box' : 'diamond';
        node = this.asShape(createNode(this.doc, TOOL_TYPE[tool]!, parentId, geom), tool);
      }
    }
    this.put(node);
    this.selection = [node.id];
  }

  private placeStroke(nodeId: string, parentId: string | null, points: VectorPoint[]) {
    const n = this.doc.get(nodeId);
    if (!n) return;
    const toParent = invert(parentId === null ? IDENTITY : this.doc.world(parentId));
    const local = (q: Point) => {
      const r = apply(toParent, q);
      return { x: round2(r.x), y: round2(r.y) };
    };
    const pts = points.map((pt) => ({ ...local(pt), ...(pt.in ? { in: local(pt.in) } : {}), ...(pt.out ? { out: local(pt.out) } : {}) }));
    this.put(fitVector({ ...n, x: 0, y: 0, rotation: 0, vector: { closed: false, points: pts } }));
    this.emit('doc', 'view');
  }

  /** Writes the pen's world points into the vector layer. */
  private placePen(closed: boolean) {
    if (!this.pen) return;
    const n = this.doc.get(this.pen.nodeId);
    if (!n) return;
    const toParent = invert(this.pen.parentId === null ? IDENTITY : this.doc.world(this.pen.parentId));
    const local = (q: Point) => apply(toParent, q);
    const points = this.pen.points.map((pt) => ({
      ...local(pt),
      ...(pt.in ? { in: local(pt.in) } : {}),
      ...(pt.out ? { out: local(pt.out) } : {}),
    }));
    this.put(fitVector({ ...n, x: 0, y: 0, rotation: 0, vector: { closed, points } }));
    this.emit('doc', 'view');
  }

  /** Ends the pen path: one point is not a path, so it is removed. */
  finishPen() {
    const pen = this.pen;
    this.pen = null;
    this.penCursor = null;
    if (!pen) return;
    const n = this.doc.get(pen.nodeId);
    if (!n || pen.points.length < 2) {
      if (n) this.drop(pen.nodeId);
      this.selection = [];
    }
    this.end();
    this.tool = 'move';
    this.emit('tool', 'view', 'selection');
  }

  /**
   * Selects every layer on the page that looks like the selected ones: same type, paints, stroke,
   * corners and font, or the same main component for instances.
   */
  selectMatching() {
    const sel = this.selectedNodes();
    if (sel.length === 0) return;
    const key = (n: SceneNode) =>
      JSON.stringify([
        n.type,
        n.type === 'INSTANCE' ? n.componentId : null,
        n.fills,
        n.strokes,
        n.strokeWeight,
        n.radii ?? null,
        n.text ? [n.text.fontFamily, n.text.fontWeight, n.text.fontSize, n.text.italic ?? false] : null,
      ]);
    const wanted = new Set(sel.map(key));
    const page = this.doc.currentPage;
    const ids = [...this.doc.all()]
      .filter((n) => this.doc.pageOf(n.id) === page && this.doc.isEffectivelyVisible(n.id) && !this.doc.isEffectivelyLocked(n.id) && wanted.has(key(n)))
      .map((n) => n.id);
    this.setSelection(ids);
  }

  /**
   * Alt measurement: distances from the selection's box to the hovered layer's box (or, with nothing
   * hovered, to the selection's parent frame). Each line is in world units with its length.
   */
  measurements(): { a: Point; b: Point; length: number }[] {
    if (!this.altDown || this.selection.length === 0 || this.isInteracting || this.editingText) return [];
    const s = this.selectionBounds();
    if (!s) return [];
    let target = this.hover && !this.selection.includes(this.hover) ? this.hover : null;
    if (!target) {
      const parents = new Set(this.selection.map((id) => this.doc.get(id)?.parentId ?? null));
      target = parents.size === 1 ? [...parents][0] : null;
    }
    if (!target || !this.doc.has(target)) return [];
    const t = this.doc.worldBounds(target);
    const out: { a: Point; b: Point; length: number }[] = [];
    const line = (a: Point, b: Point) => {
      const length = round2(Math.hypot(b.x - a.x, b.y - a.y));
      if (length > 0.005) out.push({ a, b, length });
    };
    const inside = (o: Rect, i: Rect) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height;
    if (inside(t, s) || inside(s, t)) {
      // insets on all four sides, measured through the inner box's middle
      const [o, i] = inside(t, s) ? [t, s] : [s, t];
      const icx = i.x + i.width / 2;
      const icy = i.y + i.height / 2;
      line({ x: o.x, y: icy }, { x: i.x, y: icy });
      line({ x: i.x + i.width, y: icy }, { x: o.x + o.width, y: icy });
      line({ x: icx, y: o.y }, { x: icx, y: i.y });
      line({ x: icx, y: i.y + i.height }, { x: icx, y: o.y + o.height });
      return out;
    }
    // gaps between separate boxes, through their overlap when there is one
    const sr = s.x + s.width;
    const sb = s.y + s.height;
    const tr = t.x + t.width;
    const tb = t.y + t.height;
    const oy = Math.max(s.y, t.y) < Math.min(sb, tb) ? (Math.max(s.y, t.y) + Math.min(sb, tb)) / 2 : s.y + s.height / 2;
    const ox = Math.max(s.x, t.x) < Math.min(sr, tr) ? (Math.max(s.x, t.x) + Math.min(sr, tr)) / 2 : s.x + s.width / 2;
    if (sr <= t.x) line({ x: sr, y: oy }, { x: t.x, y: oy });
    else if (tr <= s.x) line({ x: tr, y: oy }, { x: s.x, y: oy });
    if (sb <= t.y) line({ x: ox, y: sb }, { x: ox, y: t.y });
    else if (tb <= s.y) line({ x: ox, y: tb }, { x: ox, y: s.y });
    return out;
  }

  // ----------------------------------------------------------------- crop

  /** Double-click an image layer: drag to move the image inside its shape, the panel sets the zoom. */
  startCrop(id: string) {
    const n = this.doc.get(id);
    const i = n?.fills.findIndex((p) => p.type === 'IMAGE') ?? -1;
    if (!n || i < 0 || this.doc.isEffectivelyLocked(id)) return;
    const p = n.fills[i];
    if (p.type === 'IMAGE' && p.scaleMode !== 'crop') {
      this.updateNodes([id], (x) => ({ ...x, fills: x.fills.map((q, j) => (j === i && q.type === 'IMAGE' ? { ...q, scaleMode: 'crop' as const, crop: { x: 0, y: 0, scale: 1 } } : q)) }));
    }
    this.cropping = id;
    this.setSelection([id]);
    this.emit('view', 'tool');
  }

  exitCrop() {
    if (!this.cropping) return;
    this.cropping = null;
    this.emit('view', 'tool');
  }

  private cropPaint(n: SceneNode) {
    const i = n.fills.findIndex((p) => p.type === 'IMAGE' && p.scaleMode === 'crop');
    return { i, paint: i >= 0 ? (n.fills[i] as Extract<SceneNode['fills'][number], { type: 'IMAGE' }>) : null };
  }

  // ------------------------------------------------------- vector editing

  startVectorEdit(id: string) {
    const n = this.doc.get(id);
    if (!n || n.type !== 'VECTOR' || this.doc.isEffectivelyLocked(id)) return;
    this.editingVector = id;
    this.vectorPoint = null;
    this.setSelection([id]);
    this.emit('view', 'tool');
  }

  exitVectorEdit() {
    if (!this.editingVector) return;
    this.editingVector = null;
    this.vectorPoint = null;
    this.emit('view', 'tool');
  }

  /** Screen positions of the points and handles of the vector being edited. */
  vectorParts(): { index: number; part: 'point' | 'in' | 'out'; at: Point; anchor: Point }[] {
    const n = this.editingVector ? this.doc.get(this.editingVector) : undefined;
    if (!n?.vector) return [];
    const m = multiply(this.viewMatrix, this.doc.world(n.id));
    const out: { index: number; part: 'point' | 'in' | 'out'; at: Point; anchor: Point }[] = [];
    n.vector.points.forEach((pt, index) => {
      const anchor = apply(m, pt);
      if (pt.in) out.push({ index, part: 'in', at: apply(m, pt.in), anchor });
      if (pt.out) out.push({ index, part: 'out', at: apply(m, pt.out), anchor });
      out.push({ index, part: 'point', at: anchor, anchor });
    });
    return out;
  }

  private vectorPartAt(sx: number, sy: number) {
    const parts = this.vectorParts();
    for (let i = parts.length - 1; i >= 0; i--) {
      if (Math.hypot(parts[i].at.x - sx, parts[i].at.y - sy) <= 6) return parts[i];
    }
    return null;
  }

  private dragVectorPart(it: Extract<Interaction, { kind: 'vec-point' }>, p: Point, e: PointerInput) {
    const n = this.doc.get(it.id);
    if (!n) return;
    const d = applyVector(invert(this.doc.world(n.id)), { x: p.x - it.start.x, y: p.y - it.start.y });
    const points = it.original.points.map((pt) => ({ ...pt }));
    const pt = it.original.points[it.index];
    const mv = (q: Point) => ({ x: round2(q.x + d.x), y: round2(q.y + d.y) });
    if (it.part === 'point') {
      points[it.index] = { ...mv(pt), ...(pt.in ? { in: mv(pt.in) } : {}), ...(pt.out ? { out: mv(pt.out) } : {}) };
    } else {
      const moved = mv(pt[it.part]!);
      const other = it.part === 'in' ? 'out' : 'in';
      const next: VectorPoint = { ...pt, [it.part]: moved };
      // handles stay mirrored unless Alt is held
      if (!e.alt && pt[other]) next[other] = { x: round2(2 * pt.x - moved.x), y: round2(2 * pt.y - moved.y) };
      points[it.index] = next;
    }
    this.put({ ...n, vector: { ...it.original, points } });
    this.emit('doc', 'view');
  }

  private deleteVectorPoint() {
    const n = this.editingVector ? this.doc.get(this.editingVector) : undefined;
    if (!n?.vector || this.vectorPoint === null) return;
    if (n.vector.points.length <= 2) {
      this.exitVectorEdit();
      this.setSelection([n.id]);
      this.deleteSelection();
      return;
    }
    const points = n.vector.points.filter((_, i) => i !== this.vectorPoint);
    this.transact(() => this.put(fitVector({ ...n, vector: { ...n.vector!, points } })));
    this.vectorPoint = null;
    this.emit('view');
  }

  // ---------------------------------------------------------------- rotate

  /** Turns several layers together about the centre of the selection. */
  private rotateMany(it: Extract<Interaction, { kind: 'rotate-many' }>, delta: number) {
    const turn = localMatrix(0, 0, delta);
    const around = (q: Point) => {
      const v = apply(turn, { x: q.x - it.center.x, y: q.y - it.center.y });
      return { x: v.x + it.center.x, y: v.y + it.center.y };
    };
    for (const id of it.ids) {
      const o = it.originals.get(id)!;
      const pw = this.doc.parentWorld(o);
      const toParent = invert(pw);
      if (o.type === 'LINE') {
        const [a, b] = lineEnds(o).map((q) => apply(pw, q));
        this.put(lineFromEnds(o, apply(toParent, around(a)), apply(toParent, around(b))));
        continue;
      }
      const c0 = apply(multiply(pw, localMatrix(o.x, o.y, o.rotation)), { x: o.width / 2, y: o.height / 2 });
      const c1 = around(c0);
      const spun = rotateAboutCenter(o, o.rotation + delta);
      const d = applyVector(toParent, { x: c1.x - c0.x, y: c1.y - c0.y });
      this.put({ ...spun, x: round2(spun.x + d.x), y: round2(spun.y + d.y) });
    }
  }

  // ---------------------------------------------------------- guides, grids

  toggleView(flag: 'showPixelGrid' | 'snapToPixels' | 'pixelPreview') {
    this[flag] = !this[flag];
    this.emit('view');
  }

  toggleGrids() {
    this.showGrids = !this.showGrids;
    this.emit('view', 'tool');
  }

  toggleRulers() {
    this.showRulers = !this.showRulers;
    this.emit('view', 'tool');
  }

  private guideAt(sx: number, sy: number): number | null {
    const guides = this.currentPage.guides ?? [];
    for (let i = guides.length - 1; i >= 0; i--) {
      const g = guides[i];
      const s = this.toScreen(g.axis === 'x' ? { x: g.pos, y: 0 } : { x: 0, y: g.pos });
      if (g.axis === 'x' ? Math.abs(s.x - sx) <= 3 : Math.abs(s.y - sy) <= 3) return i;
    }
    return null;
  }

  /** A guide dragged out of a ruler (the UI calls this on pointer down over a ruler). */
  startGuideFromRuler(axis: 'x' | 'y') {
    this.interaction = { kind: 'guide', axis, index: null };
    this.guideDrag = { axis, pos: 0, index: null, remove: true };
    this.emit('view');
  }

  private finishGuide() {
    const drag = this.guideDrag;
    this.guideDrag = null;
    if (!drag) return;
    const page = this.currentPage;
    const list = [...(page.guides ?? [])];
    if (drag.index !== null) list.splice(drag.index, 1);
    if (!drag.remove) list.push({ axis: drag.axis, pos: drag.pos });
    if (list.length > 200) return;
    this.transact(() => this.setFileState({ pages: this.pages.map((p) => (p.id === page.id ? { ...p, guides: list } : p)) }));
  }

  clearGuides() {
    const page = this.currentPage;
    this.transact(() => this.setFileState({ pages: this.pages.map((p) => (p.id === page.id ? { ...p, guides: [] } : p)) }));
  }

  // ---------------------------------------------------------- presets, names

  /** A frame of a preset size, placed to the right of what is on the page (or in the view). */
  createFramePreset(width: number, height: number, name: string) {
    const content = this.contentBounds();
    const at = content ? { x: content.x + content.width + 80, y: content.y } : this.toWorld(this.viewSize.width / 2 - width / 2, this.viewSize.height / 2 - height / 2);
    this.transact(() => {
      const f = { ...createNode(this.doc, 'FRAME', null, { x: round2(at.x), y: round2(at.y), width, height }), name: name.slice(0, 500) };
      this.put(f);
      this.selection = [f.id];
    });
    this.setTool('move');
    this.zoomToSelection();
    this.emit('selection');
  }

  /**
   * Renames several layers at once. `pattern` may use $& (the current name) and $n (a number counting
   * from `start`, in layer order); find/replace changes part of each name.
   */
  bulkRename(ids: string[], opts: { pattern?: string; find?: string; replace?: string; start?: number }) {
    const ordered = [...ids];
    let n = opts.start ?? 1;
    this.transact(() => {
      for (const id of ordered) {
        const node = this.doc.get(id);
        if (!node) continue;
        let name = node.name;
        if (opts.find) name = name.split(opts.find).join(opts.replace ?? '');
        if (opts.pattern) name = opts.pattern.replace(/\$&/g, name).replace(/\$n/g, String(n));
        n++;
        name = name.trim().slice(0, 500);
        if (name && name !== node.name) this.put({ ...node, name });
      }
    });
  }

  /** Asks the UI to open the rename dialog (Ctrl/Cmd+R). */
  onRequestRename: (() => void) | null = null;

  // ---------------------------------------------------------------- move

  private startMove(start: Point) {
    const ids = this.selectionRoots().filter((id) => !this.doc.isEffectivelyLocked(id));
    if (ids.length === 0) return;
    const moving = new Set<string>();
    for (const id of ids) {
      moving.add(id);
      for (const d of this.doc.descendants(id)) moving.add(d);
    }
    for (const id of ids) {
      const n = this.doc.get(id)!;
      if (n.type !== 'LINE') continue;
      const keep = (b: Binding | undefined) => (b && moving.has(b.nodeId) ? b : undefined);
      if ((n.startBind && !keep(n.startBind)) || (n.endBind && !keep(n.endBind)))
        this.put({ ...n, startBind: keep(n.startBind), endBind: keep(n.endBind) });
    }
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
        if (canHaveChildren(n)) walk(id);
      }
    };
    walk(null);
    // page guides
    for (const g of this.currentPage.guides ?? []) {
      out.push(g.axis === 'x' ? { x: g.pos, y: view.y, width: 0, height: view.height } : { x: view.x, y: g.pos, width: view.width, height: 0 });
    }
    // layout grid columns and rows of visible frames
    if (this.showGrids) {
      for (const n of this.doc.all()) {
        if (!n.grids?.length || !n.visible || n.rotation !== 0 || this.doc.pageOf(n.id) !== this.doc.currentPage) continue;
        const b = this.doc.worldBounds(n.id);
        if (!rectsIntersect(b, view)) continue;
        for (const r of gridRects(n, b)) out.push(r);
      }
    }
    return out;
  }

  private snapPoint(p: Point, exclude: Set<string>): Point {
    const s = snapRect({ x: p.x, y: p.y, width: 0, height: 0 }, this.snapCandidates(exclude), 6 / this.viewport.zoom);
    this.guides = s.guides;
    const q = { x: p.x + s.dx, y: p.y + s.dy };
    return this.snapToPixels ? { x: Math.round(q.x), y: Math.round(q.y) } : q;
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
    const sameParent = parents.size === 1 && parents.has(target);
    // inside an auto layout frame, dropping reorders, so show the frame as the target too
    this.dropTarget = sameParent && !(target && this.doc.get(target)?.layout) ? undefined : target;
    // sections stay on the page
    if (target !== null && it.ids.some((id) => this.doc.get(id)?.section)) this.dropTarget = undefined;
    this.settle(new Set(it.ids));
    this.emit('doc', 'view');
  }

  private finishMove(it: Extract<Interaction, { kind: 'move' }>, p: Point) {
    const target = this.dropTarget;
    if (target === undefined) return;
    const targetWorld = target === null ? IDENTITY : this.doc.world(target);
    const frame = target ? this.doc.get(target) : undefined;
    if (frame?.layout) {
      // auto layout: the drop position picks the slot
      const local = apply(invert(targetWorld), p);
      const moving = new Set(it.ids);
      const others = this.doc.children(target).filter((id) => !moving.has(id)).map((id) => this.doc.get(id)!);
      const index = autoLayoutIndex(frame, others, local);
      const flowIds = others.filter((k) => k.visible && !k.layoutChild?.absolute).map((k) => k.id);
      const anchorId = flowIds[index - 1];
      const allIds = others.map((k) => k.id);
      const insertAt = anchorId ? allIds.indexOf(anchorId) + 1 : flowIds.length ? allIds.indexOf(flowIds[0]) : allIds.length;
      const before = insertAt > 0 ? this.doc.get(allIds[insertAt - 1])!.order : null;
      const after = insertAt < allIds.length ? this.doc.get(allIds[insertAt])!.order : null;
      const keys = generateNKeysBetween(before, after, it.ids.length);
      it.ids.forEach((id, i) => {
        const n = this.doc.get(id)!;
        const placed = n.parentId === target ? n : reparentKeepWorld(n, this.doc.parentWorld(n), targetWorld);
        this.put({ ...placed, parentId: target, order: keys[i] });
      });
      return;
    }
    const keys = keysOnTop(this.doc, target, it.ids.length);
    it.ids.forEach((id, i) => {
      const n = this.doc.get(id)!;
      if (n.parentId === target) return;
      this.put({ ...reparentKeepWorld(n, this.doc.parentWorld(n), targetWorld), parentId: target, order: keys[i] });
    });
  }

  // -------------------------------------------------------------- resize

  private updateResize(it: Extract<Interaction, { kind: 'resize' }>, p0: Point, e: PointerInput) {
    let p = p0;
    // snap the dragged edges (axis-aligned layers) to other layers, guides and grids
    const one = it.ids.length === 1 ? it.originals.get(it.ids[0])! : null;
    if (!e.alt && (it.ids.length > 1 || (one && this.doc.world(one.id)[1] === 0 && this.doc.world(one.id)[2] === 0))) {
      const exclude = new Set<string>();
      for (const id of it.ids) {
        exclude.add(id);
        for (const d of this.doc.descendants(id)) exclude.add(d);
      }
      const snap = snapRect({ x: p.x, y: p.y, width: 0, height: 0 }, this.snapCandidates(exclude), 6 / this.viewport.zoom);
      const mx = it.handle.includes('e') || it.handle.includes('w');
      const my = it.handle.startsWith('n') || it.handle.startsWith('s');
      p = { x: p.x + (mx ? snap.dx : 0), y: p.y + (my ? snap.dy : 0) };
      this.guides = snap.guides.filter((g) => (g.axis === 'x' ? mx : my));
    } else this.guides = [];
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
      if (o.layout) {
        const horizontal = it.handle.includes('e') || it.handle.includes('w');
        const vertical = it.handle.startsWith('n') || it.handle.startsWith('s');
        next = {
          ...next,
          layout: {
            ...o.layout,
            widthMode: horizontal ? 'fixed' : o.layout.widthMode,
            heightMode: vertical ? 'fixed' : o.layout.heightMode,
          },
        };
      }
      // restore all descendants first so constraints start from the originals
      for (const [id, orig] of it.originals) if (id !== o.id) this.put(orig);
      this.put(next);
      if (o.type === 'GROUP') {
        this.scaleContent(o.id, o.width > 0 ? next.width / o.width : 1, o.height > 0 ? next.height / o.height : 1);
      } else if (canHaveChildren(o) && !o.layout) {
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
          if (o.type === 'GROUP') for (const d of this.doc.descendants(o.id)) this.put(it.originals.get(d) ?? this.doc.get(d)!);
          this.put(next);
          if (o.type === 'GROUP') this.scaleContent(o.id, sx, sy);
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
    this.settle();
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
      this.put(this.asShape(withArrow, it.tool));
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
      this.bindTarget = e.mod ? null : (bindingAt(this.doc, p, this.hitTolerance(), new Set([n.id]))?.nodeId ?? null);
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
    this.settle();
    this.emit('doc', 'view');
  }

  /** A section drawn around layers on the page takes them in. */
  private adoptIntoSection(sectionId: string) {
    const s = this.doc.worldBounds(sectionId);
    const inside = this.doc
      .children(null)
      .filter((id) => {
        if (id === sectionId) return false;
        const n = this.doc.get(id)!;
        if (n.section || n.locked) return false;
        const b = this.doc.worldBounds(id);
        return b.x >= s.x && b.y >= s.y && b.x + b.width <= s.x + s.width && b.y + b.height <= s.y + s.height;
      });
    if (!inside.length) return;
    const keys = keysOnTop(this.doc, sectionId, inside.length);
    const world = this.doc.world(sectionId);
    inside.forEach((id, i) => {
      const n = this.doc.get(id)!;
      this.put({ ...reparentKeepWorld(n, IDENTITY, world), parentId: sectionId, order: keys[i] });
    });
    // the section sits behind what it holds
    const bottom = this.doc.children(null)[0];
    if (bottom !== sectionId) this.put({ ...this.doc.get(sectionId)!, order: keyAt(this.doc, this.doc.children(null), 0, new Set([sectionId])) });
  }

  /** A new vector set up as a polygon or star, or a new frame as a section, for those tools. */
  private asShape(node: SceneNode, tool: Tool): SceneNode {
    if (tool === 'slice') {
      return { ...node, name: nextName(this.doc, 'Slice'), slice: true, fills: [], strokes: [], radii: [0, 0, 0, 0], clipsContent: false };
    }
    if (tool === 'section') {
      return {
        ...node,
        name: nextName(this.doc, 'Section'),
        section: true,
        fills: [{ ...solid('#FFFFFF'), opacity: 0.6 }],
        strokes: [solid('#C9CCD1')],
        strokeWeight: 1,
        strokeAlign: 'inside',
        radii: [8, 8, 8, 8],
        clipsContent: false,
      };
    }
    if (tool === 'sticky') {
      return {
        ...node,
        name: nextName(this.doc, 'Sticky'),
        sticky: true,
        fills: [solid(DEFAULT_STICKY_COLOR.sticky)],
        strokes: [],
        radii: [6, 6, 6, 6],
        effects: [
          { type: 'DROP_SHADOW', color: '#1E1E1E', opacity: 0.08, x: 0, y: 1, blur: 2, spread: 0, visible: true },
          { type: 'DROP_SHADOW', color: '#1E1E1E', opacity: 0.1, x: 0, y: 6, blur: 14, spread: 0, visible: true },
        ],
        label: { ...defaultLabel({ ...node, sticky: true }), characters: '' },
      };
    }
    if (tool === 'box') {
      return {
        ...node,
        name: nextName(this.doc, 'Box'),
        fills: [solid(DEFAULT_SHAPE_COLOR.fill)],
        strokes: [solid(DEFAULT_SHAPE_COLOR.stroke)],
        strokeWeight: 2,
        strokeAlign: 'inside',
        radii: [12, 12, 12, 12],
        label: { ...defaultLabel(node), characters: '' },
      };
    }
    if (DIAGRAM_SHAPES.includes(tool)) {
      // diagram shapes: a soft fill with an outline of the same hue, ready for text
      return {
        ...node,
        name: nextName(this.doc, tool[0].toUpperCase() + tool.slice(1)),
        fills: [solid(DEFAULT_SHAPE_COLOR.fill)],
        strokes: [solid(DEFAULT_SHAPE_COLOR.stroke)],
        strokeWeight: 2,
        strokeAlign: 'inside',
        shape: { kind: tool as DiagramShape, count: 4, ratio: 0.5 },
      };
    }
    if (tool !== 'polygon' && tool !== 'star') return node;
    return {
      ...node,
      name: nextName(this.doc, tool === 'star' ? 'Star' : 'Polygon'),
      fills: [solid('#D9D9D9')],
      strokes: [],
      strokeWeight: 1,
      strokeAlign: 'inside',
      shape: { kind: tool, count: tool === 'star' ? 5 : 3, ratio: 0.38 },
    };
  }

  private finishCreate(it: Extract<Interaction, { kind: 'create' }>, e: PointerInput) {
    const type = TOOL_TYPE[it.tool]!;
    if (!it.nodeId) {
      // click without drag: default size at the click point
      this.begin();
      const toParent = invert(it.parentId === null ? IDENTITY : this.doc.world(it.parentId));
      const at = apply(toParent, it.start);
      let node = createNode(this.doc, type, it.parentId, {
        x: round2(at.x),
        y: round2(at.y),
        width: it.tool === 'sticky' ? 200 : it.tool === 'box' ? 160 : it.tool === 'parallelogram' || it.tool === 'chevron' || it.tool === 'document' ? 140 : 100,
        height: type === 'LINE' ? 0 : it.tool === 'sticky' ? 200 : it.tool === 'box' ? 80 : 100,
      });
      if (it.tool === 'arrow') node = { ...node, arrowEnd: true, name: nextName(this.doc, 'Arrow') };
      node = this.asShape(node, it.tool);
      if (type === 'TEXT') node = fitText({ ...node, y: round2(at.y - 10) });
      this.put(node);
      it.nodeId = node.id;
      this.selection = [node.id];
    } else if (type === 'TEXT') {
      const n = this.doc.get(it.nodeId)!;
      this.put(fitText(n));
    } else if (type === 'LINE' && !e.mod) {
      // connector: attach ends that start or finish on a shape
      const n = this.doc.get(it.nodeId)!;
      const skip = new Set([n.id]);
      const tol = this.hitTolerance();
      const startBind = bindingAt(this.doc, it.start, tol, skip) ?? undefined;
      const endBind = bindingAt(this.doc, this.toWorld(e.sx, e.sy), tol, skip) ?? undefined;
      if (startBind || endBind) {
        // a connector between diagram shapes takes the diagram look
        const ends = [startBind, endBind].map((b) => (b ? this.doc.get(b.nodeId) : undefined));
        const diagram = ends.some((e) => e && isDiagramItem(e));
        const look = diagram ? { strokes: [{ color: CONNECTOR_COLOR, opacity: 1, visible: true }], strokeWeight: 2, elbow: true } : {};
        this.put(settleLine(this.doc, { ...n, ...look, startBind, endBind }));
      }
    }
    if (it.tool === 'section' && it.nodeId) this.adoptIntoSection(it.nodeId);
    this.bindTarget = null;
    this.end();
    this.setTool('move');
    if (type === 'TEXT' && it.nodeId) {
      this.pendingTextCreate = it.nodeId;
      this.startTextEdit(it.nodeId);
    }
    // a new sticky note is for writing on
    if (it.tool === 'sticky' && it.nodeId) this.startLabelEdit(it.nodeId);
    this.emit('selection', 'view');
  }

  // ------------------------------------------------------------ keyboard

  /** Returns true when the key was handled. Letters use `code`, so shortcuts work with any keyboard layout or IME. */
  keyDown(k: KeyInput): boolean {
    if (this.editingText) return false;
    const { code, shift, alt, mod } = k;
    if (code === 'AltLeft' || code === 'AltRight') {
      if (!this.altDown) {
        this.altDown = true;
        this.emit('view');
      }
      // keeps the browser from focusing its menu bar on Alt
      return true;
    }
    if (this.pen && (code === 'Enter' || code === 'Escape' || code === 'NumpadEnter')) {
      this.finishPen();
      return true;
    }
    if (this.cropping && (code === 'Enter' || code === 'Escape')) {
      this.exitCrop();
      return true;
    }
    if (this.editingVector) {
      if (code === 'Enter' || code === 'Escape') {
        this.exitVectorEdit();
        return true;
      }
      if ((code === 'Delete' || code === 'Backspace') && this.vectorPoint !== null) {
        this.deleteVectorPoint();
        return true;
      }
    }
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
      if (this.inner) {
        this.clearInner();
        return true;
      }
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
        case 'KeyD':
          this.duplicateSelection();
          return true;
        case 'KeyA':
          if (alt) this.selectMatching();
          else this.selectAll();
          return true;
        case 'KeyG':
          // Ctrl/Cmd+G groups, Ctrl/Cmd+Alt+G wraps in a frame, Ctrl/Cmd+Shift+G ungroups or removes the frame
          if (shift) this.unwrapFrames();
          else if (alt) this.wrapInFrame();
          else this.groupSelection();
          return true;
        case 'KeyK':
          if (alt && shift) {
            this.combineAsVariants();
            return true;
          }
          if (alt) {
            this.createComponent();
            return true;
          }
          if (shift) {
            this.onRequestImage?.();
            return true;
          }
          return false;
        case 'Digit4':
          if (shift) {
            this.toggleGrids();
            return true;
          }
          return false;
        case 'KeyR':
          if (this.selection.length && this.onRequestRename) {
            this.onRequestRename();
            return true;
          }
          return false;
        case 'Enter':
        case 'NumpadEnter':
          if (alt && this.onRequestPresent) {
            this.onRequestPresent();
            return true;
          }
          return false;
        case 'KeyY':
          this.toggleOutlineMode();
          return true;
        case 'KeyE':
          if (shift) return false;
          this.flattenSelection();
          return true;
        case 'KeyO':
          if (!shift) return false;
          this.outlineStroke();
          return true;
        case 'KeyM':
          if (alt) {
            this.useAsMask();
            return true;
          }
          return false;
        case 'KeyB':
          if (alt) {
            this.detachInstances();
            return true;
          }
          return false;
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
      if (code === 'KeyR') return this.toggleRulers(), true;
      if (code === 'KeyS') return this.setTool('section'), true;
      if (code === 'KeyP') return this.setTool('pencil'), true;
      if (code === 'KeyA') {
        if (this.selection.length === 0) return false;
        this.addAutoLayout();
        return true;
      }
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
      case 'KeyP':
        this.setTool('pen');
        return true;
      case 'KeyT':
        this.setTool('text');
        return true;
      case 'KeyH':
        this.setTool('hand');
        return true;
      case 'KeyN':
        this.setTool('sticky');
        return true;
      case 'KeyE':
        this.setTool('stamp');
        return true;
      case 'KeyS':
        this.setTool('slice');
        return true;
      case 'KeyC':
        this.setTool('comment');
        return true;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        return true;
      case 'Enter': {
        const sel = this.selectedNodes();
        // diagram shapes and connectors: Enter types in them (plain vectors edit their points)
        if (sel.length === 1 && !shift && canHaveLabel(sel[0]) && !(sel[0].type === 'VECTOR' && !sel[0].shape)) {
          this.startLabelEdit(sel[0].id);
          return true;
        }
        if (sel.length === 1 && sel[0].type === 'VECTOR' && !shift) {
          this.startVectorEdit(sel[0].id);
          return true;
        }
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
    if ((k.code === 'AltLeft' || k.code === 'AltRight' || k.code === 'Blur') && this.altDown) {
      this.altDown = false;
      this.emit('view');
    }
    if (k.code === 'Space' && this.spaceDown) {
      this.spaceDown = false;
      this.emit('view');
    }
  }

  /** Cursor for the current state at a screen point. */
  cursorAt(sx: number, sy: number): string {
    const it = this.interaction.kind;
    if (this.tool === 'pen' || this.tool === 'pencil' || this.tool === 'comment' || this.tool === 'stamp') return 'crosshair';
    if (this.editingVector) return this.vectorPartAt(sx, sy) ? 'move' : 'default';
    if (it === 'pan') return 'grabbing';
    if (this.spaceDown || this.tool === 'hand') return 'grab';
    if (this.tool === 'text') return 'text';
    if (this.tool !== 'move') return 'crosshair';
    if (this.quickConnectSpots().some((s) => Math.hypot(s.at.x - sx, s.at.y - sy) <= 10)) return 'pointer';
    if (it === 'guide' || this.guideAt(sx, sy) !== null) {
      const axis = this.guideDrag?.axis ?? (this.currentPage.guides ?? [])[this.guideAt(sx, sy) ?? 0]?.axis;
      return axis === 'x' ? 'col-resize' : 'row-resize';
    }
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
