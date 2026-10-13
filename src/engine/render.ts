import type { Paint, SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { type Rect, localMatrix, rectsIntersect } from './math.ts';
import { fontString, layoutText, lineOffset } from './text.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type DrawOptions = {
  /** Nodes drawn by something else (the text being edited). */
  skip?: Set<string>;
  /** World area that is visible; layers fully outside it are not drawn. */
  cull?: Rect;
};

function culled(doc: SceneDoc, n: SceneNode, cull: Rect | undefined): boolean {
  if (!cull) return false;
  // Frames that don't clip can have children anywhere, so only their own box is skipped.
  if (n.type === 'FRAME' && !n.clipsContent) return false;
  const b = doc.worldBounds(n.id);
  const pad = n.strokeWeight * 2 + (n.type === 'LINE' ? 20 + n.strokeWeight * 4 : 0);
  return !rectsIntersect({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, cull);
}

export function paintCss(p: Paint, extraAlpha = 1): string {
  const r = parseInt(p.color.slice(1, 3), 16);
  const g = parseInt(p.color.slice(3, 5), 16);
  const b = parseInt(p.color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(p.opacity * extraAlpha * 1000) / 1000})`;
}

export function clampRadii(n: SceneNode): [number, number, number, number] {
  const r = n.radii ?? [0, 0, 0, 0];
  const max = Math.min(n.width, n.height) / 2;
  return r.map((v) => Math.max(0, Math.min(v, max))) as [number, number, number, number];
}

function shapePath(ctx: Ctx, n: SceneNode) {
  ctx.beginPath();
  if (n.type === 'ELLIPSE') {
    ctx.ellipse(n.width / 2, n.height / 2, n.width / 2, n.height / 2, 0, 0, Math.PI * 2);
  } else {
    const [tl, tr, br, bl] = clampRadii(n);
    if (tl || tr || br || bl) ctx.roundRect(0, 0, n.width, n.height, [tl, tr, br, bl]);
    else ctx.rect(0, 0, n.width, n.height);
  }
}

function fillShape(ctx: Ctx, n: SceneNode) {
  for (const p of n.fills) {
    if (!p.visible) continue;
    ctx.fillStyle = paintCss(p);
    ctx.fill();
  }
}

function strokeShape(ctx: Ctx, n: SceneNode) {
  const paints = n.strokes.filter((p) => p.visible);
  if (paints.length === 0 || n.strokeWeight <= 0) return;
  ctx.save();
  ctx.setLineDash(n.strokeDash);
  ctx.lineJoin = 'miter';
  if (n.strokeAlign === 'center') {
    ctx.lineWidth = n.strokeWeight;
  } else if (n.strokeAlign === 'inside') {
    ctx.clip();
    ctx.lineWidth = n.strokeWeight * 2;
  } else {
    // outside: clip to everything except the shape
    const pad = n.strokeWeight * 2 + 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-pad, -pad, n.width + pad * 2, n.height + pad * 2);
    if (n.type === 'ELLIPSE') {
      ctx.ellipse(n.width / 2, n.height / 2, n.width / 2, n.height / 2, 0, 0, Math.PI * 2);
    } else {
      const [tl, tr, br, bl] = clampRadii(n);
      ctx.roundRect(0, 0, n.width, n.height, [tl, tr, br, bl]);
    }
    ctx.clip('evenodd');
    shapePath(ctx, n);
    ctx.lineWidth = n.strokeWeight * 2;
    for (const p of paints) {
      ctx.strokeStyle = paintCss(p);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    return;
  }
  for (const p of paints) {
    ctx.strokeStyle = paintCss(p);
    ctx.stroke();
  }
  ctx.restore();
}

export function arrowSize(strokeWeight: number) {
  return { length: 6 + strokeWeight * 3, halfWidth: 3 + strokeWeight * 1.6 };
}

function drawLine(ctx: Ctx, n: SceneNode) {
  const paints = n.strokes.filter((p) => p.visible);
  if (paints.length === 0 || n.strokeWeight <= 0) return;
  const { length: al, halfWidth: aw } = arrowSize(n.strokeWeight);
  const len = n.width;
  const trimStart = n.arrowStart ? Math.min(al * 0.8, len / 2) : 0;
  const trimEnd = n.arrowEnd ? Math.min(al * 0.8, len / 2) : 0;
  ctx.save();
  ctx.lineWidth = n.strokeWeight;
  ctx.lineCap = 'butt';
  ctx.setLineDash(n.strokeDash);
  for (const p of paints) {
    ctx.strokeStyle = paintCss(p);
    ctx.fillStyle = paintCss(p);
    ctx.beginPath();
    ctx.moveTo(trimStart, 0);
    ctx.lineTo(len - trimEnd, 0);
    ctx.stroke();
    if (n.arrowEnd) {
      ctx.beginPath();
      ctx.moveTo(len, 0);
      ctx.lineTo(len - al, -aw);
      ctx.lineTo(len - al, aw);
      ctx.closePath();
      ctx.fill();
    }
    if (n.arrowStart) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(al, -aw);
      ctx.lineTo(al, aw);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawText(ctx: Ctx, n: SceneNode) {
  const t = n.text!;
  const layout = layoutText(t, t.autoResize === 'width' ? null : n.width);
  ctx.font = fontString(t);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${t.letterSpacing}px`;
  ctx.textBaseline = 'middle';
  for (const p of n.fills) {
    if (!p.visible) continue;
    ctx.fillStyle = paintCss(p);
    layout.lines.forEach((line, i) => {
      ctx.fillText(line.text, lineOffset(t.align, n.width, line.width), i * layout.lineHeight + layout.lineHeight / 2);
    });
  }
}

export function drawNode(ctx: Ctx, doc: SceneDoc, n: SceneNode, opts: DrawOptions = {}) {
  if (!n.visible || opts.skip?.has(n.id) || culled(doc, n, opts.cull)) return;
  ctx.save();
  const m = localMatrix(n.x, n.y, n.rotation);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.globalAlpha *= n.opacity;
  switch (n.type) {
    case 'FRAME': {
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
  ctx.restore();
}

export function drawChildren(ctx: Ctx, doc: SceneDoc, parentId: string | null, opts: DrawOptions = {}) {
  for (const id of doc.children(parentId)) drawNode(ctx, doc, doc.get(id)!, opts);
}
