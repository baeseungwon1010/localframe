import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { labelMatrix, labelNode } from '../../src/engine/labels.ts';
import { apply, matRotation, multiply } from '../../src/engine/math.ts';
import { STAMPS, TEMPLATES } from '../../src/engine/templates.ts';
import { SceneNodeSchema, validateTree } from '../../shared/schema.ts';

const ptr = (sx: number, sy: number): PointerInput => ({ sx, sy, button: 0, shift: false, alt: false, mod: false });
function setup() {
  const ed = new Editor();
  ed.setViewSize(1000, 800);
  return ed;
}
const valid = (ed: Editor) => {
  for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success, JSON.stringify(SceneNodeSchema.safeParse(n).error?.issues)).toBe(true);
  expect(validateTree(ed.doc.all(), ed.pages)).toBeNull();
};
const LONG = 'A sticky note with a lot to say, much more than fits on two hundred pixels of yellow paper, so it has to grow downwards to keep every word on it';

describe('diagram boards', () => {
  it('sticky notes and shapes grow to hold their text, and never shrink from it', () => {
    const ed = setup();
    ed.setTool('sticky');
    ed.pointerDown(ptr(100, 100));
    ed.pointerUp(ptr(100, 100));
    const s = ed.editingLabel!;
    ed.commitLabelEdit(LONG);
    const n = ed.doc.get(s)!;
    expect(n.height).toBeGreaterThan(200);
    const ln = labelNode(n)!;
    expect(ln.y + ln.height).toBeLessThanOrEqual(n.height - 16 + 0.5);
    // short text keeps the size it has
    ed.startLabelEdit(s);
    ed.commitLabelEdit('Hi');
    expect(ed.doc.get(s)!.height).toBe(n.height);

    // a diamond needs more room than its text: its middle is narrow
    ed.setTool('diamond');
    ed.pointerDown(ptr(500, 100));
    ed.pointerMove(ptr(560, 130));
    ed.pointerMove(ptr(620, 160));
    ed.pointerUp(ptr(620, 160));
    const d = ed.selection[0];
    ed.startLabelEdit(d);
    ed.commitLabelEdit('Is the payment approved by the bank?');
    const dn = ed.doc.get(d)!;
    expect(dn.height).toBeGreaterThan(labelNode(dn)!.height * 1.5);
    // the outline was rebuilt for the new size
    expect(Math.max(...dn.vector!.points.map((p) => p.y))).toBeCloseTo(dn.height, 0);
    valid(ed);
  });

  it('every template builds a valid board in the middle of the view, selected', () => {
    for (const t of TEMPLATES) {
      const ed = setup();
      ed.insertTemplate(t.kind);
      valid(ed);
      expect(ed.selection.length).toBeGreaterThan(0);
      expect(ed.tool).toBe('move');
      const b = ed.selectionBounds()!;
      const c = ed.toWorld(500, 400);
      expect(Math.abs(b.x + b.width / 2 - c.x)).toBeLessThan(60);
      // one undo removes all of it
      ed.undo();
      expect(ed.doc.size).toBe(0);
    }
  });

  it('the flowchart is joined by connectors bound at both ends, with Yes and No on them', () => {
    const ed = setup();
    ed.insertTemplate('flowchart');
    const lines = [...ed.doc.all()].filter((n) => n.type === 'LINE');
    expect(lines.length).toBe(6);
    for (const l of lines) expect(l.startBind && l.endBind && l.elbow && l.arrowEnd).toBeTruthy();
    expect(lines.map((l) => l.label?.characters).filter(Boolean).sort()).toEqual(['No', 'Yes']);
    const decide = [...ed.doc.all()].find((n) => n.label?.characters === 'Did it work?')!;
    expect(decide.shape?.kind).toBe('diamond');
  });

  it('text on a connector stays upright and centred whichever way the line runs', () => {
    const ed = setup();
    ed.insertTemplate('flowchart');
    const yes = [...ed.doc.all()].find((n) => n.label?.characters === 'Yes')!;
    expect(yes.rotation).not.toBe(0);
    const ln = labelNode(yes)!;
    const world = multiply(ed.doc.world(yes.id), labelMatrix(yes, ln));
    expect(Math.abs(matRotation(world)) % 360).toBeCloseTo(0, 5);
    // its centre is still the middle of the line
    const c = apply(world, { x: ln.width / 2, y: ln.height / 2 });
    const mid = apply(ed.doc.world(yes.id), { x: ln.x + ln.width / 2, y: ln.y + ln.height / 2 });
    expect(c.x).toBeCloseTo(mid.x, 5);
    expect(c.y).toBeCloseTo(mid.y, 5);
  });

  it('a retrospective puts empty sticky notes inside three sections', () => {
    const ed = setup();
    ed.insertTemplate('retro');
    const sections = [...ed.doc.all()].filter((n) => n.section);
    expect(sections.map((s) => s.name)).toEqual(['Went well', 'To improve', 'Actions']);
    for (const s of sections) expect(ed.doc.children(s.id).every((id) => ed.doc.get(id)!.sticky)).toBe(true);
  });

  it('the stamp tool drops the chosen stamp where you click, and stays on', () => {
    const ed = setup();
    ed.setStamp(STAMPS[2].glyph);
    expect(ed.tool).toBe('stamp');
    ed.pointerDown(ptr(300, 300));
    ed.pointerUp(ptr(300, 300));
    ed.pointerDown(ptr(400, 300));
    ed.pointerUp(ptr(400, 300));
    const stamps = [...ed.doc.all()].filter((n) => n.name.startsWith('Stamp'));
    expect(stamps.map((n) => n.text!.characters)).toEqual(['⭐', '⭐']);
    const w = ed.toWorld(300, 300);
    expect(stamps[0].x + stamps[0].width / 2).toBeCloseTo(w.x, 0);
    expect(ed.tool).toBe('stamp');
    ed.setStamp('not a stamp');
    expect(ed.stamp).toBe('⭐');
    valid(ed);
  });
});
