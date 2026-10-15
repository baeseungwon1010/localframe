import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Minus } from 'lucide-react';
import type { ImagePaint, SolidPaint } from '../../../shared/schema.ts';
import { getImage } from '../../engine/images.ts';
import { t } from '../i18n.ts';

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
        placeholder={value === MIXED ? t('Mixed') : undefined}
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
          aria-label={t('{label} colour', { label })}
          value={paint.color.toLowerCase()}
          onChange={(e) => props.onChange({ ...paint, color: e.target.value.toUpperCase() })}
        />
      </label>
      <input
        className="hex-input"
        aria-label={t('{label} hex', { label })}
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
        ariaLabel={t('{label} opacity', { label })}
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
        aria-label={paint.visible ? t('Hide {label}', { label }) : t('Show {label}', { label })}
        aria-pressed={!paint.visible}
        onClick={() => props.onChange({ ...paint, visible: !paint.visible })}
      >
        {paint.visible ? <Eye size={14} strokeWidth={1.5} /> : <EyeOff size={14} strokeWidth={1.5} />}
      </button>
      <button type="button" className="mini-btn" aria-label={t('Remove {label}', { label })} onClick={props.onRemove}>
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
      <span className="swatch image-swatch" style={img ? { backgroundImage: `url(${JSON.stringify(img.src)})` } : undefined} aria-hidden="true" />
      <select
        className="select-field"
        aria-label={t('{label} fit', { label })}
        value={paint.scaleMode}
        onChange={(e) => props.onChange({ ...paint, scaleMode: e.target.value as ImagePaint['scaleMode'] })}
      >
        <option value="fill">{t('Fill')}</option>
        <option value="fit">{t('Fit')}</option>
        <option value="stretch">{t('Stretch')}</option>
        <option value="crop">{t('Crop')}</option>
        <option value="tile">{t('Tile')}</option>
      </select>
      {paint.scaleMode === 'tile' && (
        <NumberField
          label=""
          ariaLabel={t('{label} tile size', { label })}
          value={Math.round((paint.tileScale ?? 1) * 100)}
          min={1}
          max={10_000}
          precision={0}
          suffix="%"
          onCommit={(v) => props.onChange({ ...paint, tileScale: v / 100 })}
        />
      )}
      {paint.scaleMode === 'crop' && (
        <NumberField
          label=""
          ariaLabel={t('{label} zoom', { label })}
          value={Math.round((paint.crop?.scale ?? 1) * 100)}
          min={100}
          max={1000}
          precision={0}
          suffix="%"
          onCommit={(v) => props.onChange({ ...paint, crop: { x: paint.crop?.x ?? 0, y: paint.crop?.y ?? 0, scale: v / 100 } })}
        />
      )}
      <NumberField
        label=""
        ariaLabel={t('{label} opacity', { label })}
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
        aria-label={paint.visible ? t('Hide {label}', { label }) : t('Show {label}', { label })}
        aria-pressed={!paint.visible}
        onClick={() => props.onChange({ ...paint, visible: !paint.visible })}
      >
        {paint.visible ? <Eye size={14} strokeWidth={1.5} /> : <EyeOff size={14} strokeWidth={1.5} />}
      </button>
      <button type="button" className="mini-btn" aria-label={t('Remove {label}', { label })} onClick={props.onRemove}>
        <Minus size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

const FOLD_KEY = 'localframe.sectionsFolded';
/** Section title -> folded, for sections the person opened or closed themselves. */
const foldChoice: Record<string, boolean> = (() => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
})();

/**
 * A properties section; its title folds it away, and that is remembered for every layer.
 * `folded` sections (rarely needed ones) start closed until opened once.
 * `title` is the English title: it is remembered by it, and shown translated. `label` shows other
 * text instead (a title made with a layer name, already translated).
 */
export function Section(props: { title: string; label?: string; action?: ReactNode; children?: ReactNode; folded?: boolean }) {
  const shown = props.label ?? t(props.title);
  const [closed, setClosed] = useState(() => foldChoice[props.title] ?? !!props.folded);
  const toggle = () => {
    const next = !closed;
    setClosed(next);
    foldChoice[props.title] = next;
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(foldChoice));
    } catch {
      /* not remembered */
    }
  };
  return (
    <section className={`prop-section ${closed ? 'folded' : ''}`} aria-label={shown}>
      <div className="prop-head">
        <h3>
          {props.children ? (
            <button type="button" className="fold-btn" aria-expanded={!closed} aria-label={t('{title} section', { title: shown })} onClick={toggle}>
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="fold-icon" />
              {shown}
            </button>
          ) : (
            shown
          )}
        </h3>
        {/* adding something to a folded section opens it */}
        <span className="prop-actions" onClickCapture={() => closed && props.children && toggle()}>
          {props.action}
        </span>
      </div>
      {props.children && !closed && <div className="prop-body">{props.children}</div>}
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
          {t('Mixed')}
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
