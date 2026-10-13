import { Circle, Frame, Hand, Minus, MousePointer2, MoveUpRight, Square, Type } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { IconButton, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

const TOOLS: { tool: Tool; label: string; key: string; Icon: typeof Square }[] = [
  { tool: 'move', label: 'Move', key: 'V', Icon: MousePointer2 },
  { tool: 'frame', label: 'Frame', key: 'F', Icon: Frame },
  { tool: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  { tool: 'line', label: 'Line', key: 'L', Icon: Minus },
  { tool: 'arrow', label: 'Arrow', key: `${SHIFT}L`, Icon: MoveUpRight },
  { tool: 'text', label: 'Text', key: 'T', Icon: Type },
  { tool: 'hand', label: 'Hand', key: 'H', Icon: Hand },
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
          shortcut={key}
          tooltipSide="right"
          className="tool-btn"
          pressed={editor.tool === tool}
          onClick={() => editor.setTool(tool)}
        >
          <Icon size={16} strokeWidth={1.5} />
        </IconButton>
      ))}
    </div>
  );
}
