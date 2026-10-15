import type { SceneNode, TextStyle } from '../../shared/schema.ts';

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
  // stamps and emoji in text use the system's colour emoji font
  const emoji = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
  return safe === 'Noto Sans KR' ? `"Noto Sans KR", ${emoji}, sans-serif` : `"${safe}", "Noto Sans KR", ${emoji}, sans-serif`;
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
  /** A link on this stretch (drawn underlined). */
  link: string | null;
  smallCaps?: boolean;
};

/** A CSS font shorthand; small caps go in it so measuring and drawing use the same glyphs. */
export function fontString(t: { fontWeight: number; fontSize: number; fontFamily: string; italic?: boolean; smallCaps?: boolean }): string {
  return `${t.italic ? 'italic ' : ''}${t.smallCaps ? 'small-caps ' : ''}${t.fontWeight} ${t.fontSize}px ${fontStack(t.fontFamily)}`;
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
  /** Space on the left for a list marker (the line is aligned in what is left). */
  indent: number;
  /** "•" or "3." on the first line of a list item. */
  marker?: string;
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
    link: null,
    ...(t.smallCaps ? { smallCaps: true } : {}),
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
          link: r.link ?? st.link,
          ...(st.smallCaps ? { smallCaps: true } : {}),
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
/** The text as shown: upper, lower or title case, one character for one (so offsets still match). */
export function displayText(t: TextStyle): string {
  if (!t.textCase) return t.characters;
  // per UTF-16 unit, keeping the length: a character whose case change would change the length stays as is
  const out: string[] = [];
  let prev = ' ';
  for (const c of t.characters) {
    let next = t.textCase === 'upper' ? c.toUpperCase() : t.textCase === 'lower' ? c.toLowerCase() : /\s/.test(prev) ? c.toUpperCase() : c;
    if (next.length !== c.length) next = c;
    out.push(next);
    prev = c;
  }
  return out.join('');
}

/**
 * Layouts already worked out, per text style object (styles are never changed in place, so a new
 * style is a new key) and width. Drawing a page lays out every text on every frame otherwise.
 * Fonts finishing loading change measurements: `forgetTextLayouts` starts over.
 */
let layoutCache = new WeakMap<TextStyle, Map<number | null, TextLayout>>();

export function forgetTextLayouts() {
  layoutCache = new WeakMap();
}

export function layoutText(t: TextStyle, maxWidth: number | null, measure: Measure = canvasMeasure): TextLayout {
  if (measure !== canvasMeasure) return computeLayout(t, maxWidth, measure);
  let byWidth = layoutCache.get(t);
  if (!byWidth) layoutCache.set(t, (byWidth = new Map()));
  let layout = byWidth.get(maxWidth);
  if (!layout) {
    if (byWidth.size > 8) byWidth.clear();
    byWidth.set(maxWidth, (layout = computeLayout(t, maxWidth, measure)));
  }
  return layout;
}

function computeLayout(t: TextStyle, maxWidth: number | null, measure: Measure): TextLayout {
  const text = displayText(t);
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

  // each range remembers its paragraph, for list markers and paragraph spacing
  const ranges: [number, number][] = [];
  const rangePara: number[] = [];
  let paraStart = 0;
  const paras = text.split('\n');
  const listIndent = t.fontSize * 1.6;
  paras.forEach((para, pi) => {
    const from = ranges.length;
    layoutPara(para, pi);
    for (let i = from; i < ranges.length; i++) rangePara.push(pi);
  });
  function layoutPara(para: string, pi: number) {
    const p0 = paraStart;
    const p1 = p0 + para.length;
    paraStart = p1 + 1;
    const indent = t.lists?.[pi] ? listIndent : 0;
    const maxW = maxWidth === null ? null : Math.max(1, maxWidth - indent);
    if (maxW === null) {
      ranges.push([p0, p1]);
      return;
    }
    const maxWidthHere = maxW;
    // Greedy wrap by words; words wider than the box break between characters.
    const tokens: [number, number][] = [];
    const re = /\S+\s*|\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) tokens.push([p0 + m.index, p0 + m.index + m[0].length]);
    if (tokens.length === 0) {
      ranges.push([p0, p0]);
      return;
    }
    let ls0 = -1; // current line start (-1 = empty line)
    let le = p0;
    for (const [a, b] of tokens) {
      if (ls0 < 0) {
        if (rangeWidth(a, trimEnd(a, b)) > maxWidthHere) {
          // break a long word between characters
          let c0 = a;
          for (let i = a; i < b; i++) {
            if (i > c0 && rangeWidth(c0, trimEnd(c0, i + 1)) > maxWidthHere) {
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
      } else if (rangeWidth(ls0, trimEnd(ls0, b)) <= maxWidthHere) {
        le = b;
      } else {
        ranges.push([ls0, trimEnd(ls0, le)]);
        if (/^\s+$/.test(text.slice(a, b))) {
          ls0 = -1;
          le = b;
        } else if (rangeWidth(a, trimEnd(a, b)) > maxWidthHere) {
          let c0 = a;
          for (let i = a; i < b; i++) {
            if (i > c0 && rangeWidth(c0, trimEnd(c0, i + 1)) > maxWidthHere) {
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

  // too many lines: keep maxLines, the last one ending in an ellipsis that fits
  if (t.maxLines && ranges.length > t.maxLines) {
    ranges.length = t.maxLines;
    rangePara.length = t.maxLines;
  }
  const truncated = !!t.maxLines && text.length > 0 && ranges.length === t.maxLines && ranges[ranges.length - 1][1] < trimEnd(0, text.length);
  if (truncated && maxWidth !== null) {
    const last = ranges[ranges.length - 1];
    const indent = t.lists?.[rangePara[rangePara.length - 1]] ? listIndent : 0;
    const ell = measure('…', fonts[at ? at[Math.max(0, last[1] - 1)] : 0]);
    while (last[1] > last[0] && rangeWidth(last[0], last[1]) + ell > maxWidth - indent) last[1]--;
    last[1] = trimEnd(last[0], last[1]);
  }

  const baseLh = lineHeightPx(t);
  const lines: TextLine[] = [];
  let top = 0;
  // list numbers count up through consecutive numbered paragraphs
  const numbers = new Map<number, number>();
  let counter = 0;
  paras.forEach((_, pi) => {
    if (t.lists?.[pi] === 'number') numbers.set(pi, ++counter);
    else counter = 0;
  });
  for (let ri = 0; ri < ranges.length; ri++) {
    const [a, b] = ranges[ri];
    const pi = rangePara[ri];
    const firstOfPara = ri === 0 || rangePara[ri - 1] !== pi;
    const lastOfPara = ri === ranges.length - 1 || rangePara[ri + 1] !== pi;
    const kind = t.lists?.[pi] ?? null;
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
    if (truncated && ri === ranges.length - 1) {
      const st = styles[at ? at[Math.max(0, b - 1)] : 0];
      const w = measure('…', fontString(st));
      segments.push({ text: '…', x, width: w, style: st });
      x += w;
    }
    if (maxSize === 0) maxSize = (a < text.length ? styleOf(a) : styles[0]).fontSize;
    const height = t.lineHeight ?? Math.round(maxSize * 1.2 * 100) / 100;
    lines.push({
      text: text.slice(a, b),
      width: x,
      start: a,
      end: b,
      segments,
      top,
      height,
      baseline: top + height / 2 + maxSize * 0.35,
      indent: kind ? listIndent : 0,
      ...(kind && firstOfPara ? { marker: kind === 'bullet' ? '•' : `${numbers.get(pi)}.` } : {}),
    });
    top += height;
    if (lastOfPara && ri < ranges.length - 1) top += t.paragraphSpacing ?? 0;
  }
  const contentWidth = Math.max(0, ...lines.map((l) => l.width + l.indent));
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

/** A font face text uses, with the characters drawn in it (so the right subsets can load). */
export type UsedFace = { family: string; weight: number; text: string };

const MAX_SAMPLE = 4000;

/**
 * The bundled faces a file's text uses (text layers, their styled runs and text in shapes), with
 * the characters each draws. Inter Regular to Bold is always included: new text starts in it.
 */
export function facesUsed(nodes: Iterable<SceneNode>): UsedFace[] {
  const out = new Map<string, UsedFace>();
  const add = (family: string, weight: number, text: string) => {
    if (!(FONT_FAMILIES as readonly string[]).includes(family)) return;
    const key = `${weight} ${family}`;
    const face = out.get(key) ?? { family, weight, text: '' };
    if (face.text.length < MAX_SAMPLE) face.text += text.slice(0, MAX_SAMPLE - face.text.length);
    out.set(key, face);
  };
  // Korean in another family is drawn by the fallback in fontStack: its subsets must load too
  const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
  const addText = (family: string, weight: number, text: string) => {
    add(family, weight, text);
    if (family !== 'Noto Sans KR' && HANGUL.test(text)) add('Noto Sans KR', weight, text);
  };
  for (const w of [400, 500, 600, 700]) add('Inter', w, 'Aa');
  for (const n of nodes) {
    for (const t of [n.text, n.label]) {
      if (!t) continue;
      addText(t.fontFamily, t.fontWeight, t.characters);
      for (const r of t.runs ?? []) addText(r.fontFamily ?? t.fontFamily, r.fontWeight ?? t.fontWeight, t.characters.slice(r.start, r.end));
    }
  }
  return [...out.values()];
}
