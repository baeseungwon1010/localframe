import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SolidPaint } from '../../../shared/schema.ts';
import type { Editor, PointerInput } from '../../engine/editor.ts';
import { hitDeepest, pickTarget } from '../../engine/hit.ts';
import { multiply } from '../../engine/math.ts';
import { type OverlayColors, renderEditor } from '../../engine/overlay.ts';
import { paintCss } from '../../engine/render.ts';
import { fontStack, layoutText, lineHeightPx } from '../../engine/text.ts';
import { adjustRuns, rangeValue } from '../../engine/textRuns.ts';
import { ALT, MOD, Menu, type MenuItem, SHIFT } from '../components.tsx';
import { Rulers } from './Rulers.tsx';
import { defaultLabel, labelMatrix, labelNode } from '../../engine/labels.ts';
import { ToolHint } from './ToolHint.tsx';
import { DiagramBar } from './DiagramBar.tsx';
import { TemplatePicker } from './TemplatePicker.tsx';
import { useEditorRev } from '../hooks.ts';

function readColors(): OverlayColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--color-accent', '#C8106E'),
    onAccent: v('--color-on-accent', '#FFFFFF'),
    handleFill: v('--color-handle-fill', '#FFFFFF'),
    guide: v('--color-guide', '#E2361F'),
    component: v('--color-component', '#6B35C9'),
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

export function CanvasView(props: {
  editor: Editor;
  onReady: () => void;
  onDropFiles: (files: File[], at: { x: number; y: number }) => void;
  notice: string | null;
  onDismissNotice: () => void;
  /** Diagram mode: the board view with the tool dock. */
  diagram?: boolean;
  children?: React.ReactNode;
}) {
  const { editor, onReady } = props;
  const [dragOver, setDragOver] = useState(false);
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
  const single = sel.length === 1 ? sel[0] : null;
  const otherPages = editor.pages.filter((p) => p.id !== editor.currentPage.id);
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
    {
      label: 'Flatten',
      shortcut: `${MOD}E`,
      disabled: !sel.some((n) => n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'LINE' || n.type === 'BOOLEAN' || (n.type === 'VECTOR' && n.shape)),
      onSelect: () => editor.flattenSelection(),
    },
    {
      label: 'Outline stroke',
      shortcut: `${MOD}${SHIFT}O`,
      disabled: !sel.some((n) => ['RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE'].includes(n.type) && n.strokes.some((p) => p.visible) && n.strokeWeight > 0),
      onSelect: () => editor.outlineStroke(),
    },
    { label: 'Select matching layers', shortcut: `${MOD}${ALT}A`, disabled: !hasSel, onSelect: () => editor.selectMatching() },
    { label: 'Delete', shortcut: 'Del', disabled: !hasSel, onSelect: () => editor.deleteSelection() },
    'separator',
    { label: 'Bring to front', shortcut: `${MOD}${SHIFT}]`, disabled: !hasSel, onSelect: () => editor.reorder('front') },
    { label: 'Bring forward', shortcut: `${MOD}]`, disabled: !hasSel, onSelect: () => editor.reorder('forward') },
    { label: 'Send backward', shortcut: `${MOD}[`, disabled: !hasSel, onSelect: () => editor.reorder('backward') },
    { label: 'Send to back', shortcut: `${MOD}${SHIFT}[`, disabled: !hasSel, onSelect: () => editor.reorder('back') },
    'separator',
    { label: 'Group selection', shortcut: `${MOD}G`, disabled: !hasSel, onSelect: () => editor.groupSelection() },
    { label: 'Wrap in frame', shortcut: `${MOD}${ALT}G`, disabled: !hasSel, onSelect: () => editor.wrapInFrame() },
    { label: 'Add auto layout', shortcut: `${SHIFT}A`, disabled: !hasSel, onSelect: () => editor.addAutoLayout() },
    {
      label: single?.isMask ? 'Stop using as mask' : 'Use as mask',
      shortcut: `${MOD}${ALT}M`,
      disabled: !hasSel,
      onSelect: () => editor.useAsMask(),
    },
    {
      label: sel.some((n) => n.type === 'GROUP') ? 'Ungroup' : 'Remove frame',
      shortcut: `${MOD}${SHIFT}G`,
      disabled: !sel.some((n) => n.type === 'FRAME' || n.type === 'GROUP'),
      onSelect: () => editor.unwrapFrames(),
    },
    'separator',
    single?.type === 'COMPONENT'
      ? { label: 'Create instance', onSelect: () => editor.createInstance(single.id) }
      : { label: 'Create component', shortcut: `${MOD}${ALT}K`, disabled: !hasSel, onSelect: () => editor.createComponent() },
    ...(hasSel && sel.every((n) => n.type === 'COMPONENT') && editor.doc.get(sel[0].parentId ?? '')?.type !== 'COMPONENT_SET'
      ? ([{ label: 'Combine as variants', shortcut: `${MOD}${ALT}${SHIFT}K`, onSelect: () => editor.combineAsVariants() }] as MenuItem[])
      : []),
    ...(single?.type === 'INSTANCE'
      ? ([
          { label: 'Go to main component', onSelect: () => editor.goToMainComponent(single.id) },
          { label: 'Detach instance', shortcut: `${MOD}${ALT}B`, onSelect: () => editor.detachInstances() },
        ] as MenuItem[])
      : []),
    ...(hasSel && otherPages.length
      ? (['separator', ...otherPages.map((p) => ({ label: `Move to ${p.name}`, onSelect: () => editor.moveSelectionToPage(p.id) }))] as MenuItem[])
      : []),
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
    <div
      className={`canvas-wrap ${dragOver ? 'drag-over' : ''}`}
      ref={wrapRef}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        const r = rect();
        props.onDropFiles(files, editor.toWorld(e.clientX - r.left, e.clientY - r.top));
      }}
    >
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
      {editor.editingLabel && <LabelEditor key={editor.editingLabel} editor={editor} id={editor.editingLabel} />}
      {editor.showRulers && <Rulers editor={editor} canvasRect={rect} />}
      {editor.doc.size === 0 && editor.tool === 'move' && props.diagram && <TemplatePicker editor={editor} />}
      {editor.doc.size === 0 && editor.tool === 'move' && !props.diagram && (
        <p className="canvas-hint">
          Press F to draw a frame, R for a rectangle, L for a line or T for text. {MOD}/ finds any command.
        </p>
      )}
      {props.children}
      <ToolHint editor={editor} />
      <DiagramBar editor={editor} />
      {menu && <Menu label="Canvas actions" x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {props.notice && (
        <div className="toast" role="alert">
          <span>{props.notice}</span>
          <button type="button" className="mini-btn" aria-label="Dismiss" onClick={props.onDismissNotice}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Typing in a shape or on a connector: a textarea laid over where its text goes. */
function LabelEditor({ editor, id }: { editor: Editor; id: string }) {
  const node = editor.doc.get(id)!;
  const [value, setValue] = useState(node.label?.characters ?? '');
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
    editor.commitLabelEdit(value);
  };

  // lay it out as it will be drawn, with the default style if the shape has no text yet
  const styled = node.label ? node : { ...node, label: defaultLabel(node) };
  const ln = labelNode(styled, value || ' ')!;
  const t = ln.text!;
  const m = multiply(editor.viewMatrix, multiply(editor.doc.world(id), labelMatrix(styled, ln)));
  return (
    <textarea
      ref={ref}
      className={`text-editor label-editor ${node.type === 'LINE' ? 'on-line' : ''}`}
      aria-label="Shape text"
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
        width: ln.width,
        height: ln.height + 2,
        fontFamily: fontStack(t.fontFamily),
        fontWeight: t.fontWeight,
        fontStyle: t.italic ? 'italic' : 'normal',
        fontSize: t.fontSize,
        lineHeight: `${lineHeightPx(t)}px`,
        letterSpacing: `${t.letterSpacing}px`,
        textAlign: t.align,
        whiteSpace: 'pre-wrap',
        color: node.labelColor ?? '#1B1D21',
      }}
    />
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
  const track = () => {
    const el = ref.current;
    if (el) editor.setTextSelection(el.selectionStart, el.selectionEnd, el.value);
  };
  /** Ctrl/Cmd+B, I, U toggle bold, italic and underline on the selected text. */
  const toggle = (kind: 'bold' | 'italic' | 'underline') => {
    const el = ref.current;
    if (!el || el.selectionEnd <= el.selectionStart) return;
    const tt = adjustRuns(editor.doc.get(id)!.text!, el.value);
    const a = el.selectionStart;
    const b = el.selectionEnd;
    if (kind === 'bold') editor.styleText({ fontWeight: (rangeValue(tt, a, b, 'fontWeight') ?? 400) === 700 ? 400 : 700 });
    if (kind === 'italic') editor.styleText({ italic: rangeValue(tt, a, b, 'italic') !== true });
    if (kind === 'underline') editor.styleText({ decoration: rangeValue(tt, a, b, 'decoration') === 'underline' ? 'none' : 'underline' });
  };

  const fixed = t.autoResize !== 'width';
  const layout = layoutText({ ...t, characters: value || ' ' }, fixed ? node.width : null);
  const m = multiply(editor.viewMatrix, editor.doc.world(id));
  const fill = node.fills.find((p): p is SolidPaint => p.visible && p.type !== 'IMAGE');
  const width = fixed ? node.width : Math.max(layout.width + t.fontSize, 4);
  const height = t.autoResize === 'none' ? Math.max(node.height, layout.height) : layout.height;

  return (
    <textarea
      ref={ref}
      className="text-editor"
      aria-label="Text"
      value={value}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        editor.setTextSelection(e.target.selectionStart, e.target.selectionEnd, e.target.value);
      }}
      onSelect={track}
      onBlur={(e) => {
        // styling the selected text from the properties panel keeps the editor open
        const to = e.relatedTarget as HTMLElement | null;
        if (to && to.closest('.props')) return;
        commit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.code === 'KeyB' || e.code === 'KeyI' || e.code === 'KeyU')) {
          e.preventDefault();
          toggle(e.code === 'KeyB' ? 'bold' : e.code === 'KeyI' ? 'italic' : 'underline');
          return;
        }
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
        fontStyle: t.italic ? 'italic' : 'normal',
        textDecoration: t.decoration === 'underline' ? 'underline' : t.decoration === 'strikethrough' ? 'line-through' : 'none',
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
