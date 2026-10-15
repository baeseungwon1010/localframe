import type { SceneNode, TextStyle } from '../../shared/schema.ts';
import { linePoints } from './geometry.ts';
import type { Point } from './math.ts';
import { layoutText } from './text.ts';

/** Shapes and lines that can hold text. */
export const canHaveLabel = (n: SceneNode) =>
  n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'LINE' || (n.type === 'VECTOR' && (!!n.shape || !!n.vector?.closed));

/** The style a new label starts with. */
export function defaultLabel(n: SceneNode): TextStyle {
  return {
    characters: '',
    fontFamily: 'Inter',
    fontWeight: n.sticky ? 400 : 500,
    fontSize: n.sticky ? 18 : n.type === 'LINE' ? 13 : 16,
    lineHeight: null,
    letterSpacing: 0,
    align: n.sticky ? 'left' : 'center',
    autoResize: 'height',
  };
}

/** How much of a shape's width text may use (the middle of a diamond or ellipse is narrower). */
function widthFactor(n: SceneNode): number {
  if (n.type === 'ELLIPSE') return 0.72;
  switch (n.shape?.kind) {
    case 'diamond':
      return 0.55;
    case 'polygon':
    case 'star':
      return 0.6;
    case 'parallelogram':
    case 'chevron':
      return 0.7;
    default:
      return 1;
  }
}

const LINE_LABEL_MAX = 200;

/** The point halfway along a line's path, in its own coordinates. */
export function lineMidpoint(n: SceneNode): Point {
  const pts = linePoints(n);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return pts[pts.length - 1];
}

/**
 * A layer's label as a text layer in the layer's own coordinates (null if it has none): wrapped
 * inside the shape and centred in it, starting top-left on sticky notes, or centred on the middle
 * of a connector. The canvas, SVG export and the text editor all place it from this.
 */
export function labelNode(n: SceneNode, characters = n.label?.characters ?? ''): SceneNode | null {
  if (!n.label || !canHaveLabel(n)) return null;
  const t: TextStyle = { ...n.label, characters };
  const color = n.labelColor ?? '#1E1E1E';
  const base = {
    id: `${n.id}~label`,
    type: 'TEXT' as const,
    parentId: n.id,
    order: 'a0',
    name: 'Label',
    visible: true,
    locked: false,
    opacity: 1,
    rotation: 0,
    fills: [{ color, opacity: 1, visible: true }],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside' as const,
    strokeDash: [],
  };
  if (n.type === 'LINE') {
    const natural = layoutText({ ...t, characters: characters || ' ' }, null);
    const width = Math.min(LINE_LABEL_MAX, natural.width + 1);
    const layout = layoutText({ ...t, characters: characters || ' ' }, width);
    const mid = lineMidpoint(n);
    return { ...base, x: mid.x - width / 2, y: mid.y - layout.height / 2, width, height: layout.height, text: { ...t, autoResize: 'height' } };
  }
  const pad = n.sticky ? 16 : 8;
  const full = Math.max(1, n.width - pad * 2);
  // narrow shapes keep text in their middle, but never so narrow that a word breaks in two
  const longest =
    widthFactor(n) < 1
      ? Math.max(0, ...(characters || ' ').split(/\s+/).slice(0, 200).map((w) => layoutText({ ...t, characters: w || ' ' }, null).width + 1))
      : 0;
  const width = Math.min(full, Math.max(n.width * widthFactor(n) - pad * 2, longest, 1));
  const layout = layoutText({ ...t, characters: characters || ' ' }, width);
  // a chevron's body sits right of its notch
  const shift = n.shape?.kind === 'chevron' ? Math.min(n.width * 0.25, n.height / 2) / 2 : 0;
  const x = (n.width - width) / 2 + shift;
  const y = n.sticky ? pad : (n.height - layout.height) / 2;
  return { ...base, x, y, width, height: layout.height, text: { ...t, autoResize: 'height' } };
}
