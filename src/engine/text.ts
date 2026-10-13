import type { TextStyle } from '../../shared/schema.ts';

export const FONT_FAMILIES = ['Inter', 'IBM Plex Sans', 'IBM Plex Serif', 'Space Grotesk', 'Noto Sans KR'] as const;
export const FONT_WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semi bold' },
  { value: 700, label: 'Bold' },
] as const;

/** Korean glyphs fall back to Noto Sans KR, which ships with the app. */
export function fontStack(family: string): string {
  const safe = family.replace(/["\\]/g, '');
  return safe === 'Noto Sans KR' ? '"Noto Sans KR", sans-serif' : `"${safe}", "Noto Sans KR", sans-serif`;
}

/** Font settings for one stretch of text. */
export type ResolvedStyle = {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  italic: boolean;
  decoration: 'none' | 'underline' | 'strikethrough';
  /** Run colour, or null for the layer's fill. */
  color: string | null;
};

export function fontString(t: { fontWeight: number; fontSize: number; fontFamily: string; italic?: boolean }): string {
  return `${t.italic ? 'italic ' : ''}${t.fontWeight} ${t.fontSize}px ${fontStack(t.fontFamily)}`;
}

export function lineHeightPx(t: TextStyle): number {
  return t.lineHeight ?? Math.round(t.fontSize * 1.2 * 100) / 100;
}

export type TextSegment = { text: string; x: number; width: number; style: ResolvedStyle };
export type TextLine = {
  text: string;
  width: number;
  /** Character offsets in the whole text (end exclusive, trailing spaces left out). */
  start: number;
  end: number;
  segments: TextSegment[];
  top: number;
  height: number;
  /** Alphabetic baseline, from the top of the box. */
  baseline: number;
};
export type TextLayout = { lines: TextLine[]; width: number; height: number; lineHeight: number };

export type Measure = (text: string, font: string) => number;

let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

export const canvasMeasure: Measure = (text, font) => {
  if (!measureCtx) {
    if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) {
    // No canvas (tests, server): a rough estimate from the font size.
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return [...text].length * size * 0.5;
  }
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
};

/** The style of every character: the layer's style with its runs applied (later runs win). */
function resolveStyles(t: TextStyle): { styles: ResolvedStyle[]; at: Uint16Array | null } {
  const base: ResolvedStyle = {
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    fontSize: t.fontSize,
    italic: !!t.italic,
    decoration: t.decoration ?? 'none',
    color: null,
  };
  const runs = (t.runs ?? []).filter((r) => r.end > r.start && r.start < t.characters.length);
  if (runs.length === 0) return { styles: [base], at: null };
  const styles: ResolvedStyle[] = [base];
  const keys = new Map<string, number>([[JSON.stringify(base), 0]]);
  const at = new Uint16Array(t.characters.length);
  // walk boundaries instead of characters so long texts stay fast
  const cuts = new Set<number>([0, t.characters.length]);
  for (const r of runs) {
    cuts.add(Math.min(r.start, t.characters.length));
    cuts.add(Math.min(r.end, t.characters.length));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    let st = base;
    for (const r of runs) {
      if (r.start <= a && r.end >= b) {
        st = {
          fontFamily: r.fontFamily ?? st.fontFamily,
          fontWeight: r.fontWeight ?? st.fontWeight,
          fontSize: r.fontSize ?? st.fontSize,
          italic: r.italic ?? st.italic,
          decoration: r.decoration ?? st.decoration,
          color: r.color ?? st.color,
        };
      }
    }
    const key = JSON.stringify(st);
    let idx = keys.get(key);
    if (idx === undefined) {
      idx = styles.length;
      if (idx > 0xffff) idx = 0;
      else {
        styles.push(st);
        keys.set(key, idx);
      }
    }
    at.fill(idx, a, b);
  }
  return { styles, at };
}

/**
 * Lays text out into lines of styled segments. `maxWidth` null means auto width (only hard line
 * breaks). The renderer, the SVG exporter and auto-resize all use this, so they agree.
 */
export function layoutText(t: TextStyle, maxWidth: number | null, measure: Measure = canvasMeasure): TextLayout {
  const text = t.characters;
  const { styles, at } = resolveStyles(t);
  const styleOf = (i: number) => styles[at ? at[i] : 0];
  const fonts = styles.map((st) => fontString(st));
  const ls = t.letterSpacing;

  /** Width of text[a, b), measured piece by piece in each piece's font. */
  const rangeWidth = (a: number, b: number): number => {
    if (b <= a) return 0;
    if (!at) return measure(text.slice(a, b), fonts[0]) + ls * [...text.slice(a, b)].length;
    let w = 0;
    let i = a;
    while (i < b) {
      const s = at[i];
      let j = i + 1;
      while (j < b && at[j] === s) j++;
      const piece = text.slice(i, j);
      w += measure(piece, fonts[s]) + ls * [...piece].length;
      i = j;
    }
    return w;
  };
  const trimEnd = (a: number, b: number) => {
    while (b > a && /\s/.test(text[b - 1])) b--;
    return b;
  };

  const ranges: [number, number][] = [];
  let paraStart = 0;
  const paras = text.split('\n');
  for (const para of paras) {
    const p0 = paraStart;
    const p1 = p0 + para.length;
    paraStart = p1 + 1;
    if (maxWidth === null) {
      ranges.push([p0, p1]);
      continue;
    }
    // Greedy wrap by words; words wider than the box break between characters.
    const tokens: [number, number][] = [];
    const re = /\S+\s*|\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) tokens.push([p0 + m.index, p0 + m.index + m[0].length]);
    if (tokens.length === 0) {
      ranges.push([p0, p0]);
      continue;
    }
    let ls0 = -1; // current line start (-1 = empty line)
    let le = p0;
    for (const [a, b] of tokens) {
      if (ls0 < 0) {
        if (rangeWidth(a, trimEnd(a, b)) > maxWidth) {
          // break a long word between characters
          let c0 = a;
          for (let i = a; i < b; i++) {
            if (i > c0 && rangeWidth(c0, trimEnd(c0, i + 1)) > maxWidth) {
              ranges.push([c0, trimEnd(c0, i)]);
              c0 = i;
            }
          }
          ls0 = c0;
          le = b;
        } else {
          ls0 = a;
          le = b;
        }
      } else if (rangeWidth(ls0, trimEnd(ls0, b)) <= maxWidth) {
        le = b;
      } else {
        ranges.push([ls0, trimEnd(ls0, le)]);
        if (/^\s+$/.test(text.slice(a, b))) {
          ls0 = -1;
          le = b;
        } else if (rangeWidth(a, trimEnd(a, b)) > maxWidth) {
          let c0 = a;
          for (let i = a; i < b; i++) {
            if (i > c0 && rangeWidth(c0, trimEnd(c0, i + 1)) > maxWidth) {
              ranges.push([c0, trimEnd(c0, i)]);
              c0 = i;
            }
          }
          ls0 = c0;
          le = b;
        } else {
          ls0 = a;
          le = b;
        }
      }
    }
    ranges.push(ls0 < 0 ? [le, le] : [ls0, trimEnd(ls0, le)]);
  }

  const baseLh = lineHeightPx(t);
  const lines: TextLine[] = [];
  let top = 0;
  for (const [a, b] of ranges) {
    const segments: TextSegment[] = [];
    let x = 0;
    let maxSize = 0;
    let i = a;
    while (i < b) {
      const s = at ? at[i] : 0;
      let j = i + 1;
      while (j < b && (at ? at[j] : 0) === s) j++;
      const w = rangeWidth(i, j);
      segments.push({ text: text.slice(i, j), x, width: w, style: styles[s] });
      maxSize = Math.max(maxSize, styles[s].fontSize);
      x += w;
      i = j;
    }
    if (maxSize === 0) maxSize = (a < text.length ? styleOf(a) : styles[0]).fontSize;
    const height = t.lineHeight ?? Math.round(maxSize * 1.2 * 100) / 100;
    lines.push({ text: text.slice(a, b), width: x, start: a, end: b, segments, top, height, baseline: top + height / 2 + maxSize * 0.35 });
    top += height;
  }
  const contentWidth = Math.max(0, ...lines.map((l) => l.width));
  return {
    lines,
    width: maxWidth === null ? Math.ceil(contentWidth) : maxWidth,
    height: Math.max(top, baseLh),
    lineHeight: baseLh,
  };
}

/** Line x offset inside a box of width `boxWidth`. */
export function lineOffset(align: TextStyle['align'], boxWidth: number, lineWidth: number): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  if (align === 'right') return boxWidth - lineWidth;
  return 0;
}
