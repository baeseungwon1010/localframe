import type { SceneNode } from '../../shared/schema.ts';

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
  if (n.type === 'VECTOR' && n.shape && n.shape.kind !== 'polygon' && n.shape.kind !== 'star') return true;
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
