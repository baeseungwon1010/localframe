import { useEffect, useState } from 'react';
import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { type BlurEffect, type Effect, type GradientPaint, type Paint, type SolidPaint, isGradientPaint } from '../../../shared/schema.ts';
import { ImagePaintRow, NumberField, PaintRow, normalizeHex } from './fields.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

type PaintKind = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'IMAGE';

const kindOf = (p: Paint): PaintKind => (p.type === undefined || p.type === 'SOLID' ? 'SOLID' : p.type);

/** CSS preview of a gradient for swatches. */
export function gradientCss(p: GradientPaint): string {
  const stops = [...p.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const r = parseInt(s.color.slice(1, 3), 16);
      const g = parseInt(s.color.slice(3, 5), 16);
      const b = parseInt(s.color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${s.opacity * p.opacity}) ${Math.round(s.position * 100)}%`;
    })
    .join(', ');
  if (p.type === 'GRADIENT_RADIAL') return `radial-gradient(circle at ${p.from.x * 100}% ${p.from.y * 100}%, ${stops})`;
  return `linear-gradient(${Math.round(angleOf(p) + 90)}deg, ${stops})`;
}

/** Angle of a linear gradient in degrees (0 = left to right, 90 = top to bottom), in the unit box. */
export function angleOf(p: GradientPaint): number {
  return (Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x) * 180) / Math.PI;
}

export function withAngle(p: GradientPaint, deg: number): GradientPaint {
  const r = (deg * Math.PI) / 180;
  const dx = Math.cos(r) / 2;
  const dy = Math.sin(r) / 2;
  return { ...p, from: { x: 0.5 - dx, y: 0.5 - dy }, to: { x: 0.5 + dx, y: 0.5 + dy } };
}

/** Converts a paint to another kind, keeping its colour where it can. */
export function convertPaint(p: Paint, kind: PaintKind): Paint | null {
  if (kind === kindOf(p) || kind === 'IMAGE') return null;
  const base = isGradientPaint(p) ? p.stops[0].color : p.type === 'IMAGE' ? '#D9D9D9' : p.color;
  if (kind === 'SOLID') return { color: base, opacity: p.opacity, visible: p.visible };
  const stops =
    p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL'
      ? p.stops
      : [
          { position: 0, color: base, opacity: 1 },
          { position: 1, color: base, opacity: 0 },
        ];
  const g: GradientPaint = { type: kind, stops, from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 }, opacity: p.opacity, visible: p.visible };
  return kind === 'GRADIENT_RADIAL' ? { ...g, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } } : g;
}

function KindSelect(props: { value: PaintKind; allowImage: boolean; label: string; onChange: (k: PaintKind) => void }) {
  return (
    <select className="select-field kind-select" aria-label={`${props.label} type`} value={props.value} onChange={(e) => props.onChange(e.target.value as PaintKind)}>
      <option value="SOLID">Solid</option>
      <option value="GRADIENT_LINEAR">Linear</option>
      <option value="GRADIENT_RADIAL">Radial</option>
      {props.allowImage && (
        <option value="IMAGE" disabled>
          Image
        </option>
      )}
    </select>
  );
}

/** One paint of a fill or stroke list: type, then the editor for that type. */
export function PaintEditor(props: { paint: Paint; label: string; allowImage: boolean; onChange: (p: Paint) => void; onRemove: () => void }) {
  const { paint, label } = props;
  const kind = kindOf(paint);
  const change = (k: PaintKind) => {
    const next = convertPaint(paint, k);
    if (next) props.onChange(next);
  };
  return (
    <div className="paint-editor">
      <KindSelect value={kind} allowImage={props.allowImage || kind === 'IMAGE'} label={label} onChange={change} />
      {paint.type === 'IMAGE' ? (
        <ImagePaintRow paint={paint} label={`${label} image`} onChange={props.onChange} onRemove={props.onRemove} />
      ) : paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' ? (
        <GradientEditor paint={paint} label={label} onChange={props.onChange} onRemove={props.onRemove} />
      ) : (
        <PaintRow paint={paint as SolidPaint} label={label} onChange={props.onChange} onRemove={props.onRemove} />
      )}
    </div>
  );
}

function GradientEditor(props: { paint: GradientPaint; label: string; onChange: (p: GradientPaint) => void; onRemove: () => void }) {
  const { paint, label } = props;
  const stops = paint.stops;
  const setStop = (i: number, patch: Partial<GradientPaint['stops'][number]>) =>
    props.onChange({ ...paint, stops: stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="gradient-editor">
      <div className="paint-row">
        <span className="swatch" style={{ background: gradientCss(paint) }} aria-hidden="true" />
        {paint.type === 'GRADIENT_LINEAR' ? (
          <NumberField
            label="∠"
            ariaLabel={`${label} angle`}
            value={Math.round(angleOf(paint))}
            min={-360}
            max={360}
            suffix="°"
            precision={0}
            onCommit={(v) => props.onChange(withAngle(paint, v))}
          />
        ) : (
          <span className="field-caption">From the centre</span>
        )}
        <NumberField
          label=""
          ariaLabel={`${label} opacity`}
          value={Math.round(paint.opacity * 100)}
          min={0}
          max={100}
          precision={0}
          suffix="%"
          onCommit={(v) => props.onChange({ ...paint, opacity: v / 100 })}
        />
        <button
          type="button"
          className="mini-btn"
          aria-label={paint.visible ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={!paint.visible}
          onClick={() => props.onChange({ ...paint, visible: !paint.visible })}
        >
          {paint.visible ? <Eye {...ICON} /> : <EyeOff {...ICON} />}
        </button>
        <button type="button" className="mini-btn" aria-label={`Remove ${label}`} onClick={props.onRemove}>
          <Minus {...ICON} />
        </button>
      </div>
      <div className="stops">
        {stops.map((s, i) => (
          <StopRow
            key={i}
            index={i}
            stop={s}
            label={`${label} stop ${i + 1}`}
            canRemove={stops.length > 2}
            onChange={(patch) => setStop(i, patch)}
            onRemove={() => props.onChange({ ...paint, stops: stops.filter((_, j) => j !== i) })}
          />
        ))}
        {stops.length < 16 && (
          <button
            type="button"
            className="mini-btn wide"
            onClick={() => {
              const sorted = [...stops].sort((a, b) => a.position - b.position);
              const a = sorted[sorted.length - 2];
              const b = sorted[sorted.length - 1];
              props.onChange({ ...paint, stops: [...stops, { position: (a.position + b.position) / 2, color: b.color, opacity: (a.opacity + b.opacity) / 2 }] });
            }}
          >
            <Plus {...ICON} /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

function StopRow(props: {
  index: number;
  stop: { position: number; color: string; opacity: number };
  label: string;
  canRemove: boolean;
  onChange: (patch: Partial<{ position: number; color: string; opacity: number }>) => void;
  onRemove: () => void;
}) {
  const { stop, label } = props;
  const [hex, setHex] = useState(stop.color.slice(1));
  useEffect(() => setHex(stop.color.slice(1)), [stop.color]);
  const commit = (v: string) => {
    const h = normalizeHex(v);
    if (h) props.onChange({ color: h });
    else setHex(stop.color.slice(1));
  };
  return (
    <div className="stop-row">
      <NumberField
        label=""
        ariaLabel={`${label} position`}
        value={Math.round(stop.position * 100)}
        min={0}
        max={100}
        precision={0}
        suffix="%"
        onCommit={(v) => props.onChange({ position: v / 100 })}
      />
      <label className="swatch" style={{ background: stop.color, opacity: Math.max(0.15, stop.opacity) }}>
        <input type="color" aria-label={`${label} colour`} value={stop.color.toLowerCase()} onChange={(e) => props.onChange({ color: e.target.value.toUpperCase() })} />
      </label>
      <input
        className="hex-input"
        aria-label={`${label} hex`}
        value={hex}
        maxLength={7}
        onChange={(e) => setHex(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        }}
      />
      <NumberField
        label=""
        ariaLabel={`${label} opacity`}
        value={Math.round(stop.opacity * 100)}
        min={0}
        max={100}
        precision={0}
        suffix="%"
        onCommit={(v) => props.onChange({ opacity: v / 100 })}
      />
      <button type="button" className="mini-btn" aria-label={`Remove ${label}`} disabled={!props.canRemove} onClick={props.onRemove}>
        <Minus {...ICON} />
      </button>
    </div>
  );
}

export const DEFAULT_SHADOW: Effect = { type: 'DROP_SHADOW', color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 4, spread: 0, visible: true };

const EFFECT_LABEL: Record<Effect['type'], string> = {
  DROP_SHADOW: 'Drop shadow',
  INNER_SHADOW: 'Inner shadow',
  LAYER_BLUR: 'Layer blur',
  BACKGROUND_BLUR: 'Background blur',
};

function convertEffect(e: Effect, type: Effect['type']): Effect {
  if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
    return e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? { ...e, type } : { ...DEFAULT_SHADOW, type, visible: e.visible } as Effect;
  }
  return { type, radius: e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR' ? e.radius : 4, visible: e.visible };
}

export function EffectEditor(props: { effect: Effect; index: number; onChange: (e: Effect) => void; onRemove: () => void }) {
  const { effect: e } = props;
  const label = `Effect ${props.index + 1}`;
  const [hex, setHex] = useState(e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? e.color.slice(1) : '');
  const color = e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? e.color : '';
  useEffect(() => setHex(color.slice(1)), [color]);
  return (
    <div className="effect-editor">
      <div className="effect-head">
        <select className="select-field" aria-label={`${label} type`} value={e.type} onChange={(ev) => props.onChange(convertEffect(e, ev.target.value as Effect['type']))}>
          {Object.entries(EFFECT_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="mini-btn"
          aria-label={e.visible ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={!e.visible}
          onClick={() => props.onChange({ ...e, visible: !e.visible })}
        >
          {e.visible ? <Eye {...ICON} /> : <EyeOff {...ICON} />}
        </button>
        <button type="button" className="mini-btn" aria-label={`Remove ${label}`} onClick={props.onRemove}>
          <Minus {...ICON} />
        </button>
      </div>
      {e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? (
        <div className="grid2">
          <NumberField label="X" ariaLabel={`${label} x offset`} value={e.x} onCommit={(v) => props.onChange({ ...e, x: v })} />
          <NumberField label="Y" ariaLabel={`${label} y offset`} value={e.y} onCommit={(v) => props.onChange({ ...e, y: v })} />
          <NumberField label="Blur" ariaLabel={`${label} blur`} value={e.blur} min={0} max={1000} onCommit={(v) => props.onChange({ ...e, blur: v })} />
          <NumberField label="Spread" ariaLabel={`${label} spread`} value={e.spread} min={-1000} max={1000} onCommit={(v) => props.onChange({ ...e, spread: v })} />
          <div className="paint-row compact">
            <label className="swatch" style={{ background: e.color }}>
              <input type="color" aria-label={`${label} colour`} value={e.color.toLowerCase()} onChange={(ev) => props.onChange({ ...e, color: ev.target.value.toUpperCase() })} />
            </label>
            <input
              className="hex-input"
              aria-label={`${label} hex`}
              value={hex}
              maxLength={7}
              onChange={(ev) => setHex(ev.target.value)}
              onBlur={(ev) => {
                const h = normalizeHex(ev.target.value);
                if (h) props.onChange({ ...e, color: h });
                else setHex(e.color.slice(1));
              }}
              onKeyDown={(ev) => ev.stopPropagation()}
            />
          </div>
          <NumberField
            label=""
            ariaLabel={`${label} opacity`}
            value={Math.round(e.opacity * 100)}
            min={0}
            max={100}
            precision={0}
            suffix="%"
            onCommit={(v) => props.onChange({ ...e, opacity: v / 100 })}
          />
        </div>
      ) : (
        <div className="grid2">
          <NumberField
            label="Blur"
            ariaLabel={`${label} radius`}
            value={(e as BlurEffect).radius}
            min={0}
            max={1000}
            onCommit={(v) => props.onChange({ ...(e as BlurEffect), radius: v })}
          />
        </div>
      )}
    </div>
  );
}
