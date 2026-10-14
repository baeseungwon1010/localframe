import { useEffect, useState } from 'react';
import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import type { LayoutGrid, SceneNode } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { IconButton } from '../components.tsx';
import { MIXED, NumberField, Section, SelectField, common, normalizeHex } from './fields.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

export const DEFAULT_GRID: LayoutGrid = { type: 'columns', count: 12, gutter: 20, margin: 20, size: 8, color: '#E2361F', opacity: 0.1, visible: true };

/** Layout grids on frames: columns, rows or a square grid. */
export function GridsSection({ nodes, update }: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const grids = common(nodes, (n) => n.grids ?? []);
  const set = (i: number, patch: Partial<LayoutGrid>) => update((n) => ({ ...n, grids: (n.grids ?? []).map((g, j) => (j === i ? { ...g, ...patch } : g)) }));
  return (
    <Section
      title="Layout grid"
      action={
        <IconButton
          label="Add layout grid"
          onClick={() => update((n) => ({ ...n, grids: grids === MIXED ? [DEFAULT_GRID] : [...(n.grids ?? []), DEFAULT_GRID].slice(0, 8) }))}
        >
          <Plus {...ICON} />
        </IconButton>
      }
    >
      {grids === MIXED ? (
        <p className="field-caption">Mixed. Click + to replace them with one grid.</p>
      ) : (
        grids.map((g, i) => (
          <div key={i} className="effect-editor">
            <div className="effect-head">
              <SelectField
                label={`Grid ${i + 1} type`}
                value={g.type}
                options={[
                  { value: 'columns', label: 'Columns' },
                  { value: 'rows', label: 'Rows' },
                  { value: 'grid', label: 'Grid' },
                ]}
                onChange={(v) => set(i, { type: v })}
              />
              <button type="button" className="mini-btn" aria-label={g.visible ? `Hide grid ${i + 1}` : `Show grid ${i + 1}`} aria-pressed={!g.visible} onClick={() => set(i, { visible: !g.visible })}>
                {g.visible ? <Eye {...ICON} /> : <EyeOff {...ICON} />}
              </button>
              <button type="button" className="mini-btn" aria-label={`Remove grid ${i + 1}`} onClick={() => update((n) => ({ ...n, grids: (n.grids ?? []).filter((_, j) => j !== i) }))}>
                <Minus {...ICON} />
              </button>
            </div>
            <div className="grid2">
              {g.type === 'grid' ? (
                <NumberField label="Size" ariaLabel={`Grid ${i + 1} size`} value={g.size} min={1} max={1000} onCommit={(v) => set(i, { size: v })} />
              ) : (
                <>
                  <NumberField label="Count" ariaLabel={`Grid ${i + 1} count`} value={g.count} min={1} max={100} precision={0} onCommit={(v) => set(i, { count: Math.round(v) })} />
                  <NumberField label="Gutter" ariaLabel={`Grid ${i + 1} gutter`} value={g.gutter} min={0} max={1000} onCommit={(v) => set(i, { gutter: v })} />
                  <NumberField label="Margin" ariaLabel={`Grid ${i + 1} margin`} value={g.margin} min={0} max={10_000} onCommit={(v) => set(i, { margin: v })} />
                </>
              )}
              <GridColor grid={g} label={`Grid ${i + 1}`} onChange={(patch) => set(i, patch)} />
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function GridColor({ grid, label, onChange }: { grid: LayoutGrid; label: string; onChange: (p: Partial<LayoutGrid>) => void }) {
  const [hex, setHex] = useState(grid.color.slice(1));
  useEffect(() => setHex(grid.color.slice(1)), [grid.color]);
  return (
    <div className="paint-row compact">
      <label className="swatch" style={{ background: grid.color, opacity: Math.max(0.3, grid.opacity * 3) }}>
        <input type="color" aria-label={`${label} colour`} value={grid.color.toLowerCase()} onChange={(e) => onChange({ color: e.target.value.toUpperCase() })} />
      </label>
      <input
        className="hex-input"
        aria-label={`${label} hex`}
        value={hex}
        maxLength={7}
        onChange={(e) => setHex(e.target.value)}
        onBlur={(e) => {
          const h = normalizeHex(e.target.value);
          if (h) onChange({ color: h });
          else setHex(grid.color.slice(1));
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

const PRESETS: { group: string; items: [string, number, number][] }[] = [
  {
    group: 'Phone',
    items: [
      ['iPhone 16', 393, 852],
      ['iPhone 16 Pro Max', 440, 956],
      ['Android compact', 412, 917],
      ['Phone (small)', 360, 640],
    ],
  },
  {
    group: 'Tablet',
    items: [
      ['iPad mini', 744, 1133],
      ['iPad Pro 11"', 834, 1194],
      ['Android tablet', 800, 1280],
    ],
  },
  {
    group: 'Desktop',
    items: [
      ['Desktop', 1440, 1024],
      ['MacBook Air', 1280, 832],
      ['Full HD', 1920, 1080],
    ],
  },
  {
    group: 'Presentation and print',
    items: [
      ['Slide 16:9', 1920, 1080],
      ['A4', 595, 842],
      ['Letter', 612, 792],
    ],
  },
  {
    group: 'Social',
    items: [
      ['Square post', 1080, 1080],
      ['Story', 1080, 1920],
      ['Link preview', 1200, 630],
    ],
  },
];

/** Shown while the Frame tool is active and nothing is selected. */
export function FramePresets({ editor }: { editor: Editor }) {
  return (
    <>
      <div className="panel-title">Frame</div>
      <p className="panel-empty">Drag on the canvas to draw a frame, or pick a size.</p>
      {PRESETS.map((g) => (
        <Section key={g.group} title={g.group}>
          {g.items.map(([name, w, h]) => (
            <button key={name} type="button" className="preset-row" onClick={() => editor.createFramePreset(w, h, name)}>
              <span>{name}</span>
              <span className="file-time">
                {w} × {h}
              </span>
            </button>
          ))}
        </Section>
      ))}
    </>
  );
}

/** Rename several layers: a pattern with $& (current name) and $n (number), or find and replace. */
export function RenameDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const ids = editor.selection;
  const nodes = ids.map((id) => editor.doc.get(id)!).filter(Boolean);
  const [pattern, setPattern] = useState('$&');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [start, setStart] = useState(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const preview = nodes.slice(0, 4).map((n, i) => {
    let name = n.name;
    if (find) name = name.split(find).join(replace);
    return pattern.replace(/\$&/g, name).replace(/\$n/g, String(start + i)).trim() || n.name;
  });
  const apply = () => {
    editor.bulkRename(ids, { pattern, find, replace, start });
    onClose();
  };
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <h2 id="rename-title">Rename {nodes.length} layer{nodes.length === 1 ? '' : 's'}</h2>
        <label className="dialog-field">
          <span>Rename to</span>
          <input className="hex-input override-input" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-describedby="rename-help" autoFocus />
        </label>
        <p id="rename-help" className="field-caption">
          $&amp; is the current name, $n a number counting from the start below.
        </p>
        <div className="grid2">
          <label className="dialog-field">
            <span>Find</span>
            <input className="hex-input override-input" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label className="dialog-field">
            <span>Replace with</span>
            <input className="hex-input override-input" value={replace} onChange={(e) => setReplace(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>
        <NumberField label="Start" ariaLabel="Start number" value={start} min={0} max={1e6} precision={0} onCommit={(v) => setStart(Math.round(v))} />
        <div className="rename-preview" aria-label="Preview">
          {preview.map((p, i) => (
            <div key={i}>{p}</div>
          ))}
          {nodes.length > 4 && <div className="file-time">and {nodes.length - 4} more</div>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={apply}>
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
