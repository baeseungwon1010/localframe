import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { TouchGestures } from '../../src/ui/editor/touch.ts';

const ptr = (sx: number, sy: number, touch = false): PointerInput => ({ sx, sy, button: 0, shift: false, alt: false, mod: false, touch });

describe('touch gestures', () => {
  it('a second finger starts a pinch: the view pans with the centre and zooms with the spread', () => {
    const t = new TouchGestures();
    expect(t.down(1, { x: 100, y: 100 })).toBe('editor');
    expect(t.down(2, { x: 200, y: 100 })).toBe('pinch');
    // spread to twice the distance around the same centre
    expect(t.move(2, { x: 250, y: 100 })).toMatchObject({ dx: 25, dy: 0 });
    const step = t.move(1, { x: 50, y: 100 });
    expect(step).toMatchObject({ dx: -25, dy: 0, at: { x: 150, y: 100 } });
    expect(typeof step === 'object' && step.zoom).toBeCloseTo(200 / 150, 5);
    // lifting one finger doesn't hand the other back to the editor
    expect(t.up(1, { x: 50, y: 100 }, 0)).toBe('ignore');
    expect(t.move(2, { x: 260, y: 100 })).toBe('ignore');
    expect(t.up(2, { x: 260, y: 100 }, 0)).toBe('ignore');
    expect(t.pinching).toBe(false);
    expect(t.down(3, { x: 0, y: 0 })).toBe('editor');
  });

  it('two quick taps in one place are a double tap; slow or far apart ones are not', () => {
    const t = new TouchGestures();
    t.down(1, { x: 10, y: 10 });
    expect(t.up(1, { x: 10, y: 10 }, 1000)).toBe('editor');
    t.down(2, { x: 14, y: 12 });
    expect(t.up(2, { x: 14, y: 12 }, 1200)).toBe('double-tap');
    t.down(3, { x: 10, y: 10 });
    t.up(3, { x: 10, y: 10 }, 2000);
    t.down(4, { x: 10, y: 10 });
    expect(t.up(4, { x: 10, y: 10 }, 2500)).toBe('editor');
    t.down(5, { x: 100, y: 10 });
    expect(t.up(5, { x: 100, y: 10 }, 2600)).toBe('editor');
  });

  it('a still finger held down opens the menu; a moving one is a drag', () => {
    const t = new TouchGestures();
    t.down(1, { x: 10, y: 10 });
    t.move(1, { x: 13, y: 12 });
    expect(t.longPress(1)).toBe(true);
    // the rest of that touch is spent
    expect(t.move(1, { x: 40, y: 40 })).toBe('ignore');
    expect(t.up(1, { x: 40, y: 40 }, 0)).toBe('ignore');
    t.down(2, { x: 10, y: 10 });
    t.move(2, { x: 30, y: 10 });
    expect(t.longPress(2)).toBe(false);
    expect(t.up(2, { x: 30, y: 10 }, 0)).toBe('editor');
  });

  it('fingers reach handles and "+" buttons from further away than a mouse', () => {
    const ed = new Editor();
    ed.setViewSize(1000, 800);
    ed.setTool('rect');
    ed.pointerDown(ptr(100, 100));
    ed.pointerMove(ptr(200, 200));
    ed.pointerUp(ptr(200, 200));
    // 14px in from the bottom-right corner: too far for a mouse, near enough for a finger
    expect(ed.handleAt(190, 190)).toBeNull();
    ed.pointerDown(ptr(600, 600, true));
    ed.pointerUp(ptr(600, 600, true));
    expect(ed.coarse).toBe(true);
    ed.setSelection([[...ed.doc.all()][0].id]);
    expect(ed.handleAt(190, 190)).not.toBeNull();
    // a mouse press puts things back
    ed.pointerDown(ptr(600, 600));
    ed.pointerUp(ptr(600, 600));
    expect(ed.coarse).toBe(false);
  });
});
