/**
 * SVG import: turns the text of an SVG file into layers (a frame holding groups, rectangles, ellipses,
 * lines, vectors and text). Works without the DOM: it has its own small XML reader, which never loads
 * anything external (no entities beyond the five XML ones and numeric references, no DTDs, no URLs).
 * Transforms are baked into the geometry, so every layer except lines and text has no rotation.
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import {
  type GradientPaint,
  type NodeType,
  type Paint,
  type SceneNode,
  type TextStyle,
  type VectorPoint,
  SceneNodeSchema,
} from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { type Mat, type Point, type Rect, IDENTITY, apply, boundsOfPoints, localMatrix, matRotation, multiply, normalizeDeg, round2 } from './math.ts';
import { DEFAULT_TEXT, fitText, newId } from './nodes.ts';
import { FONT_FAMILIES } from './text.ts';
import { fitVector } from './vector.ts';

export const MAX_SVG_CHARS = 5 * 1024 * 1024;
export const MAX_SVG_ELEMENTS = 10_000;
export const MAX_SVG_DEPTH = 64;
/** Points of all paths together (the schema's limit for one vector). */
export const MAX_SVG_POINTS = 50_000;
const MAX_PATH_POINTS = 10_000;
const MAX_EXTRA_PATHS = 200;
const MAX_USE_DEPTH = 8;
const MAX_CSS_RULES = 1000;
const LIMIT = 1e7;

const NOT_SVG = "This isn't an SVG file.";
const TOO_LARGE = 'This SVG is too large to import.';
const TOO_DEEP = 'This SVG is nested too deeply to import.';

// ------------------------------------------------------------------ XML

type El = { tag: string; attrs: Map<string, string>; children: (El | string)[]; parent: El | null };

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
const localName = (name: string) => (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name);

/** A small, non-validating XML reader. Throws on input that cannot be an SVG document. */
function parseXml(text: string): El {
  if (text.length > MAX_SVG_CHARS) throw new Error(TOO_LARGE);
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let root: El | null = null;
  const stack: El[] = [];
  let count = 0;
  const addText = (s: string) => {
    const top = stack[stack.length - 1];
    if (!top || !s) return;
    const last = top.children[top.children.length - 1];
    if (typeof last === 'string') top.children[top.children.length - 1] = last + s;
    else top.children.push(s);
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new Error(NOT_SVG);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error(NOT_SVG);
      addText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new Error(NOT_SVG);
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // <!DOCTYPE ...> with an optional internal subset: skipped, never interpreted
      let j = lt + 2;
      let depth = 0;
      let quote = '';
      for (; j < n; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) throw new Error(NOT_SVG);
      i = j + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end === -1) throw new Error(NOT_SVG);
      const name = localName(text.slice(lt + 2, end).trim());
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && !isSpace(text[j]) && text[j] !== '/' && text[j] !== '>') j++;
    const name = text.slice(lt + 1, j);
    if (!name) throw new Error(NOT_SVG);
    const attrs = new Map<string, string>();
    let selfClose = false;
    for (;;) {
      while (j < n && isSpace(text[j])) j++;
      if (j >= n) throw new Error(NOT_SVG);
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      const a0 = j;
      while (j < n && !isSpace(text[j]) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j++;
      const attr = text.slice(a0, j);
      if (!attr) {
        j++; // a stray '/'
        continue;
      }
      while (j < n && isSpace(text[j])) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < n && isSpace(text[j])) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, j + 1);
          if (end === -1) throw new Error(NOT_SVG);
          value = text.slice(j + 1, end);
          j = end + 1;
        } else {
          const v0 = j;
          while (j < n && !isSpace(text[j]) && text[j] !== '>') j++;
          value = text.slice(v0, j);
        }
      }
      if (!attrs.has(attr)) attrs.set(attr, decodeEntities(value));
    }
    i = j;
    if (++count > MAX_SVG_ELEMENTS) throw new Error(TOO_LARGE);
    const parent = stack[stack.length - 1] ?? null;
    const el: El = { tag: localName(name), attrs, children: [], parent };
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else continue; // a second root element: ignored
    if (!selfClose) {
      stack.push(el);
      if (stack.length > MAX_SVG_DEPTH) throw new Error(TOO_DEEP);
    }
  }
  if (!root || root.tag !== 'svg') throw new Error(NOT_SVG);
  return root;
}

// ------------------------------------------------------------------ numbers, lengths, transforms

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function numbers(s: string | undefined): number[] {
  if (!s) return [];
  const out: number[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16, ex: 8 };

/** A length in px; `ref` resolves percentages. Null when missing or not a length. */
function length(s: string | undefined, ref = 100): number | null {
  if (s === undefined) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(%|[a-zA-Z]+)?\s*$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '') return v;
  if (unit === '%') return (v / 100) * ref;
  const k = UNITS[unit];
  return k === undefined ? null : v * k;
}

const firstOf = (s: string | undefined) => (s === undefined ? undefined : s.trim().split(/[\s,]+/)[0]);

export function parseTransform(s: string | undefined): Mat {
  let m: Mat = IDENTITY;
  if (!s) return m;
  for (const part of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = numbers(part[2]);
    let t: Mat | null = null;
    switch (part[1]) {
      case 'matrix':
        if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        if (a.length >= 1) t = [1, 0, 0, 1, a[0], a[1] ?? 0];
        break;
      case 'scale':
        if (a.length >= 1) t = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
        break;
      case 'rotate':
        if (a.length >= 1) {
          const r = (a[0] * Math.PI) / 180;
          const c = Math.cos(r);
          const sn = Math.sin(r);
          const cx = a[1] ?? 0;
          const cy = a[2] ?? 0;
          t = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
        }
        break;
      case 'skewX':
        if (a.length >= 1) t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        if (a.length >= 1) t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (t) m = multiply(m, t);
  }
  return m;
}

/** Maps a viewBox onto a w × h viewport (preserveAspectRatio: align and meet/slice, or none). */
function viewBoxMatrix(vb: number[], w: number, h: number, par: string | undefined): Mat {
  const [vx, vy, vw, vh] = vb;
  const sx = w / vw;
  const sy = h / vh;
  const words = (par ?? '').trim().split(/\s+/);
  const align = words[0] === 'defer' ? (words[1] ?? '') : words[0];
  const slice = words.includes('slice');
  if (align === 'none') return [sx, 0, 0, sy, -vx * sx, -vy * sy];
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const ax = /xMin/.test(align) ? 0 : /xMax/.test(align) ? 1 : 0.5;
  const ay = /YMin/.test(align) ? 0 : /YMax/.test(align) ? 1 : 0.5;
  return [s, 0, 0, s, (w - vw * s) * ax - vx * s, (h - vh * s) * ay - vy * s];
}

function parseViewBox(s: string | undefined): number[] | null {
  const v = numbers(s);
  return v.length === 4 && v[2] > 0 && v[3] > 0 ? v : null;
}

const avgScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

// ------------------------------------------------------------------ colours

const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  (
    'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 ' +
    'blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 ' +
    'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b ' +
    'darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b ' +
    'darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a ' +
    'darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 ' +
    'darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff ' +
    'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 ' +
    'goldenrod daa520 gray 808080 grey 808080 green 008000 greenyellow adff2f honeydew f0fff0 hotpink ff69b4 ' +
    'indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 ' +
    'lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 ' +
    'lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa ' +
    'lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 ' +
    'linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 ' +
    'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc ' +
    'mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead ' +
    'navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 ' +
    'palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 ' +
    'peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 ' +
    'rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 ' +
    'seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 ' +
    'snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 ' +
    'turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'
  )
    .match(/\S+ \S+/g)!
    .map((pair) => {
      const [name, hex] = pair.split(' ');
      return [name, `#${hex.toUpperCase()}`];
    }),
);

type Rgba = { color: string; alpha: number };
const BLACK: Rgba = { color: '#000000', alpha: 1 };

const hex2 = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A CSS colour; 'none' for none, null when it isn't one. `current` is what currentColor means. */
export function parseColor(raw: string, current: Rgba = BLACK): Rgba | 'none' | null {
  const v = raw.trim().toLowerCase();
  if (v === 'none') return 'none';
  if (v === 'transparent') return { color: '#000000', alpha: 0 };
  if (v === 'currentcolor') return current;
  if (v[0] === '#') {
    const h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const c = [...h].map((x) => x + x).join('');
      return { color: `#${c.slice(0, 6).toUpperCase()}`, alpha: h.length === 4 ? parseInt(c.slice(6), 16) / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) return { color: `#${h.slice(0, 6).toUpperCase()}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p: string, pctScale: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * pctScale : parseFloat(p));
    const alpha = parts[3] !== undefined ? clamp01(num(parts[3], 1)) : 1;
    let rgb: [number, number, number];
    if (fn[1].startsWith('rgb')) rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
    else rgb = hslToRgb(parseFloat(parts[0]), clamp01(num(parts[1], 1) / (parts[1].endsWith('%') ? 1 : 100)), clamp01(num(parts[2], 1) / (parts[2].endsWith('%') ? 1 : 100)));
    if (rgb.some((c) => !Number.isFinite(c))) return null;
    return { color: `#${rgb.map(hex2).join('')}`, alpha };
  }
  const named = Object.hasOwn(NAMED_COLORS, v) ? NAMED_COLORS[v] : undefined;
  return named ? { color: named, alpha: 1 } : null;
}

// ------------------------------------------------------------------ styles

type Style = Record<string, string>;
const INHERITED = [
  'fill',
  'stroke',
  'stroke-width',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'visibility',
  'color',
];
const PROPS = new Set([...INHERITED, 'opacity', 'display', 'stop-color', 'stop-opacity']);

function parseDecls(s: string): Style {
  const out: Style = {};
  for (const decl of s.split(';')) {
    const c = decl.indexOf(':');
    if (c < 0) continue;
    const prop = decl.slice(0, c).trim().toLowerCase();
    if (!PROPS.has(prop)) continue;
    out[prop] = decl
      .slice(c + 1)
      .replace(/!\s*important/i, '')
      .trim();
  }
  return out;
}

type Compound = { tag: string | null; id: string | null; classes: string[] };
type Rule = { chain: Compound[]; spec: number; idx: number; decls: Style };

function parseSelector(sel: string): { chain: Compound[]; spec: number } | null {
  const parts = sel.replace(/>/g, ' ').trim().split(/\s+/);
  const chain: Compound[] = [];
  let spec = 0;
  for (const p of parts) {
    if (p === '*') {
      chain.push({ tag: null, id: null, classes: [] });
      continue;
    }
    const m = /^([A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(p);
    if (!m || p === '') return null;
    const c: Compound = { tag: m[1] ?? null, id: null, classes: [] };
    if (c.tag) spec += 1;
    for (const s of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (s[0] === '#') {
        c.id = s.slice(1);
        spec += 100;
      } else {
        c.classes.push(s.slice(1));
        spec += 10;
      }
    }
    chain.push(c);
  }
  return chain.length ? { chain, spec } : null;
}

/** Rules of the <style> blocks (simple selectors: tag, .class, #id, compounds and descendants). */
function parseCss(css: string, rules: Rule[]) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < s.length && rules.length < MAX_CSS_RULES) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const selector = s.slice(i, open).trim();
    if (selector.startsWith('@')) {
      // @media, @font-face, ...: skip the whole block
      let depth = 0;
      let j = open;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    const close = s.indexOf('}', open);
    if (close < 0) break;
    const decls = parseDecls(s.slice(open + 1, close));
    for (const one of selector.split(',')) {
      const parsed = parseSelector(one);
      if (parsed && rules.length < MAX_CSS_RULES) rules.push({ ...parsed, idx: rules.length, decls });
    }
    i = close + 1;
  }
}

function matchCompound(el: El, c: Compound): boolean {
  if (c.tag !== null && el.tag !== c.tag) return false;
  if (c.id !== null && el.attrs.get('id') !== c.id) return false;
  if (c.classes.length) {
    const list = (el.attrs.get('class') ?? '').split(/\s+/);
    if (!c.classes.every((k) => list.includes(k))) return false;
  }
  return true;
}

function matchRule(el: El, chain: Compound[]): boolean {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let cur = el.parent;
  for (let k = chain.length - 2; k >= 0; k--) {
    while (cur && !matchCompound(cur, chain[k])) cur = cur.parent;
    if (!cur) return false;
    cur = cur.parent;
  }
  return true;
}

// ------------------------------------------------------------------ paths

type SubPath = { closed: boolean; points: VectorPoint[] };

/** Builds paths from moveTo / lineTo / curveTo / arcTo / close, in the element's own coordinates. */
function pathBuilder() {
  const paths: SubPath[] = [];
  let sub: SubPath | null = null;
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  const finish = () => {
    if (sub && sub.points.length >= 2) paths.push(sub);
    sub = null;
  };
  const ensure = (): SubPath => {
    if (!sub) sub = { closed: false, points: [{ x: cur.x, y: cur.y }] };
    return sub;
  };
  const b = {
    paths,
    get cur() {
      return cur;
    },
    moveTo(p: Point) {
      finish();
      sub = { closed: false, points: [{ x: p.x, y: p.y }] };
      cur = start = p;
    },
    lineTo(p: Point) {
      ensure().points.push({ x: p.x, y: p.y });
      cur = p;
    },
    cubicTo(c1: Point, c2: Point, p: Point) {
      const s = ensure();
      s.points[s.points.length - 1].out = { x: c1.x, y: c1.y };
      s.points.push({ x: p.x, y: p.y, in: { x: c2.x, y: c2.y } });
      cur = p;
    },
    arcTo(rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Point) {
      const curves = arcToCubics(cur, rx, ry, phiDeg, large, sweep, p);
      if (curves === null) b.lineTo(p);
      else for (const [c1, c2, q] of curves) b.cubicTo(c1, c2, q);
      cur = p;
    },
    close() {
      if (sub) {
        const pts = sub.points;
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (pts.length > 1 && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
          if (last.in) first.in = last.in;
          pts.pop();
        }
        sub.closed = true;
        if (pts.length >= 2) paths.push(sub);
        sub = null;
      }
      cur = start;
    },
    end() {
      finish();
      return paths;
    },
  };
  return b;
}
type PathBuilder = ReturnType<typeof pathBuilder>;

/** An SVG arc as cubic curves (null: draw a straight line; []: nothing to draw). */
export function arcToCubics(p1: Point, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p2: Point): [Point, Point, Point][] | null {
  if (p1.x === p2.x && p1.y === p2.y) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return null;
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p1.x - p2.x) / 2;
  const dy = (p1.y - p2.y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (p1.x + p2.x) / 2;
  const cy = sin * cxp + cos * cyp + (p1.y + p2.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let delta = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segs;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (t: number): Point => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const deriv = (t: number): Point => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  const out: [Point, Point, Point][] = [];
  for (let s = 0; s < segs; s++) {
    const t1 = theta1 + s * step;
    const t2 = t1 + step;
    const a = at(t1);
    const e = s === segs - 1 ? p2 : at(t2);
    const d1 = deriv(t1);
    const d2 = deriv(t2);
    out.push([{ x: a.x + k * d1.x, y: a.y + k * d1.y }, { x: e.x - k * d2.x, y: e.y - k * d2.y }, e]);
  }
  return out;
}

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7 };

/** Path data (the full grammar) into paths; stops at the first error, like browsers do. */
export function parsePathData(d: string): SubPath[] {
  const b = pathBuilder();
  const n = d.length;
  let i = 0;
  const skip = () => {
    while (i < n && (isSpace(d[i]) || d[i] === ',')) i++;
  };
  const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const readNum = (): number | null => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) return null;
    i += m[0].length;
    return v;
  };
  const readFlag = (): number | null => {
    skip();
    if (d[i] === '0' || d[i] === '1') return Number(d[i++]);
    return null;
  };
  let cmd = '';
  let started = false;
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  outer: while (true) {
    skip();
    if (i >= n) break;
    let letter: string;
    const c = d[i];
    if (/[A-Za-z]/.test(c)) {
      if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) break;
      letter = c;
      i++;
    } else {
      if (!cmd || cmd === 'Z' || cmd === 'z') break;
      letter = cmd === 'M' ? 'L' : cmd === 'm' ? 'l' : cmd;
    }
    if (!started && letter !== 'M' && letter !== 'm') break;
    started = true;
    cmd = letter;
    const lower = letter.toLowerCase();
    if (lower === 'z') {
      b.close();
      lastCubic = lastQuad = null;
      continue;
    }
    const args: number[] = [];
    for (let k = 0; k < ARGS[lower]; k++) {
      const v = lower === 'a' && (k === 3 || k === 4) ? readFlag() : readNum();
      if (v === null) break outer;
      args.push(v);
    }
    const rel = letter !== letter.toUpperCase();
    const o = b.cur;
    const P = (x: number, y: number): Point => (rel ? { x: o.x + x, y: o.y + y } : { x, y });
    let cubicCtrl: Point | null = null;
    let quadCtrl: Point | null = null;
    switch (lower) {
      case 'm':
        b.moveTo(P(args[0], args[1]));
        break;
      case 'l':
        b.lineTo(P(args[0], args[1]));
        break;
      case 'h':
        b.lineTo({ x: rel ? o.x + args[0] : args[0], y: o.y });
        break;
      case 'v':
        b.lineTo({ x: o.x, y: rel ? o.y + args[0] : args[0] });
        break;
      case 'c': {
        const c2 = P(args[2], args[3]);
        b.cubicTo(P(args[0], args[1]), c2, P(args[4], args[5]));
        cubicCtrl = c2;
        break;
      }
      case 's': {
        const c1 = lastCubic ? { x: 2 * o.x - lastCubic.x, y: 2 * o.y - lastCubic.y } : o;
        const c2 = P(args[0], args[1]);
        b.cubicTo(c1, c2, P(args[2], args[3]));
        cubicCtrl = c2;
        break;
      }
      case 'q':
      case 't': {
        const q: Point = lower === 'q' ? P(args[0], args[1]) : lastQuad ? { x: 2 * o.x - lastQuad.x, y: 2 * o.y - lastQuad.y } : o;
        const p = lower === 'q' ? P(args[2], args[3]) : P(args[0], args[1]);
        b.cubicTo({ x: o.x + (2 / 3) * (q.x - o.x), y: o.y + (2 / 3) * (q.y - o.y) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
        quadCtrl = q;
        break;
      }
      case 'a':
        b.arcTo(args[0], args[1], args[2], args[3] === 1, args[4] === 1, P(args[5], args[6]));
        break;
    }
    lastCubic = cubicCtrl;
    lastQuad = quadCtrl;
  }
  return b.end();
}

function rectPath(b: PathBuilder, x: number, y: number, w: number, h: number, rx: number, ry: number) {
  if (rx <= 0 || ry <= 0) {
    b.moveTo({ x, y });
    b.lineTo({ x: x + w, y });
    b.lineTo({ x: x + w, y: y + h });
    b.lineTo({ x, y: y + h });
    b.close();
    return;
  }
  b.moveTo({ x: x + rx, y });
  b.lineTo({ x: x + w - rx, y });
  b.arcTo(rx, ry, 0, false, true, { x: x + w, y: y + ry });
  b.lineTo({ x: x + w, y: y + h - ry });
  b.arcTo(rx, ry, 0, false, true, { x: x + w - rx, y: y + h });
  b.lineTo({ x: x + rx, y: y + h });
  b.arcTo(rx, ry, 0, false, true, { x, y: y + h - ry });
  b.lineTo({ x, y: y + ry });
  b.arcTo(rx, ry, 0, false, true, { x: x + rx, y });
  b.close();
}

function ellipsePath(b: PathBuilder, cx: number, cy: number, rx: number, ry: number) {
  b.moveTo({ x: cx + rx, y: cy });
  b.arcTo(rx, ry, 0, false, true, { x: cx, y: cy + ry });
  b.arcTo(rx, ry, 0, false, true, { x: cx - rx, y: cy });
  b.arcTo(rx, ry, 0, false, true, { x: cx, y: cy - ry });
  b.arcTo(rx, ry, 0, false, true, { x: cx + rx, y: cy });
  b.close();
}

function transformPaths(paths: SubPath[], m: Mat): SubPath[] {
  const f = (p: Point) => apply(m, p);
  return paths.map((s) => ({
    closed: s.closed,
    points: s.points.map((p) => ({ ...f(p), ...(p.in ? { in: f(p.in) } : {}), ...(p.out ? { out: f(p.out) } : {}) })),
  }));
}

// ------------------------------------------------------------------ the drawing, as an intermediate tree

type PaintSpec = { kind: 'solid'; color: string; opacity: number } | { kind: 'gradient'; el: El; ctm: Mat; opacity: number; fallback: string };
type Look = {
  fill: PaintSpec | null;
  stroke: PaintSpec | null;
  strokeWeight: number;
  cap: 'none' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  dash: number[];
  opacity: number;
};
type Item =
  | { kind: 'group'; name: string; opacity: number; children: Item[] }
  | { kind: 'rect'; name: string; look: Look; box: Rect; radius: number }
  | { kind: 'ellipse'; name: string; look: Look; box: Rect }
  | { kind: 'line'; name: string; look: Look; a: Point; b: Point }
  | { kind: 'vector'; name: string; look: Look; paths: SubPath[]; fillRule: 'nonzero' | 'evenodd' }
  /** origin: the box's top-left in the element's own coordinates, before the text-anchor shift. */
  | { kind: 'text'; name: string; look: Look; text: TextStyle; origin: Point; anchor: number; m: Mat };

type Ctx = {
  ids: Map<string, El>;
  /** Rules by the key their last compound needs ('#id', '.class', a tag, or '*'). */
  rules: Map<string, Rule[]>;
  vw: number;
  vh: number;
  items: number;
  points: number;
  useStack: El[];
};

const SKIP = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'filter',
  'linearGradient',
  'radialGradient',
  'style',
  'script',
  'foreignObject',
  'image',
  'title',
  'desc',
  'metadata',
]);

function computeStyle(el: El, parent: Style, ctx: Ctx): Style {
  const declared: Style = {};
  for (const [k, v] of el.attrs) if (PROPS.has(k)) declared[k] = v.trim();
  if (ctx.rules.size) {
    const keys = ['*', el.tag];
    const id = el.attrs.get('id');
    if (id) keys.push(`#${id}`);
    for (const c of (el.attrs.get('class') ?? '').split(/\s+/)) if (c) keys.push(`.${c}`);
    const found = new Set<Rule>();
    for (const k of keys) for (const r of ctx.rules.get(k) ?? []) if (!found.has(r) && matchRule(el, r.chain)) found.add(r);
    for (const r of [...found].sort((a, b) => a.spec - b.spec || a.idx - b.idx)) Object.assign(declared, r.decls);
  }
  const inline = el.attrs.get('style');
  if (inline) Object.assign(declared, parseDecls(inline));
  const out: Style = {};
  for (const k of INHERITED) if (parent[k] !== undefined) out[k] = parent[k];
  for (const [k, v] of Object.entries(declared)) {
    if (v === 'inherit') {
      if (parent[k] !== undefined) out[k] = parent[k];
      else delete out[k];
    } else out[k] = v;
  }
  return out;
}

const num = (s: string | undefined, fallback: number) => {
  const v = length(s);
  return v === null ? fallback : v;
};
const opacityOf = (s: string | undefined) => {
  if (s === undefined) return 1;
  const v = s.trim().endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(v) ? clamp01(v) : 1;
};

function nameOf(el: El, fallback: string): string {
  const id = el.attrs.get('id')?.trim();
  return id ? id.slice(0, 500) : fallback;
}

function paintSpec(value: string | undefined, isFill: boolean, style: Style, ctm: Mat, ctx: Ctx, extraOpacity: number): PaintSpec | null {
  const v = (value ?? (isFill ? 'black' : 'none')).trim();
  const current = parseColor(style.color ?? 'black');
  const currentRgba = current && current !== 'none' ? current : BLACK;
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(v);
  if (url) {
    const target = ctx.ids.get(url[1]);
    const fallback = url[2] ? parseColor(url[2], currentRgba) : 'none';
    if (target && (target.tag === 'linearGradient' || target.tag === 'radialGradient')) {
      const fb = fallback && fallback !== 'none' ? fallback.color : '#000000';
      return { kind: 'gradient', el: target, ctm, opacity: extraOpacity, fallback: fb };
    }
    if (!fallback || fallback === 'none') return null;
    return { kind: 'solid', color: fallback.color, opacity: clamp01(fallback.alpha * extraOpacity) };
  }
  const c = parseColor(v, currentRgba);
  if (c === 'none') return null;
  const rgba = c ?? (isFill ? BLACK : null);
  if (!rgba) return null;
  return { kind: 'solid', color: rgba.color, opacity: clamp01(rgba.alpha * extraOpacity) };
}

function lookOf(style: Style, m: Mat, ctx: Ctx): Look {
  const s = avgScale(m);
  const fill = paintSpec(style.fill, true, style, m, ctx, opacityOf(style['fill-opacity']));
  let stroke = paintSpec(style.stroke, false, style, m, ctx, opacityOf(style['stroke-opacity']));
  const width = Math.max(0, num(style['stroke-width'], 1)) * s;
  if (width <= 0) stroke = null;
  const capRaw = style['stroke-linecap'];
  const joinRaw = style['stroke-linejoin'];
  let dash = numbers(style['stroke-dasharray'])
    .map((d) => d * s)
    .filter((d) => d >= 0);
  if (dash.length % 2 === 1) dash = [...dash, ...dash];
  if (dash.every((d) => d === 0)) dash = [];
  return {
    fill,
    stroke,
    strokeWeight: Math.min(1000, round2(width)),
    cap: capRaw === 'round' ? 'round' : capRaw === 'square' ? 'square' : 'none',
    join: joinRaw === 'round' ? 'round' : joinRaw === 'bevel' ? 'bevel' : 'miter',
    dash: dash.slice(0, 8).map((d) => Math.min(1000, round2(d))),
    opacity: opacityOf(style.opacity),
  };
}

const visible = (look: Look) => look.fill !== null || look.stroke !== null;
/** Translate + positive scale only: native rectangles and ellipses stay native. */
const axisAligned = (m: Mat) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0;

function countPoints(paths: SubPath[], ctx: Ctx) {
  if (paths.length > MAX_EXTRA_PATHS + 1) throw new Error(TOO_LARGE);
  for (const p of paths) {
    if (p.points.length > MAX_PATH_POINTS) throw new Error(TOO_LARGE);
    ctx.points += p.points.length;
  }
  if (ctx.points > MAX_SVG_POINTS) throw new Error(TOO_LARGE);
}

function vectorItem(el: El, look: Look, paths: SubPath[], m: Mat, style: Style, ctx: Ctx, fallback = 'Vector'): Item | null {
  if (!paths.length) return null;
  const out = transformPaths(paths, m);
  countPoints(out, ctx);
  return { kind: 'vector', name: nameOf(el, fallback), look, paths: out, fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero' };
}

function walkChildren(el: El, m: Mat, style: Style, ctx: Ctx, depth: number): Item[] {
  const out: Item[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    const item = walk(c, m, style, ctx, depth);
    if (item) out.push(item);
  }
  return out;
}

function groupOf(el: El, children: Item[], style: Style): Item | null {
  if (!children.length) return null;
  return { kind: 'group', name: nameOf(el, 'Group'), opacity: opacityOf(style.opacity), children };
}

function textOf(el: El, style: Style, ctx: Ctx): string {
  const lines = [''];
  const visit = (node: El, st: Style, d: number) => {
    for (const c of node.children) {
      if (typeof c === 'string') {
        lines[lines.length - 1] += c;
        continue;
      }
      if (d > MAX_SVG_DEPTH || !['tspan', 'textPath', 'a'].includes(c.tag)) continue;
      const cs = computeStyle(c, st, ctx);
      if (cs.display === 'none') continue;
      const dy = numbers(c.attrs.get('dy'))[0];
      if ((c.attrs.has('y') || (dy !== undefined && dy !== 0)) && lines[lines.length - 1].trim() !== '') lines.push('');
      visit(c, cs, d + 1);
    }
  };
  visit(el, style, 0);
  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 100_000);
}

const FAMILY_BY_LOWER = new Map(FONT_FAMILIES.map((f) => [f.toLowerCase(), f as string]));

function fontFamilyOf(s: string | undefined): string {
  for (const part of (s ?? '').split(',')) {
    const f = FAMILY_BY_LOWER.get(part.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
    if (f) return f;
  }
  return 'Inter';
}

function fontWeightOf(s: string | undefined): number {
  const v = (s ?? '').trim().toLowerCase();
  if (v === 'bold' || v === 'bolder') return 700;
  if (v === 'lighter') return 300;
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return 400;
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

function textItem(el: El, m: Mat, style: Style, ctx: Ctx): Item | null {
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return null;
  const characters = textOf(el, style, ctx);
  if (!characters) return null;
  const firstSpan = el.children.find((c): c is El => typeof c !== 'string' && c.tag === 'tspan');
  const x = numbers(el.attrs.get('x') ?? firstSpan?.attrs.get('x'))[0] ?? 0;
  const y = numbers(el.attrs.get('y') ?? firstSpan?.attrs.get('y'))[0] ?? 0;
  const dx = numbers(el.attrs.get('dx'))[0] ?? 0;
  const dy = numbers(el.attrs.get('dy'))[0] ?? 0;
  const s = avgScale(m) || 1;
  const sizeLocal = Math.max(0.01, num(firstOf(style['font-size']), 16));
  const fontSize = Math.min(2000, Math.max(1, round2(sizeLocal * s)));
  const text: TextStyle = {
    ...DEFAULT_TEXT,
    characters,
    fontFamily: fontFamilyOf(style['font-family']),
    fontWeight: fontWeightOf(style['font-weight']),
    fontSize,
    ...(style['font-style'] === 'italic' || style['font-style'] === 'oblique' ? { italic: true } : {}),
  };
  const look = lookOf(style, m, ctx);
  const anchor = style['text-anchor'] === 'middle' ? 0.5 : style['text-anchor'] === 'end' ? 1 : 0;
  return {
    kind: 'text',
    name: nameOf(el, characters.split('\n')[0].slice(0, 60) || 'Text'),
    look,
    text,
    origin: { x: x + dx, y: y + dy - 0.8 * sizeLocal },
    anchor,
    m,
  };
}

function walk(el: El, ctm: Mat, parentStyle: Style, ctx: Ctx, depth: number, viaUse = false): Item | null {
  if (depth > MAX_SVG_DEPTH * 2) throw new Error(TOO_DEEP);
  if (SKIP.has(el.tag) && !(viaUse && el.tag === 'symbol')) return null;
  if (++ctx.items > MAX_SVG_ELEMENTS) throw new Error(TOO_LARGE);
  const style = computeStyle(el, parentStyle, ctx);
  if (style.display === 'none') return null;
  const a = el.attrs;
  const m = multiply(ctm, parseTransform(a.get('transform')));
  const hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
  const L = (k: string, ref: number, fallback = 0) => {
    const v = length(a.get(k), ref);
    return v === null ? fallback : v;
  };
  const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
  switch (el.tag) {
    case 'g':
    case 'a':
    case 'switch':
      return groupOf(el, walkChildren(el, m, style, ctx, depth + 1), style);
    case 'svg':
    case 'symbol': {
      // nested viewport: x/y then its viewBox (no clipping)
      const w = L('width', ctx.vw, ctx.vw);
      const h = L('height', ctx.vh, ctx.vh);
      let inner = el.tag === 'svg' ? multiply(m, [1, 0, 0, 1, L('x', ctx.vw), L('y', ctx.vh)]) : m;
      const vb = parseViewBox(a.get('viewBox'));
      if (vb && w > 0 && h > 0) inner = multiply(inner, viewBoxMatrix(vb, w, h, a.get('preserveAspectRatio')));
      return groupOf(el, walkChildren(el, inner, style, ctx, depth + 1), style);
    }
    case 'use': {
      const href = (a.get('href') ?? a.get('xlink:href') ?? '').trim();
      if (!href.startsWith('#') || ctx.useStack.length >= MAX_USE_DEPTH) return null;
      const target = ctx.ids.get(href.slice(1));
      if (!target || ctx.useStack.includes(target)) return null;
      for (let p = el.parent; p; p = p.parent) if (p === target) return null;
      let inner = multiply(m, [1, 0, 0, 1, L('x', ctx.vw), L('y', ctx.vh)]);
      if (target.tag === 'symbol') {
        const vb = parseViewBox(target.attrs.get('viewBox'));
        const w = length(a.get('width'), ctx.vw) ?? length(target.attrs.get('width'), ctx.vw);
        const h = length(a.get('height'), ctx.vh) ?? length(target.attrs.get('height'), ctx.vh);
        if (vb && w && h && w > 0 && h > 0) inner = multiply(inner, viewBoxMatrix(vb, w, h, target.attrs.get('preserveAspectRatio')));
      }
      ctx.useStack.push(target);
      let item: Item | null;
      try {
        if (target.tag === 'symbol') {
          const symStyle = computeStyle(target, style, ctx);
          item = groupOf(target, walkChildren(target, inner, symStyle, ctx, depth + 1), symStyle);
        } else item = walk(target, inner, style, ctx, depth + 1, true);
      } finally {
        ctx.useStack.pop();
      }
      if (!item) return null;
      const opacity = opacityOf(style.opacity);
      const named = { ...item, name: nameOf(el, item.name) };
      if (opacity === 1) return named;
      if (named.kind === 'group') return { ...named, opacity: named.opacity * opacity };
      return { kind: 'group', name: named.name, opacity, children: [item] };
    }
    case 'text':
      return textItem(el, m, style, ctx);
  }
  // shapes
  if (hidden) return null;
  const look = lookOf(style, m, ctx);
  if (!visible(look)) return null;
  switch (el.tag) {
    case 'rect': {
      const x = L('x', ctx.vw);
      const y = L('y', ctx.vh);
      const w = L('width', ctx.vw);
      const h = L('height', ctx.vh);
      if (!(w > 0 && h > 0)) return null;
      let rx = length(a.get('rx'), ctx.vw);
      let ry = length(a.get('ry'), ctx.vh);
      if (rx === null || rx < 0) rx = ry !== null && ry >= 0 ? ry : 0;
      if (ry === null || ry < 0) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (axisAligned(m)) {
        const tl = apply(m, { x, y });
        return {
          kind: 'rect',
          name: nameOf(el, 'Rectangle'),
          look,
          box: { x: tl.x, y: tl.y, width: w * m[0], height: h * m[3] },
          radius: Math.min(rx * m[0], ry * m[3]),
        };
      }
      const b = pathBuilder();
      rectPath(b, x, y, w, h, rx, ry);
      return vectorItem(el, look, b.end(), m, style, ctx, 'Rectangle');
    }
    case 'circle':
    case 'ellipse': {
      const cx = L('cx', ctx.vw);
      const cy = L('cy', ctx.vh);
      let rx: number;
      let ry: number;
      if (el.tag === 'circle') rx = ry = L('r', diag);
      else {
        const rxa = length(a.get('rx'), ctx.vw);
        const rya = length(a.get('ry'), ctx.vh);
        rx = rxa ?? rya ?? 0;
        ry = rya ?? rxa ?? 0;
      }
      if (!(rx > 0 && ry > 0)) return null;
      if (axisAligned(m)) {
        const tl = apply(m, { x: cx - rx, y: cy - ry });
        return { kind: 'ellipse', name: nameOf(el, 'Ellipse'), look, box: { x: tl.x, y: tl.y, width: 2 * rx * m[0], height: 2 * ry * m[3] } };
      }
      const b = pathBuilder();
      ellipsePath(b, cx, cy, rx, ry);
      return vectorItem(el, look, b.end(), m, style, ctx, 'Ellipse');
    }
    case 'line': {
      if (!look.stroke) return null;
      const p1 = apply(m, { x: L('x1', ctx.vw), y: L('y1', ctx.vh) });
      const p2 = apply(m, { x: L('x2', ctx.vw), y: L('y2', ctx.vh) });
      if (p1.x === p2.x && p1.y === p2.y) return null;
      return { kind: 'line', name: nameOf(el, 'Line'), look: { ...look, fill: null }, a: p1, b: p2 };
    }
    case 'polyline':
    case 'polygon': {
      const v = numbers(a.get('points'));
      if (v.length < 4) return null;
      const b = pathBuilder();
      b.moveTo({ x: v[0], y: v[1] });
      for (let k = 2; k + 1 < v.length; k += 2) b.lineTo({ x: v[k], y: v[k + 1] });
      if (el.tag === 'polygon') b.close();
      return vectorItem(el, look, b.end(), m, style, ctx, el.tag === 'polygon' ? 'Polygon' : 'Vector');
    }
    case 'path':
      return vectorItem(el, look, parsePathData(a.get('d') ?? ''), m, style, ctx);
  }
  return null;
}

// ------------------------------------------------------------------ gradients

function gradientPaint(spec: Extract<PaintSpec, { kind: 'gradient' }>, box: Rect, ctx: Ctx): Paint | null {
  // attributes and stops can come from the gradients it links to
  const chain: El[] = [];
  for (let g: El | undefined = spec.el; g && chain.length < 8 && !chain.includes(g); ) {
    chain.push(g);
    const href: string = (g.attrs.get('href') ?? g.attrs.get('xlink:href') ?? '').trim();
    const next: El | undefined = href.startsWith('#') ? ctx.ids.get(href.slice(1)) : undefined;
    g = next && (next.tag === 'linearGradient' || next.tag === 'radialGradient') ? next : undefined;
  }
  const attr = (k: string) => {
    for (const g of chain) {
      const v = g.attrs.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const stopEls = chain.map((g) => g.children.filter((c): c is El => typeof c !== 'string' && c.tag === 'stop')).find((s) => s.length) ?? [];
  const stops: GradientPaint['stops'] = [];
  let last = 0;
  for (const s of stopEls) {
    const st = computeStyle(s, {}, ctx);
    const off = s.attrs.get('offset') ?? '0';
    let pos = off.trim().endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
    pos = Math.max(last, clamp01(Number.isFinite(pos) ? pos : 0));
    last = pos;
    const c = parseColor(st['stop-color'] ?? 'black');
    const rgba = c && c !== 'none' ? c : BLACK;
    stops.push({ position: round2(pos * 1000) / 1000, color: rgba.color, opacity: clamp01(rgba.alpha * opacityOf(st['stop-opacity'])) });
  }
  if (stops.length === 0) return null;
  if (stops.length === 1) return { color: stops[0].color, opacity: clamp01(stops[0].opacity * spec.opacity), visible: true };
  const kept = stops.length > 16 ? [...stops.slice(0, 15), stops[stops.length - 1]] : stops;
  const userSpace = attr('gradientUnits') === 'userSpaceOnUse';
  const g = parseTransform(attr('gradientTransform'));
  const coord = (k: string, def: string, ref: number) => {
    const v = attr(k) ?? def;
    if (userSpace) return length(v, ref) ?? 0;
    const t = v.trim();
    return t.endsWith('%') ? parseFloat(t) / 100 : (length(t) ?? 0);
  };
  const radial = spec.el.tag === 'radialGradient';
  let p1: Point;
  let p2: Point;
  if (radial) {
    const cx = coord('cx', '50%', ctx.vw);
    const cy = coord('cy', '50%', ctx.vh);
    const r = coord('r', '50%', Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2));
    p1 = { x: cx, y: cy };
    p2 = { x: cx + r, y: cy };
  } else {
    p1 = { x: coord('x1', '0%', ctx.vw), y: coord('y1', '0%', ctx.vh) };
    p2 = { x: coord('x2', '100%', ctx.vw), y: coord('y2', '0%', ctx.vh) };
  }
  const toUnit = (p: Point): Point => {
    let q = apply(g, p);
    if (userSpace) {
      q = apply(spec.ctm, q);
      q = { x: (q.x - box.x) / (box.width || 1), y: (q.y - box.y) / (box.height || 1) };
    }
    const c = (v: number) => Math.min(10, Math.max(-10, Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : 0));
    return { x: c(q.x), y: c(q.y) };
  };
  return {
    type: radial ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
    stops: kept,
    from: toUnit(p1),
    to: toUnit(p2),
    opacity: clamp01(spec.opacity),
    visible: true,
  };
}

function resolvePaint(spec: PaintSpec | null, box: Rect, ctx: Ctx): Paint[] {
  if (!spec) return [];
  if (spec.kind === 'solid') return [{ color: spec.color, opacity: spec.opacity, visible: true }];
  const p = gradientPaint(spec, box, ctx);
  return p ? [p] : [];
}

const strokePaints = (spec: PaintSpec | null, box: Rect, ctx: Ctx) =>
  resolvePaint(spec, box, ctx).filter((p): p is Exclude<Paint, { type: 'IMAGE' }> => p.type !== 'IMAGE');

// ------------------------------------------------------------------ layers

function baseNode(type: NodeType, name: string, parentId: string | null, box: Rect, opacity = 1): SceneNode {
  return {
    id: newId(),
    type,
    parentId,
    order: 'a0',
    name: name || 'Layer',
    visible: true,
    locked: false,
    opacity: clamp01(opacity),
    x: round2(box.x),
    y: round2(box.y),
    width: Math.max(0, round2(box.width)),
    height: Math.max(0, round2(box.height)),
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'center',
    strokeDash: [],
  };
}

function withLook(n: SceneNode, look: Look, box: Rect, ctx: Ctx): SceneNode {
  const strokes = strokePaints(look.stroke, box, ctx);
  return {
    ...n,
    opacity: look.opacity,
    fills: resolvePaint(look.fill, box, ctx),
    strokes,
    strokeWeight: strokes.length ? look.strokeWeight : 1,
    strokeAlign: 'center',
    strokeDash: strokes.length ? look.dash : [],
    strokeCap: look.cap,
    strokeJoin: look.join,
  };
}

/** Corners of a layer's box in its parent's coordinates (lines: their two ends). */
function cornersOf(n: SceneNode): Point[] {
  const m = localMatrix(n.x, n.y, n.rotation);
  const pts = n.type === 'LINE' ? [{ x: 0, y: 0 }, { x: n.width, y: 0 }] : [{ x: 0, y: 0 }, { x: n.width, y: 0 }, { x: n.width, y: n.height }, { x: 0, y: n.height }];
  return pts.map((p) => apply(m, p));
}

/** The item as layers whose positions are all in the frame's coordinates; the item's own layer comes first. */
function emit(item: Item, parentId: string | null, ctx: Ctx): SceneNode[] {
  switch (item.kind) {
    case 'group': {
      const g = baseNode('GROUP', item.name, parentId, { x: 0, y: 0, width: 0, height: 0 }, item.opacity);
      const kids = item.children.map((c) => emit(c, g.id, ctx));
      const keys = generateNKeysBetween(null, null, kids.length);
      kids.forEach((k, i) => (k[0] = { ...k[0], order: keys[i] }));
      const b = boundsOfPoints(kids.flatMap((k) => cornersOf(k[0])));
      return [{ ...g, x: round2(b.x), y: round2(b.y), width: Math.max(0.01, round2(b.width)), height: Math.max(0.01, round2(b.height)) }, ...kids.flat()];
    }
    case 'rect': {
      const n = baseNode('RECTANGLE', item.name, parentId, item.box);
      const r = round2(Math.max(0, item.radius));
      return [withLook({ ...n, radii: [r, r, r, r] }, item.look, item.box, ctx)];
    }
    case 'ellipse':
      return [withLook(baseNode('ELLIPSE', item.name, parentId, item.box), item.look, item.box, ctx)];
    case 'line': {
      const len = Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y);
      const rotation = round2(normalizeDeg((Math.atan2(item.b.y - item.a.y, item.b.x - item.a.x) * 180) / Math.PI));
      const n: SceneNode = {
        ...baseNode('LINE', item.name, parentId, { x: item.a.x, y: item.a.y, width: len, height: 0 }),
        rotation,
        arrowStart: false,
        arrowEnd: false,
      };
      return [withLook(n, item.look, boundsOfPoints([item.a, item.b]), ctx)];
    }
    case 'vector': {
      const [main, ...extra] = item.paths;
      const raw: SceneNode = {
        ...baseNode('VECTOR', item.name, parentId, { x: 0, y: 0, width: 0, height: 0 }),
        vector: {
          closed: main.closed,
          points: main.points,
          ...(extra.length ? { extra } : {}),
          ...(item.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}),
        },
      };
      const n = fitVector(raw);
      return [withLook(n, item.look, { x: n.x, y: n.y, width: n.width, height: n.height }, ctx)];
    }
    case 'text': {
      const { m, anchor } = item;
      let n = fitText({ ...baseNode('TEXT', item.name, parentId, { x: 0, y: 0, width: 1, height: 1 }), text: item.text });
      const s = avgScale(m) || 1;
      const origin = apply(m, { x: item.origin.x - anchor * (n.width / s), y: item.origin.y });
      n = { ...n, x: round2(origin.x), y: round2(origin.y), rotation: round2(normalizeDeg(matRotation(m))) };
      return [withLook(n, item.look, { x: n.x, y: n.y, width: n.width, height: n.height }, ctx)];
    }
  }
}

function checkBounds(nodes: SceneNode[]) {
  const ok = (v: number) => Math.abs(v) <= LIMIT;
  for (const n of nodes) {
    if (![n.x, n.y, n.width, n.height].every(ok)) throw new Error(TOO_LARGE);
    if (n.vector) for (const path of [n.vector, ...(n.vector.extra ?? [])]) for (const p of path.points) {
      if (!ok(p.x) || !ok(p.y) || (p.in && !(ok(p.in.x) && ok(p.in.y))) || (p.out && !(ok(p.out.x) && ok(p.out.y)))) throw new Error(TOO_LARGE);
    }
  }
}

/**
 * Reads an SVG file into new layers: one frame named `opts.name` (top-left at `opts.at`, in the
 * parent's coordinates) holding the drawing. The layers are not added to `doc`; the frame goes on
 * top of `opts.parentId`'s children. Throws an Error with a readable message on bad or huge input.
 */
export function importSvg(doc: SceneDoc, text: string, opts: { parentId: string | null; at: { x: number; y: number }; name: string }): SceneNode[] {
  if (typeof text !== 'string' || !/^\s*(﻿)?\s*</.test(text.slice(0, 1024))) throw new Error(NOT_SVG);
  const root = parseXml(text);
  // ids and style sheets of the whole document
  const ids = new Map<string, El>();
  const rules: Rule[] = [];
  const stack: El[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const id = el.attrs.get('id');
    if (id && !ids.has(id)) ids.set(id, el);
    if (el.tag === 'style') parseCss(el.children.filter((c) => typeof c === 'string').join(''), rules);
    for (let k = el.children.length - 1; k >= 0; k--) {
      const c = el.children[k];
      if (typeof c !== 'string') stack.push(c);
    }
  }
  const byKey = new Map<string, Rule[]>();
  for (const r of rules) {
    const last = r.chain[r.chain.length - 1];
    const key = last.id !== null ? `#${last.id}` : last.classes.length ? `.${last.classes[0]}` : (last.tag ?? '*');
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }

  const vb = parseViewBox(root.attrs.get('viewBox'));
  const pct = (k: string) => (root.attrs.get(k) ?? '').trim().endsWith('%');
  let w = pct('width') ? null : length(root.attrs.get('width'));
  let h = pct('height') ? null : length(root.attrs.get('height'));
  if (w !== null && w <= 0) w = null;
  if (h !== null && h <= 0) h = null;
  if (vb) {
    if (w === null && h === null) [w, h] = [vb[2], vb[3]];
    else if (w === null) w = (h! * vb[2]) / vb[3];
    else if (h === null) h = (w * vb[3]) / vb[2];
  }
  if ((w !== null && w > 1e6) || (h !== null && h > 1e6)) throw new Error(TOO_LARGE);
  const vw = vb ? vb[2] : (w ?? 300);
  const vh = vb ? vb[3] : (h ?? 150);
  const ctx: Ctx = { ids, rules: byKey, vw, vh, items: 0, points: 0, useStack: [] };
  const m = vb && w !== null && h !== null ? viewBoxMatrix(vb, w, h, root.attrs.get('preserveAspectRatio')) : IDENTITY;
  const rootStyle = computeStyle(root, {}, ctx);
  const items = walkChildren(root, m, rootStyle, ctx, 1);

  const frame = baseNode('FRAME', opts.name.trim().slice(0, 500) || 'SVG', opts.parentId, { x: 0, y: 0, width: 0, height: 0 }, opacityOf(rootStyle.opacity));
  const kids = items.map((it) => emit(it, frame.id, ctx));
  const keys = generateNKeysBetween(null, null, kids.length);
  kids.forEach((k, i) => (k[0] = { ...k[0], order: keys[i] }));
  const all = kids.flat();
  checkBounds(all);
  if (w === null || h === null) {
    // no size given: the frame fits the drawing (from the origin)
    const b = boundsOfPoints(kids.flatMap((k) => cornersOf(k[0])));
    w ??= Math.max(1, b.x + b.width);
    h ??= Math.max(1, b.y + b.height);
  }
  // positions relative to each layer's parent (groups have no rotation; the frame's origin is 0, 0)
  const abs = new Map(all.map((n) => [n.id, { x: n.x, y: n.y }]));
  const placed = all.map((n) => {
    const p = n.parentId === frame.id ? null : abs.get(n.parentId!);
    return p ? { ...n, x: round2(n.x - p.x), y: round2(n.y - p.y) } : n;
  });
  const siblings = doc.children(opts.parentId);
  const top = siblings.length ? (doc.get(siblings[siblings.length - 1])?.order ?? null) : null;
  const root2: SceneNode = {
    ...frame,
    order: generateKeyBetween(top, null),
    x: round2(opts.at.x),
    y: round2(opts.at.y),
    width: Math.max(0.01, round2(Math.min(LIMIT, w))),
    height: Math.max(0.01, round2(Math.min(LIMIT, h))),
    radii: [0, 0, 0, 0],
    clipsContent: false,
    ...(opts.parentId === null ? { pageId: doc.currentPage } : {}),
  };
  const out = [root2, ...placed];
  for (const n of out) if (!SceneNodeSchema.safeParse(n).success) throw new Error('This SVG could not be imported.');
  return out;
}
