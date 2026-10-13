import type { Paint, SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { type Mat, type Rect, IDENTITY, localMatrix, unionRects } from './math.ts';
import { arrowSize, clampRadii, drawNode } from './render.ts';
import { fontStack, layoutText, lineOffset } from './text.ts';

export type ExportTarget = { ids: string[]; background: string | null };

/** Extra room for strokes and arrow heads that reach outside a node's box. */
function overhang(doc: SceneDoc, id: string): number {
  let max = 0;
  const visit = (nid: string) => {
    const n = doc.get(nid)!;
    if (!n.visible) return;
    const stroked = n.strokes.some((p) => p.visible) && n.strokeWeight > 0;
    if (stroked) {
      if (n.type === 'LINE') max = Math.max(max, n.strokeWeight / 2, n.arrowStart || n.arrowEnd ? arrowSize(n.strokeWeight).halfWidth : 0);
      else if (n.strokeAlign === 'center') max = Math.max(max, n.strokeWeight / 2);
      else if (n.strokeAlign === 'outside') max = Math.max(max, n.strokeWeight);
    }
    if (!(n.type === 'FRAME' && n.clipsContent)) for (const c of doc.children(nid)) visit(c);
  };
  visit(id);
  return max;
}

/** Area to export: a frame exports exactly its box; anything else its bounds plus strokes. */
export function exportBounds(doc: SceneDoc, ids: string[]): Rect | null {
  const rects = ids.map((id) => {
    const n = doc.get(id)!;
    const b = doc.worldBounds(id);
    if (n.type === 'FRAME' && n.clipsContent) return b;
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

export async function exportPng(doc: SceneDoc, target: ExportTarget, scale: number): Promise<Blob> {
  const b = exportBounds(doc, target.ids);
  if (!b) throw new Error('Nothing to export');
  let s = scale;
  while (b.width * s * b.height * s > MAX_PIXELS && s > 0.1) s /= 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(b.width * s));
  canvas.height = Math.max(1, Math.round(b.height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.setTransform(s, 0, 0, s, -b.x * s, -b.y * s);
  if (target.background) {
    ctx.fillStyle = target.background;
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
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
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
  if (n.type === 'ELLIPSE') {
    return `<ellipse cx="${num(n.width / 2)}" cy="${num(n.height / 2)}" rx="${num(n.width / 2)}" ry="${num(n.height / 2)}"${attrs}/>`;
  }
  return `<path d="${roundedRectPath(n)}"${attrs}/>`;
}

const paintAttrs = (p: Paint, kind: 'fill' | 'stroke') =>
  ` ${kind}="${escapeXml(p.color)}"${p.opacity < 1 ? ` ${kind}-opacity="${num(p.opacity)}"` : ''}`;

class SvgWriter {
  private defs: string[] = [];
  private seq = 0;
  private readonly doc: SceneDoc;

  constructor(doc: SceneDoc) {
    this.doc = doc;
  }

  private id(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  get defsMarkup() {
    return this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
  }

  private strokes(n: SceneNode): string {
    const paints = n.strokes.filter((p) => p.visible);
    if (paints.length === 0 || n.strokeWeight <= 0) return '';
    const dash = n.strokeDash.length ? ` stroke-dasharray="${n.strokeDash.map(num).join(' ')}"` : '';
    const out: string[] = [];
    let wrapOpen = '';
    let wrapClose = '';
    let width = n.strokeWeight;
    if (n.strokeAlign === 'inside') {
      const cid = this.id('clip');
      this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
      wrapOpen = `<g clip-path="url(#${cid})">`;
      wrapClose = '</g>';
      width *= 2;
    } else if (n.strokeAlign === 'outside') {
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
    for (const p of paints) out.push(shapeElement(n, ` fill="none"${paintAttrs(p, 'stroke')} stroke-width="${num(width)}"${dash}`));
    return wrapOpen + out.join('') + wrapClose;
  }

  private line(n: SceneNode): string {
    const paints = n.strokes.filter((p) => p.visible);
    if (paints.length === 0 || n.strokeWeight <= 0) return '';
    const { length: al, halfWidth: aw } = arrowSize(n.strokeWeight);
    const len = n.width;
    const ts = n.arrowStart ? Math.min(al * 0.8, len / 2) : 0;
    const te = n.arrowEnd ? Math.min(al * 0.8, len / 2) : 0;
    const dash = n.strokeDash.length ? ` stroke-dasharray="${n.strokeDash.map(num).join(' ')}"` : '';
    const out: string[] = [];
    for (const p of paints) {
      out.push(`<path d="M${num(ts)} 0H${num(len - te)}" fill="none"${paintAttrs(p, 'stroke')} stroke-width="${num(n.strokeWeight)}"${dash}/>`);
      if (n.arrowEnd) out.push(`<path d="M${num(len)} 0L${num(len - al)} ${num(-aw)}L${num(len - al)} ${num(aw)}Z"${paintAttrs(p, 'fill')}/>`);
      if (n.arrowStart) out.push(`<path d="M0 0L${num(al)} ${num(-aw)}L${num(al)} ${num(aw)}Z"${paintAttrs(p, 'fill')}/>`);
    }
    return out.join('');
  }

  private text(n: SceneNode): string {
    const t = n.text!;
    const layout = layoutText(t, t.autoResize === 'width' ? null : n.width);
    const fills = n.fills.filter((p) => p.visible);
    if (fills.length === 0) return '';
    const family = escapeXml(fontStack(t.fontFamily).replace(/"/g, "'"));
    const common =
      ` font-family="${family}" font-size="${num(t.fontSize)}" font-weight="${num(Number(t.fontWeight))}"` +
      (t.letterSpacing ? ` letter-spacing="${num(t.letterSpacing)}"` : '') +
      ' xml:space="preserve"';
    return fills
      .map((p) => {
        const spans = layout.lines
          .map((line, i) => {
            const x = lineOffset(t.align, n.width, line.width);
            const y = i * layout.lineHeight + layout.lineHeight / 2;
            return `<tspan x="${num(x)}" y="${num(y)}" dominant-baseline="central">${escapeXml(line.text)}</tspan>`;
          })
          .join('');
        return `<text${common}${paintAttrs(p, 'fill')}>${spans}</text>`;
      })
      .join('');
  }

  node(n: SceneNode): string {
    if (!n.visible) return '';
    const m = localMatrix(n.x, n.y, n.rotation);
    const opacity = n.opacity < 1 ? ` opacity="${num(n.opacity)}"` : '';
    const name = ` data-name="${escapeXml(n.name)}"`;
    let body = '';
    switch (n.type) {
      case 'FRAME': {
        const fills = n.fills.filter((p) => p.visible).map((p) => shapeElement(n, paintAttrs(p, 'fill'))).join('');
        let kids = this.doc.children(n.id).map((id) => this.node(this.doc.get(id)!)).join('');
        if (n.clipsContent && kids) {
          const cid = this.id('clip');
          this.defs.push(`<clipPath id="${cid}">${shapeElement(n, '')}</clipPath>`);
          kids = `<g clip-path="url(#${cid})">${kids}</g>`;
        }
        body = fills + kids + this.strokes(n);
        break;
      }
      case 'RECTANGLE':
      case 'ELLIPSE':
        body = n.fills.filter((p) => p.visible).map((p) => shapeElement(n, paintAttrs(p, 'fill'))).join('') + this.strokes(n);
        break;
      case 'LINE':
        body = this.line(n);
        break;
      case 'TEXT':
        body = this.text(n);
        break;
    }
    return `<g${name}${matrixAttr(m)}${opacity}>${body}</g>`;
  }
}

export function exportSvg(doc: SceneDoc, target: ExportTarget): string {
  const b = exportBounds(doc, target.ids);
  if (!b) throw new Error('Nothing to export');
  const w = new SvgWriter(doc);
  const parts: string[] = [];
  if (target.background) parts.push(`<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" fill="${escapeXml(target.background)}"/>`);
  for (const id of target.ids) {
    const n = doc.get(id)!;
    const pw = n.parentId === null ? IDENTITY : doc.world(n.parentId);
    const inner = w.node(n);
    parts.push(pw === IDENTITY ? inner : `<g${matrixAttr(pw)}>${inner}</g>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(b.width)}" height="${num(b.height)}" viewBox="${num(b.x)} ${num(b.y)} ${num(b.width)} ${num(b.height)}" fill="none">` +
    w.defsMarkup +
    parts.join('') +
    '</svg>'
  );
}
