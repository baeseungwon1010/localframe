import { useState } from 'react';
import { SquareRoundCorner, ChevronRight, Cylinder, Diamond, FileText, RectangleHorizontal, StickyNote, Circle, Frame, Hand, ImagePlus, MessageCircle, Minus, MousePointer2, MoveUpRight, PenTool, Pencil, Slice, Square, SquareDashed, Star, Triangle, Type } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { STAMPS } from '../../engine/templates.ts';
import { IconButton, MOD, Menu, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

/** A tool button; stamps share the stamp tool and differ by `stamp`, drawn as their glyph. */
type Entry = { tool: Tool | 'image'; label: string; key: string; Icon: typeof Square; stamp?: string };
type Group = { id: string; label: string; entries: Entry[] };

/** Tools in groups, like Figma's toolbar: a group shows the tool last used from it. */
const GROUPS: Group[] = [
  {
    id: 'move',
    label: 'Move tools',
    entries: [
      { tool: 'move', label: 'Move', key: 'V', Icon: MousePointer2 },
      { tool: 'hand', label: 'Hand', key: 'H', Icon: Hand },
    ],
  },
  {
    id: 'frame',
    label: 'Frame tools',
    entries: [
      { tool: 'frame', label: 'Frame', key: 'F', Icon: Frame },
      { tool: 'section', label: 'Section', key: `${SHIFT}S`, Icon: SquareDashed },
      { tool: 'slice', label: 'Slice', key: 'S', Icon: Slice },
    ],
  },
  {
    id: 'shape',
    label: 'Shape tools',
    entries: [
      { tool: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
      { tool: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
      { tool: 'polygon', label: 'Polygon', key: '', Icon: Triangle },
      { tool: 'star', label: 'Star', key: '', Icon: Star },
      { tool: 'line', label: 'Line', key: 'L', Icon: Minus },
      { tool: 'arrow', label: 'Arrow', key: `${SHIFT}L`, Icon: MoveUpRight },
      { tool: 'image', label: 'Place image', key: `${MOD}${SHIFT}K`, Icon: ImagePlus },
    ],
  },
  {
    id: 'diagram',
    label: 'Diagram tools',
    entries: [
      { tool: 'sticky', label: 'Sticky note', key: 'N', Icon: StickyNote },
      { tool: 'box', label: 'Rounded box', key: '', Icon: SquareRoundCorner },
      { tool: 'diamond', label: 'Diamond', key: '', Icon: Diamond },
      { tool: 'parallelogram', label: 'Parallelogram', key: '', Icon: RectangleHorizontal },
      { tool: 'cylinder', label: 'Cylinder (database)', key: '', Icon: Cylinder },
      { tool: 'document', label: 'Document', key: '', Icon: FileText },
      { tool: 'chevron', label: 'Chevron', key: '', Icon: ChevronRight },
    ],
  },
  {
    id: 'pen',
    label: 'Drawing tools',
    entries: [
      { tool: 'pen', label: 'Pen', key: 'P', Icon: PenTool },
      { tool: 'pencil', label: 'Pencil', key: `${SHIFT}P`, Icon: Pencil },
    ],
  },
  { id: 'text', label: 'Text', entries: [{ tool: 'text', label: 'Text', key: 'T', Icon: Type }] },
  { id: 'comment', label: 'Comment', entries: [{ tool: 'comment', label: 'Comment', key: 'C', Icon: MessageCircle }] },
];

/** Diagram mode's dock: only what a board needs, the common shapes one click away. */
const group = (id: string) => GROUPS.find((g) => g.id === id)!;
const entry = (tool: Tool) => GROUPS.flatMap((g) => g.entries).find((e) => e.tool === tool)!;
const DOCK_GROUPS: Group[] = [
  group('move'),
  { id: 'dock-sticky', label: 'Sticky note', entries: [entry('sticky')] },
  { id: 'dock-shape', label: 'Diagram shapes', entries: [...group('diagram').entries.filter((e) => e.tool !== 'sticky'), entry('ellipse')] },
  { id: 'dock-arrow', label: 'Connector', entries: [{ ...entry('arrow'), label: 'Connector' }, entry('line')] },
  group('text'),
  { id: 'dock-draw', label: 'Drawing tools', entries: [entry('pencil'), entry('pen')] },
  { id: 'dock-stamp', label: 'Stamps', entries: STAMPS.map((st, i) => ({ tool: 'stamp' as const, label: `Stamp: ${st.name.toLowerCase()}`, key: i === 0 ? 'E' : '', Icon: Square, stamp: st.glyph })) },
  { id: 'dock-section', label: 'Section', entries: [entry('section')] },
  group('comment'),
];

/** Every tool the dock can pick, so diagram mode can leave others for the move tool. */
export const DOCK_TOOLS: ReadonlySet<string> = new Set(DOCK_GROUPS.flatMap((g) => g.entries.map((e) => e.tool)));

const KEY = 'localframe.toolGroups';
/** What a group remembers as its last tool (stamps by their glyph). */
const entryId = (e: Entry) => (e.stamp ? `stamp:${e.stamp}` : e.tool);

function loadLast(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** The tools: a rail down the left side, or in diagram mode a dock at the bottom of the canvas. */
export function ToolRail({ editor, dock = false }: { editor: Editor; dock?: boolean }) {
  useEditorRev(editor, 'tool');
  const groups = dock ? DOCK_GROUPS : GROUPS;
  const [next, prev, opener] = dock ? ['ArrowRight', 'ArrowLeft', 'ArrowUp'] : ['ArrowDown', 'ArrowUp', 'ArrowRight'];
  const [last, setLast] = useState<Record<string, string>>(loadLast);
  const [open, setOpen] = useState<{ group: Group; x: number; y: number; above: boolean } | null>(null);

  const pick = (g: Group, e: Entry) => {
    if (e.tool === 'image') editor.onRequestImage?.();
    else if (e.stamp) editor.setStamp(e.stamp);
    else editor.setTool(e.tool);
    const next = { ...last, [g.id]: entryId(e) };
    setLast(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== next && e.key !== prev) return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.tool-btn')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === next ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className={dock ? 'tooldock' : 'toolrail'} role="toolbar" aria-orientation={dock ? 'horizontal' : 'vertical'} aria-label="Tools" onKeyDown={onKeyDown}>
      {groups.map((g) => {
        // the group shows the active tool if it is one of its own, else the one last used from it
        const isActive = (e: Entry) => e.tool === editor.tool && (!e.stamp || e.stamp === editor.stamp);
        const current = g.entries.find(isActive) ?? g.entries.find((e) => entryId(e) === last[g.id]) ?? g.entries[0];
        const active = g.entries.some((e) => e.tool === editor.tool);
        const many = g.entries.length > 1;
        const openMenu = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          setOpen(dock ? { group: g, x: r.left, y: r.top - 8, above: true } : { group: g, x: r.right + 6, y: r.top, above: false });
        };
        return (
          <div key={g.id} className="tool-group">
            <div
              onContextMenu={(e) => {
                if (!many) return;
                e.preventDefault();
                openMenu(e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (many && e.key === opener) {
                  e.preventDefault();
                  openMenu(e.currentTarget);
                }
              }}
            >
              <IconButton
                label={current.label}
                shortcut={current.key || undefined}
                tooltipSide={dock ? 'top' : 'right'}
                className="tool-btn"
                pressed={active}
                onClick={() => pick(g, current)}
              >
                {current.stamp ? <span className="stamp-glyph" aria-hidden="true">{current.stamp}</span> : <current.Icon size={16} strokeWidth={1.5} />}
              </IconButton>
            </div>
            {many && (
              <button
                type="button"
                className="tool-more"
                aria-label={`More ${g.label.toLowerCase()}`}
                aria-haspopup="menu"
                tabIndex={-1}
                onClick={(e) => openMenu(e.currentTarget.parentElement!)}
              />
            )}
          </div>
        );
      })}
      {open && (
        <Menu
          label={open.group.label}
          x={open.x}
          y={open.y}
          above={open.above}
          onClose={() => setOpen(null)}
          items={open.group.entries.map((e) => ({
            label: `${e.tool === editor.tool && (!e.stamp || e.stamp === editor.stamp) ? '✓ ' : ''}${e.stamp ? `${e.stamp}  ` : ''}${e.label}`,
            shortcut: e.key || undefined,
            onSelect: () => pick(open.group, e),
          }))}
        />
      )}
    </div>
  );
}
