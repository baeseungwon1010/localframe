import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { type NodeType, type SceneNode, type SolidPaint, type TextStyle, isContainerType } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { clamp } from './math.ts';
import { layoutText } from './text.ts';

export const newId = () => crypto.randomUUID();

export const TYPE_LABEL: Record<NodeType, string> = {
  FRAME: 'Frame',
  COMPONENT: 'Component',
  INSTANCE: 'Instance',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  TEXT: 'Text',
};

export const solid = (color: string, opacity = 1): SolidPaint => ({ color, opacity, visible: true });

export const DEFAULT_TEXT: TextStyle = {
  characters: '',
  fontFamily: 'Inter',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: null,
  letterSpacing: 0,
  align: 'left',
  autoResize: 'width',
};

/** Key above every existing sibling (new nodes go on top of their container). */
export function keyOnTop(doc: SceneDoc, parentId: string | null): string {
  const siblings = doc.children(parentId);
  const last = siblings.length ? doc.get(siblings[siblings.length - 1])!.order : null;
  return generateKeyBetween(last, null);
}

export function keysOnTop(doc: SceneDoc, parentId: string | null, n: number): string[] {
  const siblings = doc.children(parentId);
  const last = siblings.length ? doc.get(siblings[siblings.length - 1])!.order : null;
  return generateNKeysBetween(last, null, n);
}

/** Order key for inserting at index `index` among `siblings` (ids, bottom first), skipping `exclude`. */
export function keyAt(doc: SceneDoc, siblings: string[], index: number, exclude: Set<string> = new Set()): string {
  const list = siblings.filter((id) => !exclude.has(id));
  const i = Math.max(0, Math.min(index, list.length));
  const before = i > 0 ? doc.get(list[i - 1])!.order : null;
  const after = i < list.length ? doc.get(list[i])!.order : null;
  return generateKeyBetween(before, after);
}

/** `n` keys right above sibling `id` (between it and the next sibling up). */
export function keysAbove(doc: SceneDoc, id: string, n: number): string[] {
  const node = doc.get(id)!;
  const sibs = doc.children(node.parentId);
  const i = sibs.indexOf(id);
  const after = i + 1 < sibs.length ? doc.get(sibs[i + 1])!.order : null;
  return generateNKeysBetween(node.order, after, n);
}

export function nextName(doc: SceneDoc, typeOrLabel: NodeType | string): string {
  const label = (TYPE_LABEL as Record<string, string>)[typeOrLabel] ?? typeOrLabel;
  const re = new RegExp(`^${label} (\\d+)$`);
  let max = 0;
  for (const n of doc.all()) {
    const m = re.exec(n.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${label} ${max + 1}`;
}

export function createNode(
  doc: SceneDoc,
  type: NodeType,
  parentId: string | null,
  geom: { x: number; y: number; width: number; height: number; rotation?: number },
): SceneNode {
  const base: SceneNode = {
    id: newId(),
    type,
    parentId,
    order: keyOnTop(doc, parentId),
    name: nextName(doc, type),
    visible: true,
    locked: false,
    opacity: 1,
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    rotation: geom.rotation ?? 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside',
    strokeDash: [],
  };
  switch (type) {
    case 'FRAME':
    case 'COMPONENT':
      return { ...base, fills: [solid('#FFFFFF')], radii: [0, 0, 0, 0], clipsContent: true };
    case 'INSTANCE':
      return { ...base, componentId: '', overrides: {} };
    case 'RECTANGLE':
      return { ...base, fills: [solid('#D9D9D9')], radii: [0, 0, 0, 0] };
    case 'ELLIPSE':
      return { ...base, fills: [solid('#D9D9D9')] };
    case 'LINE':
      return {
        ...base,
        height: 0,
        strokes: [solid('#1B1D21')],
        strokeWeight: 2,
        strokeAlign: 'center',
        arrowStart: false,
        arrowEnd: false,
      };
    case 'TEXT':
      return { ...base, fills: [solid('#1B1D21')], text: { ...DEFAULT_TEXT } };
  }
}

export const canHaveChildren = (n: SceneNode | undefined) => n !== undefined && isContainerType(n.type);

const MAX_SIZE = 1e7;

/** Recomputes a text layer's size from its content and auto-resize mode. */
export function fitText(n: SceneNode): SceneNode {
  if (n.type !== 'TEXT' || !n.text) return n;
  const t = n.text;
  if (t.autoResize === 'width') {
    const l = layoutText(t, null);
    return { ...n, width: clamp(l.width, 1, MAX_SIZE), height: clamp(l.height, 1, MAX_SIZE) };
  }
  if (t.autoResize === 'height') {
    const l = layoutText(t, n.width);
    return { ...n, height: clamp(l.height, 1, MAX_SIZE) };
  }
  return n;
}
