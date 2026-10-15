import { useState } from 'react';
import { X } from 'lucide-react';
import type { Editor, Tool } from '../../engine/editor.ts';
import { ALT as ALT_KEY, SHIFT as SHIFT_KEY } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';
import { t } from '../i18n.ts';

const KEY = 'localframe.hideToolHints';
// key names as words in a sentence ("Shift keeps it square"), without the shortcut "+"
const SHIFT = `${SHIFT_KEY.replace(/\+$/, '')} `;
const ALT = `${ALT_KEY.replace(/\+$/, '')} `;

/** Hints in English with {shift} and {alt} for the key names; translated when shown. */
const TOOL_HINTS: Partial<Record<Tool, string>> = {
  frame: 'Drag to draw a frame, or pick a size on the right. {shift}keeps it square, {alt}draws from the centre.',
  section: 'Drag around frames to put them in a section.',
  slice: 'Drag over the area you want to export. Slices are never drawn in the design.',
  rect: 'Drag to draw a rectangle. {shift}keeps it square, {alt}draws from the centre.',
  ellipse: 'Drag to draw an ellipse. {shift}keeps it a circle, {alt}draws from the centre.',
  polygon: 'Drag to draw a polygon. Change its sides on the right. {shift}keeps it even.',
  star: 'Drag to draw a star. Change its points on the right. {shift}keeps it even.',
  line: 'Drag to draw a line. {shift}snaps to 45°. Start or end on a shape to connect to it.',
  arrow: 'Drag from one shape to another to connect them. {shift}snaps to 45°.',
  pen: 'Click to add points, drag to curve. Click the first point to close the shape, Enter to finish.',
  pencil: 'Drag to draw freehand. The line is smoothed when you let go.',
  text: 'Click to type, or drag to make a text box of a set width.',
  comment: 'Click anywhere to leave a comment. On a layer, it moves with the layer.',
  hand: 'Drag to move around the canvas.',
  sticky: 'Click to place a sticky note and start writing on it. It grows as you write.',
  stamp: 'Click to drop a stamp, as often as you like. Esc puts the stamp away.',
  box: 'Drag to draw a box for a step. Double-click it to write in it; the + on its sides adds the next one.',
  diamond: 'Drag to draw a decision diamond. Double-click a shape to write in it.',
  parallelogram: 'Drag to draw an input/output shape. Double-click a shape to write in it.',
  cylinder: 'Drag to draw a database. Double-click a shape to write in it.',
  document: 'Drag to draw a document. Double-click a shape to write in it.',
  chevron: 'Drag to draw a process step. Double-click a shape to write in it.',
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
  const hint = editor.editingVector
    ? 'Drag points and handles. {alt}drag a handle to break the curve. Enter or Esc to finish.'
    : editor.cropping
      ? 'Drag to move the image in its shape; set the zoom on the right. Enter or Esc to finish.'
      : editor.tool === 'pencil' && editor.recognizeShapes
        ? 'Draw a box, circle, diamond or triangle and it becomes a clean shape; a line between shapes connects them. {shift}keeps it as drawn.'
        : TOOL_HINTS[editor.tool];
  if (!hint) return null;
  const text = t(hint, { shift: SHIFT, alt: ALT });
  return (
    <div className="tool-hint" role="status">
      <span>{text}</span>
      <button
        type="button"
        className="mini-btn"
        aria-label={t('Hide tips')}
        title={t('Hide tips')}
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
