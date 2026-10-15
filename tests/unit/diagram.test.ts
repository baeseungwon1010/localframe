import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { svgMarkup } from '../../src/engine/export.ts';
import { labelNode, lineMidpoint } from '../../src/engine/labels.ts';
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

describe('diagramming', () => {
  it('double-click a shape to write in it; the text sits in its middle and exports', () => {
    const ed = setup();
    const r = draw(ed, 'rect', [100, 100], [300, 200]);
    ed.doubleClick(ptr(200, 150));
    expect(ed.editingLabel).toBe(r);
    ed.commitLabelEdit('Start');
    const n = ed.doc.get(r)!;
    expect(n.label!.characters).toBe('Start');
    const ln = labelNode(n)!;
    expect(ln.x + ln.width / 2).toBeCloseTo(100, 0); // centred across 200
    expect(ln.y + ln.height / 2).toBeCloseTo(50, 0);
    expect(svgMarkup(ed.doc, { ids: [r], background: null }).svg).toContain('>Start</tspan>');
    // emptying the text removes it
    ed.startLabelEdit(r);
    ed.commitLabelEdit('  ');
    expect(ed.doc.get(r)!.label).toBeUndefined();
    valid(ed);
  });

  it('draws diagram shapes, sticky notes and connector text', () => {
    const ed = setup();
    for (const tool of ['diamond', 'parallelogram', 'cylinder', 'document', 'chevron'] as const) {
      const id = draw(ed, tool, [100, 100], [220, 180]);
      const n = ed.doc.get(id)!;
      expect(n.shape!.kind).toBe(tool);
      expect(n.vector!.points.length).toBeGreaterThan(2);
    }
    ed.setTool('sticky');
    ed.pointerDown(ptr(500, 500));
    ed.pointerUp(ptr(500, 500));
    const sticky = ed.editingLabel!;
    expect(ed.doc.get(sticky)).toMatchObject({ sticky: true, width: 200, height: 200 });
    ed.commitLabelEdit('Idea');
    expect(labelNode(ed.doc.get(sticky)!)!).toMatchObject({ x: 16, y: 16 });

    const line = draw(ed, 'line', [0, 400], [200, 400]);
    ed.startLabelEdit(line);
    ed.commitLabelEdit('yes');
    const l = ed.doc.get(line)!;
    const mid = lineMidpoint(l);
    const ln = labelNode(l)!;
    expect(ln.x + ln.width / 2).toBeCloseTo(mid.x, 1);
    valid(ed);
  });

  it('quick connect adds the same shape beyond a side, joined by an elbow arrow', () => {
    const ed = setup();
    const a = draw(ed, 'diamond', [100, 100], [200, 180]);
    ed.startLabelEdit(a);
    ed.commitLabelEdit('Ok?');
    ed.setSelection([a]);
    const spots = ed.quickConnectSpots();
    expect(spots.map((s) => s.side)).toEqual(['top', 'right', 'bottom', 'left']);
    const right = spots.find((s) => s.side === 'right')!;
    ed.pointerDown(ptr(right.at.x, right.at.y));
    ed.pointerUp(ptr(right.at.x, right.at.y));
    const b = ed.editingLabel!;
    expect(b).not.toBe(a);
    const nb = ed.doc.get(b)!;
    expect(nb).toMatchObject({ x: 100 + 100 + 80, y: 100, width: 100, height: 80 });
    expect(nb.shape!.kind).toBe('diamond');
    expect(nb.label?.characters ?? '').toBe('');
    const arrow = [...ed.doc.all()].find((n) => n.type === 'LINE')!;
    expect(arrow).toMatchObject({ elbow: true, arrowEnd: true, startBind: { nodeId: a, anchor: 'right' }, endBind: { nodeId: b, anchor: 'left' } });
    ed.commitLabelEdit('Yes');
    valid(ed);
  });

  it('find and replace reaches text in shapes', () => {
    const ed = setup();
    const r = draw(ed, 'ellipse', [0, 0], [100, 100]);
    ed.startLabelEdit(r);
    ed.commitLabelEdit('Login page');
    expect(ed.findText('login', { matchCase: false })).toEqual([{ id: r, count: 1 }]);
    ed.replaceText('Login', 'Sign-in', { matchCase: true });
    expect(ed.doc.get(r)!.label!.characters).toBe('Sign-in page');
  });
});
