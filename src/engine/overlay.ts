import type { SceneNode } from '../../shared/schema.ts';
import { type Editor, gridRects } from './editor.ts';
import { type Mat, apply, multiply } from './math.ts';
import { instanceDoc } from './instances.ts';
import { drawChildren, imageRect } from './render.ts';
import { getImage } from './images.ts';
import { tracePath } from './vector.ts';
import { linePoints } from './geometry.ts';

export type OverlayColors = {
  accent: string;
  onAccent: string;
  handleFill: string;
  guide: string;
  component: string;
  textMuted: string;
  canvasOutside: string;
  font: string;
};

const LABEL_FONT_SIZE = 11;

function outlinePath(ctx: CanvasRenderingContext2D, n: SceneNode, m: Mat) {
  ctx.beginPath();
  if (n.type === 'VECTOR' && n.vector) {
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    tracePath(ctx, n.vector);
    ctx.restore();
    return;
  }
  if (n.type === 'LINE') {
    linePoints(n).forEach((p, i) => {
      const q = apply(m, p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
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

/** Prototype mode: an arrow from each interactive layer to where it goes, and the starting frame's flag. */
function drawPrototype(ctx: CanvasRenderingContext2D, editor: Editor, c: OverlayColors) {
  const doc = editor.doc;
  const page = doc.currentPage;
  const selected = new Set(editor.selection);
  const screenBox = (id: string) => {
    const b = doc.worldBounds(id);
    const a = editor.toScreen({ x: b.x, y: b.y });
    return { x: a.x, y: a.y, width: b.width * editor.viewport.zoom, height: b.height * editor.viewport.zoom };
  };
  ctx.save();
  ctx.font = `600 ${LABEL_FONT_SIZE}px ${c.font}`;
  for (const n of doc.all()) {
    if (!n.reactions?.length || doc.pageOf(n.id) !== page || !doc.isEffectivelyVisible(n.id)) continue;
    const from = screenBox(n.id);
    const strong = selected.has(n.id);
    for (const r of n.reactions) {
      const dest = r.destinationId ? doc.get(r.destinationId) : undefined;
      if (!dest || dest.parentId !== null || doc.pageOf(dest.id) !== page) continue;
      const to = screenBox(dest.id);
      const a = { x: from.x + from.width, y: from.y + from.height / 2 };
      // into the destination's nearer side
      const left = a.x <= to.x + to.width / 2;
      const b = { x: left ? to.x : to.x + to.width, y: to.y + Math.min(to.height / 2, 40) };
      const bend = Math.max(40, Math.abs(b.x - a.x) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(a.x + bend, a.y, left ? b.x - bend : b.x + bend, b.y, b.x, b.y);
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = strong ? 1 : 0.55;
      ctx.lineWidth = strong ? 2 : 1.5;
      ctx.stroke();
      // arrowhead pointing into the frame
      const dir = left ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 8 * dir, b.y - 5);
      ctx.lineTo(b.x - 8 * dir, b.y + 5);
      ctx.closePath();
      ctx.fillStyle = c.accent;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = c.handleFill;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const start = editor.currentPage.prototypeStart;
  const s = start ? doc.get(start) : undefined;
  if (s && s.parentId === null && doc.pageOf(s.id) === page) {
    const box = screenBox(s.id);
    const label = 'Start';
    const w = ctx.measureText(label).width + 12;
    const y = box.y - 24;
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.roundRect(box.x, y, w, 18, 3);
    ctx.fill();
    ctx.fillStyle = c.onAccent;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, box.x + 6, y + 9);
  }
  ctx.restore();
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

  // layout grids of visible frames on this page
  if (editor.showGrids) {
    for (const n of doc.all()) {
      if (!n.grids?.length || !doc.isEffectivelyVisible(n.id) || doc.pageOf(n.id) !== doc.currentPage || n.rotation !== 0) continue;
      const b = doc.worldBounds(n.id);
      const tl = editor.toScreen({ x: b.x, y: b.y });
      if (tl.x > width || tl.y > height || tl.x + b.width * v.zoom < 0 || tl.y + b.height * v.zoom < 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(tl.x, tl.y, b.width * v.zoom, b.height * v.zoom);
      ctx.clip();
      for (const g of n.grids) {
        if (!g.visible) continue;
        const rects = gridRects({ ...n, grids: [g] }, b);
        ctx.globalAlpha = g.opacity;
        if (g.type === 'grid') {
          ctx.strokeStyle = g.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (const r of rects) {
            const a = editor.toScreen({ x: r.x, y: r.y });
            ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
            ctx.lineTo(Math.round(a.x + r.width * v.zoom) + 0.5, Math.round(a.y + r.height * v.zoom) + 0.5);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = g.color;
          for (const r of rects) {
            const a = editor.toScreen({ x: r.x, y: r.y });
            ctx.fillRect(a.x, a.y, r.width * v.zoom, r.height * v.zoom);
          }
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }

  // page guides (and one being dragged)
  const guides = [...(editor.currentPage.guides ?? [])];
  const drag = editor.guideDrag;
  if (drag && drag.index !== null) guides.splice(drag.index, 1);
  const drawGuide = (axis: 'x' | 'y', pos: number, faded: boolean) => {
    const s = editor.toScreen(axis === 'x' ? { x: pos, y: 0 } : { x: 0, y: pos });
    ctx.save();
    ctx.globalAlpha = faded ? 0.4 : 1;
    ctx.strokeStyle = c.guide;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (axis === 'x') {
      ctx.moveTo(Math.round(s.x) + 0.5, 0);
      ctx.lineTo(Math.round(s.x) + 0.5, height);
    } else {
      ctx.moveTo(0, Math.round(s.y) + 0.5);
      ctx.lineTo(width, Math.round(s.y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  };
  for (const g of guides) drawGuide(g.axis, g.pos, false);
  if (drag) drawGuide(drag.axis, drag.pos, drag.remove);

  // frame labels (top-level frames)
  ctx.font = `500 ${LABEL_FONT_SIZE}px ${c.font}`;
  ctx.textBaseline = 'bottom';
  for (const id of doc.children(null)) {
    const n = doc.get(id)!;
    if (!(n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE') || !n.visible) continue;
    const m = multiply(view, doc.world(id));
    const at = apply(m, { x: 0, y: 0 });
    const right = apply(m, { x: n.width, y: 0 });
    const room = Math.hypot(right.x - at.x, right.y - at.y);
    if (room < 24) continue;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(Math.atan2(m[1], m[0]));
    const isComponent = n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE';
    ctx.fillStyle = selected.has(id) ? c.accent : isComponent ? c.component : c.textMuted;
    let label = n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' ? `❖ ${n.name}` : n.type === 'INSTANCE' ? `◇ ${n.name}` : n.name;
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

  // the layer a connector end will attach to
  if (editor.bindTarget) {
    const n = doc.get(editor.bindTarget);
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
        const line = handle.kind === 'line-end' ? sel[0] : null;
        const bound = line && (handle.kind === 'line-end' && handle.end === 0 ? line.startBind : line.endBind);
        if (handle.kind === 'line-end') ctx.arc(at.x, at.y, bound ? 5.5 : 4.5, 0, Math.PI * 2);
        else ctx.rect(crisp(at.x - s / 2), crisp(at.y - s / 2), s - 1, s - 1);
        // attached connector ends are filled, loose ends are hollow
        ctx.fillStyle = bound ? c.accent : c.handleFill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = bound ? c.handleFill : c.accent;
        ctx.stroke();
      }
    }
  }

  // pen: the path so far, its points, and the segment to the pointer
  if (editor.pen) {
    const pts = editor.pen.points.map((p) => editor.toScreen(p));
    if (editor.penCursor && pts.length) {
      const last = pts[pts.length - 1];
      const cur = editor.toScreen(editor.penCursor);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.rect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
      ctx.fillStyle = i === 0 ? c.accent : c.handleFill;
      ctx.fill();
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  if (editor.prototypeView) drawPrototype(ctx, editor, c);

  // crop: the whole image faded, the layer's box outlined
  if (editor.cropping) {
    const n = doc.get(editor.cropping);
    const paint = n?.fills.find((p) => p.type === 'IMAGE' && p.scaleMode === 'crop');
    const img = paint && paint.type === 'IMAGE' ? getImage(paint.imageId) : null;
    if (n && paint && paint.type === 'IMAGE' && img) {
      const m = multiply(view, doc.world(n.id));
      const r = imageRect(paint, img.naturalWidth, img.naturalHeight, n.width, n.height);
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(img, r.x, r.y, r.width, r.height);
      ctx.restore();
      outlinePath(ctx, n, m);
      haloStroke(ctx, c);
    }
  }

  // vector editing: outline, handles and points
  if (editor.editingVector) {
    const n = doc.get(editor.editingVector);
    if (n) {
      outlinePath(ctx, n, multiply(view, doc.world(n.id)));
      haloStroke(ctx, c);
      const parts = editor.vectorParts();
      ctx.lineWidth = 1;
      for (const part of parts) {
        if (part.part === 'point') continue;
        ctx.beginPath();
        ctx.moveTo(part.anchor.x, part.anchor.y);
        ctx.lineTo(part.at.x, part.at.y);
        ctx.strokeStyle = c.accent;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(part.at.x, part.at.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = c.handleFill;
        ctx.fill();
        ctx.stroke();
      }
      for (const part of parts) {
        if (part.part !== 'point') continue;
        const selected = part.index === editor.vectorPoint;
        ctx.beginPath();
        ctx.rect(Math.round(part.at.x) - 3.5, Math.round(part.at.y) - 3.5, 7, 7);
        ctx.fillStyle = selected ? c.accent : c.handleFill;
        ctx.fill();
        ctx.strokeStyle = c.accent;
        ctx.stroke();
      }
    }
  }

  // the layer picked inside an instance
  if (editor.inner) {
    const inst = doc.get(editor.inner.instanceId);
    const v = inst ? instanceDoc(doc, inst) : null;
    const vid = `${editor.inner.instanceId}~${editor.inner.sourceId}`;
    const vn = v?.get(vid);
    if (inst && v && vn) {
      outlinePath(ctx, vn, multiply(view, multiply(doc.world(inst.id), v.world(vid))));
      haloStroke(ctx, { ...c, accent: c.component }, 1.5);
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
