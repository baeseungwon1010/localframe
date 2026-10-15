import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Search, Shapes, StickyNote, SquareDashed, Star, Triangle, Component, Diamond, Eye, EyeOff, Frame, Group, Image, LayoutGrid, Lock, LockOpen, Minus, MoveUpRight, PenTool, Scissors, Square, SquaresExclude, SquaresIntersect, SquaresSubtract, SquaresUnite, Type } from 'lucide-react';
import { type SceneNode, isContainerType } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { useEditorRev } from '../hooks.ts';

const ROW_H = 28;
const INDENT = 12;

type Row = { id: string; depth: number };
type Drop = { parentId: string | null; index: number; line: number; into: string | null };

function TypeIcon({ n }: { n: SceneNode }) {
  const props = { size: 14, strokeWidth: 1.5 };
  if (n.isMask) return <Scissors {...props} />;
  switch (n.type) {
    case 'VECTOR':
      return n.shape?.kind === 'star' ? <Star {...props} /> : n.shape?.kind === 'polygon' ? <Triangle {...props} /> : n.shape ? <Shapes {...props} /> : <PenTool {...props} />;
    case 'BOOLEAN':
      return n.booleanOp === 'subtract' ? (
        <SquaresSubtract {...props} />
      ) : n.booleanOp === 'intersect' ? (
        <SquaresIntersect {...props} />
      ) : n.booleanOp === 'exclude' ? (
        <SquaresExclude {...props} />
      ) : (
        <SquaresUnite {...props} />
      );
    case 'FRAME':
      return n.section ? <SquareDashed {...props} /> : n.layout ? <LayoutGrid {...props} /> : <Frame {...props} />;
    case 'GROUP':
      return <Group {...props} />;
    case 'COMPONENT':
    case 'COMPONENT_SET':
      return <Component {...props} />;
    case 'INSTANCE':
      return <Diamond {...props} />;
    case 'RECTANGLE':
      return n.sticky ? <StickyNote {...props} /> : n.fills.some((p) => p.type === 'IMAGE') ? <Image {...props} /> : <Square {...props} />;
    case 'ELLIPSE':
      return <Circle {...props} />;
    case 'LINE':
      return n.arrowEnd || n.arrowStart ? <MoveUpRight {...props} /> : <Minus {...props} />;
    case 'TEXT':
      return <Type {...props} />;
  }
}

export function LayersPanel({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'doc', 'selection', 'hover');
  const doc = editor.doc;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ ids: string[]; startY: number; active: boolean; drop: Drop | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const justDragged = useRef(false);

  // expand ancestors of the selection so it is visible
  useEffect(() => {
    const need = editor.selection.flatMap((id) => doc.ancestors(id)).filter((a) => collapsed.has(a));
    if (need.length) {
      setCollapsed((c) => {
        const next = new Set(c);
        need.forEach((a) => next.delete(a));
        return next;
      });
    }
  }, [editor.selection, doc, collapsed]);

  // searching: layers whose name matches, with their ancestors (all expanded)
  const q = query.trim().toLocaleLowerCase();
  let shown: Set<string> | null = null;
  if (q) {
    shown = new Set();
    const page = doc.currentPage;
    for (const n of doc.all()) {
      if (doc.pageOf(n.id) !== page || !n.name.toLocaleLowerCase().includes(q)) continue;
      shown.add(n.id);
      for (const a of doc.ancestors(n.id)) shown.add(a);
    }
  }

  // rows: top of the stack first, like the canvas reads
  const rows: Row[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const kids = doc.children(parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const id = kids[i];
      if (shown && !shown.has(id)) continue;
      rows.push({ id, depth });
      if (isContainerType(doc.get(id)!.type) && (shown || !collapsed.has(id))) walk(id, depth + 1);
    }
  };
  walk(null, 0);

  useEffect(() => {
    if (editor.selection.length !== 1) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(editor.selection[0])}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [editor.selection]);

  const select = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const depth = rows[b].depth;
        editor.setSelection(rows.slice(lo, hi + 1).filter((r) => r.depth === depth).map((r) => r.id));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      editor.setSelection(editor.selection.includes(id) ? editor.selection.filter((s) => s !== id) : [...editor.selection, id]);
    } else editor.setSelection([id]);
    anchor.current = id;
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // drag to reorder / reparent
  const computeDrop = (clientY: number, moving: string[]): Drop | null => {
    const list = listRef.current;
    if (!list) return null;
    const r = list.getBoundingClientRect();
    const y = clientY - r.top + list.scrollTop;
    const i = Math.floor(y / ROW_H);
    const blocked = (pid: string | null) => pid !== null && moving.some((m) => m === pid || doc.isAncestor(m, pid));
    if (i >= rows.length || rows.length === 0) {
      return blocked(null) ? null : { parentId: null, index: 0, line: rows.length * ROW_H, into: null };
    }
    const row = rows[Math.max(0, i)];
    const n = doc.get(row.id)!;
    const within = y - Math.max(0, i) * ROW_H;
    if (isContainerType(n.type) && within > ROW_H * 0.3 && within < ROW_H * 0.7 && !blocked(n.id)) {
      return { parentId: n.id, index: doc.children(n.id).length, line: -1, into: n.id };
    }
    const sibs = doc.children(n.parentId);
    const pos = sibs.indexOf(n.id);
    // rows are top-first: "above" a row means a higher index in the bottom-first sibling list
    const above = within <= ROW_H / 2;
    if (blocked(n.parentId)) return null;
    return {
      parentId: n.parentId,
      index: above ? pos + 1 : pos,
      line: (above ? Math.max(0, i) : Math.max(0, i) + 1) * ROW_H,
      into: null,
    };
  };

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    // the filtered list has gaps, so reordering waits until the search is cleared
    if (e.button !== 0 || renaming || q) return;
    const ids = editor.selection.includes(id) ? editor.selection : [id];
    setDrag({ ids, startY: e.clientY, active: false, drop: null });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (!drag.active && Math.abs(e.clientY - drag.startY) < 4) return;
      setDrag({ ...drag, active: true, drop: computeDrop(e.clientY, drag.ids) });
    };
    const onUp = () => {
      if (drag.active) {
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
        if (drag.drop) editor.moveInTree(drag.ids, drag.drop.parentId, drag.drop.index);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    const current = editor.selection[editor.selection.length - 1];
    const i = rows.findIndex((r) => r.id === current);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.id, e);
    } else if (e.key === 'ArrowRight' && current) {
      handled();
      const n = doc.get(current)!;
      if (isContainerType(n.type) && collapsed.has(current)) toggleCollapse(current);
      else if (isContainerType(n.type)) {
        const kids = doc.children(current);
        if (kids.length) editor.setSelection([kids[kids.length - 1]]);
      }
    } else if (e.key === 'ArrowLeft' && current) {
      handled();
      const n = doc.get(current)!;
      if (isContainerType(n.type) && !collapsed.has(current) && doc.children(current).length) toggleCollapse(current);
      else if (n.parentId) editor.setSelection([n.parentId]);
    } else if (e.key === 'Enter' && current) {
      handled();
      setRenaming(current);
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyR') {
      handled();
      editor.onRequestRename?.();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      editor.deleteSelection();
    }
  };

  const empty = doc.children(null).length === 0;
  return (
    <div className="layers-body">
      {!empty && (
        <div className="layer-search">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Find layers"
            aria-label="Find layers"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setQuery('');
            }}
          />
        </div>
      )}
      {empty ? (
        <p className="panel-empty">Draw a frame or shape to see it here. Press F for a frame, R for a rectangle.</p>
      ) : rows.length === 0 ? (
        <p className="panel-empty">No layers on this page are called “{query.trim()}”.</p>
      ) : (
        <div
          ref={listRef}
          className={`layer-list ${drag?.active ? 'dragging' : ''}`}
          role="tree"
          aria-label="Layer tree"
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {rows.map(({ id, depth }) => {
            const n = doc.get(id)!;
            const selected = editor.selection.includes(id);
            const isFrame = isContainerType(n.type);
            const hasKids = isFrame && doc.children(id).length > 0;
            const open = !collapsed.has(id);
            const parentHidden = !doc.isEffectivelyVisible(id) && n.visible;
            const dimmed = !n.visible || parentHidden;
            const into = drag?.active && drag.drop?.into === id;
            return (
              <div
                key={id}
                data-id={id}
                role="treeitem"
                aria-label={n.name}
                aria-level={depth + 1}
                aria-selected={selected}
                aria-expanded={hasKids ? open : undefined}
                className={`layer-row ${selected ? 'selected' : ''} ${editor.hover === id ? 'hovered' : ''} ${dimmed ? 'dimmed' : ''} ${into ? 'drop-into' : ''} ${drag?.active && drag.ids.includes(id) ? 'moving' : ''}`}
                style={{ paddingLeft: 4 + depth * INDENT }}
                onPointerEnter={() => !drag?.active && editor.setHover(id)}
                onPointerLeave={() => editor.setHover(null)}
                onPointerDown={(e) => onRowPointerDown(e, id)}
                onClick={(e) => !justDragged.current && select(id, e)}
                onDoubleClick={() => setRenaming(id)}
              >
                <button
                  type="button"
                  className="row-chevron"
                  aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
                  tabIndex={-1}
                  style={{ visibility: hasKids ? 'visible' : 'hidden' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(id);
                  }}
                >
                  {open ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
                </button>
                <span className={`row-icon ${n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' ? 'component' : ''}`}>
                  <TypeIcon n={n} />
                </span>
                {renaming === id ? (
                  <input
                    className="inline-input row-input"
                    defaultValue={n.name}
                    aria-label="Layer name"
                    autoFocus
                    maxLength={500}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      editor.rename(id, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="row-name">{n.name}</span>
                )}
                <span className="row-actions">
                  <button
                    type="button"
                    className={`row-btn ${n.locked ? 'on' : ''}`}
                    aria-label={n.locked ? `Unlock ${n.name}` : `Lock ${n.name}`}
                    aria-pressed={n.locked}
                    tabIndex={-1}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      editor.toggleLocked([id]);
                    }}
                  >
                    {n.locked ? <Lock size={12} strokeWidth={1.5} /> : <LockOpen size={12} strokeWidth={1.5} />}
                  </button>
                  <button
                    type="button"
                    className={`row-btn ${!n.visible ? 'on' : ''}`}
                    aria-label={n.visible ? `Hide ${n.name}` : `Show ${n.name}`}
                    aria-pressed={!n.visible}
                    tabIndex={-1}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      editor.toggleVisible([id]);
                    }}
                  >
                    {n.visible ? <Eye size={12} strokeWidth={1.5} /> : <EyeOff size={12} strokeWidth={1.5} />}
                  </button>
                </span>
              </div>
            );
          })}
          {drag?.active && drag.drop && drag.drop.line >= 0 && <div className="drop-line" style={{ top: drag.drop.line - 1 }} />}
        </div>
      )}
    </div>
  );
}
