import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { NodeType, Paint, SceneNode, TextStyle } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';

export const newId = () => crypto.randomUUID();

export const TYPE_LABEL: Record<NodeType, string> = {
  FRAME: 'Frame',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  TEXT: 'Text',
};

export const solid = (color: string, opacity = 1): Paint => ({ color, opacity, visible: true });

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

export function nextName(doc: SceneDoc, type: NodeType): string {
  const label = TYPE_LABEL[type];
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
      return { ...base, fills: [solid('#FFFFFF')], radii: [0, 0, 0, 0], clipsContent: true };
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

export const canHaveChildren = (n: SceneNode | undefined) => n?.type === 'FRAME';
