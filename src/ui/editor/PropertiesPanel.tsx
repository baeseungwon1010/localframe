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
  ArrowLeft,
  ArrowRight,
  Link2,
  Link2Off,
  Plus,
  RotateCw,
  Scan,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
} from 'lucide-react';
import type { Constraints, Paint, SceneNode, TextStyle } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { exportPng, exportSvg } from '../../engine/export.ts';
import { solid, TYPE_LABEL } from '../../engine/nodes.ts';
import { FONT_FAMILIES, FONT_WEIGHTS, fontStack } from '../../engine/text.ts';
import { IconButton } from '../components.tsx';
import { downloadBlob, safeFileName } from '../download.ts';
import { useEditorRev } from '../hooks.ts';
import { MIXED, NumberField, PaintRow, Section, Segmented, SelectField, common, normalizeHex } from './fields.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

function uniformRadius(nodes: SceneNode[]) {
  const r = common(nodes, (n) => n.radii ?? [0, 0, 0, 0]);
  if (r === MIXED) return MIXED;
  return r.every((v) => v === r[0]) ? r[0] : MIXED;
}

export function PropertiesPanel(props: { editor: Editor; fileName: string; onBackground: (c: string) => void }) {
  const { editor } = props;
  useEditorRev(editor, 'doc', 'selection');
  const sel = editor.selectedNodes();

  return (
    <aside className="props" aria-label="Properties">
      {sel.length === 0 ? (
        <PageProps editor={editor} fileName={props.fileName} onBackground={props.onBackground} />
      ) : (
        <SelectionProps editor={editor} nodes={sel} />
      )}
    </aside>
  );
}

function PageProps(props: { editor: Editor; fileName: string; onBackground: (c: string) => void }) {
  const { editor } = props;
  const [hex, setHex] = useState(editor.background.slice(1));
  const commit = (v: string) => {
    const h = normalizeHex(v);
    if (h) props.onBackground(h);
    else setHex(editor.background.slice(1));
  };
  return (
    <>
      <div className="panel-title">Page</div>
      <Section title="Background">
        <div className="paint-row simple">
          <label className="swatch" style={{ background: editor.background }}>
            <input
              type="color"
              aria-label="Background colour"
              value={editor.background.toLowerCase()}
              onChange={(e) => {
                setHex(e.target.value.slice(1).toUpperCase());
                props.onBackground(e.target.value.toUpperCase());
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
      <ExportSection editor={editor} ids={editor.doc.children(null).filter((id) => editor.doc.get(id)!.visible)} name={props.fileName} pageBackground />
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
  const hasRadius = nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME');
  const allFrames = allType('FRAME');
  const constrained = nodes.every((n) => n.parentId !== null && editor.doc.get(n.parentId)?.type === 'FRAME');
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

      {hasRadius && (
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
        </div>
      </Section>

      {allText && <TextSection nodes={nodes} update={update} />}

      <PaintsSection
        title="Fill"
        nodes={nodes}
        get={(n) => n.fills}
        set={(n, p) => ({ ...n, fills: p })}
        defaultPaint={allText ? solid('#1B1D21') : solid('#D9D9D9')}
        update={update}
        hidden={allLines}
      />
      <PaintsSection
        title="Stroke"
        nodes={nodes}
        get={(n) => n.strokes}
        set={(n, p) => ({ ...n, strokes: p })}
        defaultPaint={solid('#1B1D21')}
        update={update}
        hidden={allText}
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
          </div>
        )}
      </PaintsSection>

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

function TextSection({ nodes, update }: { nodes: SceneNode[]; update: (fn: (n: SceneNode) => SceneNode) => void }) {
  const t = (n: SceneNode) => n.text!;
  const setText = (patch: Partial<TextStyle>) => update((n) => ({ ...n, text: { ...n.text!, ...patch } }));
  return (
    <Section title="Text">
      <SelectField
        label="Font"
        value={common(nodes, (n) => t(n).fontFamily)}
        options={FONT_FAMILIES.map((f) => ({ value: f, label: f, style: { fontFamily: fontStack(f) } }))}
        onChange={(v) => setText({ fontFamily: v })}
      />
      <div className="grid2">
        <SelectField
          label="Font weight"
          value={common(nodes, (n) => t(n).fontWeight)}
          options={FONT_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
          onChange={(v) => setText({ fontWeight: v })}
        />
        <NumberField label="Size" ariaLabel="Font size" value={common(nodes, (n) => t(n).fontSize)} min={1} max={2000} onCommit={(v) => setText({ fontSize: v })} />
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
        <IconButton label={`Add ${label}`} onClick={paints === MIXED ? () => update((n) => set(n, [props.defaultPaint])) : add}>
          <Plus {...ICON} />
        </IconButton>
      }
    >
      {paints === MIXED ? (
        <p className="field-caption">Mixed. Click + to replace them with one {label}.</p>
      ) : (
        paints.map((p, i) => (
          <PaintRow
            key={i}
            paint={p}
            label={paints.length > 1 ? `${props.title} ${i + 1}` : props.title}
            onChange={(next) => update((n) => set(n, get(n).map((q, j) => (j === i ? next : q))))}
            onRemove={() => update((n) => set(n, get(n).filter((_, j) => j !== i)))}
          />
        ))
      )}
      {(paints === MIXED || paints.length > 0) && props.children}
    </Section>
  );
}

function ExportSection(props: { editor: Editor; ids: string[]; name: string; pageBackground: boolean }) {
  const { editor, ids } = props;
  const [format, setFormat] = useState<'png' | 'svg'>('png');
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
      if (format === 'png') downloadBlob(await exportPng(editor.doc, target, scale), `${base}${scale === 1 ? '' : `@${scale}x`}.png`);
      else downloadBlob(new Blob([exportSvg(editor.doc, target)], { type: 'image/svg+xml' }), `${base}.svg`);
      setMessage(`Exported ${base}.${format}`);
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
        <SelectField
          label="Export format"
          value={format}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'svg', label: 'SVG' },
          ]}
          onChange={(v) => setFormat(v)}
        />
      </div>
      <button type="button" className="btn secondary full" disabled={empty || busy} onClick={run}>
        {empty ? 'Nothing to export yet' : `Export ${props.pageBackground ? 'page' : props.name}`}
      </button>
      {message && (
        <p className="field-caption" role="status">
          {message}
        </p>
      )}
    </Section>
  );
}
