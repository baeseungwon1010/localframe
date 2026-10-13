/**
 * Embeds the bundled fonts an SVG needs, so text looks the same wherever the file is opened.
 * Reads the app's own @font-face rules (family, weight, unicode-range, file URL) and includes only
 * the subsets that cover the characters actually used.
 */

type Face = { family: string; weight: number; ranges: [number, number][] | null; url: string };

let faces: Face[] | null = null;

function parseRanges(value: string): [number, number][] | null {
  if (!value.trim()) return null;
  const out: [number, number][] = [];
  for (const part of value.split(',')) {
    const m = /U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  return out.length ? out : null;
}

function collectFaces(): Face[] {
  if (faces) return faces;
  const out: Face[] = [];
  if (typeof document === 'undefined') return out;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet (there are none, but be safe)
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const family = st.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const weight = Number.parseInt(st.getPropertyValue('font-weight'), 10) || 400;
      const src = st.getPropertyValue('src');
      const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*format\(\s*["']?([a-z0-9]+)/gi)];
      const best = urls.find((u) => u[2] === 'woff2') ?? urls[0];
      if (!family || !best) continue;
      const url = new URL(best[1], sheet.href ?? location.href).href;
      if (new URL(url).origin !== location.origin) continue; // only our own files
      out.push({ family, weight, ranges: parseRanges(st.getPropertyValue('unicode-range')), url });
    }
  }
  faces = out;
  return out;
}

const covers = (f: Face, cp: number) => !f.ranges || f.ranges.some(([a, b]) => cp >= a && cp <= b);

/** Text runs: a font stack ("Inter", "Noto Sans KR", ...), a weight and the characters drawn with it. */
export type TextRun = { stack: string[]; weight: number; text: string };

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `data:font/woff2;base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/** @font-face CSS with the font subsets the runs need, as data URLs. */
export async function embeddedFontCss(runs: TextRun[]): Promise<string> {
  const all = collectFaces();
  const needed = new Set<Face>();
  for (const run of runs) {
    for (const ch of new Set(run.text)) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0x20) continue;
      for (const family of run.stack) {
        const candidates = all.filter((f) => f.family === family && covers(f, cp));
        if (!candidates.length) continue;
        // closest weight
        candidates.sort((a, b) => Math.abs(a.weight - run.weight) - Math.abs(b.weight - run.weight));
        needed.add(candidates[0]);
        break;
      }
    }
  }
  const rules = await Promise.all(
    [...needed].map(async (f) => {
      const data = await toDataUrl(f.url);
      if (!data) return '';
      const range = f.ranges ? `unicode-range:${f.ranges.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`)).join(',')};` : '';
      return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url(${data}) format("woff2");${range}}`;
    }),
  );
  return rules.join('');
}
