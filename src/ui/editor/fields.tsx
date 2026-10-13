import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Minus } from 'lucide-react';
import type { ImagePaint, SolidPaint } from '../../../shared/schema.ts';
import { getImage } from '../../engine/images.ts';

export const MIXED = Symbol('mixed');
export type Maybe<T> = T | typeof MIXED;

export function common<T, V>(items: T[], get: (t: T) => V): Maybe<V> {
  if (items.length === 0) return MIXED;
  const first = get(items[0]);
  const key = JSON.stringify(first);
  return items.every((it) => JSON.stringify(get(it)) === key) ? first : MIXED;
}

/** Evaluates simple arithmetic typed into a number field ("120/2", "+8" relative to the current value). */
export function evalNumber(input: string, current: number | null): number | null {
  const s = input.trim().replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/');
  if (!s) return null;
  if (!/^[-+*/]?[\d.\s+\-*/()]+$/.test(s)) return null;
  let expr = s;
  if (/^[+*/]/.test(s) && current !== null) expr = `${current}${s}`;
  let pos = 0;
  const peek = () => expr[pos];
  const skip = () => {
    while (expr[pos] === ' ') pos++;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+' || c === '-') {
        pos++;
        const r = parseTerm();
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*' || c === '/') {
        pos++;
        const r = parseFactor();
        v = c === '*' ? v * r : v / r;
      } else return v;
    }
  };
  const parseFactor = (): number => {
    skip();
    const c = peek();
    if (c === '-') {
      pos++;
      return -parseFactor();
    }
    if (c === '(') {
      pos++;
      const v = parseExpr();
      skip();
      if (peek() !== ')') throw new Error('paren');
      pos++;
      return v;
    }
    const m = /^\d*\.?\d+|^\d+\./.exec(expr.slice(pos));
    if (!m) throw new Error('number');
    pos += m[0].length;
    return Number(m[0]);
  };
  try {
    const v = parseExpr();
    skip();
    if (pos !== expr.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

const fmt = (v: number, precision = 2) => {
  const r = Math.round(v * 10 ** precision) / 10 ** precision;
  return Object.is(r, -0) ? '0' : String(r);
};

export function NumberField(props: {
  label: ReactNode;
  ariaLabel: string;
  value: Maybe<number>;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  precision?: number;
  disabled?: boolean;
}) {
  const { value, min = -1e7, max = 1e7, step = 1, precision = 2 } = props;
  const shown = value === MIXED ? '' : fmt(value, precision);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  const scrub = useRef<{ x: number; v: number } | null>(null);

  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);

  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (raw: string) => {
    const v = evalNumber(raw, value === MIXED ? null : value);
    if (v === null) {
      if (raw.trim() !== '' && raw !== shown) {
        setInvalid(true);
        setTimeout(() => setInvalid(false), 300);
      }
      setText(shown);
      return;
    }
    const c = clampV(v);
    setText(fmt(c, precision));
    if (value === MIXED || Math.abs(c - value) > 1e-9) props.onCommit(c);
  };

  return (
    <label className={`num-field ${invalid ? 'invalid' : ''} ${props.disabled ? 'disabled' : ''}`}>
      <span
        className="num-label"
        onPointerDown={(e) => {
          if (props.disabled || value === MIXED) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, v: value };
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return;
          const d = Math.round((e.clientX - scrub.current.x) / 2) * step * (e.shiftKey ? 10 : 1);
          setText(fmt(clampV(scrub.current.v + d), precision));
        }}
        onPointerUp={(e) => {
          if (!scrub.current) return;
          const d = Math.round((e.clientX - scrub.current.x) / 2) * step * (e.shiftKey ? 10 : 1);
          scrub.current = null;
          if (d !== 0) props.onCommit(clampV((value as number) + d));
        }}
      >
        {props.label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={props.ariaLabel}
        value={text}
        placeholder={value === MIXED ? 'Mixed' : undefined}
        disabled={props.disabled}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).select();
          } else if (e.key === 'Escape') {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== MIXED) {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const next = clampV(value + d);
            setText(fmt(next, precision));
            props.onCommit(next);
          }
        }}
      />
      {props.suffix && <span className="num-suffix">{props.suffix}</span>}
    </label>
  );
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHex(input: string): string | null {
  const m = HEX.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}

export function PaintRow(props: {
  paint: SolidPaint;
  label: string;
  onChange: (p: SolidPaint) => void;
  onRemove: () => void;
}) {
  const { paint, label } = props;
  const [hex, setHex] = useState(paint.color.slice(1));
  useEffect(() => setHex(paint.color.slice(1)), [paint.color]);
  const commitHex = (v: string) => {
    const h = normalizeHex(v);
    if (h) props.onChange({ ...paint, color: h });
    else setHex(paint.color.slice(1));
  };
  return (
    <div className={`paint-row ${paint.visible ? '' : 'hidden-paint'}`}>
      <label className="swatch" style={{ background: paint.color, opacity: paint.visible ? 1 : 0.4 }}>
        <input
          type="color"
          aria-label={`${label} colour`}
          value={paint.color.toLowerCase()}
          onChange={(e) => props.onChange({ ...paint, color: e.target.value.toUpperCase() })}
        />
      </label>
      <input
        className="hex-input"
        aria-label={`${label} hex`}
        value={hex}
        maxLength={7}
        onChange={(e) => setHex(e.target.value)}
        onBlur={(e) => commitHex(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value);
        }}
      />
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
        {paint.visible ? <Eye size={14} strokeWidth={1.5} /> : <EyeOff size={14} strokeWidth={1.5} />}
      </button>
      <button type="button" className="mini-btn" aria-label={`Remove ${label}`} onClick={props.onRemove}>
        <Minus size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** An image fill: preview, how it fits the shape, opacity, visibility. */
export function ImagePaintRow(props: { paint: ImagePaint; label: string; onChange: (p: ImagePaint) => void; onRemove: () => void }) {
  const { paint, label } = props;
  const img = getImage(paint.imageId);
  return (
    <div className={`paint-row image-row ${paint.visible ? '' : 'hidden-paint'}`}>
      <span className="swatch image-swatch" style={img ? { backgroundImage: `url(${img.src})` } : undefined} aria-hidden="true" />
      <select
        className="select-field"
        aria-label={`${label} fit`}
        value={paint.scaleMode}
        onChange={(e) => props.onChange({ ...paint, scaleMode: e.target.value as ImagePaint['scaleMode'] })}
      >
        <option value="fill">Fill</option>
        <option value="fit">Fit</option>
        <option value="stretch">Stretch</option>
      </select>
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
        {paint.visible ? <Eye size={14} strokeWidth={1.5} /> : <EyeOff size={14} strokeWidth={1.5} />}
      </button>
      <button type="button" className="mini-btn" aria-label={`Remove ${label}`} onClick={props.onRemove}>
        <Minus size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function Section(props: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="prop-section" aria-label={props.title}>
      <div className="prop-head">
        <h3>{props.title}</h3>
        {props.action}
      </div>
      {props.children && <div className="prop-body">{props.children}</div>}
    </section>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  value: Maybe<T>;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          aria-label={o.label}
          data-tip={o.label}
          className={props.value === o.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </div>
  );
}

export function SelectField<T extends string | number>(props: {
  label: string;
  value: Maybe<T>;
  options: { value: T; label: string; style?: React.CSSProperties }[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      className="select-field"
      aria-label={props.label}
      value={props.value === MIXED ? '__mixed' : String(props.value)}
      onChange={(e) => {
        const opt = props.options.find((o) => String(o.value) === e.target.value);
        if (opt) props.onChange(opt.value);
      }}
    >
      {props.value === MIXED && (
        <option value="__mixed" disabled>
          Mixed
        </option>
      )}
      {props.options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} style={o.style}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
