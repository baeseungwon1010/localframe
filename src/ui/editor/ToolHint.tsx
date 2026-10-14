import { useState } from 'react';
import { X } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { ALT, SHIFT } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';

const KEY = 'localframe.hideToolHints';

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  frame: `Drag to draw a frame, or pick a size on the right. ${SHIFT}keeps it square, ${ALT}draws from the centre.`,
  section: 'Drag around frames to put them in a section.',
  slice: 'Drag over the area you want to export. Slices are never drawn in the design.',
  rect: `Drag to draw a rectangle. ${SHIFT}keeps it square, ${ALT}draws from the centre.`,
  ellipse: `Drag to draw an ellipse. ${SHIFT}keeps it a circle, ${ALT}draws from the centre.`,
  polygon: `Drag to draw a polygon. Change its sides on the right. ${SHIFT}keeps it even.`,
  star: `Drag to draw a star. Change its points on the right. ${SHIFT}keeps it even.`,
  line: `Drag to draw a line. ${SHIFT}snaps to 45°. Start or end on a shape to connect to it.`,
  arrow: `Drag from one shape to another to connect them. ${SHIFT}snaps to 45°.`,
  pen: 'Click to add points, drag to curve. Click the first point to close the shape, Enter to finish.',
  pencil: 'Drag to draw freehand. The line is smoothed when you let go.',
  text: 'Click to type, or drag to make a text box of a set width.',
  comment: 'Click anywhere to leave a comment. On a layer, it moves with the layer.',
  hand: 'Drag to move around the canvas.',
};

/** One line of help at the bottom of the canvas for the tool or mode in use. */
export function ToolHint({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'tool', 'selection');
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (hidden || editor.editingText) return null;
  const text = editor.editingVector
    ? `Drag points and handles. ${ALT}drag a handle to break the curve. Enter or Esc to finish.`
    : editor.cropping
      ? 'Drag to move the image in its shape; set the zoom on the right. Enter or Esc to finish.'
      : TOOL_HINTS[editor.tool];
  if (!text) return null;
  return (
    <div className="tool-hint" role="status">
      <span>{text}</span>
      <button
        type="button"
        className="mini-btn"
        aria-label="Hide tips"
        title="Hide tips"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            /* hidden for now */
          }
        }}
      >
        <X size={12} strokeWidth={1.5} />
      </button>
    </div>
  );
}
