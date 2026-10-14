import { useState } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowDown,
  Bold,
  Italic,
  Strikethrough,
  Underline,
  ArrowLeft,
  ArrowRight,
  CornerDownRight,
  Component,
  Link2,
  Link2Off,
  Plus,
  RotateCw,
  Scan,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
} from 'lucide-react';
import { type Constraints, type Layout, type LayoutChild, type Paint, type SceneNode, type TextStyle, BLEND_MODES } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { type ExportFormat, exportBounds, exportImage, exportPdf, exportSvg } from '../../engine/export.ts';
import { printSvgPages } from '../print.ts';
import { PrototypePanel } from './PrototypePanel.tsx';
import { overridableTexts } from '../../engine/instances.ts';
import { DEFAULT_LAYOUT } from '../../engine/layout.ts';
import { solid, TYPE_LABEL } from '../../engine/nodes.ts';
import { FONT_FAMILIES, FONT_WEIGHTS, fontStack } from '../../engine/text.ts';
import { IconButton, MOD } from '../components.tsx';
import { type RunProps, adjustRuns, rangeValue } from '../../engine/textRuns.ts';
import { downloadBlob, safeFileName } from '../download.ts';
import { useEditorRev } from '../hooks.ts';
import { MIXED, NumberField, Section, Segmented, SelectField, common, normalizeHex } from './fields.tsx';
import { DEFAULT_SHADOW, EffectEditor, PaintEditor } from './paints.tsx';
import { ComponentSetSection, InnerLayerSection, InstanceProps, LinkProps, PropDefinitions, VariantValues } from './componentPanels.tsx';
import { StylePicker, VariablesSection } from './assetsPanels.tsx';
import { FramePresets, GridsSection } from './framePanels.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

function uniformRadius(nodes: SceneNode[]) {
  const r = common(nodes, (n) => n.radii ?? [0, 0, 0, 0]);
  if (r === MIXED) return MIXED;
  return r.every((v) => v === r[0]) ? r[0] : MIXED;
}

export function PropertiesPanel(props: { editor: Editor; fileName: string; onPresent: () => void }) {
  const { editor } = props;
  useEditorRev(editor, 'doc', 'selection', 'pages', 'view', 'tool');
  const sel = editor.selectedNodes();
  const proto = editor.prototypeView;

  return (
    <aside className="props" aria-label="Properties">
      <div className="tabs" role="tablist" aria-label="Right panel">
        <button type="button" role="tab" aria-selected={!proto} className={proto ? '' : 'on'} onClick={() => editor.setPrototypeView(false)}>
          Design
        </button>
        <button type="button" role="tab" aria-selected={proto} className={proto ? 'on' : ''} onClick={() => editor.setPrototypeView(true)}>
          Prototype
        </button>
      </div>
      {proto ? (
        <PrototypePanel editor={editor} nodes={sel} onPresent={props.onPresent} />
      ) : sel.length === 0 && editor.tool === 'frame' ? (
        <FramePresets editor={editor} />
      ) : sel.length === 0 ? (
        <PageProps key={editor.currentPage.id} editor={editor} fileName={props.fileName} />
      ) : (
        <SelectionProps editor={editor} nodes={sel} />
      )}
    </aside>
  );
}

function PageProps(props: { editor: Editor; fileName: string }) {
  const { editor } = props;
  const page = editor.currentPage;
  const [hex, setHex] = useState(editor.background.slice(1));
  const setBackground = (c: string) => editor.setPageBackground(page.id, c);
  const commit = (v: string) => {
    const h = normalizeHex(v);
    if (h) setBackground(h);
    else setHex(editor.background.slice(1));
  };
  return (
    <>
      <div className="panel-title">
        Page<span className="panel-subtitle">{page.name}</span>
      </div>
      <Section title="Background">
        <div className="paint-row simple">
          <label className="swatch" style={{ background: editor.background }}>
            <input
              type="color"
              aria-label="Background colour"
              value={editor.background.toLowerCase()}
              onChange={(e) => {
                setHex(e.target.value.slice(1).toUpperCase());
                setBackground(e.target.value.toUpperCase());
              }}
            />
          </label>
          <input
            className="hex-input"
            aria-label="Background hex"
            value={hex}
            maxLength={7}
            onChange={(e) => setHex(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            }}
          />
        </div>
      </Section>
      <ExportSection editor={editor} ids={editor.doc.children(null).filter((id) => editor.doc.get(id)!.visible)} name={page.name} pageBackground />
    </>
  );
}

function SelectionProps({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const ids = nodes.map((n) => n.id);
  const [keepAspect, setKeepAspect] = useState(false);
  const [corners, setCorners] = useState(false);
  const update = (fn: (n: SceneNode) => SceneNode) => editor.updateNodes(ids, fn);
  const single = nodes.length === 1 ? nodes[0] : null;
  const allType = (t: SceneNode['type']) => nodes.every((n) => n.type === t);
  const allLines = allType('LINE');
  const allText = allType('TEXT');
  const isBox = (n: SceneNode) => n.type === 'FRAME' || n.type === 'COMPONENT';
  const hasRadius = nodes.every((n) => n.type === 'RECTANGLE' || isBox(n));
  const allFrames = nodes.every(isBox);
  const anyInstance = nodes.some((n) => n.type === 'INSTANCE');
  const anyGroup = nodes.some((n) => n.type === 'GROUP');
  const parent = (n: SceneNode) => (n.parentId ? editor.doc.get(n.parentId) : undefined);
  const inAutoLayout = nodes.every((n) => parent(n)?.layout);
  const constrained = !inAutoLayout && nodes.every((n) => { const p = parent(n); return p && isBox(p) && !p.layout; });
  const title = single ? TYPE_LABEL[single.type] : `${nodes.length} layers`;
  const canAlign = nodes.length > 1 || (single !== null && single.parentId !== null);

  return (
    <>
      <div className="panel-title">
        {title}
        {single && <span className="panel-subtitle">{single.name}</span>}
      </div>

      {canAlign && (
        <div className="align-bar" role="toolbar" aria-label="Align">
          <IconButton label="Align left" onClick={() => editor.align('left')}>
            <AlignStartVertical {...ICON} />
          </IconButton>
          <IconButton label="Align horizontal centres" onClick={() => editor.align('hcenter')}>
            <AlignCenterVertical {...ICON} />
          </IconButton>
          <IconButton label="Align right" onClick={() => editor.align('right')}>
            <AlignEndVertical {...ICON} />
          </IconButton>
          <IconButton label="Align top" onClick={() => editor.align('top')}>
            <AlignStartHorizontal {...ICON} />
          </IconButton>
          <IconButton label="Align vertical centres" onClick={() => editor.align('vcenter')}>
            <AlignCenterHorizontal {...ICON} />
          </IconButton>
          <IconButton label="Align bottom" onClick={() => editor.align('bottom')}>
            <AlignEndHorizontal {...ICON} />
          </IconButton>
          <IconButton label="Distribute horizontally" disabled={nodes.length < 3} onClick={() => editor.distribute('x')}>
            <AlignHorizontalSpaceAround {...ICON} />
          </IconButton>
          <IconButton label="Distribute vertically" disabled={nodes.length < 3} onClick={() => editor.distribute('y')}>
            <AlignVerticalSpaceAround {...ICON} />
          </IconButton>
        </div>
      )}

      {single && editor.inner?.instanceId === single.id && <InnerLayerSection editor={editor} />}
      {single && (single.type === 'COMPONENT' || single.type === 'INSTANCE') && <ComponentSection editor={editor} node={single} />}
      {single?.type === 'INSTANCE' && <InstanceProps editor={editor} inst={single} />}
      {single?.type === 'COMPONENT_SET' && <ComponentSetSection editor={editor} set={single} />}
      {single?.type === 'COMPONENT' && single.variant && <VariantValues editor={editor} comp={single} />}
      {single?.type === 'COMPONENT' && editor.doc.get(single.parentId ?? '')?.type !== 'COMPONENT_SET' && (
        <PropDefinitions editor={editor} owner={single} />
      )}
      {single && single.type !== 'COMPONENT' && single.type !== 'COMPONENT_SET' && <LinkProps editor={editor} layer={single} />}
      {(nodes.length > 1 || single?.type === 'BOOLEAN') && (
        <div className="align-bar boolean-bar" role="toolbar" aria-label="Boolean operations">
          {(
            [
              ['union', 'Union', SquaresUnite],
              ['subtract', 'Subtract', SquaresSubtract],
              ['intersect', 'Intersect', SquaresIntersect],
              ['exclude', 'Exclude', SquaresExclude],
            ] as const
          ).map(([op, label, Icon]) => (
            <IconButton key={op} label={`${label} selection`} pressed={single?.booleanOp === op} onClick={() => editor.booleanSelection(op)}>
              <Icon {...ICON} />
            </IconButton>
          ))}
        </div>
      )}
      {single?.type === 'VECTOR' && (
        <Section title="Path">
          <div className="grid2">
            <button type="button" className="btn secondary full" onClick={() => editor.startVectorEdit(single.id)}>
              Edit points
            </button>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!single.vector?.closed}
                onChange={(e) => update((n) => (n.vector ? { ...n, vector: { ...n.vector, closed: e.target.checked } } : n))}
              />
              Closed
            </label>
          </div>
        </Section>
      )}

      <Section title="Position">
        <div className="grid2">
          <NumberField label="X" ariaLabel="X" value={common(nodes, (n) => n.x)} onCommit={(v) => update((n) => ({ ...n, x: v }))} />
          <NumberField label="Y" ariaLabel="Y" value={common(nodes, (n) => n.y)} onCommit={(v) => update((n) => ({ ...n, y: v }))} />
          <NumberField
            label={<RotateCw {...ICON} />}
            ariaLabel="Rotation"
            value={common(nodes, (n) => n.rotation)}
            suffix="°"
            min={-360}
            max={360}
            onCommit={(v) => editor.setRotation(ids, v)}
          />
        </div>
      </Section>

      <Section
        title={allLines ? 'Line' : 'Size'}
        action={
          !allLines && (
            <IconButton label={keepAspect ? 'Unlock aspect ratio' : 'Lock aspect ratio'} pressed={keepAspect} onClick={() => setKeepAspect(!keepAspect)}>
              {keepAspect ? <Link2 {...ICON} /> : <Link2Off {...ICON} />}
            </IconButton>
          )
        }
      >
        <div className="grid2">
          <NumberField
            label={allLines ? 'L' : 'W'}
            ariaLabel={allLines ? 'Length' : 'Width'}
            value={common(nodes, (n) => n.width)}
            min={allLines ? 0 : 0.01}
            onCommit={(v) => editor.transact(() => ids.forEach((id) => editor.setSize(id, v, null, keepAspect)))}
          />
          {!allLines && (
            <NumberField
              label="H"
              ariaLabel="Height"
              value={common(nodes, (n) => n.height)}
              min={0.01}
              onCommit={(v) => editor.transact(() => ids.forEach((id) => editor.setSize(id, null, v, keepAspect)))}
            />
          )}
        </div>
      </Section>

      {hasRadius && !anyInstance && (
        <Section
          title="Corner radius"
          action={
            <IconButton label={corners ? 'Same radius for all corners' : 'Separate radius per corner'} pressed={corners} onClick={() => setCorners(!corners)}>
              <Scan {...ICON} />
            </IconButton>
          }
        >
          {corners ? (
            <div className="grid2">
              {(['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const).map((label, i) => (
                <NumberField
                  key={label}
                  label={['TL', 'TR', 'BR', 'BL'][i]}
                  ariaLabel={`${label} radius`}
                  value={common(nodes, (n) => (n.radii ?? [0, 0, 0, 0])[i])}
                  min={0}
                  onCommit={(v) =>
                    update((n) => {
                      const r = [...(n.radii ?? [0, 0, 0, 0])] as [number, number, number, number];
                      r[i] = v;
                      return { ...n, radii: r };
                    })
                  }
                />
              ))}
            </div>
          ) : (
            <div className="grid2">
              <NumberField
                label="R"
                ariaLabel="Corner radius"
                value={uniformRadius(nodes)}
                min={0}
                onCommit={(v) => update((n) => ({ ...n, radii: [v, v, v, v] }))}
              />
            </div>
          )}
        </Section>
      )}

      {allFrames && <AutoLayoutSection editor={editor} nodes={nodes} update={update} />}
      {allFrames && <GridsSection nodes={nodes} update={update} />}
      {inAutoLayout && <LayoutChildSection nodes={nodes} update={update} />}
      {single?.type === 'LINE' && (single.startBind || single.endBind) && <ConnectorSection editor={editor} line={single} />}

      {allFrames && (
        <Section title="Frame">
          <label className="check-row">
            <input
              type="checkbox"
              checked={nodes.every((n) => n.clipsContent)}
              onChange={(e) => update((n) => ({ ...n, clipsContent: e.target.checked }))}
            />
            Clip content
          </label>
        </Section>
      )}

      {constrained && <ConstraintsSection nodes={nodes} update={update} />}

      <Section title="Layer">
        <div className="grid2">
          <NumberField
            label="Opacity"
            ariaLabel="Layer opacity"
            value={common(nodes, (n) => Math.round(n.opacity * 100))}
            min={0}
            max={100}
            precision={0}
            suffix="%"
            onCommit={(v) => update((n) => ({ ...n, opacity: v / 100 }))}
          />
          <SelectField
            label="Blend mode"
            value={common(nodes, (n) => n.blendMode ?? 'normal')}
            options={BLEND_MODES.map((m) => ({ value: m, label: m === 'normal' ? 'Normal' : m[0].toUpperCase() + m.slice(1).replace('-', ' ') }))}
            onChange={(v) => update((n) => ({ ...n, blendMode: v === 'normal' ? undefined : v }))}
          />
        </div>
        <div className="grid2">
          {single && (
            <label className="check-row">
              <input type="checkbox" checked={!!single.isMask} onChange={() => editor.useAsMask()} />
              Use as mask
            </label>
          )}
        </div>
      </Section>

      <VariablesSection editor={editor} nodes={nodes} />

      {allText && <TextSection editor={editor} nodes={nodes} update={update} />}

      <PaintsSection
        title="Fill"
        nodes={nodes}
        get={(n) => n.fills}
        set={(n, p) => ({ ...n, fills: p })}
        defaultPaint={allText ? solid('#1B1D21') : solid('#D9D9D9')}
        update={update}
        hidden={allLines || anyInstance || anyGroup}
        style={<StylePicker editor={editor} nodes={nodes} field="fill" />}
      />
      <PaintsSection
        title="Stroke"
        nodes={nodes}
        get={(n) => n.strokes}
        set={(n, p) => ({ ...n, strokes: p as SceneNode['strokes'] })}
        defaultPaint={solid('#1B1D21')}
        update={update}
        hidden={allText || anyInstance || anyGroup}
        style={<StylePicker editor={editor} nodes={nodes} field="stroke" />}
      >
        <div className="grid2">
          <NumberField
            label="Weight"
            ariaLabel="Stroke weight"
            value={common(nodes, (n) => n.strokeWeight)}
            min={0}
            max={1000}
            onCommit={(v) => update((n) => ({ ...n, strokeWeight: v }))}
          />
          {!allLines && (
            <SelectField
              label="Stroke position"
              value={common(nodes, (n) => n.strokeAlign)}
              options={[
                { value: 'inside', label: 'Inside' },
                { value: 'center', label: 'Center' },
                { value: 'outside', label: 'Outside' },
              ]}
              onChange={(v) => update((n) => (n.type === 'LINE' ? n : { ...n, strokeAlign: v }))}
            />
          )}
          <SelectField
            label="Stroke style"
            value={common(nodes, (n) => (n.strokeDash.length ? 'dashed' : 'solid'))}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
            ]}
            onChange={(v) =>
              update((n) => ({ ...n, strokeDash: v === 'dashed' ? [Math.max(4, n.strokeWeight * 3), Math.max(4, n.strokeWeight * 2)] : [] }))
            }
          />
        </div>
        {allLines && (
          <div className="arrow-row">
            <span className="field-caption">Arrows</span>
            <IconButton
              label="Arrow at start"
              pressed={nodes.every((n) => n.arrowStart)}
              onClick={() => {
                const on = !nodes.every((n) => n.arrowStart);
                update((n) => ({ ...n, arrowStart: on }));
              }}
            >
              <ArrowLeft {...ICON} />
            </IconButton>
            <IconButton
              label="Arrow at end"
              pressed={nodes.every((n) => n.arrowEnd)}
              onClick={() => {
                const on = !nodes.every((n) => n.arrowEnd);
                update((n) => ({ ...n, arrowEnd: on }));
              }}
            >
              <ArrowRight {...ICON} />
            </IconButton>
            <IconButton
              label="Elbow line"
              pressed={nodes.every((n) => n.elbow)}
              onClick={() => {
                const on = !nodes.every((n) => n.elbow);
                update((n) => ({ ...n, elbow: on || undefined }));
              }}
            >
              <CornerDownRight {...ICON} />
            </IconButton>
          </div>
        )}
      </PaintsSection>

      <EffectsSection editor={editor} nodes={nodes} update={update} />

      <ExportSection key={ids.join(',')} editor={editor} ids={ids} name={single ? single.name : 'Selection'} pageBackground={false} />
    </>
  );
}

function ConstraintsSection({ nodes, update }: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const get = (n: SceneNode): Constraints => n.constraints ?? { horizontal: 'left', vertical: 'top' };
  return (
    <Section title="Constraints">
      <div className="grid2">
        <SelectField
          label="Horizontal constraint"
          value={common(nodes, (n) => get(n).horizontal)}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
            { value: 'leftRight', label: 'Left and right' },
            { value: 'center', label: 'Center' },
            { value: 'scale', label: 'Scale' },
          ]}
          onChange={(v) => update((n) => ({ ...n, constraints: { ...get(n), horizontal: v } }))}
        />
        <SelectField
          label="Vertical constraint"
          value={common(nodes, (n) => get(n).vertical)}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'bottom', label: 'Bottom' },
            { value: 'topBottom', label: 'Top and bottom' },
            { value: 'center', label: 'Center' },
            { value: 'scale', label: 'Scale' },
          ]}
          onChange={(v) => update((n) => ({ ...n, constraints: { ...get(n), vertical: v } }))}
        />
      </div>
    </Section>
  );
}

function TextSection({ editor, nodes, update }: { editor: Editor; nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const t = (n: SceneNode) => n.text!;
  const setText = (patch: Partial<TextStyle>) => update((n) => ({ ...n, text: { ...n.text!, ...patch } }));
  // while editing with text selected, font settings apply to the selection
  const editing = editor.editingText ? editor.doc.get(editor.editingText) : undefined;
  const sel = editing && editor.textSelection;
  const draftText = editing?.text ? adjustRuns(editing.text, editor.textDraft ?? editing.text.characters) : null;
  const value = <K extends keyof RunProps>(key: K, whole: (n: SceneNode) => RunProps[K]) => {
    if (sel && draftText) {
      const v = rangeValue(draftText, sel.start, sel.end, key);
      return v === 'mixed' ? MIXED : (v as RunProps[K]);
    }
    return common(nodes, whole);
  };
  const weight = value('fontWeight', (n) => t(n).fontWeight);
  const italic = value('italic', (n) => !!t(n).italic);
  const deco = value('decoration', (n) => t(n).decoration ?? 'none');
  return (
    <Section title={sel ? 'Text (selected)' : 'Text'} action={<StylePicker editor={editor} nodes={nodes} field="text" />}>
      <SelectField
        label="Font"
        value={value('fontFamily', (n) => t(n).fontFamily) as typeof MIXED | string}
        options={FONT_FAMILIES.map((f) => ({ value: f, label: f, style: { fontFamily: fontStack(f) } }))}
        onChange={(v) => editor.styleText({ fontFamily: v })}
      />
      <div className="grid2">
        <SelectField
          label="Font weight"
          value={weight as typeof MIXED | number}
          options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
          onChange={(v) => editor.styleText({ fontWeight: v })}
        />
        <NumberField
          label="Size"
          ariaLabel="Font size"
          value={value('fontSize', (n) => t(n).fontSize) as typeof MIXED | number}
          min={1}
          max={2000}
          onCommit={(v) => editor.styleText({ fontSize: v })}
        />
        <NumberField
          label="Line"
          ariaLabel="Line height"
          value={common(nodes, (n) => t(n).lineHeight ?? Math.round(t(n).fontSize * 120) / 100)}
          min={0}
          max={4000}
          onCommit={(v) => setText({ lineHeight: v })}
        />
        <NumberField
          label="Letter"
          ariaLabel="Letter spacing"
          value={common(nodes, (n) => t(n).letterSpacing)}
          min={-200}
          max={2000}
          step={0.1}
          onCommit={(v) => setText({ letterSpacing: v })}
        />
      </div>
      <div className="grid2">
        <Segmented
          label="Text align"
          value={common(nodes, (n) => t(n).align)}
          options={[
            { value: 'left', label: 'Align left', icon: <TextAlignStart {...ICON} /> },
            { value: 'center', label: 'Align center', icon: <TextAlignCenter {...ICON} /> },
            { value: 'right', label: 'Align right', icon: <TextAlignEnd {...ICON} /> },
          ]}
          onChange={(v) => setText({ align: v })}
        />
        <SelectField
          label="Resizing"
          value={common(nodes, (n) => t(n).autoResize)}
          options={[
            { value: 'width', label: 'Auto width' },
            { value: 'height', label: 'Auto height' },
            { value: 'none', label: 'Fixed size' },
          ]}
          onChange={(v) => setText({ autoResize: v })}
        />
      </div>
      <div className="text-toggles" role="toolbar" aria-label="Text decoration">
        <IconButton label="Bold" shortcut={`${MOD}B`} pressed={weight === 700} onClick={() => editor.styleText({ fontWeight: weight === 700 ? 400 : 700 })}>
          <Bold {...ICON} />
        </IconButton>
        <IconButton label="Italic" shortcut={`${MOD}I`} pressed={italic === true} onClick={() => editor.styleText({ italic: italic !== true })}>
          <Italic {...ICON} />
        </IconButton>
        <IconButton label="Underline" shortcut={`${MOD}U`} pressed={deco === 'underline'} onClick={() => editor.styleText({ decoration: deco === 'underline' ? 'none' : 'underline' })}>
          <Underline {...ICON} />
        </IconButton>
        <IconButton
          label="Strikethrough"
          pressed={deco === 'strikethrough'}
          onClick={() => editor.styleText({ decoration: deco === 'strikethrough' ? 'none' : 'strikethrough' })}
        >
          <Strikethrough {...ICON} />
        </IconButton>
        {sel && (
          <label className="swatch range-color" title="Color of the selected text">
            <input
              type="color"
              aria-label="Selected text colour"
              value={(typeof value('color', () => undefined) === 'string' ? (value('color', () => undefined) as string) : '#1b1d21').toLowerCase()}
              onChange={(e) => editor.styleText({ color: e.target.value.toUpperCase() })}
            />
          </label>
        )}
      </div>
    </Section>
  );
}

function PaintsSection(props: {
  title: string;
  nodes: SceneNode[];
  get: (n: SceneNode) => Paint[];
  set: (n: SceneNode, paints: Paint[]) => SceneNode;
  defaultPaint: Paint;
  update: (fn: (n: SceneNode) => SceneNode) => void;
  hidden?: boolean;
  children?: React.ReactNode;
  style?: React.ReactNode;
}) {
  if (props.hidden) return null;
  const { nodes, get, set, update } = props;
  const paints = common(nodes, get);
  const label = props.title.toLowerCase();
  const add = () => update((n) => set(n, [...get(n), props.defaultPaint]));
  return (
    <Section
      title={props.title}
      action={
        <div className="inline-actions">
          {props.style}
          <IconButton label={`Add ${label}`} onClick={paints === MIXED ? () => update((n) => set(n, [props.defaultPaint])) : add}>
            <Plus {...ICON} />
          </IconButton>
        </div>
      }
    >
      {paints === MIXED ? (
        <p className="field-caption">Mixed. Click + to replace them with one {label}.</p>
      ) : (
        paints.map((p, i) => {
          const label = paints.length > 1 ? `${props.title} ${i + 1}` : props.title;
          const onChange = (next: Paint) => update((n) => set(n, get(n).map((q, j) => (j === i ? next : q))));
          const onRemove = () => update((n) => set(n, get(n).filter((_, j) => j !== i)));
          return <PaintEditor key={i} paint={p} label={label} allowImage={props.title === 'Fill'} onChange={onChange} onRemove={onRemove} />;
        })
      )}
      {(paints === MIXED || paints.length > 0) && props.children}
    </Section>
  );
}

function EffectsSection({ editor, nodes, update }: { editor: Editor; nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const effects = common(nodes, (n) => n.effects ?? []);
  return (
    <Section
      title="Effects"
      action={
        <div className="inline-actions">
          <StylePicker editor={editor} nodes={nodes} field="effect" />
        <IconButton
          label="Add effect"
          onClick={() => update((n) => ({ ...n, effects: effects === MIXED ? [DEFAULT_SHADOW] : [...(n.effects ?? []), DEFAULT_SHADOW].slice(0, 8) }))}
        >
          <Plus {...ICON} />
        </IconButton>
        </div>
      }
    >
      {effects === MIXED ? (
        <p className="field-caption">Mixed. Click + to replace them with one shadow.</p>
      ) : effects.length === 0 ? null : (
        effects.map((e, i) => (
          <EffectEditor
            key={i}
            index={i}
            effect={e}
            onChange={(next) => update((n) => ({ ...n, effects: (n.effects ?? []).map((x, j) => (j === i ? next : x)) }))}
            onRemove={() => update((n) => ({ ...n, effects: (n.effects ?? []).filter((_, j) => j !== i) }))}
          />
        ))
      )}
    </Section>
  );
}

const EXPORT_FORMATS: { value: ExportFormat | 'print'; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
  { value: 'svg', label: 'SVG' },
  { value: 'pdf', label: 'PDF' },
  { value: 'print', label: 'Vector PDF (print)' },
];

function ExportSection(props: { editor: Editor; ids: string[]; name: string; pageBackground: boolean }) {
  const { editor, ids } = props;
  const [format, setFormat] = useState<ExportFormat | 'print'>('png');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const empty = ids.length === 0;

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const target = { ids, background: props.pageBackground ? editor.background : null };
      const base = safeFileName(props.name);
      const suffix = scale === 1 ? '' : `@${scale}x`;
      let filename: string;
      if (format === 'print') {
        const b = exportBounds(editor.doc, ids);
        if (!b) throw new Error('Nothing to export');
        const bg = target.background ?? editor.background;
        await printSvgPages([{ svg: await exportSvg(editor.doc, { ...target, background: bg }), width: b.width, height: b.height }], props.name);
        setMessage('Sent to the print dialog');
        return;
      }
      if (format === 'svg') {
        filename = `${base}.svg`;
        downloadBlob(new Blob([await exportSvg(editor.doc, target)], { type: 'image/svg+xml' }), filename);
      } else if (format === 'pdf') {
        filename = `${base}.pdf`;
        downloadBlob(await exportPdf(editor.doc, [{ ...target, background: target.background ?? editor.background }], scale, props.name), filename);
      } else {
        filename = `${base}${suffix}.${format}`;
        downloadBlob(await exportImage(editor.doc, target, scale, format), filename);
      }
      setMessage(`Exported ${filename}`);
    } catch (e) {
      setMessage(`Couldn't export: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Export">
      <div className="grid2">
        <SelectField
          label="Export scale"
          value={format === 'svg' ? 1 : scale}
          options={[1, 2, 3, 4].map((s) => ({ value: s, label: `${s}x` }))}
          onChange={(v) => setScale(v)}
        />
        <SelectField label="Export format" value={format} options={EXPORT_FORMATS} onChange={(v) => setFormat(v)} />
      </div>
      <button type="button" className="btn secondary full" disabled={empty || busy} onClick={run}>
        {empty ? 'Nothing to export yet' : busy ? 'Exporting…' : `Export ${props.name}`}
      </button>
      {message && (
        <p className="field-caption" role="status">
          {message}
        </p>
      )}
    </Section>
  );
}

function ComponentSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  if (node.type === 'COMPONENT') {
    const count = [...editor.doc.all()].filter((n) => n.type === 'INSTANCE' && n.componentId === node.id).length;
    return (
      <Section title="Component">
        <p className="field-caption">
          <Component {...ICON} className="component-ink" /> Main component. {count === 0 ? 'No instances yet.' : `${count} instance${count === 1 ? '' : 's'} follow its changes.`}
        </p>
        <button type="button" className="btn secondary full" onClick={() => editor.createInstance(node.id)}>
          Create instance
        </button>
      </Section>
    );
  }
  const comp = node.componentId ? editor.doc.get(node.componentId) : undefined;
  const texts = comp ? overridableTexts(editor.doc, comp.id) : [];
  const overrides = node.overrides ?? {};
  return (
    <Section title="Instance">
      <p className="field-caption">{comp ? <>Instance of “{comp.name}”.</> : 'The main component was removed.'}</p>
      <div className="grid2">
        <button type="button" className="btn secondary full" disabled={!comp} onClick={() => editor.goToMainComponent(node.id)}>
          Go to main
        </button>
        <button type="button" className="btn secondary full" onClick={() => editor.detachInstances([node.id])}>
          Detach
        </button>
      </div>
      {texts.length > 0 && (
        <div className="override-list">
          <span className="field-caption">Text in this instance</span>
          {texts.map((t) => (
            <OverrideText
              key={t.id}
              label={t.name}
              placeholder={t.text!.characters}
              value={overrides[t.id]?.characters ?? t.text!.characters}
              onCommit={(v) => editor.setOverride(node.id, t.id, v === t.text!.characters ? null : { characters: v })}
            />
          ))}
        </div>
      )}
      {Object.keys(overrides).length > 0 && (
        <button type="button" className="btn secondary full" onClick={() => editor.resetOverrides([node.id])}>
          Reset all changes
        </button>
      )}
    </Section>
  );
}

function OverrideText(props: { label: string; value: string; placeholder: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(props.value);
  return (
    <label className="override-row">
      <span className="field-caption">{props.label}</span>
      <textarea
        className="hex-input override-input"
        value={text}
        rows={Math.min(4, Math.max(1, text.split('\n').length))}
        aria-label={`Text of ${props.label}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== props.value && props.onCommit(text)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
        }}
      />
    </label>
  );
}

/** Shared padding of two sides across nodes, or Mixed. */
function pad(nodes: SceneNode[], a: number, b: number) {
  const v = common(nodes, (n) => [n.layout?.padding[a], n.layout?.padding[b]]);
  if (v === MIXED || v[0] !== v[1] || v[0] === undefined) return MIXED;
  return v[0];
}

function AutoLayoutSection(props: { editor: Editor; nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const { editor, nodes, update } = props;
  const all = nodes.every((n) => n.layout);
  const none = nodes.every((n) => !n.layout);
  const L = (n: SceneNode) => n.layout ?? DEFAULT_LAYOUT;
  const setL = (patch: Partial<Layout>) => update((n) => (n.layout ? { ...n, layout: { ...n.layout, ...patch } } : n));
  return (
    <Section
      title="Auto layout"
      action={
        all ? (
          <IconButton label="Remove auto layout" onClick={() => editor.removeAutoLayout(nodes.map((n) => n.id))}>
            <span aria-hidden="true">−</span>
          </IconButton>
        ) : (
          <IconButton label="Add auto layout" shortcut="Shift+A" onClick={() => editor.addAutoLayout()}>
            <Plus {...ICON} />
          </IconButton>
        )
      }
    >
      {none ? null : (
        <>
          <div className="grid2">
            <Segmented
              label="Direction"
              value={common(nodes, (n) => L(n).mode)}
              options={[
                { value: 'vertical', label: 'Vertical', icon: <ArrowDown {...ICON} /> },
                { value: 'horizontal', label: 'Horizontal', icon: <ArrowRight {...ICON} /> },
              ]}
              onChange={(v) => setL({ mode: v })}
            />
            <NumberField label="Gap" ariaLabel="Gap between items" value={common(nodes, (n) => L(n).gap)} onCommit={(v) => setL({ gap: v })} />
            <NumberField
              label="H pad"
              ariaLabel="Horizontal padding"
              value={pad(nodes, 1, 3)}
              min={0}
              onCommit={(v) => update((n) => (n.layout ? { ...n, layout: { ...n.layout, padding: [n.layout.padding[0], v, n.layout.padding[2], v] } } : n))}
            />
            <NumberField
              label="V pad"
              ariaLabel="Vertical padding"
              value={pad(nodes, 0, 2)}
              min={0}
              onCommit={(v) => update((n) => (n.layout ? { ...n, layout: { ...n.layout, padding: [v, n.layout.padding[1], v, n.layout.padding[3]] } } : n))}
            />
            <SelectField
              label="Distribute items"
              value={common(nodes, (n) => L(n).primaryAlign)}
              options={[
                { value: 'start', label: 'Pack at start' },
                { value: 'center', label: 'Pack in center' },
                { value: 'end', label: 'Pack at end' },
                { value: 'space-between', label: 'Space between' },
              ]}
              onChange={(v) => setL({ primaryAlign: v })}
            />
            <SelectField
              label="Align items"
              value={common(nodes, (n) => L(n).crossAlign)}
              options={[
                { value: 'start', label: 'Align start' },
                { value: 'center', label: 'Align center' },
                { value: 'end', label: 'Align end' },
                { value: 'stretch', label: 'Stretch' },
              ]}
              onChange={(v) => setL({ crossAlign: v })}
            />
            <SelectField
              label="Width sizing"
              value={common(nodes, (n) => L(n).widthMode)}
              options={[
                { value: 'hug', label: 'W: Hug contents' },
                { value: 'fixed', label: 'W: Fixed' },
              ]}
              onChange={(v) => setL({ widthMode: v })}
            />
            <SelectField
              label="Height sizing"
              value={common(nodes, (n) => L(n).heightMode)}
              options={[
                { value: 'hug', label: 'H: Hug contents' },
                { value: 'fixed', label: 'H: Fixed' },
              ]}
              onChange={(v) => setL({ heightMode: v })}
            />
          </div>
          {nodes.every((n) => L(n).mode === 'horizontal') && (
            <div className="grid2">
              <label className="check-row">
                <input type="checkbox" checked={nodes.every((n) => L(n).wrap)} onChange={(e) => setL({ wrap: e.target.checked || undefined })} />
                Wrap to new rows
              </label>
              {nodes.every((n) => L(n).wrap) && (
                <NumberField
                  label="Row gap"
                  ariaLabel="Gap between rows"
                  value={common(nodes, (n) => L(n).counterGap ?? L(n).gap)}
                  min={0}
                  onCommit={(v) => setL({ counterGap: v })}
                />
              )}
            </div>
          )}
          <SizeLimits nodes={nodes} update={update} />
        </>
      )}
    </Section>
  );
}

/** Min and max width and height; 0 means no limit. */
function SizeLimits(props: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const { nodes, update } = props;
  const field = (key: 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', label: string, aria: string) => (
    <NumberField
      label={label}
      ariaLabel={aria}
      value={common(nodes, (n) => n[key] ?? 0)}
      min={0}
      max={1e6}
      onCommit={(v) => update((n) => ({ ...n, [key]: v > 0 ? v : undefined }))}
    />
  );
  return (
    <>
      <div className="grid2">
        {field('minWidth', 'Min W', 'Minimum width')}
        {field('maxWidth', 'Max W', 'Maximum width')}
        {field('minHeight', 'Min H', 'Minimum height')}
        {field('maxHeight', 'Max H', 'Maximum height')}
      </div>
      <p className="field-caption">Size limits apply in auto layout. 0 means no limit.</p>
    </>
  );
}

function LayoutChildSection(props: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const { nodes, update } = props;
  const C = (n: SceneNode): LayoutChild => n.layoutChild ?? { horizontal: 'fixed', vertical: 'fixed', absolute: false };
  const setC = (patch: Partial<LayoutChild>) => update((n) => ({ ...n, layoutChild: { ...C(n), ...patch } }));
  return (
    <Section title="In auto layout">
      <div className="grid2">
        <SelectField
          label="Width in layout"
          value={common(nodes, (n) => C(n).horizontal)}
          options={[
            { value: 'fixed', label: 'W: Fixed' },
            { value: 'fill', label: 'W: Fill container' },
          ]}
          onChange={(v) => setC({ horizontal: v })}
        />
        <SelectField
          label="Height in layout"
          value={common(nodes, (n) => C(n).vertical)}
          options={[
            { value: 'fixed', label: 'H: Fixed' },
            { value: 'fill', label: 'H: Fill container' },
          ]}
          onChange={(v) => setC({ vertical: v })}
        />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={nodes.every((n) => C(n).absolute)} onChange={(e) => setC({ absolute: e.target.checked })} />
        Ignore auto layout (absolute position)
      </label>
      <SizeLimits nodes={nodes} update={update} />
    </Section>
  );
}

function ConnectorSection({ editor, line }: { editor: Editor; line: SceneNode }) {
  const name = (id: string | undefined) => (id ? (editor.doc.get(id)?.name ?? 'a removed layer') : '');
  const side = (a: string | undefined) => (a === 'auto' || !a ? 'nearest side' : `${a} side`);
  return (
    <Section title="Connector">
      {line.startBind && (
        <div className="bind-row">
          <span className="field-caption">
            Start on “{name(line.startBind.nodeId)}”, {side(line.startBind.anchor)}
          </span>
          <button type="button" className="mini-btn wide" onClick={() => editor.updateNodes([line.id], (n) => ({ ...n, startBind: undefined }))}>
            Detach
          </button>
        </div>
      )}
      {line.endBind && (
        <div className="bind-row">
          <span className="field-caption">
            End on “{name(line.endBind.nodeId)}”, {side(line.endBind.anchor)}
          </span>
          <button type="button" className="mini-btn wide" onClick={() => editor.updateNodes([line.id], (n) => ({ ...n, endBind: undefined }))}>
            Detach
          </button>
        </div>
      )}
    </Section>
  );
}
