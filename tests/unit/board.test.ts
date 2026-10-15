import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { labelMatrix, labelNode } from '../../src/engine/labels.ts';
import { apply, matRotation, multiply } from '../../src/engine/math.ts';
import { STAMPS, TEMPLATES } from '../../src/engine/templates.ts';
import { isBold, textColorOf, textSizeOf, withBold, withTextColor, withTextSize } from '../../src/engine/diagramColors.ts';
import { hitDeepest } from '../../src/engine/hit.ts';
import { linePoints } from '../../src/engine/geometry.ts';
import { pathBlocked } from '../../src/engine/route.ts';
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

  it('board text controls: size, bold and colour apply to all of a text, and shapes grow to the size', () => {
    const ed = setup();
    ed.setTool('text');
    ed.pointerDown(ptr(100, 100));
    ed.pointerUp(ptr(100, 100));
    const id = ed.editingText!;
    ed.commitTextEdit('Hello board');
    const n = ed.doc.get(id)!;
    // a styled stretch that the controls override
    const styled = { ...n, text: { ...n.text!, runs: [{ start: 0, end: 5, fontSize: 40, color: '#FF0000', fontWeight: 400 }] } };
    expect(textSizeOf(styled)).toBeNull();
    const big = withTextSize(styled, 36);
    expect(textSizeOf(big)).toBe(36);
    expect(big.text!.runs).toEqual([{ start: 0, end: 5, color: '#FF0000', fontWeight: 400 }]);
    const bold = withBold(big, true);
    expect(isBold(bold)).toBe(true);
    const blue = withTextColor(bold, '#5B8DEF');
    expect(textColorOf(blue)).toBe('#5B8DEF');
    expect(blue.text!.runs).toBeUndefined();
    ed.updateNodes([id], () => blue);
    expect(ed.doc.get(id)!.height).toBeGreaterThan(n.height);

    ed.insertTemplate('brainstorm');
    const sticky = [...ed.doc.all()].find((x) => x.label?.characters === 'What problem does it solve?')!;
    const grown = withTextSize(sticky, 36);
    expect(grown.label!.fontSize).toBe(36);
    expect(grown.height).toBeGreaterThan(sticky.height);
    valid(ed);
  });

  it('clicking the text on a connector picks the connector, even off a steep line', () => {
    const ed = setup();
    ed.insertTemplate('flowchart');
    const yes = [...ed.doc.all()].find((x) => x.label?.characters === 'Yes')!;
    const ln = labelNode(yes)!;
    const world = multiply(ed.doc.world(yes.id), labelMatrix(yes, ln));
    // the right end of the upright text, well off the vertical line
    const p = apply(world, { x: ln.width - 1, y: ln.height / 2 });
    const linePt = apply(ed.doc.world(yes.id), { x: ln.x + ln.width / 2, y: ln.y + ln.height / 2 });
    expect(Math.abs(p.x - linePt.x)).toBeGreaterThan(5);
    expect(hitDeepest(ed.doc, p, 0.5)).toBe(yes.id);
  });

  it('a mind map is tidied as a tree: one column per level, branches apart, connectors right to left', () => {
    const ed = setup();
    ed.insertTemplate('mindmap');
    valid(ed);
    const all = [...ed.doc.all()];
    const byText = (t: string) => all.find((n) => n.label?.characters === t)!;
    const root = byText('Main idea');
    const branches = ['Goals', 'People', 'Timeline', 'Risks'].map(byText);
    const leaves = ['Must have', 'Nice to have', 'Who decides', 'First step', 'Deadline'].map(byText);
    expect(new Set(branches.map((b) => b.x)).size).toBe(1);
    expect(new Set(leaves.map((l) => l.x)).size).toBe(1);
    expect(branches[0].x).toBeGreaterThan(root.x + root.width);
    expect(leaves[0].x).toBeGreaterThan(branches[0].x + branches[0].width);
    // no two shapes in a column overlap
    for (const col of [branches, leaves]) {
      const sorted = [...col].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height);
    }
    // the root sits in the middle of its branches
    const top = Math.min(...branches.map((b) => b.y));
    const bottom = Math.max(...branches.map((b) => b.y + b.height));
    expect(Math.abs((top + bottom) / 2 - (root.y + root.height / 2))).toBeLessThan(60);
    for (const l of all.filter((n) => n.type === 'LINE')) expect([l.startBind?.anchor, l.endBind?.anchor]).toEqual(['right', 'left']);

    // a branch dragged out of place: Tidy up puts it back; the root is the one selected
    ed.doc.set({ ...branches[1], x: branches[1].x + 300, y: branches[1].y + 400 });
    ed.setSelection([root.id]);
    expect(ed.canTidyTree()).toBe(true);
    ed.tidyTree();
    expect(ed.doc.get(branches[1].id)!.x).toBe(branches[0].x);
    ed.setSelection([leaves[0].id]);
    expect(ed.canTidyTree()).toBe(false);
  });

  it('an elbow connector re-routes around a shape moved into its way', () => {
    const ed = setup();
    ed.setTool('box');
    const draw = (x: number) => {
      ed.setTool('box');
      ed.pointerDown(ptr(x, 300));
      ed.pointerUp(ptr(x, 300));
      return ed.selection[0];
    };
    const a = draw(100);
    const c = draw(600);
    const blocker = draw(350);
    // move the blocker away, connect, then move it back between them
    ed.updateNodes([blocker], (n) => ({ ...n, y: n.y + 400 }));
    ed.setSelection([a]);
    ed.quickConnect('right');
    const extra = ed.editingLabel!;
    ed.commitLabelEdit('');
    const line = [...ed.doc.all()].find((n) => n.type === 'LINE')!;
    // point the connector at c instead, and drop the shape quick connect made
    ed.updateNodes([line.id], (n) => ({ ...n, endBind: { nodeId: c, anchor: 'left' } }));
    ed.setSelection([extra]);
    ed.deleteSelection();
    expect(ed.doc.get(line.id)).toBeDefined();
    const straight = ed.doc.get(line.id)!.route?.length ?? 0;
    ed.updateNodes([blocker], (n) => ({ ...n, y: n.y - 400 }));
    const routed = ed.doc.get(line.id)!;
    expect((routed.route?.length ?? 0)).toBeGreaterThan(straight);
    const w = ed.doc.world(routed.id);
    const pts = linePoints(routed).map((p) => apply(w, p));
    expect(pathBlocked(pts, [ed.doc.worldBounds(blocker)])).toBe(false);
  });
});
