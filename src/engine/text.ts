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

export function fontString(t: TextStyle): string {
  return `${t.fontWeight} ${t.fontSize}px ${fontStack(t.fontFamily)}`;
}

export function lineHeightPx(t: TextStyle): number {
  return t.lineHeight ?? Math.round(t.fontSize * 1.2 * 100) / 100;
}

export type TextLine = { text: string; width: number };
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

/**
 * Lays text out into lines. `maxWidth` null means auto width (only hard line breaks).
 * The renderer, the SVG exporter and auto-resize all use this, so they agree.
 */
export function layoutText(t: TextStyle, maxWidth: number | null, measure: Measure = canvasMeasure): TextLayout {
  const font = fontString(t);
  const lh = lineHeightPx(t);
  const width = (s: string) => (s ? measure(s, font) + t.letterSpacing * [...s].length : 0);
  const lines: TextLine[] = [];

  for (const para of t.characters.split('\n')) {
    if (maxWidth === null) {
      lines.push({ text: para, width: width(para) });
      continue;
    }
    // Greedy wrap by words; words wider than the box break between characters.
    const tokens = para.match(/\S+\s*|\s+/g) ?? [''];
    let line = '';
    for (const token of tokens) {
      const candidate = line + token;
      if (width(candidate.trimEnd()) <= maxWidth || line === '') {
        if (line === '' && width(token.trimEnd()) > maxWidth) {
          // break a long word
          let chunk = '';
          for (const ch of [...token]) {
            if (chunk && width((chunk + ch).trimEnd()) > maxWidth) {
              lines.push({ text: chunk.trimEnd(), width: width(chunk.trimEnd()) });
              chunk = '';
            }
            chunk += ch;
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        lines.push({ text: line.trimEnd(), width: width(line.trimEnd()) });
        line = token.trimStart() === '' ? '' : token;
      }
    }
    lines.push({ text: line.trimEnd(), width: width(line.trimEnd()) });
  }

  const contentWidth = Math.max(0, ...lines.map((l) => l.width));
  return {
    lines,
    width: maxWidth === null ? Math.ceil(contentWidth) : maxWidth,
    height: Math.max(1, lines.length) * lh,
    lineHeight: lh,
  };
}

/** Line x offset inside a box of width `boxWidth`. */
export function lineOffset(align: TextStyle['align'], boxWidth: number, lineWidth: number): number {
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  if (align === 'right') return boxWidth - lineWidth;
  return 0;
}
