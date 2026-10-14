import { describe, expect, it } from 'vitest';
import polygonClipping from 'polygon-clipping';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { svgMarkup } from '../../src/engine/export.ts';
import { fillArea } from '../../src/engine/pathOps.ts';
import { SceneNodeSchema, validateTree } from '../../shared/schema.ts';

const ptr = (sx: number, sy: number): PointerInput => ({ sx, sy, button: 0, shift: false, alt: false, mod: false });
function setup() {
  const ed = new Editor();
  ed.setViewSize(1000, 800);
  return ed;
}
const draw = (ed: Editor, tool: Parameters<Editor['setTool']>[0], from: [number, number], to: [number, number]) => {
  ed.setTool(tool);
  ed.pointerDown(ptr(...from));
  ed.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  ed.pointerMove(ptr(...to));
  ed.pointerUp(ptr(...to));
  return ed.selection[0];
};
const valid = (ed: Editor) => {
  for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success, JSON.stringify(SceneNodeSchema.safeParse(n).error?.issues)).toBe(true);
  expect(validateTree(ed.doc.all(), ed.pages)).toBeNull();
};
/** Area of a vector's even-odd fill, from its own outline. */
const areaOf = (ed: Editor, id: string) => {
  const mp = fillArea(ed.doc.get(id)!);
  let a = 0;
  for (const poly of mp)
    poly.forEach((r, i) => {
      let s = 0;
      for (let k = 0; k < r.length - 1; k++) s += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
      a += (i === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  return a;
};
void polygonClipping;

describe('outline stroke', () => {
  it('turns an inside stroke of a fill-less rectangle into a ring', () => {
    const ed = setup();
    const r = draw(ed, 'rect', [0, 0], [100, 60]);
    ed.updateNodes([r], (n) => ({ ...n, fills: [], strokes: [{ color: '#C8106E', opacity: 1, visible: true }], strokeWeight: 4, strokeAlign: 'inside' }));
    ed.setSelection([r]);
    ed.outlineStroke();
    const n = ed.doc.get(r)!;
    expect(n.type).toBe('VECTOR');
    expect(n.vector!.fillRule).toBe('evenodd');
    expect(n.vector!.extra).toHaveLength(1); // the hole
    expect((n.fills[0] as { color: string }).color).toBe('#C8106E');
    expect(n.strokes).toEqual([]);
    expect(n).toMatchObject({ x: 0, y: 0, width: 100, height: 60 });
    // ring area: outer minus inner box
    expect(areaOf(ed, r)).toBeCloseTo(100 * 60 - 92 * 52, 0);
    expect(svgMarkup(ed.doc, { ids: [r], background: null }).svg).toContain('fill-rule="evenodd"');
    valid(ed);
  });

  it('keeps the fill and puts the outlined stroke above it', () => {
    const ed = setup();
    const e = draw(ed, 'ellipse', [0, 0], [100, 100]);
    ed.updateNodes([e], (n) => ({ ...n, strokes: [{ color: '#000000', opacity: 1, visible: true }], strokeWeight: 10, strokeAlign: 'center' }));
    ed.setSelection([e]);
    ed.outlineStroke();
    const stroke = ed.doc.get(ed.selection[0])!;
    expect(stroke.id).not.toBe(e);
    expect(ed.doc.get(e)!.strokes).toEqual([]);
    expect(ed.doc.children(null).indexOf(stroke.id)).toBe(ed.doc.children(null).indexOf(e) + 1);
    // a centred 10px ring around a 100px circle reaches 5px outside it
    expect(stroke.width).toBeCloseTo(110, 0);
    valid(ed);
  });

  it('outlines an open line with round caps', () => {
    const ed = setup();
    const l = draw(ed, 'line', [0, 0], [100, 0]);
    ed.updateNodes([l], (n) => ({ ...n, strokeWeight: 10, strokeCap: 'round' }));
    ed.setSelection([l]);
    ed.outlineStroke();
    const n = ed.doc.get(ed.selection[0])!;
    expect(n.type).toBe('VECTOR');
    expect(n.width).toBeCloseTo(110, 0);
    expect(n.height).toBeCloseTo(10, 0);
    valid(ed);
  });
});

describe('flatten booleans', () => {
  it('subtracts the top shape from the bottom one into one vector', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [0, 0], [100, 100]);
    const b = draw(ed, 'rect', [50, 0], [150, 100]);
    ed.setSelection([a, b]);
    ed.booleanSelection('subtract');
    const bool = ed.selection[0];
    ed.flattenSelection();
    const n = ed.doc.get(bool)!;
    expect(n.type).toBe('VECTOR');
    expect(ed.doc.children(bool)).toHaveLength(0);
    expect(n).toMatchObject({ x: 0, width: 50, height: 100 });
    expect(areaOf(ed, bool)).toBeCloseTo(5000, 0);
    valid(ed);
  });

  it('refuses booleans with text inside and says why', () => {
    const ed = setup();
    const notices: string[] = [];
    ed.onNotice = (t) => notices.push(t);
    const a = draw(ed, 'rect', [0, 0], [100, 100]);
    ed.setTool('text');
    ed.pointerDown(ptr(20, 20));
    ed.pointerUp(ptr(20, 20));
    const t = ed.editingText!;
    ed.commitTextEdit('Hi');
    ed.setSelection([a, t]);
    ed.booleanSelection('union');
    const bool = ed.selection[0];
    ed.flattenSelection();
    expect(ed.doc.get(bool)!.type).toBe('BOOLEAN');
    expect(notices).toHaveLength(1);
  });
});

describe('grid layout and type options', () => {
  it('places items in equal columns row by row and hugs the rows', () => {
    const ed = setup();
    const f = draw(ed, 'frame', [0, 0], [220, 100]);
    const kids = [0, 1, 2].map((i) => draw(ed, 'rect', [10 + i * 5, 10], [40 + i * 5, 40]));
    ed.updateNodes(kids, (n) => ({ ...n, width: 30, height: 30 }));
    ed.setSelection([f]);
    ed.addAutoLayout();
    ed.updateNodes([f], (n) => ({
      ...n,
      width: 220,
      layout: { ...n.layout!, mode: 'grid', columns: 2, gap: 20, counterGap: 10, padding: [10, 10, 10, 10], widthMode: 'fixed', heightMode: 'hug' },
    }));
    const pos = kids.map((id) => ed.doc.get(id)!).sort((a, b) => a.y - b.y || a.x - b.x).map((n) => [n.x, n.y]);
    // cells are (200 - 20) / 2 = 90 wide
    expect(pos).toEqual([
      [10, 10],
      [120, 10],
      [10, 50],
    ]);
    expect(ed.doc.get(f)!.height).toBe(10 + 30 + 10 + 30 + 10);
    valid(ed);
  });

  it('small caps and kerning reach canvas fonts and SVG', async () => {
    const { fontString } = await import('../../src/engine/text.ts');
    expect(fontString({ fontWeight: 400, fontSize: 12, fontFamily: 'Inter', smallCaps: true })).toContain('small-caps 400 12px');
    const ed = setup();
    ed.setTool('text');
    ed.pointerDown(ptr(20, 20));
    ed.pointerUp(ptr(20, 20));
    const t = ed.editingText!;
    ed.commitTextEdit('Kern me');
    ed.updateNodes([t], (n) => ({ ...n, text: { ...n.text!, smallCaps: true, kerning: false } }));
    const svg = svgMarkup(ed.doc, { ids: [t], background: null }).svg;
    expect(svg).toContain('font-variant="small-caps"');
    expect(svg).toContain('font-kerning="none"');
    valid(ed);
  });
});
