import { type Effect, type GradientPaint, type ImagePaint, type Paint, type SceneNode, type SolidPaint, isGradientPaint } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { embeddedFontCss, type TextRun } from './fonts.ts';
import { ensureImages, imageDataUrl, imageSize } from './images.ts';
import { instanceDoc } from './instances.ts';
import { type Mat, type Rect, IDENTITY, localMatrix, unionRects } from './math.ts';
import { buildPdf, type PdfPage } from './pdf.ts';
import { arrowSize, capOf, clampRadii, gradientRaster, imageFilter, drawNode, effectReach, imageRect, imagesUsed, joinOf, lineShape, sideBands } from './render.ts';
import { fontStack, layoutText, lineOffset } from './text.ts';
import { svgPathData } from './vector.ts';

/** What to export: these layers on this background, cut to `clip` (a slice's area) when given. */
export type ExportTarget = { ids: string[]; background: string | null; clip?: Rect };

/** The export target for a layer: a slice exports everything on its page under its area. */
export function exportTargetFor(doc: SceneDoc, node: SceneNode, background: string | null, pageBackground: string): ExportTarget {
  if (!node.slice) return { ids: [node.id], background };
  const page = doc.pageOf(node.id);
  const ids = doc.pageChildren(page).filter((id) => {
    const n = doc.get(id)!;
    return n.visible && !n.slice;
  });
  return { ids, background: pageBackground, clip: doc.worldBounds(node.id) };
}
export type RasterFormat = 'png' | 'jpg' | 'webp';
export type ExportFormat = RasterFormat | 'svg' | 'pdf';

const isContainer = (n: SceneNode) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE';
const clips = (n: SceneNode) => isContainer(n) && !!n.clipsContent;

/** Extra room for strokes and arrow heads that reach outside a node's box. */
function overhang(doc: SceneDoc, id: string): number {
  let max = 0;
  const visit = (nid: string) => {
    const n = doc.get(nid)!;
    if (!n.visible) return;
    max = Math.max(max, effectReach(n));
    const stroked = n.strokes.some((p) => p.visible) && n.strokeWeight > 0;
    if (stroked) {
      if (n.type === 'LINE') max = Math.max(max, n.strokeWeight / 2, n.arrowStart || n.arrowEnd ? arrowSize(n.strokeWeight).halfWidth : 0);
      else if (n.strokeAlign === 'center') max = Math.max(max, n.strokeWeight / 2);
      else if (n.strokeAlign === 'outside') max = Math.max(max, n.strokeWeight);
    }
    if (!clips(n)) for (const c of doc.children(nid)) visit(c);
  };
  visit(id);
  return max;
}

/** Area to export: a clipping frame exports exactly its box; anything else its bounds plus strokes. */
export function exportBounds(doc: SceneDoc, ids: string[]): Rect | null {
  const rects = ids.map((id) => {
    const n = doc.get(id)!;
    const b = doc.worldBounds(id);
    if (clips(n) && !effectReach(n)) return b;
    const pad = overhang(doc, id);
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  });
  const u = unionRects(rects);
  if (!u) return null;
  return {
    x: Math.floor(u.x),
    y: Math.floor(u.y),
    width: Math.max(1, Math.ceil(u.x + u.width) - Math.floor(u.x)),
    height: Math.max(1, Math.ceil(u.y + u.height) - Math.floor(u.y)),
  };
}

const MAX_PIXELS = 16384 * 16384;

/** Draws the target into a new canvas at `scale` (lowered if the result would be too large). */
export async function renderCanvas(doc: SceneDoc, target: ExportTarget, scale: number, background: string | null = target.background) {
  const b = target.clip ?? exportBounds(doc, target.ids);
  if (!b) throw new Error('Nothing to export');
  await ensureImages(imagesUsed(doc, target.ids));
  let s = scale;
  while (b.width * s * b.height * s > MAX_PIXELS && s > 0.05) s /= 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(b.width * s));
  canvas.height = Math.max(1, Math.round(b.height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.setTransform(s, 0, 0, s, -b.x * s, -b.y * s);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(b.x, b.y, b.width, b.height);
  }
  for (const id of target.ids) {
    const n = doc.get(id)!;
    const pw = doc.parentWorld(n);
    ctx.save();
    ctx.transform(pw[0], pw[1], pw[2], pw[3], pw[4], pw[5]);
    drawNode(ctx, doc, n);
    ctx.restore();
  }
  return { canvas, bounds: b, scale: s };
}

const MIME: Record<RasterFormat, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), type, quality),
  );
}

/** PNG and WebP keep transparency; JPG has none, so empty areas become white (or the page colour). */
export async function exportImage(doc: SceneDoc, target: ExportTarget, scale: number, format: RasterFormat): Promise<Blob> {
  const bg = format === 'jpg' ? (target.background ?? '#FFFFFF') : target.background;
  const { canvas } = await renderCanvas(doc, target, scale, bg);
  return toBlob(canvas, MIME[format], format === 'png' ? undefined : 0.92);
}

/** Kept for callers that only need PNG. */
export const exportPng = (doc: SceneDoc, target: ExportTarget, scale: number) => exportImage(doc, target, scale, 'png');

/** One PDF page per target (for example one per frame). Pages are images at `scale`. */
export async function exportPdf(doc: SceneDoc, targets: ExportTarget[], scale: number, title: string): Promise<Blob> {
  const pages: PdfPage[] = [];
  for (const t of targets) {
    const { canvas, bounds } = await renderCanvas(doc, t, scale, t.background ?? '#FFFFFF');
    const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
    pages.push({ jpeg, pxWidth: canvas.width, pxHeight: canvas.height, ptWidth: bounds.width * 0.75, ptHeight: bounds.height * 0.75 });
  }
  if (pages.length === 0) throw new Error('Nothing to export');
  return buildPdf(pages, title);
}

// ------------------------------------------------------------------ SVG

export function escapeXml(s: string): string {
  return s
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const matrixAttr = (m: Mat) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1
    ? m[4] === 0 && m[5] === 0
      ? ''
      : ` transform="translate(${num(m[4])} ${num(m[5])})"`
    : ` transform="matrix(${m.map(num).join(' ')})"`;

function roundedRectPath(n: SceneNode): string {
  const w = n.width;
  const h = n.height;
  const [tl, tr, br, bl] = clampRadii(n);
  if (!tl && !tr && !br && !bl) return `M0 0H${num(w)}V${num(h)}H0Z`;
  return [
    `M${num(tl)} 0`,
    `H${num(w - tr)}`,
    tr ? `A${num(tr)} ${num(tr)} 0 0 1 ${num(w)} ${num(tr)}` : '',
    `V${num(h - br)}`,
    br ? `A${num(br)} ${num(br)} 0 0 1 ${num(w - br)} ${num(h)}` : '',
    `H${num(bl)}`,
    bl ? `A${num(bl)} ${num(bl)} 0 0 1 0 ${num(h - bl)}` : '',
    `V${num(tl)}`,
    tl ? `A${num(tl)} ${num(tl)} 0 0 1 ${num(tl)} 0` : '',
    'Z',
  ].join('');
}

function shapeElement(n: SceneNode, attrs: string): string {
  if (n.type === 'VECTOR' && n.vector) return `<path d="${svgPathData(n.vector)}"${attrs}/>`;
  if (n.type === 'ELLIPSE') {
    return `<ellipse cx="${num(n.width / 2)}" cy="${num(n.height / 2)}" rx="${num(n.width / 2)}" ry="${num(n.height / 2)}"${attrs}/>`;
  }
  return `<path d="${roundedRectPath(n)}"${attrs}/>`;
}

const solidAttrs = (p: SolidPaint, kind: 'fill' | 'stroke') =>
  ` ${kind}="${escapeXml(p.color)}"${p.opacity < 1 ? ` ${kind}-opacity="${num(p.opacity)}"` : ''}`;

export type SvgAssets = { images: Map<string, { url: string; width: number; height: number }> };

/** Refuse to build SVG exports beyond these (a file full of nested instances could be enormous). */
const SVG_MAX_ELEMENTS = 500_000;
const SVG_MAX_CHARS = 200_000_000;

class SvgWriter {
  private defs: string[] = [];
  private seq = 0;
  private elements = 0;
  /** Each image is embedded once and referenced wherever it is used. */
  private imageDefs = new Map<string, string>();
  readonly runs: TextRun[] = [];
  private readonly root: SceneDoc;
  private readonly assets: SvgAssets;

  constructor(root: SceneDoc, assets: SvgAssets) {
    this.root = root;
    this.assets = assets;
  }

  private id(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  defsMarkup(extra = '') {
    return this.defs.length || extra ? `<defs>${extra}${this.defs.join('')}</defs>` : '';
  }

  /** fill/stroke attributes for a solid or gradient paint (gradients go into defs). */
  private paint(p: SolidPaint | GradientPaint, kind: 'fill' | 'stroke', w: number, h: number): string {
    if (!isGradientPaint(p)) return solidAttrs(p, kind);
    const gid = this.id('grad');
    const stops = [...p.stops]
      .sort((a, b) => a.position - b.position)
      .map((st) => `<stop offset="${num(st.position)}" stop-color="${escapeXml(st.color)}"${st.opacity * p.opacity < 1 ? ` stop-opacity="${num(st.opacity * p.opacity)}"` : ''}/>`)
      .join('');
    const fx = p.from.x * w;
    const fy = p.from.y * h;
    const tx = p.to.x * w;
    const ty = p.to.y * h;
    // SVG has no angular or diamond gradients: they go in as an image of the gradient
    const raster = p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND' ? gradientRaster(p, w, h) : null;
    if (raster) {
      this.defs.push(
        `<pattern id="${gid}" patternUnits="userSpaceOnUse" width="${num(w)}" height="${num(h)}"><image href="${raster.toDataURL('image/png')}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/></pattern>`,
      );
      return ` ${kind}="url(#${gid})"`;
    }
    this.defs.push(
      p.type === 'GRADIENT_LINEAR'
        ? `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${num(fx)}" y1="${num(fy)}" x2="${num(tx)}" y2="${num(ty)}">${stops}</linearGradient>`
        : `<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${num(fx)}" cy="${num(fy)}" r="${num(Math.max(0.01, Math.hypot(tx - fx, ty - fy)))}">${stops}</radialGradient>`,
    );
    return ` ${kind}="url(#${gid})"`;
  }

  /** An SVG filter for shadows and layer blur (background blur has no SVG equivalent and is left out). */
  private filter(n: SceneNode, effects: Effect[]): string {
    const prims: string[] = [];
    const merge: string[] = [];
    effects.forEach((e, i) => {
      if (e.type !== 'DROP_SHADOW') return;
      let src = 'SourceAlpha';
      if (e.spread) {
        prims.push(`<feMorphology in="SourceAlpha" operator="${e.spread > 0 ? 'dilate' : 'erode'}" radius="${num(Math.abs(e.spread))}" result="d${i}s"/>`);
        src = `d${i}s`;
      }
      prims.push(
        `<feOffset in="${src}" dx="${num(e.x)}" dy="${num(e.y)}" result="d${i}o"/>`,
        `<feGaussianBlur in="d${i}o" stdDeviation="${num(e.blur / 2)}" result="d${i}b"/>`,
        `<feFlood flood-color="${escapeXml(e.color)}" flood-opacity="${num(e.opacity)}" result="d${i}f"/>`,
        `<feComposite in="d${i}f" in2="d${i}b" operator="in" result="d${i}"/>`,
      );
      merge.push(`d${i}`);
    });
    merge.push('SourceGraphic');
    effects.forEach((e, i) => {
      if (e.type !== 'INNER_SHADOW') return;
      prims.push(
        `<feFlood flood-color="${escapeXml(e.color)}" flood-opacity="${num(e.opacity)}" result="i${i}f"/>`,
        `<feOffset in="SourceAlpha" dx="${num(e.x)}" dy="${num(e.y)}" result="i${i}o"/>`,
        `<feGaussianBlur in="i${i}o" stdDeviation="${num(e.blur / 2)}" result="i${i}b"/>`,
        `<feComposite in="SourceAlpha" in2="i${i}b" operator="arithmetic" k2="1" k3="-1" result="i${i}m"/>`,
        `<feComposite in="i${i}f" in2="i${i}m" operator="in" result="i${i}"/>`,
      );
      merge.push(`i${i}`);
    });
    // grain: turbulence in the noise colour, kept to where the layer is
    const noise = effects.find((e) => e.type === 'NOISE');
    if (noise && noise.type === 'NOISE' && noise.amount > 0) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(noise.color.slice(i, i + 2), 16) / 255);
      prims.push(
        `<feTurbulence type="fractalNoise" baseFrequency="${num(Math.min(1, 0.5 / noise.size))}" numOctaves="1" seed="7" result="nz"/>`,
        `<feColorMatrix in="nz" type="matrix" values="0 0 0 0 ${num(r)} 0 0 0 0 ${num(g)} 0 0 0 0 ${num(b)} 0 0 0 ${num(noise.amount * 2)} ${num(-noise.amount * 0.5)}" result="nc"/>`,
        `<feComposite in="nc" in2="SourceGraphic" operator="in" result="ng"/>`,
      );
      merge.push('ng');
    }
    prims.push(`<feMerge result="m">${merge.map((m) => `<feMergeNode in="${m}"/>`).join('')}</feMerge>`);
    const blur = effects.find((e) => e.type === 'LAYER_BLUR');
    if (blur && blur.type === 'LAYER_BLUR' && blur.radius > 0) prims.push(`<feGaussianBlur in="m" stdDeviation="${num(blur.radius / 2)}"/>`);
    // SVG can't vary a blur across the layer: the progressive blur uses its average
    const prog = effects.find((e) => e.type === 'PROGRESSIVE_BLUR');
    if (!blur && prog && prog.type === 'PROGRESSIVE_BLUR' && prog.start + prog.end > 0)
      prims.push(`<feGaussianBlur in="m" stdDeviation="${num((prog.start + prog.end) / 4)}"/>`);
    const r = effectReach(n) + n.strokeWeight * 2 + 2;
    const fid = this.id('fx');
    this.defs.push(
      `<filter id="${fid}" filterUnits="userSpaceOnUse" x="${num(-r)}" y="${num(-r)}" width="${num(n.width + r * 2)}" height="${num(Math.max(n.height, 1) + r * 2)}" color-interpolation-filters="sRGB">${prims.join('')}</filter>`,
    );
    return ` filter="url(#${fid})"`;
  }

  private fills(n: SceneNode): string {
    return n.fills
      .filter((p) => p.visible)
      .map((p: Paint) => (p.type === 'IMAGE' ? this.imageFill(n, p) : shapeElement(n, this.paint(p, 'fill', n.width, n.height))))
      .join('');
  }

  private imageFill(n: SceneNode, p: ImagePaint): string {
    const img = this.assets.images.get(p.imageId);
    if (!img) return shapeElement(n, ' fill="#808080" fill-opacity="0.18"');
    let ref = this.imageDefs.get(p.imageId);
    if (!ref) {
      ref = this.id('img');
      this.imageDefs.set(p.imageId, ref);
      this.defs.push(
        `<image id="${ref}" href="${escapeXml(img.url)}" width="${num(img.width)}" height="${num(img.height)}" preserveAspectRatio="none"/>`,
      );
    }
    const cid = this.id('clip');
    this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
    // the filter is built from numbers only, so it is safe in the attribute
    const filter = imageFilter(p);
    const opacity = (p.opacity < 1 ? ` opacity="${num(p.opacity)}"` : '') + (filter ? ` style="filter:${filter}"` : '');
    if (p.scaleMode === 'tile') {
      const pid = this.id('tile');
      const s = p.tileScale ?? 1;
      this.defs.push(
        `<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${num(img.width * s)}" height="${num(img.height * s)}"><use href="#${ref}" transform="scale(${num(s)})"/></pattern>`,
      );
      return `<g clip-path="url(#${cid})"${opacity}><rect width="${num(n.width)}" height="${num(n.height)}" fill="url(#${pid})"/></g>`;
    }
    const r = imageRect(p, img.width, img.height, n.width, n.height);
    const sx = r.width / Math.max(1, img.width);
    const sy = r.height / Math.max(1, img.height);
    return `<g clip-path="url(#${cid})"${opacity}><use href="#${ref}" transform="matrix(${num(sx)} 0 0 ${num(sy)} ${num(r.x)} ${num(r.y)})"/></g>`;
  }

  private strokes(n: SceneNode): string {
    const paints = n.strokes.filter((p) => p.visible);
    if (n.strokeSides && (n.type === 'RECTANGLE' || isContainer(n)) && n.type !== 'INSTANCE') {
      if (!paints.length) return '';
      let open = '';
      let close = '';
      if (n.strokeAlign === 'inside') {
        const cid = this.id('clip');
        this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
        open = `<g clip-path="url(#${cid})">`;
        close = '</g>';
      }
      const bands = sideBands(n);
      const body = paints
        .map((p) => bands.map((r) => `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.width)}" height="${num(r.height)}"${this.paint(p, 'fill', n.width, n.height)}/>`).join(''))
        .join('');
      return open + body + close;
    }
    if (paints.length === 0 || n.strokeWeight <= 0) return '';
    const dash = n.strokeDash.length ? ` stroke-dasharray="${n.strokeDash.map(num).join(' ')}"` : '';
    const out: string[] = [];
    let wrapOpen = '';
    let wrapClose = '';
    let width = n.strokeWeight;
    const align = n.type === 'VECTOR' && !n.vector?.closed ? 'center' : n.strokeAlign;
    const caps = ` stroke-linecap="${capOf(n)}" stroke-linejoin="${joinOf(n)}"`;
    if (align === 'inside') {
      const cid = this.id('clip');
      this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
      wrapOpen = `<g clip-path="url(#${cid})">`;
      wrapClose = '</g>';
      width *= 2;
    } else if (align === 'outside') {
      const mid = this.id('mask');
      const pad = n.strokeWeight * 2 + 2;
      this.defs.push(
        `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${num(-pad)}" y="${num(-pad)}" width="${num(n.width + pad * 2)}" height="${num(n.height + pad * 2)}">` +
          `<rect x="${num(-pad)}" y="${num(-pad)}" width="${num(n.width + pad * 2)}" height="${num(n.height + pad * 2)}" fill="#fff"/>` +
          shapeElement(n, ' fill="#000"') +
          '</mask>',
      );
      wrapOpen = `<g mask="url(#${mid})">`;
      wrapClose = '</g>';
      width *= 2;
    }
    for (const p of paints) out.push(shapeElement(n, ` fill="none"${this.paint(p, 'stroke', n.width, n.height)} stroke-width="${num(width)}"${dash}${caps}`));
    return wrapOpen + out.join('') + wrapClose;
  }

  private line(n: SceneNode): string {
    const paints = n.strokes.filter((p) => p.visible);
    if (paints.length === 0 || n.strokeWeight <= 0) return '';
    const len = n.width;
    const shape = lineShape(n);
    const poly = (pts: { x: number; y: number }[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${num(q.x)} ${num(q.y)}`).join('');
    const dash = n.strokeDash.length ? ` stroke-dasharray="${n.strokeDash.map(num).join(' ')}"` : '';
    const out: string[] = [];
    for (const p of paints) {
      out.push(`<path d="${poly(shape.points)}" fill="none" stroke-linecap="${capOf(n)}" stroke-linejoin="round"${this.paint(p, 'stroke', Math.max(1, len), Math.max(1, n.strokeWeight))} stroke-width="${num(n.strokeWeight)}"${dash}/>`);
      for (const h of shape.heads) out.push(`<path d="${poly(h)}Z"${this.paint(p, 'fill', Math.max(1, len), Math.max(1, n.strokeWeight))}/>`);
    }
    return out.join('');
  }

  private text(n: SceneNode): string {
    const t = n.text!;
    const layout = layoutText(t, t.autoResize === 'width' ? null : n.width);
    const fills = n.fills.filter((p): p is SolidPaint | GradientPaint => p.visible && p.type !== 'IMAGE');
    if (fills.length === 0) return '';
    const stack = fontStack(t.fontFamily);
    this.runs.push({
      stack: stack.split(',').map((f) => f.trim().replace(/^"|"$/g, '')).filter((f) => f !== 'sans-serif'),
      weight: t.fontWeight,
      text: t.characters,
    });
    const family = escapeXml(stack.replace(/"/g, "'"));
    const common =
      ` font-family="${family}" font-size="${num(t.fontSize)}" font-weight="${num(Number(t.fontWeight))}"` +
      (t.letterSpacing ? ` letter-spacing="${num(t.letterSpacing)}"` : '') +
      ' xml:space="preserve"';
    for (const line of layout.lines)
      for (const seg of line.segments)
        if (seg.style.fontFamily !== t.fontFamily || seg.style.fontWeight !== t.fontWeight)
          this.runs.push({ stack: fontStack(seg.style.fontFamily).split(',').map((f) => f.trim().replace(/^"|"$/g, '')).filter((f) => f !== 'sans-serif'), weight: seg.style.fontWeight, text: seg.text });
    const fillAttr = fills.map((p) => this.paint(p, 'fill', n.width, n.height));
    return fills
      .map((_, fi) => {
        const spans = layout.lines
          .map((line) => {
            const x0 = line.indent + lineOffset(t.align, n.width - line.indent, line.width);
            // the marker sits in the indent; its exact width isn't known here, so it is right-aligned
            const marker = line.marker
              ? `<tspan x="${num(line.indent - t.fontSize * 0.4)}" y="${num(line.baseline)}" text-anchor="end">${escapeXml(line.marker)}</tspan>`
              : '';
            return marker + line.segments
              .map((seg) => {
                const st = seg.style;
                const attrs =
                  (st.fontFamily !== t.fontFamily ? ` font-family="${escapeXml(fontStack(st.fontFamily).replace(/"/g, "'"))}"` : '') +
                  (st.fontWeight !== t.fontWeight ? ` font-weight="${num(st.fontWeight)}"` : '') +
                  (st.fontSize !== t.fontSize ? ` font-size="${num(st.fontSize)}"` : '') +
                  (st.italic ? ' font-style="italic"' : '') +
                  (st.decoration === 'underline' || (st.decoration === 'none' && st.link) ? ' text-decoration="underline"' : st.decoration === 'strikethrough' ? ' text-decoration="line-through"' : '') +
                  (st.color ? ` fill="${escapeXml(st.color)}"` : '');
                const span = `<tspan x="${num(x0 + seg.x)}" y="${num(line.baseline)}"${attrs}>${escapeXml(seg.text)}</tspan>`;
                // links are http(s) or mailto only (checked by the schema)
                return st.link ? `<a href="${escapeXml(st.link)}">${span}</a>` : span;
              })
              .join('');
          })
          .join('');
        return `<text${common}${fillAttr[fi]}>${spans}</text>`;
      })
      .join('');
  }

  /** Children in order; a mask clips the siblings above it. */
  private kids(doc: SceneDoc, parentId: string, depth: number): string {
    let out = '';
    let open = false;
    for (const id of doc.children(parentId)) {
      const k = doc.get(id)!;
      if (k.isMask && k.visible) {
        if (open) out += '</g>';
        const cid = this.id('mask');
        const t = matrixAttr(localMatrix(k.x, k.y, k.rotation));
        const shape =
          k.type === 'RECTANGLE' || k.type === 'ELLIPSE' || k.type === 'VECTOR' || k.type === 'FRAME' || k.type === 'COMPONENT'
            ? shapeElement(k, t)
            : `<rect width="${num(k.width)}" height="${num(k.height)}"${t}/>`;
        this.defs.push(`<clipPath id="${cid}">${shape}</clipPath>`);
        out += `<g clip-path="url(#${cid})">`;
        open = true;
        continue;
      }
      out += this.node(doc, k, depth);
    }
    return open ? out + '</g>' : out;
  }

  /** A layer's shape in one colour, for boolean masks. */
  private silhouette(doc: SceneDoc, k: SceneNode, color: string): string {
    if (!k.visible) return '';
    const t = matrixAttr(localMatrix(k.x, k.y, k.rotation));
    if (k.type === 'GROUP' || k.type === 'BOOLEAN')
      return `<g${t}>${doc.children(k.id).map((c) => this.silhouette(doc, doc.get(c)!, color)).join('')}</g>`;
    if (k.type === 'VECTOR' && !k.vector?.closed)
      return `<g${t}>${shapeElement(k, ` fill="none" stroke="${color}" stroke-width="${num(Math.max(1, k.strokeWeight))}"`)}</g>`;
    if (k.type === 'RECTANGLE' || k.type === 'ELLIPSE' || k.type === 'VECTOR' || k.type === 'FRAME' || k.type === 'COMPONENT')
      return `<g${t}>${shapeElement(k, ` fill="${color}"`)}</g>`;
    return `<g${t}><rect width="${num(k.width)}" height="${num(k.height)}" fill="${color}"/></g>`;
  }

  private boolean(doc: SceneDoc, n: SceneNode): string {
    const kids = doc.children(n.id).map((id) => doc.get(id)!).filter((k) => k.visible);
    if (kids.length === 0) return '';
    const pad = 2;
    const region = `maskUnits="userSpaceOnUse" x="${num(-pad)}" y="${num(-pad)}" width="${num(n.width + pad * 2)}" height="${num(n.height + pad * 2)}"`;
    const mask = (content: string) => {
      const id = this.id('bool');
      this.defs.push(`<mask id="${id}" ${region}>${content}</mask>`);
      return id;
    };
    const white = (k: SceneNode) => this.silhouette(doc, k, '#fff');
    const black = (k: SceneNode) => this.silhouette(doc, k, '#000');
    let content: string;
    const op = n.booleanOp ?? 'union';
    if (op === 'union') content = kids.map(white).join('');
    else if (op === 'subtract') content = white(kids[0]) + kids.slice(1).map(black).join('');
    else if (op === 'intersect') {
      content = white(kids[0]);
      for (const k of kids.slice(1)) content = `<g mask="url(#${mask(white(k))})">${content}</g>`;
    } else {
      // exclude: everything once, minus where the first two overlap
      const overlap = `<g mask="url(#${mask(white(kids[1] ?? kids[0]))})">${black(kids[0])}</g>`;
      content = kids.map(white).join('') + (kids.length > 1 ? overlap : '');
    }
    const id = mask(content);
    const box: SceneNode = { ...n, type: 'RECTANGLE', radii: [0, 0, 0, 0] };
    return `<g mask="url(#${id})">${this.fills(box)}</g>`;
  }

  private container(doc: SceneDoc, n: SceneNode, depth: number): string {
    let kids = this.kids(doc, n.id, depth);
    if (n.clipsContent && kids) {
      const cid = this.id('clip');
      this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
      kids = `<g clip-path="url(#${cid})">${kids}</g>`;
    }
    return this.fills(n) + kids + this.strokes(n);
  }

  node(doc: SceneDoc, n: SceneNode, depth = 0): string {
    if (!n.visible || n.slice) return '';
    if (++this.elements > SVG_MAX_ELEMENTS) throw new Error('This selection is too large to export as SVG. Try PNG or PDF.');
    const m = localMatrix(n.x, n.y, n.rotation);
    // blend mode names come from a fixed list (schema), so they are safe in the attribute
    const opacity =
      (n.opacity < 1 ? ` opacity="${num(n.opacity)}"` : '') + (n.blendMode && n.blendMode !== 'normal' ? ` style="mix-blend-mode:${n.blendMode}"` : '');
    const name = ` data-name="${escapeXml(n.name)}"`;
    let body = '';
    switch (n.type) {
      case 'FRAME':
      case 'COMPONENT':
      case 'COMPONENT_SET':
        body = this.container(doc, n, depth);
        break;
      case 'GROUP':
        body = this.kids(doc, n.id, depth);
        break;
      case 'BOOLEAN':
        body = this.boolean(doc, n);
        break;
      case 'INSTANCE': {
        const v = depth < 12 ? instanceDoc(this.root, n) : null;
        body = v ? this.container(v, v.get(n.id)!, depth + 1) : '';
        break;
      }
      case 'RECTANGLE':
      case 'ELLIPSE':
      case 'VECTOR':
        body = this.fills(n) + this.strokes(n);
        break;
      case 'LINE':
        body = this.line(n);
        break;
      case 'TEXT':
        body = this.text(n);
        break;
    }
    const effects = (n.effects ?? []).filter((e) => e.visible && e.type !== 'BACKGROUND_BLUR');
    if (effects.length) body = `<g${this.filter(n, effects)}>${body}</g>`;
    return `<g${name}${matrixAttr(m)}${opacity}>${body}</g>`;
  }
}

/** SVG markup with the given assets (images as URLs). Text runs are returned for font embedding. */
export function svgMarkup(doc: SceneDoc, target: ExportTarget, assets: SvgAssets = { images: new Map() }, fontCss = '') {
  const b = target.clip ?? exportBounds(doc, target.ids);
  if (!b) throw new Error('Nothing to export');
  const w = new SvgWriter(doc, assets);
  const parts: string[] = [];
  if (target.background)
    parts.push(`<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" fill="${escapeXml(target.background)}"/>`);
  for (const id of target.ids) {
    const n = doc.get(id)!;
    const pw = n.parentId === null ? IDENTITY : doc.world(n.parentId);
    const inner = w.node(doc, n);
    parts.push(pw === IDENTITY ? inner : `<g${matrixAttr(pw)}>${inner}</g>`);
  }
  const style = fontCss ? `<style>${fontCss}</style>` : '';
  const size = parts.reduce((s, p) => s + p.length, 0) + style.length;
  if (size > SVG_MAX_CHARS) throw new Error('This selection is too large to export as SVG. Try PNG or PDF.');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(b.width)}" height="${num(b.height)}" viewBox="${num(b.x)} ${num(b.y)} ${num(b.width)} ${num(b.height)}" fill="none">` +
    w.defsMarkup(style) +
    parts.join('') +
    '</svg>';
  return { svg, runs: w.runs };
}

/** Self-contained SVG: images and the font subsets the text needs are embedded. */
export async function exportSvg(doc: SceneDoc, target: ExportTarget, opts: { embedFonts?: boolean } = {}): Promise<string> {
  const ids = imagesUsed(doc, target.ids);
  await ensureImages(ids);
  const images = new Map<string, { url: string; width: number; height: number }>();
  await Promise.all(
    ids.map(async (id) => {
      const url = await imageDataUrl(id);
      const size = imageSize(id);
      if (url && size) images.set(id, { url, ...size });
    }),
  );
  const first = svgMarkup(doc, target, { images });
  if (opts.embedFonts === false || first.runs.length === 0) return first.svg;
  const css = await embeddedFontCss(first.runs);
  return css ? svgMarkup(doc, target, { images }, css).svg : first.svg;
}
