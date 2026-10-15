import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize, X } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import type { Rect } from '../../engine/math.ts';
import { FrameCache, drawChildren } from '../../engine/render.ts';
import { IconButton } from '../components.tsx';
import { t } from '../i18n.ts';

type Slide = { name: string; box: Rect };
type Camera = { x: number; y: number; zoom: number };

const PAD = 48;
const MOVE_MS = 450;

/**
 * The slides of a board: its sections in reading order (rows from the top, then left to right),
 * else its frames, else everything on the page as one slide.
 */
export function boardSlides(editor: Editor): Slide[] {
  const doc = editor.doc;
  const top = doc.children(null).map((id) => doc.get(id)!).filter((n) => n.visible && !n.slice);
  const pick = (ns: typeof top) =>
    ns.map((n) => ({ name: n.name, box: doc.worldBounds(n.id) }));
  let slides = pick(top.filter((n) => n.section));
  if (!slides.length) slides = pick(editor.topFrames().filter((f) => f.visible));
  if (!slides.length) {
    const b = editor.contentBounds();
    return b && b.width > 0 && b.height > 0 ? [{ name: editor.currentPage.name, box: b }] : [];
  }
  // reading order: a slide starts a new row when it begins below the middle of the row so far
  slides.sort((a, b) => a.box.y - b.box.y);
  const rows: Slide[][] = [];
  for (const s of slides) {
    const row = rows[rows.length - 1];
    const rowMid = row ? Math.min(...row.map((r) => r.box.y + r.box.height / 2)) : -Infinity;
    if (row && s.box.y < rowMid) row.push(s);
    else rows.push([s]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box.x - b.box.x));
}

/** Height of the bar under the slides. */
const BAR = 56;

/** The camera that shows a slide whole, centred above the bar, with a margin. */
function cameraFor(box: Rect, w: number, h: number): Camera {
  const zoom = Math.min((w - PAD * 2) / box.width, (h - PAD * 2 - BAR) / box.height, 8);
  return centredOn({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, zoom, w, h);
}

const centredOn = (c: { x: number; y: number }, zoom: number, w: number, h: number): Camera => ({ zoom, x: w / 2 - c.x * zoom, y: (h - BAR) / 2 - c.y * zoom });
const centreOf = (cam: Camera, w: number, h: number) => ({ x: (w / 2 - cam.x) / cam.zoom, y: ((h - BAR) / 2 - cam.y) / cam.zoom });

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Presents a board: one slide at a time, the view gliding from one to the next. */
export function BoardPresenter({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const slides = useMemo(() => boardSlides(editor), [editor]);
  const [index, setIndex] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera | null>(null);
  const frames = useMemo(() => new FrameCache(), []);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const go = (i: number) => setIndex(Math.max(0, Math.min(slides.length - 1, i)));

  // draw at a camera; moving between slides animates the camera
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !slides.length) return;
    let raf = 0;
    const draw = (cam: Camera) => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = editor.background;
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
      frames.nextFrame();
      drawChildren(ctx, editor.doc, null, { scale: cam.zoom, frames, cull: { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: w / cam.zoom, height: h / cam.zoom } });
      camera.current = cam;
    };
    const target = cameraFor(slides[index].box, window.innerWidth, window.innerHeight);
    const from = camera.current;
    const still = !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) draw(target);
    else {
      const start = performance.now();
      const step = (now: number) => {
        const k = ease(Math.min(1, (now - start) / MOVE_MS));
        // zoom moves in proportion, so the glide looks even at every scale
        const w = window.innerWidth;
        const h = window.innerHeight;
        const a = centreOf(from, w, h);
        const b = centreOf(target, w, h);
        // zoom changes in proportion, so the glide looks even at every scale
        const zoom = from.zoom * (target.zoom / from.zoom) ** k;
        draw(centredOn({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, zoom, w, h));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    const onResize = () => draw(cameraFor(slides[index].box, window.innerWidth, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [editor, slides, index, frames]);

  useEffect(() => {
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(index + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(index - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(slides.length - 1);
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'f' || e.key === 'F') void toggleFullscreen();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // leaving full screen with the browser's own Esc doesn't end the presentation
  useEffect(() => () => void (document.fullscreenElement && document.exitFullscreen().catch(() => {})), []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      /* not allowed here: the window is presentation enough */
    }
  };

  if (!slides.length) {
    return (
      <div className="board-presenter empty" role="dialog" aria-modal="true" aria-label={t('Present board')} tabIndex={-1} ref={rootRef}>
        <p>{t('Nothing to present on this page yet.')}</p>
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    );
  }
  return (
    <div className="board-presenter" role="dialog" aria-modal="true" aria-label={t('Present board')} tabIndex={-1} ref={rootRef}>
      <canvas
        ref={canvasRef}
        aria-label={t('Slide {n} of {total}: {name}', { n: index + 1, total: slides.length, name: slides[index].name })}
        role="img"
        onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          // a swipe sideways, or a tap on the left or right half
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(index + (dx < 0 ? 1 : -1));
          else if (Math.abs(dx) < 8) go(index + (e.clientX > window.innerWidth / 2 ? 1 : -1));
        }}
      />
      <div className="board-bar">
        <IconButton label={t('Previous')} disabled={index === 0} onClick={() => go(index - 1)}>
          <ChevronLeft size={18} strokeWidth={1.5} />
        </IconButton>
        <span className="board-count" aria-live="polite">
          {t('{n} / {total}', { n: index + 1, total: slides.length })} <span className="board-name">{slides[index].name}</span>
        </span>
        <IconButton label={t('Next')} disabled={index === slides.length - 1} onClick={() => go(index + 1)}>
          <ChevronRight size={18} strokeWidth={1.5} />
        </IconButton>
        <IconButton label={t('Full screen')} onClick={() => void toggleFullscreen()}>
          <Maximize size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label={t('Close presentation')} onClick={onClose}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  );
}
