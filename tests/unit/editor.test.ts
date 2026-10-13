import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { pickTarget } from '../../src/engine/hit.ts';
import { svgMarkup, escapeXml } from '../../src/engine/export.ts';
import { layoutText } from '../../src/engine/text.ts';
import { DEFAULT_TEXT } from '../../src/engine/nodes.ts';
import { validateTree, SceneNodeSchema } from '../../shared/schema.ts';

const ptr = (sx: number, sy: number, mods: Partial<PointerInput> = {}): PointerInput => ({
  sx,
  sy,
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  ...mods,
});

function drag(ed: Editor, from: [number, number], to: [number, number], mods: Partial<PointerInput> = {}) {
  ed.pointerDown(ptr(from[0], from[1], mods));
  ed.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods));
  ed.pointerMove(ptr(to[0], to[1], mods));
  ed.pointerUp(ptr(to[0], to[1], mods));
}

function setup() {
  const ed = new Editor();
  ed.setViewSize(1000, 800);
  return ed;
}

describe('editor', () => {
  it('draws a frame, then a rectangle inside it becomes its child', () => {
    const ed = setup();
    ed.setTool('frame');
    drag(ed, [100, 100], [500, 400]);
    const frameId = ed.selection[0];
    expect(ed.doc.get(frameId)).toMatchObject({ type: 'FRAME', x: 100, y: 100, width: 400, height: 300, name: 'Frame 1' });
    expect(ed.tool).toBe('move');

    ed.setTool('rect');
    drag(ed, [150, 150], [250, 200]);
    const rect = ed.doc.get(ed.selection[0])!;
    expect(rect).toMatchObject({ type: 'RECTANGLE', parentId: frameId, x: 50, y: 50, width: 100, height: 50 });
    expect(validateTree(ed.doc.all())).toBeNull();
    for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success).toBe(true);
  });

  it('click selects children of top-level frames, and moving out of the frame reparents', () => {
    const ed = setup();
    ed.setTool('frame');
    drag(ed, [100, 100], [500, 400]);
    ed.setTool('ellipse');
    drag(ed, [150, 150], [200, 200]);
    const ellipse = ed.selection[0];
    ed.setSelection([]);
    ed.pointerDown(ptr(175, 175));
    ed.pointerUp(ptr(175, 175));
    expect(ed.selection).toEqual([ellipse]);

    drag(ed, [175, 175], [775, 575]);
    const moved = ed.doc.get(ellipse)!;
    expect(moved.parentId).toBeNull();
    expect(moved.x).toBe(750);
    expect(moved.y).toBe(550);
    ed.undo();
    expect(ed.doc.get(ellipse)!.parentId).not.toBeNull();
    ed.redo();
    expect(ed.doc.get(ellipse)!.parentId).toBeNull();
  });

  it('marquee selects, resize scales, undo restores', () => {
    const ed = setup();
    ed.setTool('rect');
    drag(ed, [100, 100], [200, 200]);
    ed.setTool('rect');
    drag(ed, [300, 100], [400, 200]);
    drag(ed, [50, 50], [450, 250]);
    expect(ed.selection).toHaveLength(2);
    // drag the south-east handle of the group box from (400,200) to (600,300)
    drag(ed, [400, 200], [700, 300]);
    const [a, b] = ed.selection.map((id) => ed.doc.get(id)!);
    expect(a.width).toBeCloseTo(200);
    expect(b.x).toBeCloseTo(500);
    ed.undo();
    expect(ed.doc.get(a.id)!.width).toBe(100);
  });

  it('draws arrows, duplicates, deletes', () => {
    const ed = setup();
    ed.setTool('arrow');
    drag(ed, [100, 100], [300, 100]);
    const arrow = ed.doc.get(ed.selection[0])!;
    expect(arrow).toMatchObject({ type: 'LINE', width: 200, rotation: 0, arrowEnd: true });
    ed.duplicateSelection();
    expect(ed.doc.size).toBe(2);
    ed.deleteSelection();
    expect(ed.doc.size).toBe(1);
  });

  it('copies and pastes into another frame keeping the page position', () => {
    const ed = setup();
    ed.setTool('rect');
    drag(ed, [100, 100], [150, 150]);
    const text = ed.copyToText()!;
    ed.setTool('frame');
    drag(ed, [400, 400], [600, 600]);
    ed.pasteText(text);
    const pasted = ed.doc.get(ed.selection[0])!;
    expect(pasted.parentId).not.toBeNull();
    expect(pasted.x).toBe(-300);
    expect(ed.doc.worldBounds(pasted.id).x).toBe(100);
  });

  it('wraps a selection in a frame', () => {
    const ed = setup();
    ed.setTool('rect');
    drag(ed, [100, 100], [150, 150]);
    ed.setTool('rect');
    drag(ed, [200, 200], [260, 260]);
    ed.selectAll();
    ed.wrapInFrame();
    const frame = ed.doc.get(ed.selection[0])!;
    expect(frame).toMatchObject({ type: 'FRAME', x: 100, y: 100, width: 160, height: 160 });
    expect(ed.doc.children(frame.id)).toHaveLength(2);
  });

  it('keyboard shortcuts use physical keys (work with a Korean layout)', () => {
    const ed = setup();
    expect(ed.keyDown({ code: 'KeyR', key: 'ㄱ', shift: false, alt: false, mod: false, repeat: false })).toBe(true);
    expect(ed.tool).toBe('rect');
  });
});

describe('selection rule', () => {
  it('needs a double-click to go deeper than the children of a top-level frame', () => {
    const ed = setup();
    ed.setTool('frame');
    drag(ed, [0, 0], [500, 500]);
    ed.setTool('frame');
    drag(ed, [100, 100], [300, 300]);
    const inner = ed.selection[0];
    ed.setTool('rect');
    drag(ed, [150, 150], [200, 200]);
    const rect = ed.selection[0];
    expect(pickTarget(ed.doc, rect, [])).toBe(inner);
    expect(pickTarget(ed.doc, rect, [inner])).toBe(inner);
    ed.setSelection([inner]);
    ed.doubleClick(ptr(175, 175));
    expect(ed.selection).toEqual([rect]);
  });
});

describe('text and export', () => {
  const measure = (s: string) => s.length * 10;

  it('wraps text at word boundaries in a fixed-width box', () => {
    const l = layoutText({ ...DEFAULT_TEXT, characters: 'aaa bbb ccc', fontSize: 10 }, 75, measure);
    expect(l.lines.map((x) => x.text)).toEqual(['aaa bbb', 'ccc']);
    expect(l.height).toBe(24);
  });

  it('breaks words longer than the box', () => {
    const l = layoutText({ ...DEFAULT_TEXT, characters: 'abcdefghij' }, 35, measure);
    expect(l.lines.map((x) => x.text)).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('escapes text and names in SVG', () => {
    const ed = setup();
    ed.pasteText('<script>alert("x")</script> & co');
    const id = ed.selection[0];
    ed.rename(id, '"><img src=x onerror=alert(1)>');
    const { svg } = svgMarkup(ed.doc, { ids: [id], background: null });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;script&gt;');
    expect(escapeXml('a\u0001b')).toBe('ab');
  });
});

describe('frames as groups', () => {
  it('Ctrl+G wraps and Ctrl+Shift+G unwraps without moving anything', () => {
    const ed = setup();
    ed.setTool('rect');
    drag(ed, [100, 100], [150, 150]);
    ed.setTool('ellipse');
    drag(ed, [200, 200], [260, 260]);
    ed.selectAll();
    const before = ed.selection.map((id) => ed.doc.worldBounds(id));
    const key = (shift: boolean) => ({ code: 'KeyG', key: 'g', shift, alt: false, mod: true, repeat: false });
    ed.keyDown(key(false));
    expect(ed.doc.get(ed.selection[0])!.type).toBe('FRAME');
    ed.keyDown(key(true));
    expect([...ed.doc.all()].every((n) => n.type !== 'FRAME')).toBe(true);
    expect(ed.selection.map((id) => ed.doc.worldBounds(id))).toEqual(before);
    ed.undo();
    expect([...ed.doc.all()].some((n) => n.type === 'FRAME')).toBe(true);
  });
});

describe('frame labels', () => {
  it('clicking a top-level frame name selects the frame, dragging it moves the frame', () => {
    const ed = setup();
    ed.setTool('frame');
    drag(ed, [100, 100], [400, 300]);
    const frame = ed.selection[0];
    ed.setTool('rect');
    drag(ed, [150, 150], [200, 200]);
    ed.setSelection([]);
    drag(ed, [104, 92], [154, 142]);
    expect(ed.selection).toEqual([frame]);
    expect(ed.doc.get(frame)).toMatchObject({ x: 150, y: 150 });
  });
});
