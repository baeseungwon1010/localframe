import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor, PointerInput } from '../../engine/editor.ts';
import { hitDeepest, pickTarget } from '../../engine/hit.ts';
import { multiply } from '../../engine/math.ts';
import { type OverlayColors, renderEditor } from '../../engine/overlay.ts';
import { paintCss } from '../../engine/render.ts';
import { fontStack, layoutText, lineHeightPx } from '../../engine/text.ts';
import { ALT, MOD, Menu, type MenuItem, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

function readColors(): OverlayColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--color-accent', '#C8106E'),
    onAccent: v('--color-on-accent', '#FFFFFF'),
    handleFill: v('--color-handle-fill', '#FFFFFF'),
    guide: v('--color-guide', '#E2361F'),
    textMuted: v('--color-text-muted', '#5B6068'),
    canvasOutside: v('--color-canvas-default', '#F3F3F1'),
    font: '"IBM Plex Sans", system-ui, sans-serif',
  };
}

function toInput(e: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, rect: DOMRect): PointerInput {
  return {
    sx: e.clientX - rect.left,
    sy: e.clientY - rect.top,
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: e.ctrlKey || e.metaKey,
  };
}

export function CanvasView({ editor, onReady }: { editor: Editor; onReady: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useRef<OverlayColors | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEditorRev(editor, 'view', 'tool');

  // size + render loop
  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    let dirty = true;
    let dpr = window.devicePixelRatio || 1;

    const draw = () => {
      frame = 0;
      if (!dirty) return;
      dirty = false;
      if (!colors.current) colors.current = readColors();
      renderEditor(ctx, editor, dpr, colors.current);
    };
    const invalidate = () => {
      dirty = true;
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      editor.setViewSize(r.width, r.height);
      dirty = true;
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    onReady();

    const offs = (['doc', 'selection', 'view', 'tool'] as const).map((c) => editor.subscribe(c, invalidate));
    // theme changes: re-read the colours
    const mo = new MutationObserver(() => {
      colors.current = null;
      invalidate();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      colors.current = null;
      invalidate();
    };
    mq.addEventListener('change', onScheme);
    document.fonts?.addEventListener?.('loadingdone', invalidate);

    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener('change', onScheme);
      document.fonts?.removeEventListener?.('loadingdone', invalidate);
      offs.forEach((off) => off());
      if (frame) cancelAnimationFrame(frame);
    };
    // onReady is intentionally only called once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // wheel needs a non-passive listener to stop page zoom
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      editor.wheel(e.clientX - r.left, e.clientY - r.top, dx, dy, e.ctrlKey || e.metaKey);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [editor]);

  const rect = () => canvasRef.current!.getBoundingClientRect();

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (menu) setMenu(null);
    if (e.button === 2) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    editor.pointerDown(toInput(e, rect()));
    e.currentTarget.style.cursor = editor.cursorAt(e.clientX - rect().left, e.clientY - rect().top);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const input = toInput(e, rect());
    editor.pointerMove(input);
    e.currentTarget.style.cursor = editor.cursorAt(input.sx, input.sy);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    editor.pointerUp(toInput(e, rect()));
  };
  const onLostCapture = () => {
    if (editor.isInteracting) editor.cancelInteraction();
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => editor.doubleClick(toInput(e, rect()));
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (editor.tool !== 'move' || editor.editingText) return;
    const input = toInput(e, rect());
    const p = editor.toWorld(input.sx, input.sy);
    const deepest = hitDeepest(editor.doc, p, 4 / editor.viewport.zoom);
    if (deepest) {
      const target = pickTarget(editor.doc, deepest, editor.selection);
      if (!editor.selection.includes(target)) editor.setSelection([target]);
    } else editor.setSelection([]);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const sel = editor.selectedNodes();
  const hasSel = sel.length > 0;
  const menuItems: MenuItem[] = [
    {
      label: 'Copy',
      shortcut: `${MOD}C`,
      disabled: !hasSel,
      onSelect: () => {
        const t = editor.copyToText();
        if (t) void navigator.clipboard?.writeText(t);
      },
    },
    {
      label: 'Paste',
      shortcut: `${MOD}V`,
      onSelect: async () => {
        try {
          const t = await navigator.clipboard.readText();
          if (t) editor.pasteText(t);
        } catch {
          /* clipboard permission refused: Ctrl/Cmd+V still works */
        }
      },
    },
    { label: 'Duplicate', shortcut: `${MOD}D`, disabled: !hasSel, onSelect: () => editor.duplicateSelection() },
    { label: 'Delete', shortcut: 'Del', disabled: !hasSel, onSelect: () => editor.deleteSelection() },
    'separator',
    { label: 'Bring to front', shortcut: `${MOD}${SHIFT}]`, disabled: !hasSel, onSelect: () => editor.reorder('front') },
    { label: 'Bring forward', shortcut: `${MOD}]`, disabled: !hasSel, onSelect: () => editor.reorder('forward') },
    { label: 'Send backward', shortcut: `${MOD}[`, disabled: !hasSel, onSelect: () => editor.reorder('backward') },
    { label: 'Send to back', shortcut: `${MOD}${SHIFT}[`, disabled: !hasSel, onSelect: () => editor.reorder('back') },
    'separator',
    { label: 'Wrap in frame', shortcut: `${MOD}${ALT}G`, disabled: !hasSel, onSelect: () => editor.wrapInFrame() },
    'separator',
    {
      label: sel.some((n) => n.visible) ? 'Hide' : 'Show',
      shortcut: `${MOD}${SHIFT}H`,
      disabled: !hasSel,
      onSelect: () => editor.toggleVisible(),
    },
    { label: 'Lock', shortcut: `${MOD}${SHIFT}L`, disabled: !hasSel, onSelect: () => editor.toggleLocked() },
  ];

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="canvas"
        aria-label="Canvas"
        role="application"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onLostCapture}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerLeave={() => !editor.isInteracting && editor.setHover(null)}
      />
      {editor.editingText && <TextEditor key={editor.editingText} editor={editor} id={editor.editingText} />}
      {editor.doc.size === 0 && editor.tool === 'move' && (
        <p className="canvas-hint">Press F to draw a frame, R for a rectangle, L for a line or T for text.</p>
      )}
      {menu && <Menu label="Canvas actions" x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** In-place text editing: a textarea laid exactly over the text layer. */
function TextEditor({ editor, id }: { editor: Editor; id: string }) {
  const node = editor.doc.get(id)!;
  const t = node.text!;
  const [value, setValue] = useState(t.characters);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEditorRev(editor, 'view');

  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    editor.commitTextEdit(value);
  };

  const fixed = t.autoResize !== 'width';
  const layout = layoutText({ ...t, characters: value || ' ' }, fixed ? node.width : null);
  const m = multiply(editor.viewMatrix, editor.doc.world(id));
  const fill = node.fills.find((p) => p.visible);
  const width = fixed ? node.width : Math.max(layout.width + t.fontSize, 4);
  const height = t.autoResize === 'none' ? Math.max(node.height, layout.height) : layout.height;

  return (
    <textarea
      ref={ref}
      className="text-editor"
      aria-label="Text"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          commit();
        }
      }}
      style={{
        transform: `matrix(${m.join(',')})`,
        width,
        height: height + 2,
        fontFamily: fontStack(t.fontFamily),
        fontWeight: t.fontWeight,
        fontSize: t.fontSize,
        lineHeight: `${lineHeightPx(t)}px`,
        letterSpacing: `${t.letterSpacing}px`,
        textAlign: t.align,
        whiteSpace: fixed ? 'pre-wrap' : 'pre',
        color: fill ? paintCss(fill, 1) : 'transparent',
        opacity: node.opacity,
      }}
    />
  );
}
