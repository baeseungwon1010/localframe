import type { SceneNode, TextRun } from '../../shared/schema.ts';
import { canHaveLabel, defaultLabel, heightForLabel } from './labels.ts';

/**
 * Colours for diagrams, in the spirit of FigJam: soft fills with an outline of the same hue, and
 * a stronger tint for sticky notes. Text stays near-black on all of them.
 */
export const DIAGRAM_COLORS = [
  { id: 'grey', name: 'Grey', fill: '#F2F2F0', stroke: '#9D9D98', sticky: '#E6E6E3' },
  { id: 'blue', name: 'Blue', fill: '#E3EEFF', stroke: '#5B8DEF', sticky: '#C7DDFF' },
  { id: 'violet', name: 'Violet', fill: '#EDE7FF', stroke: '#8C76E8', sticky: '#D9CCFF' },
  { id: 'pink', name: 'Pink', fill: '#FDE6F2', stroke: '#DB67A6', sticky: '#FFCCE6' },
  { id: 'red', name: 'Red', fill: '#FFE5E3', stroke: '#E0605B', sticky: '#FFC7C2' },
  { id: 'orange', name: 'Orange', fill: '#FFEBDC', stroke: '#EC8A45', sticky: '#FFD3AD' },
  { id: 'yellow', name: 'Yellow', fill: '#FFF5CC', stroke: '#D9A92B', sticky: '#FFE8A3' },
  { id: 'green', name: 'Green', fill: '#E2F6E8', stroke: '#45AE6E', sticky: '#C3EBCF' },
] as const;

export type DiagramColor = (typeof DIAGRAM_COLORS)[number];

export const DIAGRAM_TEXT = '#1E1E1E';
export const CONNECTOR_COLOR = '#5F6368';
export const DEFAULT_SHAPE_COLOR = DIAGRAM_COLORS[1];
export const DEFAULT_STICKY_COLOR = DIAGRAM_COLORS[6];

const solid = (color: string) => ({ color, opacity: 1, visible: true });

/** Is this layer part of a diagram (it gets the colour bar)? */
export function isDiagramItem(n: SceneNode): boolean {
  if (n.sticky) return true;
  // polygons and stars are design shapes, unless they hold text (a drawn triangle on a board)
  if (n.type === 'VECTOR' && n.shape && ((n.shape.kind !== 'polygon' && n.shape.kind !== 'star') || n.label !== undefined)) return true;
  if (n.type === 'LINE') return !!(n.startBind || n.endBind || n.label);
  // boxes from the diagram tools carry a (possibly empty) text
  return (n.type === 'RECTANGLE' || n.type === 'ELLIPSE') && n.label !== undefined;
}

/** A diagram item in one of the colours: shapes get fill and outline, stickies their tint, connectors their line. */
export function withDiagramColor(n: SceneNode, c: DiagramColor): SceneNode {
  if (n.type === 'LINE') return { ...n, strokes: [solid(c.stroke)] };
  if (n.sticky) return { ...n, fills: [solid(c.sticky)] };
  return { ...n, fills: [solid(c.fill)], strokes: [solid(c.stroke)] };
}

/** Which palette colour a layer uses, if any. */
export function diagramColorOf(n: SceneNode): DiagramColor | undefined {
  const fill = n.fills[0];
  const stroke = n.strokes[0];
  const hex = (p: unknown) => (p && typeof p === 'object' && 'color' in p ? String((p as { color: string }).color).toUpperCase() : '');
  if (n.type === 'LINE') return DIAGRAM_COLORS.find((c) => c.stroke === hex(stroke));
  if (n.sticky) return DIAGRAM_COLORS.find((c) => c.sticky === hex(fill));
  return DIAGRAM_COLORS.find((c) => c.fill === hex(fill));
}

// ---------------------------------------------------------------- text on a board

/** Text sizes offered on a board (like a whiteboard's S/M/L/XL). */
export const TEXT_SIZES = [
  { id: 'S', name: 'Small', size: 12 },
  { id: 'M', name: 'Medium', size: 16 },
  { id: 'L', name: 'Large', size: 24 },
  { id: 'XL', name: 'Extra large', size: 36 },
] as const;

/** Text colours on a board: ink, then the palette's outline shades (dark enough to read). */
export const TEXT_COLORS = [{ id: 'ink', name: 'Ink', color: DIAGRAM_TEXT }, ...DIAGRAM_COLORS.map((c) => ({ id: c.id, name: c.name, color: c.stroke }))];

type RunKey = 'fontSize' | 'fontWeight' | 'color';

/** A text style with one property set for all of it: styled stretches stop overriding it. */
function withBase<T extends { runs?: TextRun[] }>(t: T, key: RunKey, extra: Partial<T>): T {
  const runs = t.runs
    ?.map((r) => {
      const { [key]: _drop, ...rest } = r;
      return rest as TextRun;
    })
    .filter((r) => Object.keys(r).some((k) => k !== 'start' && k !== 'end'));
  return { ...t, ...extra, runs: runs?.length ? runs : undefined };
}

/** Text layers and text in shapes: what the board's size control changes. */
export const hasBoardText = (n: SceneNode) => n.type === 'TEXT' || canHaveLabel(n);

/** The size of a layer's text, if it is one size throughout. */
export function textSizeOf(n: SceneNode): number | null {
  const t = n.type === 'TEXT' ? n.text : (n.label ?? (canHaveLabel(n) ? defaultLabel(n) : undefined));
  if (!t || t.runs?.some((r) => r.fontSize !== undefined)) return null;
  return t.fontSize;
}

/** Sets the size of a text layer or of the text in a shape (which grows to fit it). */
export function withTextSize(n: SceneNode, size: number): SceneNode {
  if (n.type === 'TEXT' && n.text) return { ...n, text: withBase(n.text, 'fontSize', { fontSize: size }) };
  if (!canHaveLabel(n)) return n;
  const next = { ...n, label: withBase(n.label ?? defaultLabel(n), 'fontSize', { fontSize: size }) };
  return next.type === 'LINE' ? next : { ...next, height: heightForLabel(next) };
}

export const isBold = (n: SceneNode) => n.type === 'TEXT' && !!n.text && n.text.fontWeight >= 600 && !n.text.runs?.some((r) => r.fontWeight !== undefined);

export function withBold(n: SceneNode, on: boolean): SceneNode {
  if (n.type !== 'TEXT' || !n.text) return n;
  return { ...n, text: withBase(n.text, 'fontWeight', { fontWeight: on ? 700 : 400 }) };
}

export function withTextColor(n: SceneNode, color: string): SceneNode {
  if (n.type !== 'TEXT' || !n.text) return n;
  return { ...n, fills: [solid(color)], text: withBase(n.text, 'color', {}) };
}

/** The text colour of a layer, if it is one colour throughout. */
export function textColorOf(n: SceneNode): string | null {
  if (n.type !== 'TEXT' || n.text?.runs?.some((r) => r.color !== undefined)) return null;
  const f = n.fills[0];
  return f && (f.type === undefined || f.type === 'SOLID') ? f.color.toUpperCase() : null;
}
