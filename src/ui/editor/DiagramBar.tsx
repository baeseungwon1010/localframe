import { useState } from 'react';
import { AlignCenterVertical, Bold, CornerDownRight, MoveRight, Network } from 'lucide-react';
import type { SceneNode } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import {
  DIAGRAM_COLORS,
  TEXT_COLORS,
  TEXT_SIZES,
  diagramColorOf,
  isBold,
  isDiagramItem,
  textColorOf,
  textSizeOf,
  withBold,
  withDiagramColor,
  withTextColor,
  withTextSize,
} from '../../engine/diagramColors.ts';
import { Menu } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';
import { t } from '../i18n.ts';

/** S / M / L / XL for the text of the selection; marked when all of it is that size. */
function SizePicker({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const sizes = nodes.map(textSizeOf);
  const same = sizes.every((v) => v !== null && v === sizes[0]) ? sizes[0] : null;
  return (
    <span className="diagram-sizes" role="group" aria-label={t('Text size')}>
      {TEXT_SIZES.map((sz) => (
        <button
          key={sz.id}
          type="button"
          className="mini-btn size-btn"
          aria-label={t(`${sz.name} text`)}
          aria-pressed={same === sz.size}
          title={`${t(`${sz.name} text`)} (${sz.size})`}
          onClick={() => editor.updateNodes(nodes.map((n) => n.id), (n) => withTextSize(n, sz.size))}
        >
          {sz.id}
        </button>
      ))}
    </span>
  );
}

/**
 * In diagram mode there is no properties panel: text layers (and stamps) get their size, bold
 * and colour here instead.
 */
function TextBar({ editor, nodes, left, top }: { editor: Editor; nodes: SceneNode[]; left: number; top: number }) {
  const ids = nodes.map((n) => n.id);
  const colors = nodes.map(textColorOf);
  const color = colors.every((c) => c !== null && c === colors[0]) ? colors[0] : null;
  const bold = nodes.every(isBold);
  return (
    <div className="diagram-bar" role="toolbar" aria-label={t('Text style')} style={{ left, top }}>
      <SizePicker editor={editor} nodes={nodes} />
      <span className="diagram-sep" aria-hidden="true" />
      <button
        type="button"
        className="mini-btn"
        aria-label={t('Bold')}
        aria-pressed={bold}
        title={t('Bold')}
        onClick={() => editor.updateNodes(ids, (n) => withBold(n, !bold))}
      >
        <Bold size={14} strokeWidth={2} />
      </button>
      <span className="diagram-sep" aria-hidden="true" />
      {TEXT_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`diagram-swatch ${color === c.color.toUpperCase() ? 'on' : ''}`}
          aria-label={t(`${c.name} text`)}
          aria-pressed={color === c.color.toUpperCase()}
          title={t(c.name)}
          style={{ background: c.color, borderColor: c.color }}
          onClick={() => editor.updateNodes(ids, (n) => withTextColor(n, c.color))}
        />
      ))}
    </div>
  );
}

/**
 * A small bar above selected diagram shapes, sticky notes and connectors (like FigJam's): the
 * palette colours, the text size, and for connectors the elbow and arrowhead switches. In
 * diagram mode, text layers get a bar of their own.
 */
export function DiagramBar({ editor, diagram = false }: { editor: Editor; diagram?: boolean }) {
  useEditorRev(editor, 'selection', 'doc', 'view');
  const [arrange, setArrange] = useState<{ x: number; y: number } | null>(null);
  if (editor.tool !== 'move' || editor.isInteracting || editor.editingLabel || editor.editingText) return null;
  const nodes = editor.selectedNodes();
  const textOnly = diagram && nodes.length > 0 && nodes.every((n) => n.type === 'TEXT');
  if (!nodes.length || (!textOnly && !nodes.every(isDiagramItem))) return null;
  const b = editor.selectionBounds();
  if (!b) return null;
  const tl = editor.toScreen({ x: b.x, y: b.y });
  const width = b.width * editor.viewport.zoom;
  // above the quick connect "+" (further out, with bigger swatches, for fingers)
  // text has no "+" buttons: the bar sits just above it
  const top = tl.y - (textOnly ? (editor.coarse ? 64 : 48) : editor.coarse ? 104 : 70);
  if (top < 4) return null;
  if (textOnly) return <TextBar editor={editor} nodes={nodes} left={tl.x + width / 2} top={top} />;
  const ids = nodes.map((n) => n.id);
  const current = nodes.map(diagramColorOf);
  const same = current.every((c) => c && c.id === current[0]?.id) ? current[0]?.id : null;
  const lines = nodes.filter((n) => n.type === 'LINE');
  const onlyLines = lines.length === nodes.length;
  return (
    <div className="diagram-bar" role="toolbar" aria-label={t('Diagram colours')} style={{ left: tl.x + width / 2, top }}>
      {DIAGRAM_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`diagram-swatch ${same === c.id ? 'on' : ''}`}
          aria-label={t(c.name)}
          aria-pressed={same === c.id}
          title={t(c.name)}
          style={{ background: onlyLines ? c.stroke : c.fill, borderColor: c.stroke }}
          onClick={() => editor.updateNodes(ids, (n) => withDiagramColor(n, c))}
        />
      ))}
      {!onlyLines && (
        <>
          <span className="diagram-sep" aria-hidden="true" />
          <SizePicker editor={editor} nodes={nodes.filter((n) => n.type !== 'LINE')} />
        </>
      )}
      {(nodes.length > 1 || editor.canTidyTree()) && <span className="diagram-sep" aria-hidden="true" />}
      {editor.canTidyTree() && (
        <button type="button" className="mini-btn" aria-label={t('Tidy up as a tree')} title={t('Tidy up as a tree (mind map)')} onClick={() => editor.tidyTree()}>
          <Network size={14} strokeWidth={1.75} />
        </button>
      )}
      {nodes.length > 1 && (
        <button
          type="button"
          className="mini-btn"
          aria-label={t('Align and space')}
          aria-haspopup="menu"
          title={t('Align and space')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setArrange({ x: r.left, y: r.bottom + 6 });
          }}
        >
          <AlignCenterVertical size={14} strokeWidth={1.75} />
        </button>
      )}
      {arrange && (
        <Menu
          label={t('Align and space')}
          x={arrange.x}
          y={arrange.y}
          onClose={() => setArrange(null)}
          items={[
            { label: t('Align left'), onSelect: () => editor.align('left') },
            { label: t('Align centres'), onSelect: () => editor.align('hcenter') },
            { label: t('Align right'), onSelect: () => editor.align('right') },
            'separator',
            { label: t('Align top'), onSelect: () => editor.align('top') },
            { label: t('Align middles'), onSelect: () => editor.align('vcenter') },
            { label: t('Align bottom'), onSelect: () => editor.align('bottom') },
            'separator',
            { label: t('Space evenly across'), disabled: nodes.length < 3, onSelect: () => editor.distribute('x') },
            { label: t('Space evenly down'), disabled: nodes.length < 3, onSelect: () => editor.distribute('y') },
          ]}
        />
      )}
      {lines.length > 0 && (
        <>
          <span className="diagram-sep" aria-hidden="true" />
          <button
            type="button"
            className="mini-btn"
            aria-label={t('Elbow connector')}
            aria-pressed={lines.every((n) => n.elbow)}
            title={t('Elbow connector')}
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
            aria-label={t('Arrowhead')}
            aria-pressed={lines.every((n) => n.arrowEnd)}
            title={t('Arrowhead')}
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
