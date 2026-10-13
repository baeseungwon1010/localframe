import type { Layout, SceneNode } from '../../shared/schema.ts';
import { round2 } from './math.ts';
import { fitText } from './nodes.ts';

export const DEFAULT_LAYOUT: Layout = {
  mode: 'vertical',
  gap: 10,
  padding: [10, 10, 10, 10],
  primaryAlign: 'start',
  crossAlign: 'start',
  widthMode: 'hug',
  heightMode: 'hug',
};

/**
 * Places the children of an auto layout frame and sizes the frame if it hugs its content.
 * `kids` are in layer order, bottom first, which is the reading order of the layout.
 * Returns new objects only for nodes that changed.
 */
export function applyAutoLayout(frame: SceneNode, kids: SceneNode[]): { frame: SceneNode; kids: SceneNode[] } {
  const L = frame.layout;
  if (!L) return { frame, kids };
  const horizontal = L.mode === 'horizontal';
  const [pt, pr, pb, pl] = L.padding;
  const padMainStart = horizontal ? pl : pt;
  const padMainEnd = horizontal ? pr : pb;
  const padCrossStart = horizontal ? pt : pl;
  const padCrossEnd = horizontal ? pb : pr;
  const mainSize = (n: SceneNode) => (horizontal ? n.width : n.height);
  const crossSize = (n: SceneNode) => (horizontal ? n.height : n.width);
  const mainHug = horizontal ? L.widthMode === 'hug' : L.heightMode === 'hug';
  const crossHug = horizontal ? L.heightMode === 'hug' : L.widthMode === 'hug';
  const fillsMain = (n: SceneNode) => (horizontal ? n.layoutChild?.horizontal : n.layoutChild?.vertical) === 'fill';
  const fillsCross = (n: SceneNode) =>
    L.crossAlign === 'stretch' || (horizontal ? n.layoutChild?.vertical : n.layoutChild?.horizontal) === 'fill';

  const flow = kids.filter((k) => k.visible && !k.layoutChild?.absolute);
  const out = new Map<string, SceneNode>(kids.map((k) => [k.id, k]));
  const set = (n: SceneNode, main: number | null, cross: number | null) => {
    let next = n;
    if (main !== null && Math.abs(mainSize(n) - main) > 0.001) next = horizontal ? { ...next, width: main } : { ...next, height: main };
    if (cross !== null && Math.abs(crossSize(next) - cross) > 0.001 && next.type !== 'LINE')
      next = horizontal ? { ...next, height: cross } : { ...next, width: cross };
    if (next !== n && next.type === 'TEXT' && next.text) {
      // a text layer that is stretched horizontally wraps inside its new width
      const widthChanged = next.width !== n.width;
      const mode = widthChanged ? (next.height !== n.height ? 'none' : 'height') : next.text.autoResize;
      next = fitText({ ...next, text: { ...next.text, autoResize: mode } });
    }
    out.set(n.id, next);
    return next;
  };

  const gapCount = Math.max(0, flow.length - 1);
  let frameMain = mainSize(frame);
  let frameCross = crossSize(frame);
  let innerCross = frameCross - padCrossStart - padCrossEnd;

  // cross sizes first (stretch needs the frame's inner size)
  if (crossHug) {
    const fixedCross = flow.filter((k) => !fillsCross(k)).map(crossSize);
    innerCross = fixedCross.length ? Math.max(...fixedCross) : Math.max(0, ...flow.map(crossSize));
    frameCross = padCrossStart + innerCross + padCrossEnd;
  }
  for (const k of flow) if (fillsCross(k)) set(k, null, Math.max(0.01, innerCross));

  // main sizes: fill children share what fixed ones leave
  const current = () => flow.map((k) => out.get(k.id)!);
  if (!mainHug) {
    const inner = frameMain - padMainStart - padMainEnd;
    const fixed = current().filter((k) => !fillsMain(k));
    const fillers = current().filter(fillsMain);
    if (fillers.length) {
      const gaps = L.primaryAlign === 'space-between' ? 0 : L.gap * gapCount;
      const share = Math.max(1, (inner - fixed.reduce((s, k) => s + mainSize(k), 0) - gaps) / fillers.length);
      for (const k of fillers) set(k, round2(share), null);
    }
  }

  const items = current();
  const total = items.reduce((s, k) => s + mainSize(k), 0);
  let gap = L.gap;
  if (mainHug) frameMain = padMainStart + total + gap * gapCount + padMainEnd;
  const inner = frameMain - padMainStart - padMainEnd;
  let cursor = padMainStart;
  if (L.primaryAlign === 'space-between' && items.length > 1 && !mainHug) gap = (inner - total) / gapCount;
  else if (L.primaryAlign === 'center') cursor += (inner - total - gap * gapCount) / 2;
  else if (L.primaryAlign === 'end') cursor += inner - total - gap * gapCount;

  for (const k of items) {
    const c = crossSize(k);
    let crossPos = padCrossStart;
    if (!fillsCross(k)) {
      if (L.crossAlign === 'center') crossPos += (innerCross - c) / 2;
      else if (L.crossAlign === 'end') crossPos += innerCross - c;
    }
    const x = round2(horizontal ? cursor : crossPos);
    const y = round2(horizontal ? crossPos : cursor);
    if (k.x !== x || k.y !== y || k.rotation !== 0) out.set(k.id, { ...k, x, y, rotation: 0 });
    cursor += mainSize(k) + gap;
  }

  const w = round2(Math.max(0.01, horizontal ? frameMain : frameCross));
  const h = round2(Math.max(0.01, horizontal ? frameCross : frameMain));
  const nextFrame = w !== frame.width || h !== frame.height ? { ...frame, width: w, height: h } : frame;
  return { frame: nextFrame, kids: kids.map((k) => out.get(k.id)!) };
}

/** Child index where a layer dropped at `pos` (parent coordinates) belongs in an auto layout frame. */
export function autoLayoutIndex(frame: SceneNode, kids: SceneNode[], pos: { x: number; y: number }): number {
  const horizontal = frame.layout?.mode === 'horizontal';
  const flow = kids.filter((k) => k.visible && !k.layoutChild?.absolute);
  let i = 0;
  for (const k of flow) {
    const mid = horizontal ? k.x + k.width / 2 : k.y + k.height / 2;
    if ((horizontal ? pos.x : pos.y) > mid) i++;
  }
  return i;
}
