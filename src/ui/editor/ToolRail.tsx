import { Circle, Frame, Pencil, Slice, SquareDashed, Hand, ImagePlus, MessageCircle, Minus, Star, Triangle, MousePointer2, MoveUpRight, PenTool, Square, Type } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { IconButton, MOD, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

const TOOLS: { tool: Tool; label: string; key: string; Icon: typeof Square }[] = [
  { tool: 'move', label: 'Move', key: 'V', Icon: MousePointer2 },
  { tool: 'frame', label: 'Frame', key: 'F', Icon: Frame },
  { tool: 'section', label: 'Section', key: `${SHIFT}S`, Icon: SquareDashed },
  { tool: 'slice', label: 'Slice', key: 'S', Icon: Slice },
  { tool: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  { tool: 'polygon', label: 'Polygon', key: '', Icon: Triangle },
  { tool: 'star', label: 'Star', key: '', Icon: Star },
  { tool: 'line', label: 'Line', key: 'L', Icon: Minus },
  { tool: 'arrow', label: 'Arrow', key: `${SHIFT}L`, Icon: MoveUpRight },
  { tool: 'pen', label: 'Pen', key: 'P', Icon: PenTool },
  { tool: 'pencil', label: 'Pencil', key: `${SHIFT}P`, Icon: Pencil },
  { tool: 'text', label: 'Text', key: 'T', Icon: Type },
  { tool: 'hand', label: 'Hand', key: 'H', Icon: Hand },
  { tool: 'comment', label: 'Comment', key: 'C', Icon: MessageCircle },
];

export function ToolRail({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'tool');
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div className="toolrail" role="toolbar" aria-orientation="vertical" aria-label="Tools" onKeyDown={onKeyDown}>
      {TOOLS.map(({ tool, label, key, Icon }) => (
        <IconButton
          key={tool}
          label={label}
          shortcut={key || undefined}
          tooltipSide="right"
          className="tool-btn"
          pressed={editor.tool === tool}
          onClick={() => editor.setTool(tool)}
        >
          <Icon size={16} strokeWidth={1.5} />
        </IconButton>
      ))}
      <IconButton label="Place image" shortcut={`${MOD}${SHIFT}K`} tooltipSide="right" className="tool-btn" onClick={() => editor.onRequestImage?.()}>
        <ImagePlus size={16} strokeWidth={1.5} />
      </IconButton>
    </div>
  );
}
