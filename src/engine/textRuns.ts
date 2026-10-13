import type { TextRun, TextStyle } from '../../shared/schema.ts';

export type RunProps = Omit<TextRun, 'start' | 'end'>;
const KEYS: (keyof RunProps)[] = ['fontFamily', 'fontWeight', 'fontSize', 'color', 'italic', 'decoration'];

/** One props object per character (shared objects for equal stretches). */
function explode(runs: TextRun[] | undefined, length: number): RunProps[] {
  const out: RunProps[] = new Array(length);
  const empty: RunProps = {};
  out.fill(empty);
  for (const r of runs ?? []) {
    const props: RunProps = {};
    for (const k of KEYS) if (r[k] !== undefined) (props as Record<string, unknown>)[k] = r[k];
    for (let i = Math.max(0, r.start); i < Math.min(length, r.end); i++) out[i] = { ...out[i], ...props };
  }
  return out;
}

const sameProps = (a: RunProps, b: RunProps) => KEYS.every((k) => a[k] === b[k]);

/** Back to runs: consecutive characters with the same props become one run; empty props are dropped. */
function implode(chars: RunProps[]): TextRun[] {
  const runs: TextRun[] = [];
  let i = 0;
  while (i < chars.length) {
    let j = i + 1;
    while (j < chars.length && sameProps(chars[j], chars[i])) j++;
    if (KEYS.some((k) => chars[i][k] !== undefined)) runs.push({ start: i, end: j, ...chars[i] });
    i = j;
  }
  return runs.slice(0, 2000);
}

/** Drops run values equal to the layer's own style. */
function prune(t: TextStyle, chars: RunProps[]): RunProps[] {
  const base: RunProps = { fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, italic: t.italic ?? false, decoration: t.decoration ?? 'none' };
  return chars.map((c) => {
    let changed = false;
    const next: RunProps = { ...c };
    for (const k of KEYS) {
      if (k !== 'color' && next[k] !== undefined && next[k] === base[k]) {
        delete next[k];
        changed = true;
      }
    }
    return changed ? next : c;
  });
}

/** Applies props to text[start, end); with no range (or the whole text) it changes the layer's own style. */
export function styleRange(t: TextStyle, start: number, end: number, patch: RunProps): TextStyle {
  const len = t.characters.length;
  const a = Math.max(0, Math.min(start, len));
  const b = Math.max(a, Math.min(end, len));
  if (a === 0 && b === len) {
    // whole text: the layer's style changes, and runs stop overriding what was set
    const base: TextStyle = { ...t };
    for (const k of KEYS) {
      if (patch[k] === undefined || k === 'color') continue;
      (base as Record<string, unknown>)[k] = patch[k];
    }
    let chars = explode(t.runs, len).map((c) => {
      const next = { ...c };
      for (const k of KEYS) if (patch[k] !== undefined && k !== 'color') delete next[k];
      return next;
    });
    if (patch.color !== undefined) chars = chars.map((c) => ({ ...c, color: patch.color }));
    const runs = implode(prune(base, chars));
    return { ...base, runs: runs.length ? runs : undefined };
  }
  if (b <= a) return t;
  const chars = explode(t.runs, len);
  for (let i = a; i < b; i++) chars[i] = { ...chars[i], ...patch };
  const runs = implode(prune(t, chars));
  return { ...t, runs: runs.length ? runs : undefined };
}

/** Effective value of a prop over a range: a single value, or undefined if it differs. */
export function rangeValue<K extends keyof RunProps>(t: TextStyle, start: number, end: number, key: K): RunProps[K] | undefined | 'mixed' {
  const chars = explode(t.runs, t.characters.length);
  const base = { fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, italic: t.italic ?? false, decoration: t.decoration ?? 'none', color: undefined } as RunProps;
  let value: RunProps[K] | undefined;
  for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
    const v = chars[i][key] ?? base[key];
    if (i === Math.max(0, start)) value = v;
    else if (v !== value) return 'mixed';
  }
  return value;
}

/** Keeps runs on the same characters when the text is edited (typed text takes the style before it). */
export function adjustRuns(t: TextStyle, next: string): TextStyle {
  if (!t.runs?.length || t.characters === next) return { ...t, characters: next };
  const old = t.characters;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  const chars = explode(t.runs, old.length);
  const inserted = next.length - p - s;
  const fill = chars[p - 1] ?? chars[p] ?? {};
  const merged = [...chars.slice(0, p), ...new Array(Math.max(0, inserted)).fill(fill), ...chars.slice(old.length - s)];
  const runs = implode(merged);
  return { ...t, characters: next, runs: runs.length ? runs : undefined };
}
