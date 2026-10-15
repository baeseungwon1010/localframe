import { useState } from 'react';
import { SquareRoundCorner, ChevronRight, Cylinder, Diamond, FileText, RectangleHorizontal, StickyNote, Circle, Frame, Hand, ImagePlus, MessageCircle, Minus, MousePointer2, MoveUpRight, PenTool, Pencil, Slice, Square, SquareDashed, Star, Triangle, Type } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { IconButton, MOD, Menu, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

type Entry = { tool: Tool | 'image'; label: string; key: string; Icon: typeof Square };
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

const KEY = 'localframe.toolGroups';

function loadLast(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function ToolRail({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'tool');
  const [last, setLast] = useState<Record<string, string>>(loadLast);
  const [open, setOpen] = useState<{ group: Group; x: number; y: number } | null>(null);

  const pick = (g: Group, e: Entry) => {
    if (e.tool === 'image') editor.onRequestImage?.();
    else editor.setTool(e.tool);
    const next = { ...last, [g.id]: e.tool };
    setLast(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.tool-btn')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className="toolrail" role="toolbar" aria-orientation="vertical" aria-label="Tools" onKeyDown={onKeyDown}>
      {GROUPS.map((g) => {
        // the group shows the active tool if it is one of its own, else the one last used from it
        const current = g.entries.find((e) => e.tool === editor.tool) ?? g.entries.find((e) => e.tool === last[g.id]) ?? g.entries[0];
        const active = g.entries.some((e) => e.tool === editor.tool);
        const many = g.entries.length > 1;
        const openMenu = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          setOpen({ group: g, x: r.right + 6, y: r.top });
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
                if (many && e.key === 'ArrowRight') {
                  e.preventDefault();
                  openMenu(e.currentTarget);
                }
              }}
            >
              <IconButton
                label={current.label}
                shortcut={current.key || undefined}
                tooltipSide="right"
                className="tool-btn"
                pressed={active}
                onClick={() => pick(g, current)}
              >
                <current.Icon size={16} strokeWidth={1.5} />
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
          onClose={() => setOpen(null)}
          items={open.group.entries.map((e) => ({
            label: `${e.tool === editor.tool ? '✓ ' : ''}${e.label}`,
            shortcut: e.key || undefined,
            onSelect: () => pick(open.group, e),
          }))}
        />
      )}
    </div>
  );
}
