import { useEffect, useRef } from 'react';
import { type Editor, RULER } from '../../engine/editor.ts';
import { useEditorRev } from '../hooks.ts';

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];

function readColor(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Top and left rulers in page coordinates. Dragging out of one creates a guide. */
export function Rulers({ editor, canvasRect }: { editor: Editor; canvasRect: () => DOMRect }) {
  useEditorRev(editor, 'view', 'selection', 'doc');
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = editor.viewSize;
    const v = editor.viewport;
    const step = STEPS.find((st) => st * v.zoom >= 60) ?? STEPS[STEPS.length - 1];
    const minor = step / 5;
    const text = readColor('--color-text-muted', '#5B6068');
    const line = readColor('--color-border-input', '#868B94');
    const surface = readColor('--color-surface', '#F7F7F8');
    const accentSoft = readColor('--color-accent-soft', '#FBE4EF');
    const accent = readColor('--color-accent', '#C8106E');
    const sel = editor.selectionBounds();

    const draw = (c: HTMLCanvasElement | null, horizontal: boolean) => {
      if (!c) return;
      const len = horizontal ? width : height;
      c.width = Math.round((horizontal ? len : RULER) * dpr);
      c.height = Math.round((horizontal ? RULER : len) * dpr);
      c.style.width = `${horizontal ? len : RULER}px`;
      c.style.height = `${horizontal ? RULER : len}px`;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, horizontal ? len : RULER, horizontal ? RULER : len);
      const offset = horizontal ? v.x : v.y;
      // the selection's extent
      if (sel) {
        const a = (horizontal ? sel.x : sel.y) * v.zoom + offset;
        const b = (horizontal ? sel.x + sel.width : sel.y + sel.height) * v.zoom + offset;
        ctx.fillStyle = accentSoft;
        if (horizontal) ctx.fillRect(a, 0, b - a, RULER);
        else ctx.fillRect(0, a, RULER, b - a);
      }
      const first = Math.floor(-offset / v.zoom / minor) * minor;
      const last = (len - offset) / v.zoom;
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.fillStyle = text;
      ctx.font = '500 9px "IBM Plex Sans", system-ui, sans-serif';
      ctx.beginPath();
      for (let w = first; w <= last; w += minor) {
        const s = Math.round(w * v.zoom + offset) + 0.5;
        const major = Math.abs(w / step - Math.round(w / step)) < 1e-6;
        const tick = major ? 8 : 4;
        if (horizontal) {
          ctx.moveTo(s, RULER);
          ctx.lineTo(s, RULER - tick);
        } else {
          ctx.moveTo(RULER, s);
          ctx.lineTo(RULER - tick, s);
        }
        if (major) {
          const label = String(Math.round(w));
          if (horizontal) ctx.fillText(label, s + 3, 10);
          else {
            ctx.save();
            ctx.translate(10, s - 3);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label, 0, 0);
            ctx.restore();
          }
        }
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = line;
      if (horizontal) {
        ctx.moveTo(0, RULER - 0.5);
        ctx.lineTo(len, RULER - 0.5);
      } else {
        ctx.moveTo(RULER - 0.5, 0);
        ctx.lineTo(RULER - 0.5, len);
      }
      ctx.stroke();
      if (sel) {
        ctx.fillStyle = accent;
        const a = (horizontal ? sel.x : sel.y) * v.zoom + offset;
        const b = (horizontal ? sel.x + sel.width : sel.y + sel.height) * v.zoom + offset;
        if (horizontal) {
          ctx.fillRect(a, RULER - 2, 1, 2);
          ctx.fillRect(b, RULER - 2, 1, 2);
        } else {
          ctx.fillRect(RULER - 2, a, 2, 1);
          ctx.fillRect(RULER - 2, b, 2, 1);
        }
      }
    };
    draw(top.current, true);
    draw(left.current, false);
  });

  const drag = (axis: 'x' | 'y') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    editor.startGuideFromRuler(axis);
    const toInput = (ev: PointerEvent) => {
      const r = canvasRect();
      return { sx: ev.clientX - r.left, sy: ev.clientY - r.top, button: 0, shift: ev.shiftKey, alt: ev.altKey, mod: ev.ctrlKey || ev.metaKey };
    };
    const move = (ev: PointerEvent) => editor.pointerMove(toInput(ev));
    const up = (ev: PointerEvent) => {
      editor.pointerUp(toInput(ev));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      <canvas ref={top} className="ruler ruler-top" aria-label="Horizontal ruler. Drag down to add a guide." onPointerDown={drag('y')} />
      <canvas ref={left} className="ruler ruler-left" aria-label="Vertical ruler. Drag right to add a guide." onPointerDown={drag('x')} />
      <div className="ruler-corner" aria-hidden="true" />
    </>
  );
}
