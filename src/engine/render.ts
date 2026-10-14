import { type Effect, type GradientPaint, type ImagePaint, type Paint, type SceneNode, type ShadowEffect, type SolidPaint, isGradientPaint } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { getImage } from './images.ts';
import { instanceDoc } from './instances.ts';
import { type Point, type Rect, boundsOfPoints, localMatrix, rectsIntersect } from './math.ts';
import { linePoints } from './geometry.ts';
import { fontString, layoutText, lineOffset } from './text.ts';
import { tracePath } from './vector.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type DrawOptions = {
  /** Nodes drawn by something else (the text being edited). */
  skip?: Set<string>;
  /** World area that is visible; layers fully outside it are not drawn. */
  cull?: Rect;
  /** The file's document, where instances find their components (set automatically). */
  root?: SceneDoc;
  /** How many instances deep we are, to stop runaway nesting. */
  depth?: number;
  /** Layers inside instances that may still be drawn in this pass (shared by the whole pass). */
  budget?: { left: number };
};

/** Upper bound on instance content drawn per frame, whatever the file says. */
export const INSTANCE_DRAW_BUDGET = 200_000;

const MAX_INSTANCE_DEPTH = 12;
/** Largest offscreen layer for effects, in device pixels per side. */
const MAX_LAYER = 4096;

const isBox = (n: SceneNode) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET';

/** How far effects reach outside a layer's box, in its own units. */
export function effectReach(n: SceneNode): number {
  let r = 0;
  for (const e of n.effects ?? []) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW') r = Math.max(r, Math.abs(e.x) + Math.abs(e.y) + e.blur * 1.5 + Math.max(0, e.spread));
    if (e.type === 'LAYER_BLUR') r = Math.max(r, e.radius * 1.5);
  }
  return r;
}

/** A line's own-coordinate box with room for its stroke and arrowheads. */
function lineBox(n: SceneNode): Rect {
  const b = boundsOfPoints(linePoints(n));
  const pad = n.strokeWeight * 4 + 10;
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

function culled(doc: SceneDoc, n: SceneNode, cull: Rect | undefined): boolean {
  if (!cull) return false;
  // Frames that don't clip, and groups, can have children anywhere: only skip what can't reach the view.
  if ((isBox(n) && !n.clipsContent) || n.type === 'GROUP') return false;
  const b = doc.worldBounds(n.id);
  const pad = n.strokeWeight * 2 + (n.type === 'LINE' ? 20 + n.strokeWeight * 4 : 0) + effectReach(n);
  return !rectsIntersect({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, cull);
}

export function rgba(color: string, alpha: number): string {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

export function paintCss(p: SolidPaint, extraAlpha = 1): string {
  return rgba(p.color, p.opacity * extraAlpha);
}

/** A canvas gradient in the layer's own coordinates (unit box scaled to w x h). */
function gradientStyle(ctx: Ctx, p: GradientPaint, w: number, h: number): CanvasGradient {
  const fx = p.from.x * w;
  const fy = p.from.y * h;
  const tx = p.to.x * w;
  const ty = p.to.y * h;
  const g =
    p.type === 'GRADIENT_LINEAR'
      ? ctx.createLinearGradient(fx, fy, tx, ty)
      : ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(0.01, Math.hypot(tx - fx, ty - fy)));
  const stops = [...p.stops].sort((a, b) => a.position - b.position);
  for (const s of stops) g.addColorStop(s.position, rgba(s.color, s.opacity * p.opacity));
  return g;
}

/** Fill or stroke style for a solid or gradient paint. */
export function paintStyle(ctx: Ctx, p: SolidPaint | GradientPaint, w: number, h: number): string | CanvasGradient {
  return isGradientPaint(p) ? gradientStyle(ctx, p, w, h) : paintCss(p);
}

export function clampRadii(n: SceneNode): [number, number, number, number] {
  const r = n.radii ?? [0, 0, 0, 0];
  const max = Math.min(n.width, n.height) / 2;
  return r.map((v) => Math.max(0, Math.min(v, max))) as [number, number, number, number];
}

/** Adds a layer's own outline to the current path, grown by `grow` (for shadow spread). */
function addShape(ctx: Ctx, n: SceneNode, grow = 0) {
  if (n.type === 'VECTOR' && n.vector) {
    tracePath(ctx, n.vector);
    return;
  }
  const w = Math.max(0, n.width + grow * 2);
  const h = Math.max(0, n.height + grow * 2);
  if (n.type === 'ELLIPSE') {
    ctx.ellipse(n.width / 2, n.height / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    const [tl, tr, br, bl] = clampRadii(n).map((r) => (r > 0 ? Math.max(0, r + grow) : 0));
    if (tl || tr || br || bl) ctx.roundRect(-grow, -grow, w, h, [tl, tr, br, bl]);
    else ctx.rect(-grow, -grow, w, h);
  }
}

function shapePath(ctx: Ctx, n: SceneNode, grow = 0) {
  ctx.beginPath();
  addShape(ctx, n, grow);
}

/** Open paths can only be stroked along their centre line. */
const strokeAlignOf = (n: SceneNode) => (n.type === 'VECTOR' && !n.vector?.closed ? 'center' : n.strokeAlign);

/** Where an image lands inside a w x h box for a scale mode. */
export function imageRect(p: ImagePaint, iw: number, ih: number, w: number, h: number): Rect {
  if (p.scaleMode === 'stretch' || iw <= 0 || ih <= 0) return { x: 0, y: 0, width: w, height: h };
  if (p.scaleMode === 'crop') {
    const c = p.crop ?? { x: 0, y: 0, scale: 1 };
    const s = Math.max(w / iw, h / ih) * c.scale;
    return { x: (w - iw * s) / 2 + c.x, y: (h - ih * s) / 2 + c.y, width: iw * s, height: ih * s };
  }
  const s = p.scaleMode === 'fill' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  return { x: (w - iw * s) / 2, y: (h - ih * s) / 2, width: iw * s, height: ih * s };
}

function fillImage(ctx: Ctx, n: SceneNode, p: ImagePaint) {
  const img = getImage(p.imageId);
  ctx.save();
  ctx.clip();
  if (!img) {
    // placeholder while the image loads
    ctx.fillStyle = 'rgba(128, 128, 128, 0.18)';
    ctx.fillRect(0, 0, n.width, n.height);
  } else {
    const r = imageRect(p, img.naturalWidth, img.naturalHeight, n.width, n.height);
    ctx.globalAlpha *= p.opacity;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}

function fillShape(ctx: Ctx, n: SceneNode) {
  for (const p of n.fills) {
    if (!p.visible) continue;
    if (p.type === 'IMAGE') {
      fillImage(ctx, n, p);
      continue;
    }
    ctx.fillStyle = paintStyle(ctx, p, n.width, n.height);
    ctx.fill();
  }
}

function strokeShape(ctx: Ctx, n: SceneNode) {
  const paints = n.strokes.filter((p) => p.visible);
  if (paints.length === 0 || n.strokeWeight <= 0) return;
  ctx.save();
  ctx.setLineDash(n.strokeDash);
  ctx.lineJoin = n.type === 'VECTOR' ? 'round' : 'miter';
  ctx.lineCap = n.type === 'VECTOR' ? 'round' : 'butt';
  const align = strokeAlignOf(n);
  if (align === 'center') {
    ctx.lineWidth = n.strokeWeight;
  } else if (align === 'inside') {
    ctx.clip();
    ctx.lineWidth = n.strokeWeight * 2;
  } else {
    // outside: clip to everything except the shape
    const pad = n.strokeWeight * 2 + 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-pad, -pad, n.width + pad * 2, n.height + pad * 2);
    addShape(ctx, n);
    ctx.clip('evenodd');
    shapePath(ctx, n);
    ctx.lineWidth = n.strokeWeight * 2;
    for (const p of paints) {
      ctx.strokeStyle = paintStyle(ctx, p, n.width, n.height);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    return;
  }
  for (const p of paints) {
    ctx.strokeStyle = paintStyle(ctx, p, n.width, n.height);
    ctx.stroke();
  }
  ctx.restore();
}

export function arrowSize(strokeWeight: number) {
  return { length: 6 + strokeWeight * 3, halfWidth: 3 + strokeWeight * 1.6 };
}

/**
 * A line's stroke (trimmed where arrowheads sit) and its arrowhead triangles, in its own
 * coordinates. Heads point along the first and last segments, so elbows get them right too.
 */
export function lineShape(n: SceneNode): { points: Point[]; heads: Point[][] } {
  const pts = linePoints(n).map((p) => ({ ...p }));
  const { length: al, halfWidth: aw } = arrowSize(n.strokeWeight);
  const heads: Point[][] = [];
  const head = (tip: Point, from: Point, end: 'start' | 'end') => {
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return;
    const ux = dx / d;
    const uy = dy / d;
    const trim = Math.min(al * 0.8, d / 2);
    const back = { x: tip.x - ux * al, y: tip.y - uy * al };
    heads.push([tip, { x: back.x + uy * aw, y: back.y - ux * aw }, { x: back.x - uy * aw, y: back.y + ux * aw }]);
    const k = end === 'end' ? pts.length - 1 : 0;
    pts[k] = { x: tip.x - ux * trim, y: tip.y - uy * trim };
  };
  const tipEnd = pts[pts.length - 1];
  const tipStart = pts[0];
  if (n.arrowEnd) head(tipEnd, pts[pts.length - 2], 'end');
  if (n.arrowStart) head(tipStart, pts[1], 'start');
  return { points: pts, heads };
}

function drawLine(ctx: Ctx, n: SceneNode) {
  const paints = n.strokes.filter((p) => p.visible);
  if (paints.length === 0 || n.strokeWeight <= 0) return;
  const shape = lineShape(n);
  const len = n.width;
  ctx.save();
  ctx.lineWidth = n.strokeWeight;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.setLineDash(n.strokeDash);
  for (const p of paints) {
    const style = paintStyle(ctx, p, Math.max(1, len), Math.max(1, n.strokeWeight));
    ctx.strokeStyle = style;
    ctx.fillStyle = style;
    ctx.beginPath();
    shape.points.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
    for (const head of shape.heads) {
      ctx.beginPath();
      head.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawText(ctx: Ctx, n: SceneNode) {
  const t = n.text!;
  const layout = layoutText(t, t.autoResize === 'width' ? null : n.width);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${t.letterSpacing}px`;
  ctx.textBaseline = 'alphabetic';
  const fills = n.fills.filter((p) => p.visible && p.type !== 'IMAGE');
  for (const line of layout.lines) {
    const x0 = lineOffset(t.align, n.width, line.width);
    for (const seg of line.segments) {
      ctx.font = fontString(seg.style);
      const x = x0 + seg.x;
      // a run's own colour replaces the layer's fills for that stretch
      const paints = seg.style.color ? [{ color: seg.style.color, opacity: 1, visible: true } as SolidPaint] : fills;
      for (const p of paints) {
        if (p.type === 'IMAGE') continue;
        ctx.fillStyle = paintStyle(ctx, p, n.width, n.height);
        ctx.fillText(seg.text, x, line.baseline);
        if (seg.style.decoration !== 'none') {
          const size = seg.style.fontSize;
          const thick = Math.max(1, size / 14);
          const y = seg.style.decoration === 'underline' ? line.baseline + size * 0.12 : line.baseline - size * 0.3;
          ctx.fillRect(x, y - thick / 2, seg.width, thick);
        }
      }
    }
  }
}

/** Fills, content and strokes of a frame-like box (frame, component, or an instance's content). */
function drawContainer(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions) {
  shapePath(ctx, n);
  fillShape(ctx, n);
  ctx.save();
  if (n.clipsContent) {
    shapePath(ctx, n);
    ctx.clip();
  }
  drawChildren(ctx, doc, n.id, opts);
  ctx.restore();
  shapePath(ctx, n);
  strokeShape(ctx, n);
}

function drawMissingComponent(ctx: Ctx, n: SceneNode) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, n.width, n.height);
  ctx.restore();
}

/** The layer itself, without effects, in its own coordinates. */
function drawBody(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions, root: SceneDoc) {
  switch (n.type) {
    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
      drawContainer(ctx, doc, n, { ...opts, root });
      break;
    case 'GROUP':
      drawChildren(ctx, doc, n.id, { ...opts, root });
      break;
    case 'BOOLEAN':
      drawBoolean(ctx, doc, n, { ...opts, root });
      break;
    case 'VECTOR':
      shapePath(ctx, n);
      fillShape(ctx, n);
      strokeShape(ctx, n);
      break;
    case 'INSTANCE': {
      const depth = opts.depth ?? 0;
      const budget = opts.budget ?? { left: INSTANCE_DRAW_BUDGET };
      const v = depth < MAX_INSTANCE_DEPTH && budget.left > 0 ? instanceDoc(root, n) : null;
      if (!v) drawMissingComponent(ctx, n);
      else drawContainer(ctx, v, v.get(n.id)!, { root, depth: depth + 1, budget });
      break;
    }
    case 'RECTANGLE':
    case 'ELLIPSE':
      shapePath(ctx, n);
      fillShape(ctx, n);
      strokeShape(ctx, n);
      break;
    case 'LINE':
      drawLine(ctx, n);
      break;
    case 'TEXT':
      drawText(ctx, n);
      break;
  }
}

// ------------------------------------------------------------------ effects

/** Layers whose shadows follow their own outline (with spread); others cast the shadow of what they draw. */
const hasShapeOutline = (n: SceneNode) =>
  n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || (n.type === 'VECTOR' && !!n.vector?.closed) || isBox(n);

// ------------------------------------------------------------------ booleans

const BOOLEAN_COMPOSITE: Record<string, GlobalCompositeOperation> = {
  union: 'source-over',
  subtract: 'destination-out',
  intersect: 'destination-in',
  exclude: 'xor',
};

/** A child's shape in solid black (its alpha is what counts). */
function silhouette(ctx: Ctx, doc: SceneDoc, k: SceneNode, opts: DrawOptions) {
  if (!k.visible) return;
  if (k.type === 'RECTANGLE' || k.type === 'ELLIPSE' || k.type === 'VECTOR' || isBox(k) || k.type === 'INSTANCE') {
    ctx.save();
    const m = localMatrix(k.x, k.y, k.rotation);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    shapePath(ctx, k);
    ctx.fillStyle = '#000';
    if (k.type === 'VECTOR' && !k.vector?.closed) {
      ctx.lineWidth = Math.max(1, k.strokeWeight);
      ctx.strokeStyle = '#000';
      ctx.stroke();
    } else ctx.fill();
    ctx.restore();
    return;
  }
  if (k.type === 'GROUP') {
    ctx.save();
    const m = localMatrix(k.x, k.y, k.rotation);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    for (const id of doc.children(k.id)) silhouette(ctx, doc, doc.get(id)!, opts);
    ctx.restore();
    return;
  }
  drawNode(ctx, doc, k, opts);
}

/** The children combined by the operation, painted with the boolean's own fills. */
function drawBoolean(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions) {
  const kids = doc.children(n.id).map((id) => doc.get(id)!).filter((k) => k.visible);
  if (kids.length === 0) return;
  const layer = renderLayer(ctx, { x: -2, y: -2, width: n.width + 4, height: n.height + 4 }, (lc) => {
    kids.forEach((k, i) => {
      lc.globalCompositeOperation = i === 0 ? 'source-over' : BOOLEAN_COMPOSITE[n.booleanOp ?? 'union'];
      silhouette(lc, doc, k, opts);
    });
    let first = true;
    for (const p of n.fills) {
      if (!p.visible) continue;
      lc.globalCompositeOperation = first ? 'source-in' : 'source-atop';
      first = false;
      lc.beginPath();
      lc.rect(-2, -2, n.width + 4, n.height + 4);
      if (p.type === 'IMAGE') {
        lc.save();
        lc.beginPath();
        lc.rect(0, 0, n.width, n.height);
        fillImage(lc, n, p);
        lc.restore();
      } else {
        lc.fillStyle = paintStyle(lc, p, n.width, n.height);
        lc.fill();
      }
    }
    if (first) {
      // no visible fill: nothing shows
      lc.globalCompositeOperation = 'destination-out';
      lc.fillRect(-2, -2, n.width + 4, n.height + 4);
    }
    lc.globalCompositeOperation = 'source-over';
  });
  if (!layer) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer.canvas, layer.x, layer.y);
  ctx.restore();
}

// ------------------------------------------------------------------ masks

/** Clips everything drawn next to the mask layer's shape (its box if it has no outline). */
function clipToMask(ctx: Ctx, n: SceneNode) {
  const t = ctx.getTransform();
  const m = localMatrix(n.x, n.y, n.rotation);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.beginPath();
  if (n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'VECTOR' || isBox(n)) addShape(ctx, n);
  else ctx.rect(0, 0, n.width, n.height);
  ctx.clip();
  ctx.setTransform(t);
}

function deviceScale(ctx: Ctx): number {
  const m = ctx.getTransform();
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function deviceVector(ctx: Ctx, x: number, y: number) {
  const m = ctx.getTransform();
  return { x: m.a * x + m.c * y, y: m.b * x + m.d * y };
}

/** Canvas shadows are offset in device pixels; this draws only the shadow of `draw` by moving the shape far away. */
const FAR = 1_000_000;

function shapeShadow(ctx: Ctx, n: SceneNode, e: ShadowEffect) {
  const s = deviceScale(ctx);
  const off = deviceVector(ctx, e.x, e.y);
  ctx.save();
  const m = ctx.getTransform();
  ctx.shadowColor = rgba(e.color, e.opacity);
  ctx.shadowBlur = e.blur * s;
  ctx.shadowOffsetX = off.x + FAR;
  ctx.shadowOffsetY = off.y;
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
  shapePath(ctx, n, e.spread);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
}

function innerShadow(ctx: Ctx, n: SceneNode, e: ShadowEffect) {
  const s = deviceScale(ctx);
  const off = deviceVector(ctx, e.x, e.y);
  ctx.save();
  shapePath(ctx, n);
  ctx.clip();
  const m = ctx.getTransform();
  ctx.shadowColor = rgba(e.color, e.opacity);
  ctx.shadowBlur = e.blur * s;
  ctx.shadowOffsetX = off.x + FAR;
  ctx.shadowOffsetY = off.y;
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
  // a big ring around the shape (shrunk by spread) casts its shadow inward
  const pad = Math.max(n.width, n.height) + e.blur * 3 + Math.abs(e.x) + Math.abs(e.y) + 10;
  ctx.beginPath();
  ctx.rect(-pad, -pad, n.width + pad * 2, n.height + pad * 2);
  shapePath(ctx, n, -e.spread);
  ctx.fillStyle = '#000';
  ctx.fill('evenodd');
  ctx.restore();
}

type Layer = { canvas: HTMLCanvasElement | OffscreenCanvas; x: number; y: number };

function newCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/** Renders `draw` (in the current local coordinates) into an offscreen layer covering the given local box. */
function renderLayer(ctx: Ctx, box: Rect, draw: (c: Ctx) => void): Layer | null {
  const m = ctx.getTransform();
  const pts = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
  let x0 = Math.floor(Math.min(...pts.map((p) => p.x)));
  let y0 = Math.floor(Math.min(...pts.map((p) => p.y)));
  let x1 = Math.ceil(Math.max(...pts.map((p) => p.x)));
  let y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  // only what can be seen on the target canvas (plus a margin for blur)
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const margin = 256;
  x0 = Math.max(x0, -margin);
  y0 = Math.max(y0, -margin);
  x1 = Math.min(x1, cw + margin);
  y1 = Math.min(y1, ch + margin);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0 || w > MAX_LAYER || h > MAX_LAYER) return null;
  const canvas = newCanvas(w, h);
  const lc = canvas?.getContext('2d') as Ctx | null;
  if (!canvas || !lc) return null;
  lc.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  draw(lc);
  return { canvas, x: x0, y: y0 };
}

function drawWithEffects(ctx: Ctx, doc: SceneDoc, n: SceneNode, effects: Effect[], opts: DrawOptions, root: SceneDoc) {
  const shadows = effects.filter((e): e is ShadowEffect => e.type === 'DROP_SHADOW');
  const inner = effects.filter((e): e is ShadowEffect => e.type === 'INNER_SHADOW');
  const layerBlur = effects.find((e) => e.type === 'LAYER_BLUR');
  const backgroundBlur = effects.find((e) => e.type === 'BACKGROUND_BLUR');
  const reach = effectReach(n) + n.strokeWeight * 2 + 2;
  const s = deviceScale(ctx);

  // background blur: blur what is already drawn under the shape
  if (backgroundBlur && backgroundBlur.type === 'BACKGROUND_BLUR' && backgroundBlur.radius > 0 && hasShapeOutline(n)) {
    const snap = renderLayer(ctx, { x: 0, y: 0, width: n.width, height: n.height }, () => {});
    if (snap) {
      const sc = snap.canvas.getContext('2d') as Ctx;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.filter = `blur(${backgroundBlur.radius * s * 0.5}px)`;
      sc.drawImage(ctx.canvas, -snap.x, -snap.y);
      ctx.save();
      shapePath(ctx, n);
      ctx.clip();
      const m = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(snap.canvas, snap.x, snap.y);
      ctx.setTransform(m);
      ctx.restore();
    }
  }

  const useLayer = !!layerBlur || (shadows.length > 0 && !hasShapeOutline(n));
  if (!useLayer) {
    for (const e of shadows) shapeShadow(ctx, n, e);
    drawBody(ctx, doc, n, opts, root);
    for (const e of inner) if (hasShapeOutline(n)) innerShadow(ctx, n, e);
    return;
  }

  // content as an image, so shadows follow what is drawn and blur applies to all of it
  const box = n.type === 'LINE' ? lineBox(n) : { x: 0, y: 0, width: n.width, height: n.height };
  const layer = renderLayer(ctx, { x: box.x - reach, y: box.y - reach, width: box.width + reach * 2, height: box.height + reach * 2 }, (lc) => {
    drawBody(lc, doc, n, opts, root);
    if (hasShapeOutline(n)) for (const e of inner) innerShadow(lc, n, e);
  });
  if (!layer) {
    drawBody(ctx, doc, n, opts, root);
    return;
  }
  const m = ctx.getTransform();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const e of shadows) {
    const off = { x: m.a * e.x + m.c * e.y, y: m.b * e.x + m.d * e.y };
    ctx.save();
    ctx.shadowColor = rgba(e.color, e.opacity);
    ctx.shadowBlur = e.blur * s;
    ctx.shadowOffsetX = off.x + FAR;
    ctx.shadowOffsetY = off.y;
    ctx.drawImage(layer.canvas, layer.x - FAR, layer.y);
    ctx.restore();
  }
  if (layerBlur && layerBlur.type === 'LAYER_BLUR' && layerBlur.radius > 0) ctx.filter = `blur(${layerBlur.radius * s * 0.5}px)`;
  ctx.drawImage(layer.canvas, layer.x, layer.y);
  ctx.restore();
}

export function drawNode(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions = {}) {
  if (!n.visible || opts.skip?.has(n.id) || culled(doc, n, opts.cull)) return;
  if (opts.depth && opts.budget && opts.budget.left-- <= 0) return;
  const root = opts.root ?? doc;
  ctx.save();
  const m = localMatrix(n.x, n.y, n.rotation);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.globalAlpha *= n.opacity;
  if (n.blendMode && n.blendMode !== 'normal') ctx.globalCompositeOperation = n.blendMode;
  const effects = (n.effects ?? []).filter((e) => e.visible);
  if (effects.length && typeof ctx.getTransform === 'function') drawWithEffects(ctx, doc, n, effects, opts, root);
  else drawBody(ctx, doc, n, opts, root);
  ctx.restore();
}

export function drawChildren(ctx: Ctx, doc: SceneDoc, parentId: string | null, opts: DrawOptions = {}) {
  const o = opts.root && opts.budget ? opts : { ...opts, root: opts.root ?? doc, budget: opts.budget ?? { left: INSTANCE_DRAW_BUDGET } };
  let masked = false;
  for (const id of doc.children(parentId)) {
    const n = doc.get(id)!;
    if (n.isMask && n.visible && typeof ctx.getTransform === 'function') {
      // a mask clips the layers above it, up to the next mask; the mask itself isn't drawn
      if (masked) ctx.restore();
      ctx.save();
      masked = true;
      clipToMask(ctx, n);
      continue;
    }
    drawNode(ctx, doc, n, o);
  }
  if (masked) ctx.restore();
}

/** Image ids a subtree needs (including through instances), for preloading before an export. */
export function imagesUsed(doc: SceneDoc, ids: string[], root: SceneDoc = doc, depth = 0, budget = { left: INSTANCE_DRAW_BUDGET }): string[] {
  const out = new Set<string>();
  const visit = (d: SceneDoc, id: string) => {
    const n = d.get(id);
    if (!n || budget.left-- <= 0) return;
    for (const p of n.fills) if (p.type === 'IMAGE') out.add(p.imageId);
    if (n.type === 'INSTANCE' && depth < MAX_INSTANCE_DEPTH) {
      const v = instanceDoc(root, n);
      if (v) for (const x of imagesUsed(v, v.children(n.id), root, depth + 1, budget)) out.add(x);
      const vr = v?.get(n.id);
      if (vr) for (const p of vr.fills) if (p.type === 'IMAGE') out.add(p.imageId);
    }
    for (const c of d.children(id)) visit(d, c);
  };
  for (const id of ids) visit(doc, id);
  return [...out];
}

export type { Paint };
