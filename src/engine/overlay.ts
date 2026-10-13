import type { SceneNode } from '../../shared/schema.ts';
import type { Editor } from './editor.ts';
import { type Mat, apply, multiply } from './math.ts';
import { drawChildren } from './render.ts';

export type OverlayColors = {
  accent: string;
  onAccent: string;
  handleFill: string;
  guide: string;
  textMuted: string;
  canvasOutside: string;
  font: string;
};

const LABEL_FONT_SIZE = 11;

function outlinePath(ctx: CanvasRenderingContext2D, n: SceneNode, m: Mat) {
  ctx.beginPath();
  if (n.type === 'LINE') {
    const a = apply(m, { x: 0, y: 0 });
    const b = apply(m, { x: n.width, y: 0 });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    return;
  }
  if (n.type === 'ELLIPSE') {
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.ellipse(n.width / 2, n.height / 2, n.width / 2, n.height / 2, 0, 0, Math.PI * 2);
    ctx.restore();
    return;
  }
  const pts = [
    { x: 0, y: 0 },
    { x: n.width, y: 0 },
    { x: n.width, y: n.height },
    { x: 0, y: n.height },
  ].map((p) => apply(m, p));
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
}

/** Strokes the current path in accent with a light halo, so it stays visible on any content. */
function haloStroke(ctx: CanvasRenderingContext2D, c: OverlayColors, width = 1) {
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = c.handleFill;
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = width;
  ctx.strokeStyle = c.accent;
  ctx.stroke();
}

function crisp(v: number) {
  return Math.round(v) + 0.5;
}

/** Draws the document and all editor overlays. `dpr` is the device pixel ratio. */
export function renderEditor(ctx: CanvasRenderingContext2D, editor: Editor, dpr: number, c: OverlayColors) {
  const { width, height } = editor.viewSize;
  const doc = editor.doc;
  const v = editor.viewport;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = editor.background;
  ctx.fillRect(0, 0, width, height);

  // document
  ctx.save();
  ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.x, dpr * v.y);
  const topLeft = editor.toWorld(0, 0);
  drawChildren(ctx, doc, null, {
    skip: editor.editingText ? new Set([editor.editingText]) : undefined,
    cull: { x: topLeft.x, y: topLeft.y, width: width / v.zoom, height: height / v.zoom },
  });
  ctx.restore();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const view = editor.viewMatrix;
  const selected = new Set(editor.selection);

  // frame labels (top-level frames)
  ctx.font = `500 ${LABEL_FONT_SIZE}px ${c.font}`;
  ctx.textBaseline = 'bottom';
  for (const id of doc.children(null)) {
    const n = doc.get(id)!;
    if (n.type !== 'FRAME' || !n.visible) continue;
    const m = multiply(view, doc.world(id));
    const at = apply(m, { x: 0, y: 0 });
    const right = apply(m, { x: n.width, y: 0 });
    const room = Math.hypot(right.x - at.x, right.y - at.y);
    if (room < 24) continue;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(Math.atan2(m[1], m[0]));
    ctx.fillStyle = selected.has(id) ? c.accent : c.textMuted;
    let label = n.name;
    while (label.length > 1 && ctx.measureText(label).width > room) label = label.slice(0, -2) + '…';
    ctx.fillText(label, 0, -4);
    ctx.restore();
  }

  // drop target
  if (editor.dropTarget) {
    const n = doc.get(editor.dropTarget);
    if (n) {
      outlinePath(ctx, n, multiply(view, doc.world(n.id)));
      haloStroke(ctx, c, 2);
    }
  }

  // hover
  if (editor.hover && !selected.has(editor.hover) && !editor.isInteracting) {
    const n = doc.get(editor.hover);
    if (n) {
      outlinePath(ctx, n, multiply(view, doc.world(n.id)));
      haloStroke(ctx, c, n.type === 'LINE' ? 1.5 : 1);
    }
  }

  // selection
  const sel = editor.selectedNodes();
  if (sel.length > 0 && !editor.editingText) {
    for (const n of sel) {
      if (sel.length > 1 || n.type === 'LINE') {
        outlinePath(ctx, n, multiply(view, doc.world(n.id)));
        haloStroke(ctx, c);
      }
    }
    const lineOnly = sel.length === 1 && sel[0].type === 'LINE';
    if (!lineOnly) {
      const { m, w, h } = editor.selectionFrame();
      const pts = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ].map((p) => apply(m, p));
      ctx.beginPath();
      const axisAligned = Math.abs(m[1]) < 1e-9;
      pts.forEach((p, i) => {
        const x = axisAligned ? crisp(p.x) : p.x;
        const y = axisAligned ? crisp(p.y) : p.y;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      haloStroke(ctx, c);
    }
    if (!editor.isInteracting || editor.interactionKind === 'resize' || editor.interactionKind === 'line-end') {
      const { w, h } = editor.selectionFrame();
      const screenW = Math.abs(w * v.zoom);
      const screenH = Math.abs(h * v.zoom);
      for (const { handle, at } of editor.handlePositions()) {
        if (handle.kind === 'resize') {
          const isEdge = handle.handle.length === 1;
          if (isEdge && (handle.handle === 'n' || handle.handle === 's' ? screenW < 24 : screenH < 24)) continue;
        }
        const s = 7;
        ctx.beginPath();
        if (handle.kind === 'line-end') ctx.arc(at.x, at.y, 4.5, 0, Math.PI * 2);
        else ctx.rect(crisp(at.x - s / 2), crisp(at.y - s / 2), s - 1, s - 1);
        ctx.fillStyle = c.handleFill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = c.accent;
        ctx.stroke();
      }
    }
  }

  // marquee
  if (editor.marquee) {
    const a = editor.toScreen({ x: editor.marquee.x, y: editor.marquee.y });
    const w = editor.marquee.width * v.zoom;
    const h = editor.marquee.height * v.zoom;
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(a.x, a.y, w, h);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.accent;
    ctx.strokeRect(crisp(a.x), crisp(a.y), Math.round(w), Math.round(h));
  }

  // smart guides
  if (editor.guides.length) {
    ctx.strokeStyle = c.guide;
    ctx.lineWidth = 1;
    for (const g of editor.guides) {
      ctx.beginPath();
      if (g.axis === 'x') {
        const a = editor.toScreen({ x: g.pos, y: g.from });
        const b = editor.toScreen({ x: g.pos, y: g.to });
        ctx.moveTo(crisp(a.x), a.y);
        ctx.lineTo(crisp(b.x), b.y);
      } else {
        const a = editor.toScreen({ x: g.from, y: g.pos });
        const b = editor.toScreen({ x: g.to, y: g.pos });
        ctx.moveTo(a.x, crisp(a.y));
        ctx.lineTo(b.x, crisp(b.y));
      }
      ctx.stroke();
    }
  }

  // size badge
  if (editor.sizeBadge) {
    ctx.font = `500 ${LABEL_FONT_SIZE}px ${c.font}`;
    const text = editor.sizeBadge.text;
    const tw = ctx.measureText(text).width;
    const padX = 5;
    const bw = tw + padX * 2;
    const bh = 18;
    const x = Math.round(editor.sizeBadge.at.x - bw / 2);
    const y = Math.round(editor.sizeBadge.at.y);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 2);
    ctx.fill();
    ctx.fillStyle = c.onAccent;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + bh / 2 + 0.5);
  }
}
