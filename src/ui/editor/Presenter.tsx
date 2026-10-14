import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { Reaction, SceneNode } from '../../../shared/schema.ts';
import type { SceneDoc } from '../../engine/doc.ts';
import type { Editor } from '../../engine/editor.ts';
import { exportBounds, renderCanvas } from '../../engine/export.ts';
import { ensureImages } from '../../engine/images.ts';
import { type Rect, apply, unionRects } from '../../engine/math.ts';
import { ease, isScreen, presentationDoc, reactionsOf, setPresentationMode, swapVariant, tweenScreens } from '../../engine/prototype.ts';
import { drawNode, imagesUsed } from '../../engine/render.ts';
import { layoutText, lineOffset } from '../../engine/text.ts';
import { IconButton } from '../components.tsx';

type Overflow = NonNullable<SceneNode['overflow']> | 'none';
type Screen = {
  id: string;
  /** What is visible: the frame's box (scrolling frames) or everything it draws. */
  view: Rect;
  /** What scrolls: the frame's content (the same as `view` when it doesn't scroll). */
  content: Rect;
  fit: number;
  canvas: HTMLCanvasElement;
  /** Layers that stay put while the content scrolls. */
  fixed: HTMLCanvasElement | null;
  overflow: Overflow;
};
type Hotspot = { id: string; name: string; rect: Rect; reactions: Reaction[]; fixed: boolean };

const PAD = 48;
const MIN_DELAY = 50;
const MAX_HISTORY = 200;
const MAX_SCALE = 4;

const frameHasFill = (n: SceneNode) => n.fills.some((p) => p.visible && p.opacity > 0);

/** Is this layer (or one above it inside the screen) fixed while the screen scrolls? */
function isFixed(doc: SceneDoc, id: string, screenId: string): boolean {
  for (let cur = doc.get(id); cur && cur.id !== screenId; cur = cur.parentId ? doc.get(cur.parentId) : undefined) if (cur.fixedOnScroll) return true;
  return false;
}

/**
 * Plays the current page as a prototype: one screen at a time, fitted to the window. Interactions
 * run on a private copy of the file, so swapping variants or modes never touches the design.
 */
export function Presenter({ editor, startId, onClose }: { editor: Editor; startId: string | null; onClose: () => void }) {
  const frames = editor.topFrames();
  const first = (startId && frames.find((f) => f.id === startId)?.id) ?? frames[0]?.id ?? null;
  const doc = useMemo(() => presentationDoc(editor.doc), [editor]);
  const device = editor.currentPage.device;
  const [current, setCurrent] = useState<Screen | null>(null);
  const [overlay, setOverlay] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const history = useRef<string[]>([]);
  const shown = useRef<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const prevHost = useRef<HTMLDivElement>(null);
  const screenEl = useRef<HTMLDivElement>(null);
  const curHost = useRef<HTMLDivElement>(null);
  const fixedHost = useRef<HTMLDivElement>(null);
  const overlayHost = useRef<HTMLDivElement>(null);
  const animCanvas = useRef<HTMLCanvasElement>(null);
  const pending = useRef<{ how: Reaction; from: string } | null>(null);
  const busy = useRef(false);

  const room = () => {
    const r = stage.current?.getBoundingClientRect();
    // a device frame takes some room of its own
    const extra = device ? 64 : 0;
    return { width: (r?.width ?? window.innerWidth) - extra, height: (r?.height ?? window.innerHeight) - extra };
  };

  /** Renders a screen at the size it is shown, crisp on high-density screens. */
  const render = useCallback(
    async (id: string, space: { width: number; height: number }): Promise<Screen | null> => {
      const n = doc.get(id);
      if (!n) return null;
      const overflow: Overflow = n.overflow ?? 'none';
      const background = frameHasFill(n) ? null : editor.background;
      const dpr = window.devicePixelRatio || 1;
      if (overflow === 'none') {
        const b = exportBounds(doc, [id]);
        if (!b) return null;
        const fit = Math.min((space.width - PAD * 2) / b.width, (space.height - PAD * 2) / b.height);
        const out = await renderCanvas(doc, { ids: [id], background }, Math.min(MAX_SCALE, Math.max(0.05, fit * dpr)));
        sizeCanvas(out.canvas, b, fit);
        return { id, view: b, content: b, fit, canvas: out.canvas, fixed: null, overflow };
      }
      // scrolling: the frame's box is the window; its content (all of it) scrolls inside
      const view = doc.worldBounds(id);
      const kids = doc.descendants(id);
      const all = unionRects([view, ...kids.filter((k) => doc.get(k)!.visible).map((k) => doc.worldBounds(k))]) ?? view;
      const content = {
        width: overflow === 'vertical' ? view.width : Math.max(view.width, all.x + all.width - view.x),
        height: overflow === 'horizontal' ? view.height : Math.max(view.height, all.y + all.height - view.y),
      };
      const fit = Math.min((space.width - PAD * 2) / view.width, (space.height - PAD * 2) / view.height);
      const scale = Math.min(MAX_SCALE, Math.max(0.05, fit * dpr));
      const fixedIds = kids.filter((k) => doc.get(k)!.fixedOnScroll);
      const scroller = presentationDoc(doc);
      scroller.set({ ...n, clipsContent: true, width: content.width, height: content.height });
      for (const k of fixedIds) scroller.set({ ...scroller.get(k)!, visible: false });
      const body = await renderCanvas(scroller, { ids: [id], background }, scale);
      sizeCanvas(body.canvas, body.bounds, fit);
      let fixed: HTMLCanvasElement | null = null;
      if (fixedIds.length) {
        const pinned = presentationDoc(doc);
        pinned.set({ ...n, fills: [], strokes: [], effects: undefined, clipsContent: true });
        const keep = new Set(fixedIds.flatMap((k) => [k, ...doc.ancestors(k), ...doc.descendants(k)]));
        for (const k of kids) if (!keep.has(k)) pinned.set({ ...pinned.get(k)!, visible: false });
        const out = await renderCanvas(pinned, { ids: [id], background: null }, scale);
        sizeCanvas(out.canvas, out.bounds, fit);
        fixed = out.canvas;
      }
      return { id, view, content: body.bounds, fit, canvas: body.canvas, fixed, overflow };
    },
    [doc, editor],
  );

  const show = useCallback(
    async (id: string, how: Reaction | null, push = true) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const next = await render(id, room());
        if (!next) return;
        setOverlay(null);
        const from = shown.current;
        if (from && push) {
          history.current.push(from);
          if (history.current.length > MAX_HISTORY) history.current.shift();
        }
        shown.current = id;
        pending.current = how && from ? { how, from } : null;
        setCurrent(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't show this frame");
      } finally {
        busy.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [render],
  );

  // start
  useEffect(() => {
    if (first) void show(first, null, false);
  }, [first, show]);

  /** Smart animate: tween the layers both screens share, drawn frame by frame over the new screen. */
  const smartAnimate = useCallback(
    async (fromId: string, to: Screen, how: Reaction) => {
      const c = animCanvas.current;
      if (!c || !doc.get(fromId)) return;
      await ensureImages([...imagesUsed(doc, [fromId]), ...imagesUsed(doc, [to.id])]);
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(MAX_SCALE, to.fit * dpr);
      c.width = Math.max(1, Math.round(to.view.width * scale));
      c.height = Math.max(1, Math.round(to.view.height * scale));
      c.style.width = `${to.view.width * to.fit}px`;
      c.style.height = `${to.view.height * to.fit}px`;
      c.hidden = false;
      const ctx = c.getContext('2d')!;
      const target = doc.get(to.id)!;
      const start = performance.now();
      await new Promise<void>((done) => {
        const frame = (now: number) => {
          const t = Math.min(1, (now - start) / Math.max(1, how.duration));
          const tween = tweenScreens(doc, fromId, doc, to.id, ease(how.easing, t));
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.setTransform(scale, 0, 0, scale, -to.view.x * scale, -to.view.y * scale);
          if (!frameHasFill(target)) {
            ctx.fillStyle = editor.background;
            ctx.fillRect(to.view.x, to.view.y, to.view.width, to.view.height);
          }
          drawNode(ctx, tween, tween.get(to.id)!);
          if (t < 1) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      });
      c.hidden = true;
    },
    [doc, editor],
  );

  // put the new screen in place and play its transition
  useLayoutEffect(() => {
    const host = curHost.current;
    const prev = prevHost.current;
    const el = screenEl.current;
    if (!current || !host || !prev || !el) return;
    const old = host.firstElementChild as HTMLCanvasElement | null;
    prev.replaceChildren();
    if (old && old !== current.canvas) prev.append(old);
    host.replaceChildren(current.canvas);
    fixedHost.current?.replaceChildren(...(current.fixed ? [current.fixed] : []));
    const p = pending.current;
    pending.current = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!p || p.how.transition === 'instant' || p.how.duration === 0 || reduce || !old) {
      prev.replaceChildren();
      return;
    }
    const { how } = p;
    if (how.transition === 'smart-animate') {
      prev.replaceChildren();
      void smartAnimate(p.from, current, how);
      return;
    }
    const timing = { duration: how.duration, easing: how.easing };
    const d = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }[how.direction ?? 'left'];
    const off = (k: number) => `translate(${d[0] * k * 100}%, ${d[1] * k * 100}%)`;
    let anim: Animation;
    if (how.transition === 'dissolve') anim = el.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    else if (how.transition === 'slide-in') anim = el.animate([{ opacity: 0, transform: off(0.3) }, { opacity: 1, transform: off(0) }], timing);
    else {
      // move in covers the old screen; push moves it out of the way
      anim = el.animate([{ transform: off(1) }, { transform: off(0) }], timing);
      if (how.transition === 'push') prev.animate([{ transform: off(0) }, { transform: off(-1) }], timing);
    }
    anim.onfinish = () => prev.replaceChildren();
  }, [current, smartAnimate]);

  useLayoutEffect(() => {
    const host = overlayHost.current;
    if (!host) return;
    if (overlay) host.replaceChildren(overlay.canvas);
  }, [overlay]);

  /** Draws the shown screen again after an interaction changed the presentation's copy of the file. */
  const refresh = useCallback(async () => {
    const id = shown.current;
    if (!id) return;
    const next = await render(id, room());
    if (next) setCurrent(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render]);

  const run = useCallback(
    async (r: Reaction, sourceId?: string) => {
      if (r.action === 'back') {
        const id = history.current.pop();
        if (id) await show(id, null, false);
        return;
      }
      if (r.action === 'close-overlay') {
        setOverlay(null);
        return;
      }
      if (r.action === 'set-mode') {
        if (r.collectionId && r.modeId && setPresentationMode(doc, editor.variables, r.collectionId, r.modeId)) await refresh();
        return;
      }
      if (r.action === 'change-to') {
        if (sourceId && r.destinationId && swapVariant(doc, sourceId, r.destinationId)) await refresh();
        return;
      }
      const dest = r.destinationId ? doc.get(r.destinationId) : undefined;
      if (!dest || !isScreen(doc, dest.id) || doc.pageOf(dest.id) !== doc.currentPage) return;
      if (r.action === 'navigate') {
        if (dest.id !== shown.current) await show(dest.id, r);
      } else {
        const o = await render(dest.id, room());
        if (o) setOverlay(o);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, editor, refresh, render, show],
  );

  // after-delay interactions on the screen being shown
  useEffect(() => {
    const screen = overlay ?? current;
    if (!screen) return;
    const timers = hotspots(doc, screen)
      .flatMap((h) => h.reactions.map((r) => [r, h.id] as const))
      .filter(([r]) => r.trigger === 'after-delay')
      .map(([r, id]) => setTimeout(() => void run(r, id), Math.max(MIN_DELAY, r.delay ?? 800)));
    return () => timers.forEach(clearTimeout);
  }, [current, overlay, doc, run]);

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
      } else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
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

  const spots = (screen: Screen, fixed: boolean) =>
    hotspots(doc, screen)
      .filter((h) => h.fixed === fixed)
      .map((h) => {
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
              if (click) void run(click, h.id);
              else flash();
            }}
            onPointerEnter={() => enter && void run(enter, h.id)}
          />
        );
      });

  const links = (screen: Screen) =>
    linkSpots(doc, screen).map((l) => (
      // only http(s) and mailto links get here (the schema allows nothing else)
      <a
        key={l.key}
        className="hotspot"
        href={l.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${l.href}`}
        style={{ left: l.rect.x, top: l.rect.y, width: l.rect.width, height: l.rect.height }}
        onClick={(e) => e.stopPropagation()}
      />
    ));

  const name = current ? (doc.get(current.id)?.name ?? '') : '';
  const index = current ? frames.findIndex((f) => f.id === current.id) : -1;
  const scrollStyle = (s: Screen): React.CSSProperties => ({
    width: s.view.width * s.fit,
    height: s.view.height * s.fit,
    overflowX: s.overflow === 'horizontal' || s.overflow === 'both' ? 'auto' : 'hidden',
    overflowY: s.overflow === 'vertical' || s.overflow === 'both' ? 'auto' : 'hidden',
  });

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
        <div className={device ? `device device-${device}` : 'device-none'}>
          <div className="present-screen" ref={screenEl} style={current ? { width: current.view.width * current.fit, height: current.view.height * current.fit } : undefined}>
            <div className="present-scroll" style={current ? scrollStyle(current) : undefined}>
              <div className="present-content">
                <div className="present-host" ref={curHost} />
                {current && spots(current, false)}
                {current && links(current)}
              </div>
            </div>
            <div className="present-fixed" ref={fixedHost} />
            {current && <div className="present-fixed-spots">{spots(current, true)}</div>}
            <canvas className="present-anim" ref={animCanvas} hidden />
          </div>
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
              style={{ width: overlay.view.width * overlay.fit, height: overlay.view.height * overlay.fit }}
              onClick={(e) => {
                e.stopPropagation();
                flash();
              }}
            >
              <div className="present-host" ref={overlayHost} />
              {spots(overlay, false)}
              {links(overlay)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function sizeCanvas(c: HTMLCanvasElement, b: Rect, fit: number) {
  c.className = 'present-canvas';
  c.style.width = `${b.width * fit}px`;
  c.style.height = `${b.height * fit}px`;
}

/** Linked text inside a screen, in content pixels: each opens its address in a new tab. */
function linkSpots(doc: SceneDoc, screen: Screen): { key: string; href: string; rect: Rect }[] {
  const out: { key: string; href: string; rect: Rect }[] = [];
  for (const id of [screen.id, ...doc.descendants(screen.id)]) {
    const n = doc.get(id);
    if (n?.type !== 'TEXT' || !n.text?.runs?.some((r) => r.link) || !doc.isEffectivelyVisible(id)) continue;
    const t = n.text;
    const layout = layoutText(t, t.autoResize === 'width' ? null : n.width);
    const m = doc.world(id);
    layout.lines.forEach((line, li) => {
      const x0 = line.indent + lineOffset(t.align, n.width - line.indent, line.width);
      line.segments.forEach((seg, si) => {
        if (!seg.style.link) return;
        const p = apply(m, { x: x0 + seg.x, y: line.top });
        out.push({
          key: `${id}:${li}:${si}`,
          href: seg.style.link,
          rect: {
            x: (p.x - screen.content.x) * screen.fit,
            y: (p.y - screen.content.y) * screen.fit,
            width: seg.width * screen.fit,
            height: line.height * screen.fit,
          },
        });
      });
    });
  }
  return out;
}

/**
 * Layers with interactions inside a screen (instances also use their component's), in pixels of
 * the scrolling content, or of the window for fixed layers. Later ones sit on top.
 */
function hotspots(doc: SceneDoc, screen: Screen): Hotspot[] {
  const out: Hotspot[] = [];
  for (const id of [screen.id, ...doc.descendants(screen.id)]) {
    const n = doc.get(id);
    if (!n || !doc.isEffectivelyVisible(id)) continue;
    const reactions = reactionsOf(doc, n);
    if (!reactions.length) continue;
    const b = doc.worldBounds(id);
    const fixed = id !== screen.id && screen.overflow !== 'none' && isFixed(doc, id, screen.id);
    const origin = fixed ? screen.view : screen.content;
    out.push({
      id,
      name: n.name,
      reactions,
      fixed,
      rect: { x: (b.x - origin.x) * screen.fit, y: (b.y - origin.y) * screen.fit, width: b.width * screen.fit, height: b.height * screen.fit },
    });
  }
  return out;
}
