import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Sparkles, Type, Variable, SwatchBook } from 'lucide-react';
import { type Bindable, type Effect, type Paint, type SceneNode, type Style, type Variables, BINDABLE, isGradientPaint } from '../../../shared/schema.ts';
import { BINDING_TYPE, type StyleField, STYLE_KEY } from '../../engine/assets.ts';
import type { Editor } from '../../engine/editor.ts';
import { newId } from '../../engine/nodes.ts';
import { FONT_FAMILIES, FONT_WEIGHTS } from '../../engine/text.ts';
import { IconButton } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';
import { MIXED, NumberField, Section, SelectField, common, normalizeHex } from './fields.tsx';
import { EffectEditor, PaintEditor, gradientCss } from './paints.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

export function paintPreview(p: Paint | undefined): string {
  if (!p) return 'transparent';
  if (p.type === 'IMAGE') return 'var(--color-surface-hover)';
  if (isGradientPaint(p)) return gradientCss(p);
  return p.color;
}

const FIELD_TYPE: Record<StyleField, Style['type']> = { fill: 'FILL', stroke: 'FILL', text: 'TEXT', effect: 'EFFECT' };

/** "Style: [None ▾]" picker for a section, with "Create style". */
export function StylePicker(props: { editor: Editor; nodes: SceneNode[]; field: StyleField }) {
  const { editor, nodes, field } = props;
  const key = STYLE_KEY[field];
  const current = common(nodes, (n) => n[key] ?? '');
  const options = editor.styles.filter((s) => s.type === FIELD_TYPE[field]);
  const canCreate = nodes.length === 1;
  const create = () => {
    const name = window.prompt('Name for the new style', `${field === 'text' ? 'Text' : field === 'effect' ? 'Shadow' : 'Color'} ${options.length + 1}`);
    if (name) editor.createStyle(field, nodes[0].id, name);
  };
  // no styles of this kind yet: a small button instead of a dropdown with nothing in it
  if (options.length === 0 && current === '') {
    return canCreate ? (
      <IconButton label={`Create ${field} style`} onClick={create}>
        <SwatchBook {...ICON} />
      </IconButton>
    ) : null;
  }
  return (
    <select
      className="select-field style-picker"
      aria-label={`${field} style`}
      value={current === MIXED ? '__mixed' : current}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '__create') return create();
        editor.applyStyle(nodes.map((n) => n.id), field, v || null);
      }}
    >
      {current === MIXED && (
        <option value="__mixed" disabled>
          Mixed styles
        </option>
      )}
      <option value="">No style</option>
      {options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
      {canCreate && <option value="__create">Create style…</option>}
    </select>
  );
}

/** Styles in the Assets tab: pick one to edit it. */
export function StylesList({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'pages');
  const [open, setOpen] = useState<string | null>(null);
  const groups: [Style['type'], string][] = [
    ['FILL', 'Color styles'],
    ['TEXT', 'Text styles'],
    ['EFFECT', 'Effect styles'],
  ];
  return (
    <div className="styles-list">
      {groups.map(([type, title]) => {
        const list = editor.styles.filter((s) => s.type === type);
        if (list.length === 0) return null;
        return (
          <section key={type} aria-label={title}>
            <h4 className="asset-heading">{title}</h4>
            {list.map((s) => (
              <div key={s.id}>
                <button type="button" className={`style-row ${open === s.id ? 'on' : ''}`} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                  {s.type === 'FILL' ? (
                    <span className="swatch" style={{ background: paintPreview(s.value[0]) }} aria-hidden="true" />
                  ) : s.type === 'TEXT' ? (
                    <Type {...ICON} aria-hidden="true" />
                  ) : (
                    <Sparkles {...ICON} aria-hidden="true" />
                  )}
                  <span className="row-name">{s.name}</span>
                  {s.type === 'TEXT' && <span className="file-time">{`${s.value.fontSize}/${s.value.fontWeight}`}</span>}
                </button>
                {open === s.id && <StyleEditor editor={editor} style={s} onDone={() => setOpen(null)} />}
              </div>
            ))}
          </section>
        );
      })}
      {editor.styles.length === 0 && (
        <p className="panel-empty">No styles yet. Select a layer and use the style button in its Fill, Stroke, Text or Effects section.</p>
      )}
    </div>
  );
}

function StyleEditor({ editor, style, onDone }: { editor: Editor; style: Style; onDone: () => void }) {
  const [name, setName] = useState(style.name);
  useEffect(() => setName(style.name), [style.name]);
  return (
    <div className="style-editor">
      <input
        className="hex-input override-input"
        aria-label="Style name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== style.name && editor.updateStyle(style.id, { name })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {style.type === 'FILL' &&
        style.value.map((p, i) => (
          <PaintEditor
            key={i}
            paint={p}
            label={`Style paint ${i + 1}`}
            allowImage={false}
            onChange={(next) => editor.updateStyle(style.id, { value: style.value.map((q, j) => (j === i ? next : q)) })}
            onRemove={() => style.value.length > 1 && editor.updateStyle(style.id, { value: style.value.filter((_, j) => j !== i) })}
          />
        ))}
      {style.type === 'TEXT' && (
        <div className="grid2">
          <SelectField
            label="Style font"
            value={style.value.fontFamily}
            options={FONT_FAMILIES.map((f) => ({ value: f, label: f }))}
            onChange={(v) => editor.updateStyle(style.id, { value: { ...style.value, fontFamily: v } })}
          />
          <SelectField
            label="Style weight"
            value={style.value.fontWeight}
            options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
            onChange={(v) => editor.updateStyle(style.id, { value: { ...style.value, fontWeight: v } })}
          />
          <NumberField label="Size" ariaLabel="Style font size" value={style.value.fontSize} min={1} max={2000} onCommit={(v) => editor.updateStyle(style.id, { value: { ...style.value, fontSize: v } })} />
          <NumberField
            label="Letter"
            ariaLabel="Style letter spacing"
            value={style.value.letterSpacing}
            step={0.1}
            min={-200}
            max={2000}
            onCommit={(v) => editor.updateStyle(style.id, { value: { ...style.value, letterSpacing: v } })}
          />
        </div>
      )}
      {style.type === 'EFFECT' &&
        style.value.map((e, i) => (
          <EffectEditor
            key={i}
            index={i}
            effect={e}
            onChange={(next: Effect) => editor.updateStyle(style.id, { value: style.value.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => style.value.length > 1 && editor.updateStyle(style.id, { value: style.value.filter((_, j) => j !== i) })}
          />
        ))}
      <div className="grid2">
        <button type="button" className="btn secondary full" onClick={onDone}>
          Done
        </button>
        <button
          type="button"
          className="btn secondary full danger-text"
          onClick={() => {
            if (window.confirm(`Delete the style “${style.name}”? Layers keep their look.`)) editor.deleteStyle(style.id);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- variables

/** Editing variables: collections, modes as columns, variables as rows. */
export function VariablesDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  useEditorRev(editor, 'pages');
  const vars = editor.variables;
  const [colId, setColId] = useState<string | null>(vars.collections[0]?.id ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const col = vars.collections.find((c) => c.id === colId) ?? vars.collections[0];

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

  const save = (next: Variables) => editor.setVariables(next);
  const addCollection = () => {
    const c = { id: newId(), name: `Collection ${vars.collections.length + 1}`, modes: [{ id: newId(), name: 'Mode 1' }] };
    save({ ...vars, collections: [...vars.collections, c] });
    setColId(c.id);
  };
  const addMode = () => {
    if (!col || col.modes.length >= 20) return;
    const mode = { id: newId(), name: `Mode ${col.modes.length + 1}` };
    save({
      collections: vars.collections.map((c) => (c.id === col.id ? { ...c, modes: [...c.modes, mode] } : c)),
      // new mode starts with the first mode's values
      vars: vars.vars.map((v) => (v.collectionId === col.id ? { ...v, values: { ...v.values, [mode.id]: v.values[col.modes[0].id] } } : v)),
    });
  };
  const addVar = (type: 'COLOR' | 'NUMBER' | 'STRING' | 'BOOLEAN') => {
    if (!col) return;
    const start = { COLOR: '#C8106E', NUMBER: 8, STRING: 'Text', BOOLEAN: true }[type];
    const values: Record<string, string | number | boolean> = {};
    for (const m of col.modes) values[m.id] = start;
    const n = vars.vars.filter((v) => v.collectionId === col.id).length + 1;
    save({ ...vars, vars: [...vars.vars, { id: newId(), collectionId: col.id, name: `${type.toLowerCase()}-${n}`, type, values }] });
  };
  const setValue = (varId: string, modeId: string, value: string | number | boolean) =>
    save({ ...vars, vars: vars.vars.map((v) => (v.id === varId ? { ...v, values: { ...v.values, [modeId]: value } } : v)) });
  const renameVar = (varId: string, name: string) => name.trim() && save({ ...vars, vars: vars.vars.map((v) => (v.id === varId ? { ...v, name: name.trim().slice(0, 200) } : v)) });
  const renameMode = (modeId: string, name: string) =>
    col && name.trim() && save({ ...vars, collections: vars.collections.map((c) => (c.id === col.id ? { ...c, modes: c.modes.map((m) => (m.id === modeId ? { ...m, name: name.trim().slice(0, 100) } : m)) } : c)) });
  const renameCol = (name: string) => col && name.trim() && save({ ...vars, collections: vars.collections.map((c) => (c.id === col.id ? { ...c, name: name.trim().slice(0, 200) } : c)) });
  const removeVar = (varId: string) => {
    // layers bound to it keep their current values
    save({ ...vars, vars: vars.vars.filter((v) => v.id !== varId) });
    const bound = [...editor.doc.all()].filter((n) => Object.values(n.bindings ?? {}).includes(varId));
    for (const n of bound) for (const [prop, id] of Object.entries(n.bindings ?? {})) if (id === varId) editor.bind([n.id], prop as Bindable, null);
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="vars-title">
        <div className="dialog-head">
          <h2 id="vars-title">Variables</h2>
          <button type="button" className="btn secondary small" onClick={addCollection}>
            <Plus {...ICON} /> Collection
          </button>
        </div>
        {vars.collections.length === 0 ? (
          <p className="field-caption">Variables hold colours and numbers you can reuse and switch between modes (for example light and dark). Start with a collection.</p>
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="Collections">
              {vars.collections.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={c.id === col?.id} className={c.id === col?.id ? 'on' : ''} onClick={() => setColId(c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
            {col && (
              <>
                <div className="vars-toolbar">
                  <BlurInput value={col.name} label="Collection name" onCommit={renameCol} />
                  <button type="button" className="btn secondary small" onClick={addMode} disabled={col.modes.length >= 20}>
                    <Plus {...ICON} /> Mode
                  </button>
                  <button type="button" className="btn secondary small" onClick={() => addVar('COLOR')}>
                    <Plus {...ICON} /> Color
                  </button>
                  <button type="button" className="btn secondary small" onClick={() => addVar('NUMBER')}>
                    <Plus {...ICON} /> Number
                  </button>
                  <button type="button" className="btn secondary small" onClick={() => addVar('STRING')}>
                    <Plus {...ICON} /> String
                  </button>
                  <button type="button" className="btn secondary small" onClick={() => addVar('BOOLEAN')}>
                    <Plus {...ICON} /> Boolean
                  </button>
                </div>
                <div className="vars-table-wrap">
                  <table className="vars-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        {col.modes.map((m) => (
                          <th key={m.id} scope="col">
                            <BlurInput value={m.name} label={`Mode name ${m.name}`} onCommit={(v) => renameMode(m.id, v)} />
                          </th>
                        ))}
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {vars.vars
                        .filter((v) => v.collectionId === col.id)
                        .map((v) => (
                          <tr key={v.id}>
                            <td>
                              <BlurInput value={v.name} label={`Variable name ${v.name}`} onCommit={(name) => renameVar(v.id, name)} />
                            </td>
                            {col.modes.map((m) => {
                              const value = v.values[m.id] ?? v.values[col.modes[0].id];
                              return (
                                <td key={m.id}>
                                  {v.type === 'COLOR' ? (
                                    <ColorCell value={String(value)} label={`${v.name} in ${m.name}`} onCommit={(c) => setValue(v.id, m.id, c)} />
                                  ) : v.type === 'STRING' ? (
                                    <BlurInput value={String(value)} label={`${v.name} in ${m.name}`} onCommit={(s) => setValue(v.id, m.id, s.slice(0, 10_000))} />
                                  ) : v.type === 'BOOLEAN' ? (
                                    <input type="checkbox" aria-label={`${v.name} in ${m.name}`} checked={value === true} onChange={(e) => setValue(v.id, m.id, e.target.checked)} />
                                  ) : (
                                    <NumberField label="" ariaLabel={`${v.name} in ${m.name}`} value={Number(value)} min={-1e7} max={1e7} onCommit={(n) => setValue(v.id, m.id, n)} />
                                  )}
                                </td>
                              );
                            })}
                            <td>
                              <IconButton label={`Delete ${v.name}`} onClick={() => removeVar(v.id)}>
                                <Minus {...ICON} />
                              </IconButton>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function BlurInput(props: { value: string; label: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <input
      className="hex-input override-input"
      aria-label={props.label}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onCommit(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ColorCell(props: { value: string; label: string; onCommit: (c: string) => void }) {
  const [hex, setHex] = useState(props.value.slice(1));
  useEffect(() => setHex(props.value.slice(1)), [props.value]);
  return (
    <div className="paint-row compact">
      <label className="swatch" style={{ background: props.value }}>
        <input type="color" aria-label={`${props.label} colour`} value={props.value.toLowerCase()} onChange={(e) => props.onCommit(e.target.value.toUpperCase())} />
      </label>
      <input
        className="hex-input"
        aria-label={`${props.label} hex`}
        value={hex}
        maxLength={7}
        onChange={(e) => setHex(e.target.value)}
        onBlur={(e) => {
          const h = normalizeHex(e.target.value);
          if (h) props.onCommit(h);
          else setHex(props.value.slice(1));
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

const BIND_LABEL: Record<Bindable, string> = {
  fill: 'Fill color',
  stroke: 'Stroke color',
  radius: 'Corner radius',
  gap: 'Gap',
  padding: 'Padding',
  strokeWeight: 'Stroke weight',
  opacity: 'Opacity (%)',
  characters: 'Text',
  visible: 'Visible',
};

/** Properties of the selection that can follow variables, and the modes frames choose. */
export function VariablesSection({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const vars = editor.variables;
  const [open, setOpen] = useState(false);
  if (vars.vars.length === 0 && !nodes.some((n) => n.bindings)) return null;
  const ids = nodes.map((n) => n.id);
  const relevant = BINDABLE.filter((p) => {
    if (p === 'radius') return nodes.every((n) => n.radii);
    if (p === 'gap' || p === 'padding') return nodes.every((n) => n.layout);
    if (p === 'characters') return nodes.every((n) => n.type === 'TEXT');
    return true;
  });
  const frames = nodes.every((n) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET');
  const multiMode = vars.collections.filter((c) => c.modes.length > 1);
  const boundCount = relevant.filter((p) => nodes.some((n) => n.bindings?.[p])).length;
  return (
    <Section
      folded
      title="Variables"
      action={
        <IconButton label={open ? 'Hide variable bindings' : 'Show variable bindings'} pressed={open} onClick={() => setOpen(!open)}>
          <Variable {...ICON} />
        </IconButton>
      }
    >
      {!open && boundCount > 0 && <p className="field-caption">{boundCount} propert{boundCount === 1 ? 'y follows' : 'ies follow'} variables.</p>}
      {open &&
        relevant.map((prop) => {
          const options = vars.vars.filter((v) => v.type === BINDING_TYPE[prop]);
          const value = common(nodes, (n) => n.bindings?.[prop] ?? '');
          return (
            <label key={prop} className="variant-row">
              <span className="field-caption">{BIND_LABEL[prop]}</span>
              <select
                className="select-field"
                aria-label={`${BIND_LABEL[prop]} variable`}
                value={value === MIXED ? '__mixed' : value}
                onChange={(e) => editor.bind(ids, prop, e.target.value || null)}
              >
                {value === MIXED && (
                  <option value="__mixed" disabled>
                    Mixed
                  </option>
                )}
                <option value="">No variable</option>
                {options.map((v) => (
                  <option key={v.id} value={v.id}>
                    {vars.collections.find((c) => c.id === v.collectionId)?.name} / {v.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      {frames &&
        multiMode.map((c) => {
          const value = common(nodes, (n) => n.modes?.[c.id] ?? '');
          return (
            <label key={c.id} className="variant-row">
              <span className="field-caption">{c.name} mode</span>
              <select
                className="select-field"
                aria-label={`${c.name} mode`}
                value={value === MIXED ? '__mixed' : value}
                onChange={(e) => editor.setMode(ids, c.id, e.target.value || null)}
              >
                {value === MIXED && (
                  <option value="__mixed" disabled>
                    Mixed
                  </option>
                )}
                <option value="">Inherit ({c.modes[0].name})</option>
                {c.modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
    </Section>
  );
}
