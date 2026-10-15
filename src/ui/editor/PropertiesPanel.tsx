import { useState } from 'react';
import { isDiagramItem } from '../../engine/diagramColors.ts';
import { canHaveLabel } from '../../engine/labels.ts';
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
  Minus,
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
  List,
  ListOrdered,
  Grid3x3,
} from 'lucide-react';
import { type Constraints, type Layout, type LayoutChild, type Paint, type SceneNode, type TextStyle, BLEND_MODES } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { type ExportFormat, exportBounds, exportImage, exportPdf, exportSvg, exportTargetFor } from '../../engine/export.ts';
import { printSvgPages } from '../print.ts';
import { PrototypePanel } from './PrototypePanel.tsx';
import { exportLayers } from '../layerExport.ts';
import { CodePanel } from './CodePanel.tsx';
import { overridableTexts } from '../../engine/instances.ts';
import { DEFAULT_LAYOUT } from '../../engine/layout.ts';
import { fitText, solid, TYPE_LABEL } from '../../engine/nodes.ts';
import { FONT_FAMILIES, FONT_WEIGHTS, fontStack } from '../../engine/text.ts';
import { IconButton, MOD } from '../components.tsx';
import { type RunProps, adjustRuns, rangeValue } from '../../engine/textRuns.ts';
import { downloadBlob, safeFileName } from '../download.ts';
import { useEditorRev, useRemembered } from '../hooks.ts';
import { MIXED, NumberField, Section, Segmented, SelectField, common, normalizeHex } from './fields.tsx';
import { DEFAULT_SHADOW, EffectEditor, PaintEditor } from './paints.tsx';
import { ComponentSetSection, InnerLayerSection, InstanceProps, LinkProps, PropDefinitions, VariantValues } from './componentPanels.tsx';
import { StylePicker, VariablesSection } from './assetsPanels.tsx';
import { FramePresets, GridsSection } from './framePanels.tsx';
import { t } from '../i18n.ts';

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
  const [code, setCode] = useState(false);
  const proto = editor.prototypeView && !code;
  const tab = code ? 'code' : proto ? 'prototype' : 'design';
  const pick = (k: 'design' | 'prototype' | 'code') => {
    setCode(k === 'code');
    editor.setPrototypeView(k === 'prototype');
  };

  return (
    <aside className="props" aria-label={t('Properties')}>
      <div className="tabs" role="tablist" aria-label={t('Right panel')}>
        {(['design', 'prototype', 'code'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>
            {k === 'design' ? t('Design') : k === 'prototype' ? t('Prototype') : t('Code')}
          </button>
        ))}
      </div>
      {code ? (
        <CodePanel editor={editor} nodes={sel} />
      ) : proto ? (
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
        {t('Page')}<span className="panel-subtitle">{page.name}</span>
      </div>
      <Section title="Background">
        <div className="paint-row simple">
          <label className="swatch" style={{ background: editor.background }}>
            <input
              type="color"
              aria-label={t('Background colour')}
              value={editor.background.toLowerCase()}
              onChange={(e) => {
                setHex(e.target.value.slice(1).toUpperCase());
                setBackground(e.target.value.toUpperCase());
              }}
            />
          </label>
          <input
            className="hex-input"
            aria-label={t('Background hex')}
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
  const [strokeMore, setStrokeMore] = useRemembered('strokeMore', false);
  const update = (fn: (n: SceneNode) => SceneNode) => editor.updateNodes(ids, fn);
  const single = nodes.length === 1 ? nodes[0] : null;
  const allType = (type: SceneNode['type']) => nodes.every((n) => n.type === type);
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
  const title = single?.section
    ? t('Section')
    : single?.sticky
      ? t('Sticky note')
      : single?.shape
      ? t(single.shape.kind[0].toUpperCase() + single.shape.kind.slice(1))
      : single
        ? t(TYPE_LABEL[single.type])
        : t('{n} layers', { n: nodes.length });
  const canAlign = nodes.length > 1 || (single !== null && single.parentId !== null);

  return (
    <>
      <div className="panel-title">
        {title}
        {single && <span className="panel-subtitle">{single.name}</span>}
      </div>

      {canAlign && (
        <div className="align-bar" role="toolbar" aria-label={t('Align')}>
          <IconButton label={t('Align left')} onClick={() => editor.align('left')}>
            <AlignStartVertical {...ICON} />
          </IconButton>
          <IconButton label={t('Align horizontal centres')} onClick={() => editor.align('hcenter')}>
            <AlignCenterVertical {...ICON} />
          </IconButton>
          <IconButton label={t('Align right')} onClick={() => editor.align('right')}>
            <AlignEndVertical {...ICON} />
          </IconButton>
          <IconButton label={t('Align top')} onClick={() => editor.align('top')}>
            <AlignStartHorizontal {...ICON} />
          </IconButton>
          <IconButton label={t('Align vertical centres')} onClick={() => editor.align('vcenter')}>
            <AlignCenterHorizontal {...ICON} />
          </IconButton>
          <IconButton label={t('Align bottom')} onClick={() => editor.align('bottom')}>
            <AlignEndHorizontal {...ICON} />
          </IconButton>
          <IconButton label={t('Distribute horizontally')} disabled={nodes.length < 3} onClick={() => editor.distribute('x')}>
            <AlignHorizontalSpaceAround {...ICON} />
          </IconButton>
          <IconButton label={t('Distribute vertically')} disabled={nodes.length < 3} onClick={() => editor.distribute('y')}>
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
        <div className="align-bar boolean-bar" role="toolbar" aria-label={t('Boolean operations')}>
          {(
            [
              ['union', 'Union selection', SquaresUnite],
              ['subtract', 'Subtract selection', SquaresSubtract],
              ['intersect', 'Intersect selection', SquaresIntersect],
              ['exclude', 'Exclude selection', SquaresExclude],
            ] as const
          ).map(([op, label, Icon]) => (
            <IconButton key={op} label={t(label)} pressed={single?.booleanOp === op} onClick={() => editor.booleanSelection(op)}>
              <Icon {...ICON} />
            </IconButton>
          ))}
        </div>
      )}
      {single?.type === 'VECTOR' && !isDiagramItem(single) && (
        <Section title="Path">
          <div className="grid2">
            <button type="button" className="btn secondary full" onClick={() => editor.startVectorEdit(single.id)}>
              {t('Edit points')}
            </button>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!single.vector?.closed}
                onChange={(e) => update((n) => (n.vector ? { ...n, vector: { ...n.vector, closed: e.target.checked } } : n))}
              />
              {t('Closed')}
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
            ariaLabel={t('Rotation')}
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
            <IconButton label={keepAspect ? t('Unlock aspect ratio') : t('Lock aspect ratio')} pressed={keepAspect} onClick={() => setKeepAspect(!keepAspect)}>
              {keepAspect ? <Link2 {...ICON} /> : <Link2Off {...ICON} />}
            </IconButton>
          )
        }
      >
        <div className="grid2">
          <NumberField
            label={allLines ? 'L' : 'W'}
            ariaLabel={allLines ? t('Length') : t('Width')}
            value={common(nodes, (n) => n.width)}
            min={allLines ? 0 : 0.01}
            onCommit={(v) => editor.transact(() => ids.forEach((id) => editor.setSize(id, v, null, keepAspect)))}
          />
          {!allLines && (
            <NumberField
              label="H"
              ariaLabel={t('Height')}
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
            <IconButton label={corners ? t('Same radius for all corners') : t('Separate radius per corner')} pressed={corners} onClick={() => setCorners(!corners)}>
              <Scan {...ICON} />
            </IconButton>
          }
        >
          {corners ? (
            <div className="grid2">
              {(['Top left radius', 'Top right radius', 'Bottom right radius', 'Bottom left radius'] as const).map((label, i) => (
                <NumberField
                  key={label}
                  label={['TL', 'TR', 'BR', 'BL'][i]}
                  ariaLabel={t(label)}
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
                ariaLabel={t('Corner radius')}
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
            {t('Clip content')}
          </label>
        </Section>
      )}

      {single?.type === 'VECTOR' && single.shape && (single.shape.kind === 'polygon' || single.shape.kind === 'star') && <ShapeSection node={single} update={update} />}
      {single && canHaveLabel(single) && (single.label !== undefined || isDiagramItem(single)) && <LabelSection editor={editor} node={single} update={update} />}

      {constrained && <ConstraintsSection nodes={nodes} update={update} />}

      <Section title="Layer">
        <div className="grid2">
          <NumberField
            label={t('Opacity')}
            ariaLabel={t('Layer opacity')}
            value={common(nodes, (n) => Math.round(n.opacity * 100))}
            min={0}
            max={100}
            precision={0}
            suffix="%"
            onCommit={(v) => update((n) => ({ ...n, opacity: v / 100 }))}
          />
          <SelectField
            label={t('Blend mode')}
            value={common(nodes, (n) => n.blendMode ?? 'normal')}
            options={BLEND_MODES.map((m) => ({ value: m, label: t(m === 'normal' ? 'Normal' : m[0].toUpperCase() + m.slice(1).replace('-', ' ')) }))}
            onChange={(v) => update((n) => ({ ...n, blendMode: v === 'normal' ? undefined : v }))}
          />
        </div>
        <div className="grid2">
          {single && (
            <label className="check-row">
              <input type="checkbox" checked={!!single.isMask} onChange={() => editor.useAsMask()} />
              {t('Use as mask')}
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
            label={t('Weight')}
            ariaLabel={t('Stroke weight')}
            value={common(nodes, (n) => n.strokeWeight)}
            min={0}
            max={1000}
            onCommit={(v) => update((n) => ({ ...n, strokeWeight: v }))}
          />
          <button type="button" className="mini-btn wide more-btn" aria-expanded={strokeMore} onClick={() => setStrokeMore(!strokeMore)}>
            {strokeMore ? t('Fewer options') : t('More stroke options')}
          </button>
        </div>
        {strokeMore && (
          <div className="grid2">
          {!allLines && (
            <SelectField
              label={t('Stroke position')}
              value={common(nodes, (n) => n.strokeAlign)}
              options={[
                { value: 'inside', label: t('Inside') },
                { value: 'center', label: t('Center') },
                { value: 'outside', label: t('Outside') },
              ]}
              onChange={(v) => update((n) => (n.type === 'LINE' ? n : { ...n, strokeAlign: v }))}
            />
          )}
          <SelectField
            label={t('Stroke style')}
            value={common(nodes, (n) => (n.strokeDash.length ? 'dashed' : 'solid'))}
            options={[
              { value: 'solid', label: t('Solid') },
              { value: 'dashed', label: t('Dashed') },
            ]}
            onChange={(v) =>
              update((n) => ({ ...n, strokeDash: v === 'dashed' ? [Math.max(4, n.strokeWeight * 3), Math.max(4, n.strokeWeight * 2)] : [] }))
            }
          />
          {nodes.every((n) => n.type === 'LINE' || n.type === 'VECTOR') && (
            <SelectField
              label={t('Line ends')}
              value={common(nodes, (n) => n.strokeCap ?? (n.type === 'VECTOR' ? 'round' : 'none'))}
              options={[
                { value: 'none', label: t('Ends: flat') },
                { value: 'round', label: t('Ends: round') },
                { value: 'square', label: t('Ends: square') },
              ]}
              onChange={(v) => update((n) => ({ ...n, strokeCap: v }))}
            />
          )}
          {!allLines && (
            <SelectField
              label={t('Corners')}
              value={common(nodes, (n) => n.strokeJoin ?? (n.type === 'VECTOR' ? 'round' : 'miter'))}
              options={[
                { value: 'miter', label: t('Join: miter') },
                { value: 'round', label: t('Join: round') },
                { value: 'bevel', label: t('Join: bevel') },
              ]}
              onChange={(v) => update((n) => ({ ...n, strokeJoin: v }))}
            />
          )}
          </div>
        )}
        {strokeMore && (
          <>
        {nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME' || n.type === 'COMPONENT') && (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={nodes.every((n) => n.strokeSides)}
                onChange={(e) =>
                  update((n) => ({
                    ...n,
                    strokeSides: e.target.checked ? [n.strokeWeight, n.strokeWeight, n.strokeWeight, n.strokeWeight] : undefined,
                  }))
                }
              />
              {t('Different weight per side')}
            </label>
            {nodes.every((n) => n.strokeSides) && (
              <div className="grid2">
                {(['Top', 'Right', 'Bottom', 'Left'] as const).map((side, i) => (
                  <NumberField
                    key={side}
                    label={side[0]}
                    ariaLabel={side === 'Top' ? t('Top stroke weight') : side === 'Right' ? t('Right stroke weight') : side === 'Bottom' ? t('Bottom stroke weight') : t('Left stroke weight')}
                    value={common(nodes, (n) => n.strokeSides![i])}
                    min={0}
                    max={1000}
                    onCommit={(v) =>
                      update((n) => (n.strokeSides ? { ...n, strokeSides: n.strokeSides.map((w, j) => (j === i ? v : w)) as [number, number, number, number] } : n))
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
          </>
        )}
        {allLines && (
          <div className="arrow-row">
            <span className="field-caption">{t('Arrows')}</span>
            <IconButton
              label={t('Arrow at start')}
              pressed={nodes.every((n) => n.arrowStart)}
              onClick={() => {
                const on = !nodes.every((n) => n.arrowStart);
                update((n) => ({ ...n, arrowStart: on }));
              }}
            >
              <ArrowLeft {...ICON} />
            </IconButton>
            <IconButton
              label={t('Arrow at end')}
              pressed={nodes.every((n) => n.arrowEnd)}
              onClick={() => {
                const on = !nodes.every((n) => n.arrowEnd);
                update((n) => ({ ...n, arrowEnd: on }));
              }}
            >
              <ArrowRight {...ICON} />
            </IconButton>
            <IconButton
              label={t('Elbow line')}
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

      <ExportSection key={ids.join(',')} editor={editor} ids={ids} name={single ? single.name : 'Selection'} shownName={single ? single.name : t('Selection')} pageBackground={false} />
    </>
  );
}

function ConstraintsSection({ nodes, update }: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const get = (n: SceneNode): Constraints => n.constraints ?? { horizontal: 'left', vertical: 'top' };
  return (
    <Section folded title="Constraints">
      <div className="grid2">
        <SelectField
          label={t('Horizontal constraint')}
          value={common(nodes, (n) => get(n).horizontal)}
          options={[
            { value: 'left', label: t('Left') },
            { value: 'right', label: t('Right') },
            { value: 'leftRight', label: t('Left and right') },
            { value: 'center', label: t('Center') },
            { value: 'scale', label: t('Scale') },
          ]}
          onChange={(v) => update((n) => ({ ...n, constraints: { ...get(n), horizontal: v } }))}
        />
        <SelectField
          label={t('Vertical constraint')}
          value={common(nodes, (n) => get(n).vertical)}
          options={[
            { value: 'top', label: t('Top') },
            { value: 'bottom', label: t('Bottom') },
            { value: 'topBottom', label: t('Top and bottom') },
            { value: 'center', label: t('Center') },
            { value: 'scale', label: t('Scale') },
          ]}
          onChange={(v) => update((n) => ({ ...n, constraints: { ...get(n), vertical: v } }))}
        />
      </div>
    </Section>
  );
}

function TextSection({ editor, nodes, update }: { editor: Editor; nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const tx = (n: SceneNode) => n.text!;
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
  const weight = value('fontWeight', (n) => tx(n).fontWeight);
  const italic = value('italic', (n) => !!tx(n).italic);
  const deco = value('decoration', (n) => tx(n).decoration ?? 'none');
  return (
    <Section title={sel ? 'Text (selected)' : 'Text'} action={<StylePicker editor={editor} nodes={nodes} field="text" />}>
      <FontPicker value={value('fontFamily', (n) => tx(n).fontFamily) as typeof MIXED | string} onChange={(v) => editor.styleText({ fontFamily: v })} />
      <div className="grid2">
        <SelectField
          label={t('Font weight')}
          value={weight as typeof MIXED | number}
          options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: t(w.label) }))}
          onChange={(v) => editor.styleText({ fontWeight: v })}
        />
        <NumberField
          label={t('Size')}
          ariaLabel={t('Font size')}
          value={value('fontSize', (n) => tx(n).fontSize) as typeof MIXED | number}
          min={1}
          max={2000}
          onCommit={(v) => editor.styleText({ fontSize: v })}
        />
        <NumberField
          label={t('Line')}
          ariaLabel={t('Line height')}
          value={common(nodes, (n) => tx(n).lineHeight ?? Math.round(tx(n).fontSize * 120) / 100)}
          min={0}
          max={4000}
          onCommit={(v) => setText({ lineHeight: v })}
        />
        <NumberField
          label={t('Letter')}
          ariaLabel={t('Letter spacing')}
          value={common(nodes, (n) => tx(n).letterSpacing)}
          min={-200}
          max={2000}
          step={0.1}
          onCommit={(v) => setText({ letterSpacing: v })}
        />
      </div>
      <div className="grid2">
        <Segmented
          label={t('Text align')}
          value={common(nodes, (n) => tx(n).align)}
          options={[
            { value: 'left', label: t('Align left'), icon: <TextAlignStart {...ICON} /> },
            { value: 'center', label: t('Align center'), icon: <TextAlignCenter {...ICON} /> },
            { value: 'right', label: t('Align right'), icon: <TextAlignEnd {...ICON} /> },
          ]}
          onChange={(v) => setText({ align: v })}
        />
        <SelectField
          label={t('Resizing')}
          value={common(nodes, (n) => tx(n).autoResize)}
          options={[
            { value: 'width', label: t('Auto width') },
            { value: 'height', label: t('Auto height') },
            { value: 'none', label: t('Fixed size') },
          ]}
          onChange={(v) => setText({ autoResize: v })}
        />
        <NumberField
          label={t('Para')}
          ariaLabel={t('Paragraph spacing')}
          value={common(nodes, (n) => tx(n).paragraphSpacing ?? 0)}
          min={0}
          max={10_000}
          onCommit={(v) => update((n) => fitText({ ...n, text: { ...n.text!, paragraphSpacing: v > 0 ? v : undefined } }))}
        />
        <NumberField
          label={t('Lines')}
          ariaLabel={t('Maximum lines (0 for no limit)')}
          value={common(nodes, (n) => tx(n).maxLines ?? 0)}
          min={0}
          max={10_000}
          precision={0}
          onCommit={(v) => update((n) => fitText({ ...n, text: { ...n.text!, maxLines: v >= 1 ? Math.round(v) : undefined } }))}
        />
        <SelectField
          label={t('Text case')}
          value={common(nodes, (n) => tx(n).textCase ?? 'none')}
          options={[
            { value: 'none', label: t('As typed') },
            { value: 'upper', label: t('UPPER CASE') },
            { value: 'lower', label: t('lower case') },
            { value: 'title', label: t('Title Case') },
          ]}
          onChange={(v) => update((n) => fitText({ ...n, text: { ...n.text!, textCase: v === 'none' ? undefined : v } }))}
        />
      </div>
      <LinkField editor={editor} current={value('link', () => undefined)} />
      <div className="grid2">
        <label className="check-row">
          <input
            type="checkbox"
            checked={nodes.every((n) => tx(n).smallCaps)}
            onChange={(e) => update((n) => fitText({ ...n, text: { ...n.text!, smallCaps: e.target.checked || undefined } }))}
          />
          {t('Small caps')}
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={nodes.every((n) => tx(n).kerning !== false)}
            onChange={(e) => update((n) => fitText({ ...n, text: { ...n.text!, kerning: e.target.checked ? undefined : false } }))}
          />
          {t('Kerning')}
        </label>
      </div>
      <div className="text-toggles" role="toolbar" aria-label={t('Text decoration')}>
        <IconButton label={t('Bulleted list')} onClick={() => editor.setTextList('bullet')}>
          <List {...ICON} />
        </IconButton>
        <IconButton label={t('Numbered list')} onClick={() => editor.setTextList('number')}>
          <ListOrdered {...ICON} />
        </IconButton>
        <IconButton label={t('Bold')} shortcut={`${MOD}B`} pressed={weight === 700} onClick={() => editor.styleText({ fontWeight: weight === 700 ? 400 : 700 })}>
          <Bold {...ICON} />
        </IconButton>
        <IconButton label={t('Italic')} shortcut={`${MOD}I`} pressed={italic === true} onClick={() => editor.styleText({ italic: italic !== true })}>
          <Italic {...ICON} />
        </IconButton>
        <IconButton label={t('Underline')} shortcut={`${MOD}U`} pressed={deco === 'underline'} onClick={() => editor.styleText({ decoration: deco === 'underline' ? 'none' : 'underline' })}>
          <Underline {...ICON} />
        </IconButton>
        <IconButton
          label={t('Strikethrough')}
          pressed={deco === 'strikethrough'}
          onClick={() => editor.styleText({ decoration: deco === 'strikethrough' ? 'none' : 'strikethrough' })}
        >
          <Strikethrough {...ICON} />
        </IconButton>
        {sel && (
          <label className="swatch range-color" title={t('Color of the selected text')}>
            <input
              type="color"
              aria-label={t('Selected text colour')}
              value={(typeof value('color', () => undefined) === 'string' ? (value('color', () => undefined) as string) : '#1b1d21').toLowerCase()}
              onChange={(e) => editor.styleText({ color: e.target.value.toUpperCase() })}
            />
          </label>
        )}
      </div>
    </Section>
  );
}

const LINK_RE = /^(https?:\/\/|mailto:)[^\s"<>]+$/;

/** A link on the selected text (or the whole layer): web and mail addresses only. */
function LinkField({ editor, current }: { editor: Editor; current: string | undefined | typeof MIXED | 'mixed' }) {
  const shown = typeof current === 'string' && current !== 'mixed' ? current : '';
  const [error, setError] = useState(false);
  return (
    <label className="dialog-field">
      <span>{t('Link')}</span>
      <input
        className={`hex-input override-input ${error ? 'invalid' : ''}`}
        key={shown}
        defaultValue={shown}
        placeholder={current === MIXED || current === 'mixed' ? t('Mixed') : 'https://…'}
        maxLength={2000}
        aria-label={t('Link')}
        aria-invalid={error}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          let v = e.target.value.trim();
          if (v && !/^[a-z]+:/i.test(v)) v = `https://${v}`;
          if (v && !LINK_RE.test(v)) return setError(true);
          setError(false);
          if (v !== shown) editor.styleText({ link: v });
        }}
      />
    </label>
  );
}

/** Font family: the bundled fonts, fonts on this computer (where the browser can list them), or any name. */
function FontPicker({ value, onChange }: { value: string | typeof MIXED; onChange: (v: string) => void }) {
  const [local, setLocal] = useState<string[]>([]);
  const canList = typeof window !== 'undefined' && 'queryLocalFonts' in window;
  const families = [...new Set([...FONT_FAMILIES, ...local])];
  return (
    <div className="font-picker">
      <input
        className="hex-input override-input"
        list="font-families"
        aria-label={t('Font')}
        key={String(value)}
        defaultValue={value === MIXED ? '' : value}
        placeholder={value === MIXED ? t('Mixed') : t('Font')}
        maxLength={100}
        style={value === MIXED ? undefined : { fontFamily: fontStack(value) }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const v = e.target.value.replace(/["\\]/g, '').trim().slice(0, 100);
          if (v && v !== value) onChange(v);
        }}
      />
      <datalist id="font-families">
        {families.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {canList && local.length === 0 && (
        <button
          type="button"
          className="mini-btn wide"
          title={t('Lists the fonts installed on this computer (the browser asks first)')}
          onClick={async () => {
            try {
              const fonts = await (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts();
              setLocal([...new Set(fonts.map((f) => f.family))].sort().slice(0, 2000));
            } catch {
              /* refused: the bundled fonts and typed names still work */
            }
          }}
        >
          {t('Local fonts')}
        </button>
      )}
    </div>
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
  const isFill = props.title === 'Fill';
  const add = () => update((n) => set(n, [...get(n), props.defaultPaint]));
  return (
    <Section
      title={props.title}
      action={
        <div className="inline-actions">
          {props.style}
          <IconButton label={isFill ? t('Add fill') : t('Add stroke')} onClick={paints === MIXED ? () => update((n) => set(n, [props.defaultPaint])) : add}>
            <Plus {...ICON} />
          </IconButton>
        </div>
      }
    >
      {paints === MIXED ? (
        <p className="field-caption">{isFill ? t('Mixed. Click + to replace them with one fill.') : t('Mixed. Click + to replace them with one stroke.')}</p>
      ) : (
        paints.map((p, i) => {
          const label = paints.length > 1 ? t('{name} {n}', { name: t(props.title), n: i + 1 }) : t(props.title);
          const onChange = (next: Paint) => update((n) => set(n, get(n).map((q, j) => (j === i ? next : q))));
          const onRemove = () => update((n) => set(n, get(n).filter((_, j) => j !== i)));
          return <PaintEditor key={i} paint={p} label={label} allowImage={isFill} onChange={onChange} onRemove={onRemove} />;
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
          label={t('Add effect')}
          onClick={() => update((n) => ({ ...n, effects: effects === MIXED ? [DEFAULT_SHADOW] : [...(n.effects ?? []), DEFAULT_SHADOW].slice(0, 8) }))}
        >
          <Plus {...ICON} />
        </IconButton>
        </div>
      }
    >
      {effects === MIXED ? (
        <p className="field-caption">{t('Mixed. Click + to replace them with one shadow.')}</p>
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

/** `name` names the files; `shownName` (if given) is shown on the button instead. */
function ExportSection(props: { editor: Editor; ids: string[]; name: string; shownName?: string; pageBackground: boolean }) {
  const { editor, ids } = props;
  const shownName = props.shownName ?? props.name;
  const [format, setFormat] = useState<ExportFormat | 'print'>('png');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const empty = ids.length === 0;
  const nodes = ids.map((id) => editor.doc.get(id)).filter((n): n is SceneNode => !!n);
  const single = nodes.length === 1 ? nodes[0] : null;
  const settings = single?.exportSettings ?? [];
  const withSettings = nodes.filter((n) => n.exportSettings?.length);
  const setSettings = (next: NonNullable<SceneNode['exportSettings']>) =>
    single && editor.updateNodes([single.id], (n) => ({ ...n, exportSettings: next.length ? next : undefined }));

  /** Every saved export setting of the selected layers. */
  const runSettings = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const out = await exportLayers(
        editor.doc,
        withSettings,
        (n) => (n.parentId === null && !n.fills.length ? editor.background : null),
        props.name,
        undefined,
        () => editor.background,
      );
      if (!out) throw new Error('Nothing to export');
      downloadBlob(out.blob, out.filename);
      setMessage(t('Exported {name}', { name: out.filename }));
    } catch (e) {
      setMessage(t("Couldn't export: {error}", { error: e instanceof Error ? t(e.message) : t('unknown error') }));
    } finally {
      setBusy(false);
    }
  };

  if (withSettings.length) {
    return (
      <Section
        folded
        title="Export"
        action={
          single && settings.length < 10 ? (
            <IconButton label={t('Add export setting')} onClick={() => setSettings([...settings, { format: 'png', scale: 2, suffix: '@2x' }])}>
              <Plus {...ICON} />
            </IconButton>
          ) : undefined
        }
      >
        {single &&
          settings.map((s, i) => (
            <div className="export-row" key={i} role="group" aria-label={t('Export setting {n}', { n: i + 1 })}>
              <SelectField
                label={t('Scale')}
                value={s.scale}
                options={[0.5, 1, 1.5, 2, 3, 4].map((v) => ({ value: v, label: `${v}x` }))}
                onChange={(v) => setSettings(settings.map((x, j) => (j === i ? { ...x, scale: v } : x)))}
              />
              <input
                className="hex-input override-input"
                aria-label={t('File name suffix')}
                placeholder={t('Suffix')}
                maxLength={40}
                defaultValue={s.suffix}
                key={`${i}-${s.suffix}`}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const suffix = e.target.value.replace(/[^A-Za-z0-9 @._-]/g, '').slice(0, 40);
                  if (suffix !== s.suffix) setSettings(settings.map((x, j) => (j === i ? { ...x, suffix } : x)));
                }}
              />
              <SelectField
                label={t('Format')}
                value={s.format}
                options={EXPORT_FORMATS.filter((f) => f.value !== 'print') as { value: ExportFormat; label: string }[]}
                onChange={(v) => setSettings(settings.map((x, j) => (j === i ? { ...x, format: v } : x)))}
              />
              <IconButton label={t('Remove export setting {n}', { n: i + 1 })} onClick={() => setSettings(settings.filter((_, j) => j !== i))}>
                <Minus {...ICON} />
              </IconButton>
            </div>
          ))}
        {!single && <p className="field-caption">{t('{n} of the selected layers have export settings.', { n: withSettings.length })}</p>}
        <button type="button" className="btn secondary full" disabled={busy} onClick={runSettings}>
          {busy ? t('Exporting…') : t('Export {name}', { name: shownName })}
        </button>
        {message && (
          <p className="field-caption" role="status">
            {message}
          </p>
        )}
      </Section>
    );
  }

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const bg = props.pageBackground ? editor.background : null;
      const target = single?.slice ? exportTargetFor(editor.doc, single, bg, editor.background) : { ids, background: bg };
      const base = safeFileName(props.name);
      const suffix = scale === 1 ? '' : `@${scale}x`;
      let filename: string;
      if (format === 'print') {
        const b = target.clip ?? exportBounds(editor.doc, ids);
        if (!b) throw new Error('Nothing to export');
        const bg = target.background ?? editor.background;
        await printSvgPages([{ svg: await exportSvg(editor.doc, { ...target, background: bg }), width: b.width, height: b.height }], props.name);
        setMessage(t('Sent to the print dialog'));
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
      setMessage(t("Couldn't export: {error}", { error: e instanceof Error ? t(e.message) : t('unknown error') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      folded
        title="Export"
      action={
        single ? (
          <IconButton label={t('Add export setting')} onClick={() => setSettings([{ format: 'png', scale: 1, suffix: '' }])}>
            <Plus {...ICON} />
          </IconButton>
        ) : undefined
      }
    >
      <div className="grid2">
        <SelectField
          label={t('Export scale')}
          value={format === 'svg' ? 1 : scale}
          options={[1, 2, 3, 4].map((s) => ({ value: s, label: `${s}x` }))}
          onChange={(v) => setScale(v)}
        />
        <SelectField label={t('Export format')} value={format} options={EXPORT_FORMATS.map((f) => (f.value === 'print' ? { ...f, label: t(f.label) } : f))} onChange={(v) => setFormat(v)} />
      </div>
      <button type="button" className="btn secondary full" disabled={empty || busy} onClick={run}>
        {empty ? t('Nothing to export yet') : busy ? t('Exporting…') : t('Export {name}', { name: shownName })}
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
          <Component {...ICON} className="component-ink" /> {t('Main component.')}{' '}
          {count === 0 ? t('No instances yet.') : count === 1 ? t('1 instance follow its changes.') : t('{n} instances follow its changes.', { n: count })}
        </p>
        <button type="button" className="btn secondary full" onClick={() => editor.createInstance(node.id)}>
          {t('Create instance')}
        </button>
      </Section>
    );
  }
  const comp = node.componentId ? editor.doc.get(node.componentId) : undefined;
  const texts = comp ? overridableTexts(editor.doc, comp.id) : [];
  const overrides = node.overrides ?? {};
  return (
    <Section title="Instance">
      <p className="field-caption">{comp ? t('Instance of “{name}”.', { name: comp.name }) : t('The main component was removed.')}</p>
      <div className="grid2">
        <button type="button" className="btn secondary full" disabled={!comp} onClick={() => editor.goToMainComponent(node.id)}>
          {t('Go to main')}
        </button>
        <button type="button" className="btn secondary full" onClick={() => editor.detachInstances([node.id])}>
          {t('Detach')}
        </button>
      </div>
      {texts.length > 0 && (
        <div className="override-list">
          <span className="field-caption">{t('Text in this instance')}</span>
          {texts.map((tt) => (
            <OverrideText
              key={tt.id}
              label={tt.name}
              placeholder={tt.text!.characters}
              value={overrides[tt.id]?.characters ?? tt.text!.characters}
              onCommit={(v) => editor.setOverride(node.id, tt.id, v === tt.text!.characters ? null : { characters: v })}
            />
          ))}
        </div>
      )}
      {Object.keys(overrides).length > 0 && (
        <button type="button" className="btn secondary full" onClick={() => editor.resetOverrides([node.id])}>
          {t('Reset all changes')}
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
        aria-label={t('Text of {name}', { name: props.label })}
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
          <IconButton label={t('Remove auto layout')} onClick={() => editor.removeAutoLayout(nodes.map((n) => n.id))}>
            <span aria-hidden="true">−</span>
          </IconButton>
        ) : (
          <IconButton label={t('Add auto layout')} shortcut="Shift+A" onClick={() => editor.addAutoLayout()}>
            <Plus {...ICON} />
          </IconButton>
        )
      }
    >
      {none ? null : (
        <>
          <div className="grid2">
            <Segmented
              label={t('Direction')}
              value={common(nodes, (n) => L(n).mode)}
              options={[
                { value: 'vertical', label: t('Vertical'), icon: <ArrowDown {...ICON} /> },
                { value: 'horizontal', label: t('Horizontal'), icon: <ArrowRight {...ICON} /> },
                { value: 'grid', label: t('Grid'), icon: <Grid3x3 {...ICON} /> },
              ]}
              onChange={(v) => setL({ mode: v, ...(v === 'grid' ? { columns: 2, widthMode: 'fixed' as const } : {}) })}
            />
            <NumberField label={t('Gap')} ariaLabel={t('Gap between items')} value={common(nodes, (n) => L(n).gap)} onCommit={(v) => setL({ gap: v })} />
            <NumberField
              label={t('H pad')}
              ariaLabel={t('Horizontal padding')}
              value={pad(nodes, 1, 3)}
              min={0}
              onCommit={(v) => update((n) => (n.layout ? { ...n, layout: { ...n.layout, padding: [n.layout.padding[0], v, n.layout.padding[2], v] } } : n))}
            />
            <NumberField
              label={t('V pad')}
              ariaLabel={t('Vertical padding')}
              value={pad(nodes, 0, 2)}
              min={0}
              onCommit={(v) => update((n) => (n.layout ? { ...n, layout: { ...n.layout, padding: [v, n.layout.padding[1], v, n.layout.padding[3]] } } : n))}
            />
            <SelectField
              label={t('Distribute items')}
              value={common(nodes, (n) => L(n).primaryAlign)}
              options={[
                { value: 'start', label: t('Pack at start') },
                { value: 'center', label: t('Pack in center') },
                { value: 'end', label: t('Pack at end') },
                { value: 'space-between', label: t('Space between') },
              ]}
              onChange={(v) => setL({ primaryAlign: v })}
            />
            <SelectField
              label={t('Align items')}
              value={common(nodes, (n) => L(n).crossAlign)}
              options={[
                { value: 'start', label: t('Align start') },
                { value: 'center', label: t('Align center') },
                { value: 'end', label: t('Align end') },
                { value: 'stretch', label: t('Stretch') },
              ]}
              onChange={(v) => setL({ crossAlign: v })}
            />
            <SelectField
              label={t('Width sizing')}
              value={common(nodes, (n) => L(n).widthMode)}
              options={[
                { value: 'hug', label: t('W: Hug contents') },
                { value: 'fixed', label: t('W: Fixed') },
              ]}
              onChange={(v) => setL({ widthMode: v })}
            />
            <SelectField
              label={t('Height sizing')}
              value={common(nodes, (n) => L(n).heightMode)}
              options={[
                { value: 'hug', label: t('H: Hug contents') },
                { value: 'fixed', label: t('H: Fixed') },
              ]}
              onChange={(v) => setL({ heightMode: v })}
            />
          </div>
          {nodes.every((n) => L(n).mode === 'grid') && (
            <div className="grid2">
              <NumberField
                label={t('Cols')}
                ariaLabel={t('Grid columns')}
                value={common(nodes, (n) => L(n).columns ?? 2)}
                min={1}
                max={100}
                precision={0}
                onCommit={(v) => setL({ columns: Math.round(v) })}
              />
              <NumberField
                label={t('Row gap')}
                ariaLabel={t('Gap between grid rows')}
                value={common(nodes, (n) => L(n).counterGap ?? L(n).gap)}
                min={0}
                onCommit={(v) => setL({ counterGap: v })}
              />
            </div>
          )}
          {nodes.every((n) => L(n).mode === 'horizontal') && (
            <div className="grid2">
              <label className="check-row">
                <input type="checkbox" checked={nodes.every((n) => L(n).wrap)} onChange={(e) => setL({ wrap: e.target.checked || undefined })} />
                {t('Wrap to new rows')}
              </label>
              {nodes.every((n) => L(n).wrap) && (
                <NumberField
                  label={t('Row gap')}
                  ariaLabel={t('Gap between rows')}
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

/** The text inside a shape or on a connector: how it looks. Double-clicking the shape types in it. */
function LabelSection({ editor, node, update }: { editor: Editor; node: SceneNode; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const l = node.label;
  const set = (patch: Partial<TextStyle>) => update((n) => (n.label ? { ...n, label: { ...n.label, ...patch } } : n));
  return (
    <Section
      title={node.type === 'LINE' ? 'Connector text' : 'Shape text'}
      action={
        <button type="button" className="mini-btn wide" onClick={() => editor.startLabelEdit(node.id)}>
          {l?.characters ? t('Edit') : t('Add text')}
        </button>
      }
    >
      {l?.characters ? (
        <>
          <div className="grid2">
            <NumberField label={t('Size')} ariaLabel={t('Shape text size')} value={l.fontSize} min={1} max={2000} onCommit={(v) => set({ fontSize: v })} />
            <SelectField
              label={t('Shape text weight')}
              value={l.fontWeight}
              options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: t(w.label) }))}
              onChange={(v) => set({ fontWeight: v })}
            />
            <label className="paint-row compact">
              <span className="swatch" style={{ background: node.labelColor ?? '#1B1D21' }}>
                <input
                  type="color"
                  aria-label={t('Shape text colour')}
                  value={(node.labelColor ?? '#1B1D21').toLowerCase()}
                  onChange={(e) => update((n) => ({ ...n, labelColor: e.target.value.toUpperCase() }))}
                />
              </span>
            </label>
            <Segmented
              label={t('Shape text align')}
              value={l.align}
              options={[
                { value: 'left', label: t('Align left'), icon: <TextAlignStart {...ICON} /> },
                { value: 'center', label: t('Align center'), icon: <TextAlignCenter {...ICON} /> },
                { value: 'right', label: t('Align right'), icon: <TextAlignEnd {...ICON} /> },
              ]}
              onChange={(v) => set({ align: v })}
            />
          </div>
        </>
      ) : (
        <p className="field-caption">
          {node.type === 'LINE' ? t('Double-click the connector or press Enter to write in it.') : t('Double-click the shape or press Enter to write in it.')}
        </p>
      )}
    </Section>
  );
}

/** Polygon sides, or star points and how deep its inner corners go. */
function ShapeSection({ node, update }: { node: SceneNode; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const shape = node.shape!;
  const set = (patch: Partial<typeof shape>) => update((n) => (n.shape ? { ...n, shape: { ...n.shape, ...patch } } : n));
  return (
    <Section title={shape.kind === 'star' ? 'Star' : 'Polygon'}>
      <div className="grid2">
        <NumberField
          label={shape.kind === 'star' ? t('Points') : t('Sides')}
          ariaLabel={shape.kind === 'star' ? t('Star points') : t('Polygon sides')}
          value={shape.count}
          min={3}
          max={60}
          precision={0}
          onCommit={(v) => set({ count: Math.round(v) })}
        />
        {shape.kind === 'star' && (
          <NumberField label={t('Ratio')} ariaLabel={t('Inner radius ratio')} value={Math.round(shape.ratio * 100)} min={1} max={100} precision={0} suffix="%" onCommit={(v) => set({ ratio: v / 100 })} />
        )}
      </div>
      <p className="field-caption">{t('Editing its points turns it into a plain vector.')}</p>
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
        {field('minWidth', t('Min W'), t('Minimum width'))}
        {field('maxWidth', t('Max W'), t('Maximum width'))}
        {field('minHeight', t('Min H'), t('Minimum height'))}
        {field('maxHeight', t('Max H'), t('Maximum height'))}
      </div>
      <p className="field-caption">{t('Size limits apply in auto layout. 0 means no limit.')}</p>
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
          label={t('Width in layout')}
          value={common(nodes, (n) => C(n).horizontal)}
          options={[
            { value: 'fixed', label: t('W: Fixed') },
            { value: 'fill', label: t('W: Fill container') },
          ]}
          onChange={(v) => setC({ horizontal: v })}
        />
        <SelectField
          label={t('Height in layout')}
          value={common(nodes, (n) => C(n).vertical)}
          options={[
            { value: 'fixed', label: t('H: Fixed') },
            { value: 'fill', label: t('H: Fill container') },
          ]}
          onChange={(v) => setC({ vertical: v })}
        />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={nodes.every((n) => C(n).absolute)} onChange={(e) => setC({ absolute: e.target.checked })} />
        {t('Ignore auto layout (absolute position)')}
      </label>
      <SizeLimits nodes={nodes} update={update} />
    </Section>
  );
}

function ConnectorSection({ editor, line }: { editor: Editor; line: SceneNode }) {
  const name = (id: string | undefined) => (id ? (editor.doc.get(id)?.name ?? t('a removed layer')) : '');
  const side = (a: string | undefined) =>
    a === 'top' ? t('top side') : a === 'right' ? t('right side') : a === 'bottom' ? t('bottom side') : a === 'left' ? t('left side') : t('nearest side');
  return (
    <Section title="Connector">
      {line.startBind && (
        <div className="bind-row">
          <span className="field-caption">
            {t('Start on “{name}”, {side}', { name: name(line.startBind.nodeId), side: side(line.startBind.anchor) })}
          </span>
          <button type="button" className="mini-btn wide" onClick={() => editor.updateNodes([line.id], (n) => ({ ...n, startBind: undefined }))}>
            {t('Detach')}
          </button>
        </div>
      )}
      {line.endBind && (
        <div className="bind-row">
          <span className="field-caption">
            {t('End on “{name}”, {side}', { name: name(line.endBind.nodeId), side: side(line.endBind.anchor) })}
          </span>
          <button type="button" className="mini-btn wide" onClick={() => editor.updateNodes([line.id], (n) => ({ ...n, endBind: undefined }))}>
            {t('Detach')}
          </button>
        </div>
      )}
    </Section>
  );
}
