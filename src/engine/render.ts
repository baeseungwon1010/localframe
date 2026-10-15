import {
  type Effect,
  type GradientPaint,
  type ImagePaint,
  type NoiseEffect,
  type Paint,
  type ProgressiveBlur,
  type SceneNode,
  type ShadowEffect,
  type SolidPaint,
  isGradientPaint,
} from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { getImage } from './images.ts';
import { instanceDoc } from './instances.ts';
import { type Point, type Rect, boundsOfPoints, localMatrix, rectsIntersect } from './math.ts';
import { linePoints } from './geometry.ts';
import { labelMatrix, labelNode } from './labels.ts';
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
  /** Outline mode: every layer as a thin outline, no fills, images or effects. */
  outline?: boolean;
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
    if (e.type === 'PROGRESSIVE_BLUR') r = Math.max(r, Math.max(e.start, e.end) * 1.5);
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
/** Colour of a gradient at t (0..1) as RGBA bytes; `stops` sorted by position. */
function sampleStops(p: GradientPaint, stops: GradientPaint['stops'], t: number): [number, number, number, number] {
  const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  let a = stops[0];
  let b = stops[stops.length - 1];
  if (t <= a.position) b = a;
  else if (t >= b.position) a = b;
  else
    for (let i = 1; i < stops.length; i++)
      if (t <= stops[i].position) {
        a = stops[i - 1];
        b = stops[i];
        break;
      }
  const k = b.position > a.position ? (t - a.position) / (b.position - a.position) : 0;
  const ca = hex(a.color);
  const cb = hex(b.color);
  const alpha = (a.opacity + (b.opacity - a.opacity) * k) * p.opacity;
  return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k, alpha * 255];
}

const rasterCache = new Map<string, HTMLCanvasElement>();

/**
 * Angular and diamond gradients drawn pixel by pixel into a small canvas (up to 256 px a side) that
 * stretches over the layer. Null where there is no canvas (tests, workers).
 */
export function gradientRaster(p: GradientPaint, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  // the pattern only depends on the box's shape, so it is drawn in a box of the same proportions
  // (at most 256 px a side) and cached by that: resizing a layer reuses it
  const k = Math.min(1, 256 / Math.max(1, w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const key = JSON.stringify([p.type, p.stops, p.from, p.to, p.opacity, cw, ch]);
  const hit = rasterCache.get(key);
  if (hit) {
    // most recently used last
    rasterCache.delete(key);
    rasterCache.set(key, hit);
    return hit;
  }
  w = cw;
  h = ch;
  const sorted = [...p.stops].sort((a, b) => a.position - b.position);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(cw, ch);
  const fx = p.from.x * w;
  const fy = p.from.y * h;
  const ux = p.to.x * w - fx;
  const uy = p.to.y * h - fy;
  const len = Math.max(0.01, Math.hypot(ux, uy));
  const start = Math.atan2(uy, ux);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dx = ((x + 0.5) * w) / cw - fx;
      const dy = ((y + 0.5) * h) / ch - fy;
      let t: number;
      if (p.type === 'GRADIENT_ANGULAR') {
        const a = Math.atan2(dy, dx) - start;
        t = (((a / (Math.PI * 2)) % 1) + 1) % 1;
      } else {
        // diamond: distance measured along the gradient's axis and across it
        t = Math.min(1, (Math.abs(dx * ux + dy * uy) + Math.abs(-dx * uy + dy * ux)) / (len * len));
      }
      const [r, gg, b, a] = sampleStops(p, sorted, t);
      const i = (y * cw + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  // least recently used go first
  while (rasterCache.size >= 128) rasterCache.delete(rasterCache.keys().next().value!);
  rasterCache.set(key, c);
  return c;
}

function gradientStyle(ctx: Ctx, p: GradientPaint, w: number, h: number): CanvasGradient | CanvasPattern {
  const fx = p.from.x * w;
  const fy = p.from.y * h;
  const tx = p.to.x * w;
  const ty = p.to.y * h;
  if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
    const raster = gradientRaster(p, w, h);
    const pattern = raster ? ctx.createPattern(raster, 'no-repeat') : null;
    if (pattern && raster) {
      pattern.setTransform(new DOMMatrix().scale(w / raster.width, h / raster.height));
      return pattern;
    }
  }
  const g =
    p.type === 'GRADIENT_LINEAR'
      ? ctx.createLinearGradient(fx, fy, tx, ty)
      : ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(0.01, Math.hypot(tx - fx, ty - fy)));
  const stops = [...p.stops].sort((a, b) => a.position - b.position);
  for (const s of stops) g.addColorStop(s.position, rgba(s.color, s.opacity * p.opacity));
  return g;
}

/** Fill or stroke style for a solid or gradient paint. */
export function paintStyle(ctx: Ctx, p: SolidPaint | GradientPaint, w: number, h: number): string | CanvasGradient | CanvasPattern {
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

/** How a vector's paths fill where they overlap: even-odd leaves holes where paths cross. */
export const ruleOf = (n: SceneNode): CanvasFillRule => (n.type === 'VECTOR' && n.vector?.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');

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

/** CSS filter for an image's adjustments (canvas and SVG both take it), or '' when there are none. */
export function imageFilter(p: ImagePaint): string {
  const a = p.adjust;
  if (!a || (!a.exposure && !a.contrast && !a.saturation)) return '';
  const k = (v: number) => Math.round((1 + v / 100) * 1000) / 1000;
  return `brightness(${k(a.exposure)}) contrast(${k(a.contrast)}) saturate(${k(a.saturation)})`;
}

function fillImage(ctx: Ctx, n: SceneNode, p: ImagePaint) {
  const img = getImage(p.imageId);
  ctx.save();
  ctx.clip(ruleOf(n));
  if (!img) {
    // placeholder while the image loads
    ctx.fillStyle = 'rgba(128, 128, 128, 0.18)';
    ctx.fillRect(0, 0, n.width, n.height);
  } else {
    ctx.globalAlpha *= p.opacity;
    ctx.imageSmoothingQuality = 'high';
    const filter = imageFilter(p);
    if (filter) ctx.filter = filter;
    if (p.scaleMode === 'tile') {
      const pattern = ctx.createPattern(img, 'repeat');
      if (pattern) {
        const s = p.tileScale ?? 1;
        pattern.setTransform(new DOMMatrix().scale(s, s));
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, n.width, n.height);
      }
    } else {
      const r = imageRect(p, img.naturalWidth, img.naturalHeight, n.width, n.height);
      ctx.drawImage(img, r.x, r.y, r.width, r.height);
    }
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
    ctx.fill(ruleOf(n));
  }
}

/** Canvas and SVG line caps and joins for a layer (vectors default to round). */
export function capOf(n: SceneNode): 'butt' | 'round' | 'square' {
  const c = n.strokeCap ?? (n.type === 'VECTOR' ? 'round' : 'none');
  return c === 'none' ? 'butt' : c;
}
export function joinOf(n: SceneNode): 'miter' | 'round' | 'bevel' {
  return n.strokeJoin ?? (n.type === 'VECTOR' ? 'round' : 'miter');
}

/** Bands for a per-side stroke, in the layer's own units, placed by the stroke's alignment. */
export function sideBands(n: SceneNode): { x: number; y: number; width: number; height: number }[] {
  const [t, r, b, l] = n.strokeSides!;
  const at = (w: number) => (n.strokeAlign === 'inside' ? 0 : n.strokeAlign === 'center' ? -w / 2 : -w);
  const bands = [];
  if (t > 0) bands.push({ x: 0, y: at(t), width: n.width, height: t });
  if (b > 0) bands.push({ x: 0, y: n.height - b - at(b), width: n.width, height: b });
  if (l > 0) bands.push({ x: at(l), y: 0, width: l, height: n.height });
  if (r > 0) bands.push({ x: n.width - r - at(r), y: 0, width: r, height: n.height });
  return bands;
}

function strokeShape(ctx: Ctx, n: SceneNode) {
  const paints = n.strokes.filter((p) => p.visible);
  if (n.strokeSides && (n.type === 'RECTANGLE' || isBox(n))) {
    if (paints.length === 0) return;
    ctx.save();
    if (n.strokeAlign === 'inside') ctx.clip();
    for (const p of paints) {
      ctx.fillStyle = paintStyle(ctx, p, n.width, n.height);
      for (const r of sideBands(n)) ctx.fillRect(r.x, r.y, r.width, r.height);
    }
    ctx.restore();
    return;
  }
  if (paints.length === 0 || n.strokeWeight <= 0) return;
  ctx.save();
  ctx.setLineDash(n.strokeDash);
  ctx.lineJoin = joinOf(n);
  ctx.lineCap = capOf(n);
  const align = strokeAlignOf(n);
  if (align === 'center') {
    ctx.lineWidth = n.strokeWeight;
  } else if (align === 'inside') {
    ctx.clip(ruleOf(n));
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

/** Elbow connectors turn their corners on this radius (less where segments are short). */
export const ELBOW_RADIUS = 10;

/** A polyline, its corners rounded on `r` (0 for sharp corners). Works on canvas paths and SVG sinks. */
export function tracePolyline(sink: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void }, pts: Point[], r: number) {
  if (!pts.length) return;
  sink.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    if (!next || r <= 0) {
      sink.lineTo(p.x, p.y);
      continue;
    }
    const prev = pts[i - 1];
    const d1 = Math.hypot(p.x - prev.x, p.y - prev.y);
    const d2 = Math.hypot(next.x - p.x, next.y - p.y);
    const k = Math.min(r, d1 / 2, d2 / 2);
    if (k <= 0.01) {
      sink.lineTo(p.x, p.y);
      continue;
    }
    sink.lineTo(p.x + ((prev.x - p.x) * k) / d1, p.y + ((prev.y - p.y) * k) / d1);
    sink.quadraticCurveTo(p.x, p.y, p.x + ((next.x - p.x) * k) / d2, p.y + ((next.y - p.y) * k) / d2);
  }
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
  ctx.lineCap = capOf(n);
  ctx.lineJoin = 'round';
  ctx.setLineDash(n.strokeDash);
  for (const p of paints) {
    const style = paintStyle(ctx, p, Math.max(1, len), Math.max(1, n.strokeWeight));
    ctx.strokeStyle = style;
    ctx.fillStyle = style;
    ctx.beginPath();
    tracePolyline(ctx, shape.points, n.elbow ? ELBOW_RADIUS : 0);
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
  if ('fontKerning' in ctx) (ctx as CanvasRenderingContext2D).fontKerning = t.kerning === false ? 'none' : 'normal';
  ctx.textBaseline = 'alphabetic';
  const fills = n.fills.filter((p) => p.visible && p.type !== 'IMAGE');
  for (const line of layout.lines) {
    const x0 = line.indent + lineOffset(t.align, n.width - line.indent, line.width);
    if (line.marker) {
      // list marker, right-aligned in the indent
      const st = line.segments[0]?.style ?? { fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, italic: false };
      ctx.font = fontString({ ...st, italic: false });
      const mw = ctx.measureText(line.marker).width;
      for (const p of fills) {
        if (p.type === 'IMAGE') continue;
        ctx.fillStyle = paintStyle(ctx, p, n.width, n.height);
        ctx.fillText(line.marker, line.indent - mw - st.fontSize * 0.4, line.baseline);
      }
    }
    for (const seg of line.segments) {
      ctx.font = fontString(seg.style);
      const x = x0 + seg.x;
      // a run's own colour replaces the layer's fills for that stretch
      const paints = seg.style.color ? [{ color: seg.style.color, opacity: 1, visible: true } as SolidPaint] : fills;
      for (const p of paints) {
        if (p.type === 'IMAGE') continue;
        ctx.fillStyle = paintStyle(ctx, p, n.width, n.height);
        ctx.fillText(seg.text, x, line.baseline);
        // links are underlined unless they have their own decoration
        const deco = seg.style.decoration !== 'none' ? seg.style.decoration : seg.style.link ? 'underline' : 'none';
        if (deco !== 'none') {
          const size = seg.style.fontSize;
          const thick = Math.max(1, size / 14);
          const y = deco === 'underline' ? line.baseline + size * 0.12 : line.baseline - size * 0.3;
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

const OUTLINE_INK = '#6E7177';

/** Outline mode: the layer's shape as a one-pixel line; text stays readable; containers show their content. */
function drawOutline(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions, root: SceneDoc) {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const px = t ? 1 / Math.max(1e-6, Math.hypot(t.a, t.b)) : 1;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = px;
  ctx.setLineDash([]);
  ctx.strokeStyle = OUTLINE_INK;
  switch (n.type) {
    case 'GROUP':
    case 'BOOLEAN':
      drawChildren(ctx, doc, n.id, { ...opts, root });
      return;
    case 'INSTANCE': {
      const depth = opts.depth ?? 0;
      const v = depth < MAX_INSTANCE_DEPTH && (opts.budget?.left ?? 1) > 0 ? instanceDoc(root, n) : null;
      shapePath(ctx, n);
      ctx.stroke();
      if (v) drawChildren(ctx, v, n.id, { ...opts, root, depth: depth + 1 });
      return;
    }
    case 'TEXT':
      drawText(ctx, { ...n, fills: [{ color: OUTLINE_INK, opacity: 1, visible: true }] });
      return;
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'VECTOR':
      shapePath(ctx, n);
      ctx.stroke();
      drawLabel(ctx, { ...n, labelColor: OUTLINE_INK }, opts);
      return;
    case 'LINE': {
      ctx.beginPath();
      linePoints(n).forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.stroke();
      return;
    }
    default:
      shapePath(ctx, n);
      ctx.stroke();
      if (isBox(n)) drawChildren(ctx, doc, n.id, { ...opts, root });
  }
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
      drawLabel(ctx, n, opts);
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
      drawLabel(ctx, n, opts);
      break;
    case 'LINE':
      drawLine(ctx, n);
      drawLabel(ctx, n, opts);
      break;
    case 'TEXT':
      drawText(ctx, n);
      break;
  }
}

/** Text inside a shape, or on a white pill in the middle of a connector. Skipped while it is being typed. */
function drawLabel(ctx: Ctx, n: SceneNode, opts: DrawOptions) {
  if (!n.label?.characters || opts.skip?.has(`${n.id}~label`)) return;
  const ln = labelNode(n);
  if (!ln) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const m = labelMatrix(n, ln);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (n.type === 'LINE') {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(-6, -3, ln.width + 12, ln.height + 6, 4);
    ctx.fill();
  }
  drawText(ctx, ln);
  ctx.restore();
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
    } else ctx.fill(ruleOf(k));
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
        lc.fill(ruleOf(n));
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
  ctx.clip(ruleOf(n));
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
  ctx.fill(ruleOf(n));
  ctx.restore();
}

function innerShadow(ctx: Ctx, n: SceneNode, e: ShadowEffect) {
  const s = deviceScale(ctx);
  const off = deviceVector(ctx, e.x, e.y);
  ctx.save();
  shapePath(ctx, n);
  ctx.clip(ruleOf(n));
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

/** A 64 px tile of grain in one colour with random transparency, the same every time. */
const noiseTiles = new Map<string, HTMLCanvasElement>();
function noiseTile(color: string): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hit = noiseTiles.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(64, 64);
  const r = parseInt(color.slice(1, 3), 16);
  const gg = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  let seed = 0x2f6b9c1d;
  for (let i = 0; i < 64 * 64; i++) {
    // xorshift: a fixed seed keeps exports identical
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = (seed >>> 0) % 256;
  }
  g.putImageData(img, 0, 0);
  while (noiseTiles.size >= 16) noiseTiles.delete(noiseTiles.keys().next().value!);
  noiseTiles.set(color, c);
  return c;
}

/**
 * The layer with a blur that grows from `start` to `end` along the direction: each step is a more
 * blurred copy faded in over the previous one with a gradient mask, so there are no hard bands.
 * `pad` is the room around the layer's own box in the offscreen layer (device px).
 */
function drawProgressive(ctx: Ctx, layer: { canvas: HTMLCanvasElement | OffscreenCanvas; x: number; y: number }, e: ProgressiveBlur, s: number, pad: number) {
  const STEPS = 8;
  const w = layer.canvas.width;
  const h = layer.canvas.height;
  const vertical = e.direction === 'down' || e.direction === 'up';
  const forward = e.direction === 'down' || e.direction === 'right';
  const len = Math.max(1, (vertical ? h : w) - pad * 2);
  const at = (k: number) => pad + len * (forward ? k : 1 - k);
  const radius = (k: number) => e.start + (e.end - e.start) * k;
  const blur = (r: number) => (r > 0 ? `blur(${r * s * 0.5}px)` : 'none');
  ctx.filter = blur(radius(0));
  ctx.drawImage(layer.canvas as CanvasImageSource, layer.x, layer.y);
  ctx.filter = 'none';
  const tmp = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : null;
  const tg = tmp?.getContext('2d');
  if (!tmp || !tg) return;
  for (let i = 1; i < STEPS; i++) {
    const k0 = (i - 1) / (STEPS - 1);
    const k1 = i / (STEPS - 1);
    tg.globalCompositeOperation = 'source-over';
    tg.clearRect(0, 0, w, h);
    tg.filter = blur(radius(k1));
    tg.drawImage(layer.canvas as CanvasImageSource, 0, 0);
    tg.filter = 'none';
    // keep this step only from where the previous one ends, fading in
    const p0 = at(k0);
    const p1 = at(k1);
    const g = vertical ? tg.createLinearGradient(0, p0, 0, p1) : tg.createLinearGradient(p0, 0, p1, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    tg.globalCompositeOperation = 'destination-in';
    tg.fillStyle = g;
    tg.fillRect(0, 0, w, h);
    ctx.drawImage(tmp, layer.x, layer.y);
  }
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
      ctx.clip(ruleOf(n));
      const m = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(snap.canvas, snap.x, snap.y);
      ctx.setTransform(m);
      ctx.restore();
    }
  }

  const noise = effects.find((e): e is NoiseEffect => e.type === 'NOISE');
  const progressive = effects.find((e): e is ProgressiveBlur => e.type === 'PROGRESSIVE_BLUR');
  const useLayer = !!layerBlur || !!noise || !!progressive || (shadows.length > 0 && !hasShapeOutline(n));
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
    if (noise && noise.amount > 0) {
      // grain only where the layer drew something
      const tile = noiseTile(noise.color);
      const pattern = tile ? lc.createPattern(tile, 'repeat') : null;
      if (pattern) {
        pattern.setTransform(new DOMMatrix().scale(noise.size, noise.size));
        lc.save();
        lc.globalCompositeOperation = 'source-atop';
        lc.globalAlpha = noise.amount;
        lc.fillStyle = pattern;
        lc.fillRect(box.x - reach, box.y - reach, box.width + reach * 2, box.height + reach * 2);
        lc.restore();
      }
    }
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
  if (progressive && (progressive.start > 0 || progressive.end > 0)) {
    drawProgressive(ctx, layer, progressive, s, reach * s);
    ctx.restore();
    return;
  }
  ctx.drawImage(layer.canvas, layer.x, layer.y);
  ctx.restore();
}

export function drawNode(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions = {}) {
  if (!n.visible || n.slice || opts.skip?.has(n.id) || culled(doc, n, opts.cull)) return;
  if (opts.depth && opts.budget && opts.budget.left-- <= 0) return;
  const root = opts.root ?? doc;
  ctx.save();
  const m = localMatrix(n.x, n.y, n.rotation);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (opts.outline) {
    drawOutline(ctx, doc, n, opts, root);
    ctx.restore();
    return;
  }
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
    if (n.isMask && n.visible && !o.outline && typeof ctx.getTransform === 'function') {
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
