import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { Reaction, SceneNode } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { exportBounds, renderCanvas } from '../../engine/export.ts';
import type { Rect } from '../../engine/math.ts';
import { IconButton } from '../components.tsx';

type Screen = { id: string; canvas: HTMLCanvasElement; bounds: Rect; fit: number };
type Hotspot = { id: string; name: string; rect: Rect; reactions: Reaction[] };

const PAD = 48;
const MAX_SCALE = 4;

/**
 * Plays the current page as a prototype: one top-level frame at a time, fitted to the window.
 * Layers with interactions become click (or hover) targets; clicking elsewhere flashes them.
 */
export function Presenter({ editor, startId, onClose }: { editor: Editor; startId: string | null; onClose: () => void }) {
  const frames = editor.topFrames();
  const first = (startId && frames.find((f) => f.id === startId)?.id) ?? frames[0]?.id ?? null;
  const [current, setCurrent] = useState<Screen | null>(null);
  const [overlay, setOverlay] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const history = useRef<string[]>([]);
  const shown = useRef<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const prevHost = useRef<HTMLDivElement>(null);
  const curHost = useRef<HTMLDivElement>(null);
  const overlayHost = useRef<HTMLDivElement>(null);
  const pending = useRef<Reaction | null>(null);
  const busy = useRef(false);

  /** Renders a frame at the size it is shown, crisp on high-density screens. */
  const render = useCallback(
    async (id: string, room: { width: number; height: number }): Promise<Screen | null> => {
      const n = editor.doc.get(id);
      const b = n ? exportBounds(editor.doc, [id]) : null;
      if (!n || !b) return null;
      const fit = Math.min((room.width - PAD * 2) / b.width, (room.height - PAD * 2) / b.height);
      const dpr = window.devicePixelRatio || 1;
      const out = await renderCanvas(editor.doc, { ids: [id], background: frameHasFill(n) ? null : editor.background }, Math.min(MAX_SCALE, Math.max(0.05, fit * dpr)));
      out.canvas.className = 'present-canvas';
      out.canvas.style.width = `${b.width * fit}px`;
      out.canvas.style.height = `${b.height * fit}px`;
      return { id, canvas: out.canvas, bounds: b, fit };
    },
    [editor],
  );

  const room = () => {
    const r = stage.current?.getBoundingClientRect();
    return { width: r?.width ?? window.innerWidth, height: r?.height ?? window.innerHeight };
  };

  const show = useCallback(
    async (id: string, how: Reaction | null, push = true) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const next = await render(id, room());
        if (!next) return;
        setOverlay(null);
        if (shown.current && push) history.current.push(shown.current);
        shown.current = id;
        pending.current = how;
        setCurrent(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't show this frame");
      } finally {
        busy.current = false;
      }
    },
    [render],
  );

  // start
  useEffect(() => {
    if (first) void show(first, null, false);
  }, [first, show]);

  // put the new screen in place and play its transition
  useLayoutEffect(() => {
    const host = curHost.current;
    const prev = prevHost.current;
    if (!current || !host || !prev) return;
    const old = host.firstElementChild as HTMLCanvasElement | null;
    prev.replaceChildren();
    if (old && old !== current.canvas) prev.append(old);
    host.replaceChildren(current.canvas);
    const how = pending.current;
    pending.current = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!how || how.transition === 'instant' || how.duration === 0 || reduce || !old) {
      prev.replaceChildren();
      return;
    }
    const timing = { duration: how.duration, easing: how.easing };
    const d = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }[how.direction ?? 'left'];
    const off = (k: number) => `translate(${d[0] * k * 100}%, ${d[1] * k * 100}%)`;
    let anim: Animation;
    if (how.transition === 'dissolve') anim = host.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    else if (how.transition === 'slide-in') anim = host.animate([{ opacity: 0, transform: off(0.3) }, { opacity: 1, transform: off(0) }], timing);
    else {
      // move in covers the old screen; push moves it out of the way
      anim = host.animate([{ transform: off(1) }, { transform: off(0) }], timing);
      if (how.transition === 'push') prev.animate([{ transform: off(0) }, { transform: off(-1) }], timing);
    }
    anim.onfinish = () => prev.replaceChildren();
  }, [current]);

  useLayoutEffect(() => {
    const host = overlayHost.current;
    if (!host) return;
    if (overlay) host.replaceChildren(overlay.canvas);
  }, [overlay]);

  const run = useCallback(
    async (r: Reaction) => {
      if (r.action === 'back') {
        const id = history.current.pop();
        if (id) await show(id, null, false);
        return;
      }
      if (r.action === 'close-overlay') {
        setOverlay(null);
        return;
      }
      const dest = r.destinationId ? editor.doc.get(r.destinationId) : undefined;
      if (!dest || dest.parentId !== null || editor.doc.pageOf(dest.id) !== editor.doc.currentPage) return;
      if (r.action === 'navigate') await show(dest.id, r);
      else {
        const o = await render(dest.id, room());
        if (o) setOverlay(o);
      }
    },
    [editor, render, show],
  );

  // after-delay interactions on the screen being shown
  useEffect(() => {
    const screen = overlay ?? current;
    if (!screen) return;
    const timers = hotspots(editor, screen)
      .flatMap((h) => h.reactions)
      .filter((r) => r.trigger === 'after-delay')
      .map((r) => setTimeout(() => void run(r), r.delay ?? 800));
    return () => timers.forEach(clearTimeout);
  }, [current, overlay, editor, run]);

  const step = useCallback(
    (by: number) => {
      if (!current) return;
      const i = frames.findIndex((f) => f.id === current.id);
      const next = frames[i + by];
      if (next) void show(next.id, null);
    },
    [current, frames, show],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (overlay) setOverlay(null);
        else onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
      else if (e.key === 'r' || e.key === 'R') {
        history.current = [];
        if (first) void show(first, null, false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [first, onClose, overlay, show, step]);

  const flash = () => {
    setHint(true);
    setTimeout(() => setHint(false), 500);
  };

  const spots = (screen: Screen) =>
    hotspots(editor, screen).map((h) => {
      const click = h.reactions.find((r) => r.trigger === 'click');
      const enter = h.reactions.find((r) => r.trigger === 'mouse-enter');
      if (!click && !enter) return null;
      return (
        <button
          key={h.id}
          type="button"
          className="hotspot"
          aria-label={h.name}
          style={{ left: h.rect.x, top: h.rect.y, width: h.rect.width, height: h.rect.height }}
          onClick={(e) => {
            e.stopPropagation();
            if (click) void run(click);
            else flash();
          }}
          onPointerEnter={() => enter && void run(enter)}
        />
      );
    });

  const name = current ? (editor.doc.get(current.id)?.name ?? '') : '';
  const index = current ? frames.findIndex((f) => f.id === current.id) : -1;

  return (
    <div className={`presenter ${hint ? 'hint' : ''}`} role="dialog" aria-modal="true" aria-label="Presentation">
      <div className="present-bar">
        <span className="present-title">
          {name}
          {index >= 0 && <span className="file-time"> {index + 1} of {frames.length}</span>}
        </span>
        <IconButton
          label="Restart"
          shortcut="R"
          onClick={() => {
            history.current = [];
            if (first) void show(first, null, false);
          }}
        >
          <RotateCcw size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="Close presentation" shortcut="Esc" onClick={onClose}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
      <div className="present-stage" ref={stage} onClick={flash}>
        {!first && <p className="present-empty">This page has no frames to present. Draw a frame first.</p>}
        {error && (
          <p className="present-empty" role="alert">
            {error}
          </p>
        )}
        <div className="present-screen prev" ref={prevHost} aria-hidden="true" />
        <div className="present-screen" style={current ? { width: current.bounds.width * current.fit, height: current.bounds.height * current.fit } : undefined}>
          <div className="present-host" ref={curHost} />
          {current && spots(current)}
        </div>
        {overlay && (
          <div
            className="present-backdrop"
            onClick={(e) => {
              e.stopPropagation();
              setOverlay(null);
            }}
          >
            <div
              className="present-screen overlay"
              style={{ width: overlay.bounds.width * overlay.fit, height: overlay.bounds.height * overlay.fit }}
              onClick={(e) => {
                e.stopPropagation();
                flash();
              }}
            >
              <div className="present-host" ref={overlayHost} />
              {spots(overlay)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function frameHasFill(n: SceneNode) {
  return n.fills.some((p) => p.visible && p.opacity > 0);
}

/** Layers with interactions inside a screen, in screen pixels (later ones sit on top). */
function hotspots(editor: Editor, screen: Screen): Hotspot[] {
  const doc = editor.doc;
  const out: Hotspot[] = [];
  for (const id of [screen.id, ...doc.descendants(screen.id)]) {
    const n = doc.get(id);
    if (!n?.reactions?.length || !doc.isEffectivelyVisible(id)) continue;
    const b = doc.worldBounds(id);
    out.push({
      id,
      name: n.name,
      reactions: n.reactions,
      rect: {
        x: (b.x - screen.bounds.x) * screen.fit,
        y: (b.y - screen.bounds.y) * screen.fit,
        width: b.width * screen.fit,
        height: b.height * screen.fit,
      },
    });
  }
  return out;
}
