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
  if (L.wrap && L.mode === 'horizontal') return wrapLayout(frame, L, kids);
  if (L.mode === 'grid') return gridLayout(frame, L, kids);
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
    if (main !== null) main = horizontal ? clampW(n, main) : clampH(n, main);
    if (cross !== null) cross = horizontal ? clampH(n, cross) : clampW(n, cross);
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

  return { frame: sized(frame, horizontal ? frameMain : frameCross, horizontal ? frameCross : frameMain), kids: kids.map((k) => out.get(k.id)!) };
}

const clampW = (n: SceneNode, w: number) => Math.min(n.maxWidth || Infinity, Math.max(n.minWidth ?? 0, w));
const clampH = (n: SceneNode, h: number) => Math.min(n.maxHeight || Infinity, Math.max(n.minHeight ?? 0, h));

/** The frame at its new size, within its own limits (a new object only if the size changed). */
function sized(frame: SceneNode, width: number, height: number): SceneNode {
  const w = round2(Math.max(0.01, clampW(frame, width)));
  const h = round2(Math.max(0.01, clampH(frame, height)));
  return w !== frame.width || h !== frame.height ? { ...frame, width: w, height: h } : frame;
}

/**
 * Grid auto layout: equal columns across the inner width, items row by row. A row is as tall as its
 * tallest item; items that fill take their cell's width or height. `gap` runs between columns and
 * `counterGap` between rows; `primaryAlign` places items across their cell, `crossAlign` down it.
 */
function gridLayout(frame: SceneNode, L: NonNullable<SceneNode['layout']>, kids: SceneNode[]): { frame: SceneNode; kids: SceneNode[] } {
  const [pt, pr, pb, pl] = L.padding;
  const out = new Map<string, SceneNode>(kids.map((k) => [k.id, k]));
  const flow = kids.filter((k) => k.visible && !k.layoutChild?.absolute);
  const cols = Math.max(1, L.columns ?? 2);
  const colGap = L.gap;
  const rowGap = L.counterGap ?? L.gap;
  const inner = Math.max(0, frame.width - pl - pr);
  const cellW = Math.max(0.01, (inner - colGap * (cols - 1)) / cols);
  const items = flow.map((k) => {
    let n = k;
    if (k.layoutChild?.horizontal === 'fill' || L.crossAlign === 'stretch') {
      n = { ...n, width: round2(clampW(n, cellW)) };
      // text that is given a width wraps inside it
      if (n.type === 'TEXT' && n.text && n.width !== k.width) n = fitText({ ...n, text: { ...n.text, autoResize: 'height' } });
    }
    return n;
  });
  const rows: SceneNode[][] = [];
  items.forEach((k, i) => (rows[Math.floor(i / cols)] ??= []).push(k));
  let y = pt;
  for (const row of rows) {
    const fixedHeights = row.filter((k) => k.layoutChild?.vertical !== 'fill').map((k) => k.height);
    const rowH = fixedHeights.length ? Math.max(...fixedHeights) : Math.max(...row.map((k) => k.height));
    row.forEach((k, col) => {
      let n = k;
      if (k.layoutChild?.vertical === 'fill') n = { ...n, height: round2(clampH(n, rowH)) };
      let x = pl + col * (cellW + colGap);
      if (L.primaryAlign === 'center') x += (cellW - n.width) / 2;
      else if (L.primaryAlign === 'end') x += cellW - n.width;
      let ky = y;
      if (L.crossAlign === 'center') ky += (rowH - n.height) / 2;
      else if (L.crossAlign === 'end') ky += rowH - n.height;
      const nx = round2(x);
      const ny = round2(ky);
      if (n !== kids.find((c) => c.id === n.id) || n.x !== nx || n.y !== ny || n.rotation !== 0) out.set(n.id, { ...n, x: nx, y: ny, rotation: 0 });
    });
    y += rowH + rowGap;
  }
  const contentH = rows.length ? y - rowGap + pb : pt + pb;
  const h = L.heightMode === 'hug' ? contentH : frame.height;
  return { frame: sized(frame, frame.width, h), kids: kids.map((k) => out.get(k.id)!) };
}

/**
 * Horizontal auto layout that wraps: items fill a row left to right and move to a new row when the
 * next one would pass the inner width. Rows stack with `counterGap`; alignment applies per row.
 */
function wrapLayout(frame: SceneNode, L: NonNullable<SceneNode['layout']>, kids: SceneNode[]): { frame: SceneNode; kids: SceneNode[] } {
  const [pt, pr, pb, pl] = L.padding;
  const out = new Map<string, SceneNode>(kids.map((k) => [k.id, k]));
  const flow = kids.filter((k) => k.visible && !k.layoutChild?.absolute);
  // a wrapping layout needs a width to wrap at: a hugging one keeps its current width
  const inner = Math.max(0, frame.width - pl - pr);
  const rowGap = L.counterGap ?? L.gap;
  const rows: SceneNode[][] = [];
  let row: SceneNode[] = [];
  let used = 0;
  for (const k of flow) {
    const add = (row.length ? L.gap : 0) + k.width;
    if (row.length && used + add > inner + 0.001) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length ? L.gap : 0) + k.width;
    row.push(k);
  }
  if (row.length) rows.push(row);

  let y = pt;
  for (const r of rows) {
    const rowH = Math.max(...r.map((k) => k.height));
    const total = r.reduce((s, k) => s + k.width, 0);
    let gap = L.gap;
    let x = pl;
    const free = inner - total - gap * (r.length - 1);
    if (L.primaryAlign === 'space-between' && r.length > 1) gap = (inner - total) / (r.length - 1);
    else if (L.primaryAlign === 'center') x += free / 2;
    else if (L.primaryAlign === 'end') x += free;
    for (const k of r) {
      let ky = y;
      if (L.crossAlign === 'center') ky += (rowH - k.height) / 2;
      else if (L.crossAlign === 'end') ky += rowH - k.height;
      const nx = round2(x);
      const ny = round2(ky);
      if (k.x !== nx || k.y !== ny || k.rotation !== 0) out.set(k.id, { ...k, x: nx, y: ny, rotation: 0 });
      x += k.width + gap;
    }
    y += rowH + rowGap;
  }
  const contentH = rows.length ? y - rowGap + pb : pt + pb;
  const h = L.heightMode === 'hug' ? contentH : frame.height;
  return { frame: sized(frame, frame.width, h), kids: kids.map((k) => out.get(k.id)!) };
}

/** Child index where a layer dropped at `pos` (parent coordinates) belongs in an auto layout frame. */
export function autoLayoutIndex(frame: SceneNode, kids: SceneNode[], pos: { x: number; y: number }): number {
  const horizontal = frame.layout?.mode === 'horizontal';
  const flow = kids.filter((k) => k.visible && !k.layoutChild?.absolute);
  if (frame.layout?.mode === 'grid') {
    // reading order: items whose row is above, or in the same row and to the left
    return flow.filter((k) => pos.y > k.y + k.height || (pos.y >= k.y && pos.x > k.x + k.width / 2)).length;
  }
  let i = 0;
  for (const k of flow) {
    const mid = horizontal ? k.x + k.width / 2 : k.y + k.height / 2;
    if ((horizontal ? pos.x : pos.y) > mid) i++;
  }
  return i;
}
