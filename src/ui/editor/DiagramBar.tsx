import { CornerDownRight, MoveRight } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { DIAGRAM_COLORS, diagramColorOf, isDiagramItem, withDiagramColor } from '../../engine/diagramColors.ts';
import { useEditorRev } from '../hooks.ts';

/**
 * A small bar above selected diagram shapes, sticky notes and connectors (like FigJam's): the
 * palette colours, and for connectors the elbow and arrowhead switches.
 */
export function DiagramBar({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'selection', 'doc', 'view');
  if (editor.tool !== 'move' || editor.isInteracting || editor.editingLabel || editor.editingText) return null;
  const nodes = editor.selectedNodes();
  if (!nodes.length || !nodes.every(isDiagramItem)) return null;
  const b = editor.selectionBounds();
  if (!b) return null;
  const tl = editor.toScreen({ x: b.x, y: b.y });
  const width = b.width * editor.viewport.zoom;
  // above the quick connect "+" (further out, with bigger swatches, for fingers)
  const top = tl.y - (editor.coarse ? 104 : 70);
  if (top < 4) return null;
  const ids = nodes.map((n) => n.id);
  const current = nodes.map(diagramColorOf);
  const same = current.every((c) => c && c.id === current[0]?.id) ? current[0]?.id : null;
  const lines = nodes.filter((n) => n.type === 'LINE');
  const onlyLines = lines.length === nodes.length;
  return (
    <div className="diagram-bar" role="toolbar" aria-label="Diagram colours" style={{ left: tl.x + width / 2, top }}>
      {DIAGRAM_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`diagram-swatch ${same === c.id ? 'on' : ''}`}
          aria-label={c.name}
          aria-pressed={same === c.id}
          title={c.name}
          style={{ background: onlyLines ? c.stroke : c.fill, borderColor: c.stroke }}
          onClick={() => editor.updateNodes(ids, (n) => withDiagramColor(n, c))}
        />
      ))}
      {lines.length > 0 && (
        <>
          <span className="diagram-sep" aria-hidden="true" />
          <button
            type="button"
            className="mini-btn"
            aria-label="Elbow connector"
            aria-pressed={lines.every((n) => n.elbow)}
            title="Elbow connector"
            onClick={() => {
              const on = !lines.every((n) => n.elbow);
              editor.updateNodes(lines.map((n) => n.id), (n) => ({ ...n, elbow: on || undefined }));
            }}
          >
            <CornerDownRight size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="mini-btn"
            aria-label="Arrowhead"
            aria-pressed={lines.every((n) => n.arrowEnd)}
            title="Arrowhead"
            onClick={() => {
              const on = !lines.every((n) => n.arrowEnd);
              editor.updateNodes(lines.map((n) => n.id), (n) => ({ ...n, arrowEnd: on }));
            }}
          >
            <MoveRight size={14} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}
