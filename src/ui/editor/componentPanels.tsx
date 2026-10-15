import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { SceneNode, SolidPaint } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { componentPropsOf, instanceDoc, variantOptions } from '../../engine/instances.ts';
import { IconButton } from '../components.tsx';
import { Section } from './fields.tsx';
import { PaintEditor } from './paints.tsx';
import { t } from '../i18n.ts';

const ICON = { size: 14, strokeWidth: 1.5 };

/** Text that commits on blur or Enter. */
function CommitInput(props: { value: string; label: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const common = {
    className: 'hex-input override-input',
    'aria-label': props.label,
    value: v,
    onBlur: () => v !== props.value && props.onCommit(v),
  };
  return props.multiline ? (
    <textarea
      {...common}
      rows={Math.min(4, Math.max(1, v.split('\n').length))}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  ) : (
    <input
      {...common}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Picks one of the file's main components. */
function ComponentSelect(props: { editor: Editor; label: string; value: string; onChange: (id: string) => void }) {
  const comps = [...props.editor.doc.all()].filter((n) => n.type === 'COMPONENT').sort((a, b) => a.name.localeCompare(b.name));
  return (
    <select className="select-field" aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {comps.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Properties defined on a component or component set: text, boolean and instance swap. */
export function PropDefinitions({ editor, owner }: { editor: Editor; owner: SceneNode }) {
  const props = owner.componentProps ?? [];
  return (
    <Section
      title={t('Properties')}
      action={
        <div className="inline-actions">
          <button type="button" className="mini-btn wide" onClick={() => editor.addComponentProp(owner.id, 'TEXT')}>
            <Plus {...ICON} /> {t('Text')}
          </button>
          <button type="button" className="mini-btn wide" onClick={() => editor.addComponentProp(owner.id, 'BOOLEAN')}>
            <Plus {...ICON} /> {t('Boolean')}
          </button>
          <button type="button" className="mini-btn wide" onClick={() => editor.addComponentProp(owner.id, 'INSTANCE_SWAP')}>
            <Plus {...ICON} /> {t('Instance')}
          </button>
        </div>
      }
    >
      {props.length === 0 ? (
        <p className="field-caption">{t('Add a property, then link layers inside to it. Instances can then change it.')}</p>
      ) : (
        props.map((p) => (
          <div key={p.id} className="prop-def">
            <CommitInput value={p.name} label={t('Name of property {name}', { name: p.name })} onCommit={(v) => editor.updateComponentProp(owner.id, p.id, { name: v })} />
            {p.type === 'TEXT' ? (
              <CommitInput value={p.defaultValue} label={t('Default of {name}', { name: p.name })} onCommit={(v) => editor.updateComponentProp(owner.id, p.id, { defaultValue: v })} />
            ) : p.type === 'INSTANCE_SWAP' ? (
              <ComponentSelect editor={editor} label={t('Default of {name}', { name: p.name })} value={p.defaultValue} onChange={(v) => editor.updateComponentProp(owner.id, p.id, { defaultValue: v })} />
            ) : (
              <label className="check-row">
                <input type="checkbox" checked={p.defaultValue} onChange={(e) => editor.updateComponentProp(owner.id, p.id, { defaultValue: e.target.checked })} />
                {t('Shown by default')}
              </label>
            )}
            <IconButton label={t('Remove property {name}', { name: p.name })} onClick={() => editor.removeComponentProp(owner.id, p.id)}>
              <Minus {...ICON} />
            </IconButton>
          </div>
        ))
      )}
    </Section>
  );
}

/** A component set: its variant properties and a button to add a variant. */
export function ComponentSetSection({ editor, set }: { editor: Editor; set: SceneNode }) {
  const options = variantOptions(editor.doc, set.id);
  return (
    <>
      <Section
        title={t('Variants')}
        action={
          <button type="button" className="mini-btn wide" onClick={() => editor.addVariantProp(set.id)}>
            <Plus {...ICON} /> {t('Property')}
          </button>
        }
      >
        {[...options.entries()].map(([prop, values]) => (
          <div key={prop} className="variant-prop">
            <CommitInput value={prop} label={t('Variant property {name}', { name: prop })} onCommit={(v) => editor.renameVariantProp(set.id, prop, v)} />
            <span className="field-caption">{values.join(', ')}</span>
          </div>
        ))}
        <button type="button" className="btn secondary full" onClick={() => editor.addVariant(set.id)}>
          {t('Add variant')}
        </button>
      </Section>
      <PropDefinitions editor={editor} owner={set} />
    </>
  );
}

/** A component inside a set: its variant values. */
export function VariantValues({ editor, comp }: { editor: Editor; comp: SceneNode }) {
  return (
    <Section title="Variant">
      {Object.entries(comp.variant ?? {}).map(([prop, value]) => (
        <label key={prop} className="variant-row">
          <span className="field-caption">{prop}</span>
          <CommitInput value={value} label={t('{name} value', { name: prop })} onCommit={(v) => editor.setVariantValue(comp.id, prop, v)} />
        </label>
      ))}
    </Section>
  );
}

/** An instance: variant pickers and its component's properties. */
export function InstanceProps({ editor, inst }: { editor: Editor; inst: SceneNode }) {
  const comp = inst.componentId ? editor.doc.get(inst.componentId) : undefined;
  if (!comp) return null;
  const set = comp.parentId ? editor.doc.get(comp.parentId) : undefined;
  const options = set?.type === 'COMPONENT_SET' ? variantOptions(editor.doc, set.id) : new Map<string, string[]>();
  const props = componentPropsOf(editor.doc, comp.id);
  if (options.size === 0 && props.length === 0) return null;
  return (
    <Section title="Properties">
      {[...options.entries()].map(([prop, values]) => (
        <label key={prop} className="variant-row">
          <span className="field-caption">{prop}</span>
          <select className="select-field" aria-label={prop} value={comp.variant?.[prop] ?? ''} onChange={(e) => editor.setVariant(inst.id, prop, e.target.value)}>
            {values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
      {props.map((p) => {
        const value = inst.propValues && Object.hasOwn(inst.propValues, p.id) ? inst.propValues[p.id] : p.defaultValue;
        return p.type === 'TEXT' ? (
          <label key={p.id} className="variant-row">
            <span className="field-caption">{p.name}</span>
            <CommitInput value={String(value)} label={p.name} multiline onCommit={(v) => editor.setPropValue(inst.id, p.id, v)} />
          </label>
        ) : p.type === 'INSTANCE_SWAP' ? (
          <label key={p.id} className="variant-row">
            <span className="field-caption">{p.name}</span>
            <ComponentSelect editor={editor} label={p.name} value={String(value)} onChange={(v) => editor.setPropValue(inst.id, p.id, v)} />
          </label>
        ) : (
          <label key={p.id} className="check-row">
            <input type="checkbox" checked={value === true} onChange={(e) => editor.setPropValue(inst.id, p.id, e.target.checked)} />
            {p.name}
          </label>
        );
      })}
    </Section>
  );
}

/** A layer inside a component: link its text or visibility to a component property. */
export function LinkProps({ editor, layer }: { editor: Editor; layer: SceneNode }) {
  const props = editor.componentPropsFor(layer.id);
  if (props.length === 0) return null;
  const textProps = props.filter((p) => p.type === 'TEXT');
  const boolProps = props.filter((p) => p.type === 'BOOLEAN');
  const swapProps = props.filter((p) => p.type === 'INSTANCE_SWAP');
  return (
    <Section title="Linked properties">
      {layer.type === 'TEXT' && textProps.length > 0 && (
        <label className="variant-row">
          <span className="field-caption">{t('Text')}</span>
          <select
            className="select-field"
            aria-label={t('Text property')}
            value={layer.propRefs?.characters ?? ''}
            onChange={(e) => editor.linkProp(layer.id, 'characters', e.target.value || null)}
          >
            <option value="">{t('Not linked')}</option>
            {textProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {layer.type === 'INSTANCE' && swapProps.length > 0 && (
        <label className="variant-row">
          <span className="field-caption">{t('Instance')}</span>
          <select
            className="select-field"
            aria-label={t('Instance swap property')}
            value={layer.propRefs?.swap ?? ''}
            onChange={(e) => editor.linkProp(layer.id, 'swap', e.target.value || null)}
          >
            <option value="">{t('Not linked')}</option>
            {swapProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {boolProps.length > 0 && (
        <label className="variant-row">
          <span className="field-caption">{t('Visible')}</span>
          <select
            className="select-field"
            aria-label={t('Visibility property')}
            value={layer.propRefs?.visible ?? ''}
            onChange={(e) => editor.linkProp(layer.id, 'visible', e.target.value || null)}
          >
            <option value="">{t('Not linked')}</option>
            {boolProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </Section>
  );
}

/** A layer picked inside an instance: what this instance changes about it. */
export function InnerLayerSection({ editor }: { editor: Editor }) {
  const inner = editor.inner!;
  const inst = editor.doc.get(inner.instanceId);
  const v = inst ? instanceDoc(editor.doc, inst) : null;
  const vn = v?.get(`${inner.instanceId}~${inner.sourceId}`);
  if (!inst || !vn) return null;
  const override = inst.overrides?.[inner.sourceId];
  const fill = vn.fills[0] as SolidPaint | undefined;
  return (
    <Section title={`In this instance: ${vn.name}`} label={t('In this instance: {name}', { name: vn.name })}>
      <label className="check-row">
        <input type="checkbox" checked={vn.visible} onChange={(e) => editor.setOverride(inst.id, inner.sourceId, { visible: e.target.checked })} />
        {t('Visible')}
      </label>
      {vn.type === 'TEXT' && (
        <label className="variant-row">
          <span className="field-caption">{t('Text')}</span>
          <CommitInput
            value={vn.text!.characters}
            label={t('Text in this instance')}
            multiline
            onCommit={(text) => editor.setOverride(inst.id, inner.sourceId, { characters: text })}
          />
        </label>
      )}
      {fill && (
        <PaintEditor
          paint={fill}
          label={t('Fill')}
          allowImage={false}
          onChange={(p) => editor.setOverride(inst.id, inner.sourceId, { fills: [p, ...vn.fills.slice(1)] })}
          onRemove={() => editor.setOverride(inst.id, inner.sourceId, { fills: vn.fills.slice(1) })}
        />
      )}
      {override && (
        <button type="button" className="btn secondary full" onClick={() => editor.setOverride(inst.id, inner.sourceId, null)}>
          {t('Reset this layer')}
        </button>
      )}
      <p className="field-caption">{t('Esc goes back to the instance.')}</p>
    </Section>
  );
}
