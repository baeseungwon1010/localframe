import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../../shared/schema.ts';
import {
  applyBox,
  applyConstraints,
  lineEnds,
  lineFromEnds,
  reparentKeepWorld,
  resizeBox,
  rotateAboutCenter,
  snapRect,
} from '../../src/engine/geometry.ts';
import { IDENTITY, apply, localMatrix, multiply, translate } from '../../src/engine/math.ts';

function node(extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'n',
    type: 'RECTANGLE',
    parentId: null,
    order: 'a0',
    name: 'n',
    visible: true,
    locked: false,
    opacity: 1,
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside',
    strokeDash: [],
    ...extra,
  };
}

const plain = { keepAspect: false, fromCenter: false };

describe('resizeBox', () => {
  it('moves only the dragged edges', () => {
    expect(resizeBox(200, 100, 'se', { x: 20, y: 10 }, plain)).toEqual({ l: 0, t: 0, r: 220, b: 110 });
    expect(resizeBox(200, 100, 'w', { x: 20, y: 10 }, plain)).toEqual({ l: 20, t: 0, r: 200, b: 100 });
    expect(resizeBox(200, 100, 'n', { x: 20, y: -10 }, plain)).toEqual({ l: 0, t: -10, r: 200, b: 100 });
  });

  it('resizes from the centre with Alt', () => {
    expect(resizeBox(200, 100, 'e', { x: 10, y: 0 }, { keepAspect: false, fromCenter: true })).toEqual({
      l: -10,
      t: 0,
      r: 210,
      b: 100,
    });
  });

  it('keeps the aspect ratio with Shift on a corner', () => {
    const b = resizeBox(200, 100, 'se', { x: 200, y: 0 }, { keepAspect: true, fromCenter: false });
    expect(b.r - b.l).toBeCloseTo(400);
    expect(b.b - b.t).toBeCloseTo(200);
    expect(b.l).toBe(0);
    expect(b.t).toBe(0);
  });

  it('flips when dragged past the opposite edge', () => {
    const n = applyBox(node(), resizeBox(200, 100, 'e', { x: -250, y: 0 }, plain));
    expect(n.x).toBe(50);
    expect(n.width).toBe(50);
  });
});

describe('transforms', () => {
  it('resizing a rotated node keeps the opposite corner fixed', () => {
    const n = node({ rotation: 30 });
    const before = apply(localMatrix(n.x, n.y, n.rotation), { x: 0, y: 0 });
    const next = applyBox(n, resizeBox(n.width, n.height, 'se', { x: 40, y: 20 }, plain));
    const after = apply(localMatrix(next.x, next.y, next.rotation), { x: 0, y: 0 });
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(next.width).toBe(240);
    expect(next.height).toBe(120);
  });

  it('rotates about the centre', () => {
    const n = node();
    const center = (m: SceneNode) => apply(localMatrix(m.x, m.y, m.rotation), { x: m.width / 2, y: m.height / 2 });
    const r = rotateAboutCenter(n, 90);
    expect(r.rotation).toBe(90);
    expect(center(r).x).toBeCloseTo(center(n).x, 1);
    expect(center(r).y).toBeCloseTo(center(n).y, 1);
  });

  it('reparenting keeps the page position', () => {
    const n = node({ x: 10, y: 20, rotation: 15 });
    const oldParent = translate(100, 100);
    const newParent = multiply(translate(40, 60), localMatrix(0, 0, 0));
    const moved = reparentKeepWorld(n, oldParent, newParent);
    const w0 = apply(multiply(oldParent, localMatrix(n.x, n.y, n.rotation)), { x: 5, y: 5 });
    const w1 = apply(multiply(newParent, localMatrix(moved.x, moved.y, moved.rotation)), { x: 5, y: 5 });
    expect(w1.x).toBeCloseTo(w0.x, 1);
    expect(w1.y).toBeCloseTo(w0.y, 1);
    expect(moved.rotation).toBeCloseTo(15);
    expect(reparentKeepWorld(n, IDENTITY, IDENTITY)).toEqual({ ...n });
  });

  it('builds lines from two end points', () => {
    const l = lineFromEnds(node({ type: 'LINE', height: 0 }), { x: 0, y: 0 }, { x: 0, y: 50 });
    expect(l.width).toBe(50);
    expect(l.rotation).toBe(90);
    const [a, b] = lineEnds(l);
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(50);
  });
});

describe('constraints', () => {
  it('moves and stretches children by their constraints', () => {
    const kids = [
      node({ id: 'a', x: 10, width: 20 }),
      node({ id: 'b', x: 10, width: 20, constraints: { horizontal: 'right', vertical: 'bottom' } }),
      node({ id: 'c', x: 10, width: 20, constraints: { horizontal: 'leftRight', vertical: 'top' } }),
      node({ id: 'd', x: 10, width: 20, constraints: { horizontal: 'scale', vertical: 'center' } }),
    ];
    const [a, b, c, d] = applyConstraints(kids, 100, 100, 200, 150);
    expect(a.x).toBe(10);
    expect(b.x).toBe(110);
    expect(b.y).toBe(100);
    expect(c.width).toBe(120);
    expect(d.x).toBe(20);
    expect(d.width).toBe(40);
    expect(d.y).toBe(75);
  });
});

describe('snapping', () => {
  it('snaps edges within the threshold and reports a guide', () => {
    const s = snapRect({ x: 97, y: 0, width: 10, height: 10 }, [{ x: 0, y: 50, width: 100, height: 10 }], 5);
    expect(s.dx).toBe(-2); // the centre (102) is closer to 100 than the left edge (97)
    expect(s.guides[0]).toMatchObject({ axis: 'x', pos: 100 });
  });
  it('does not snap beyond the threshold', () => {
    const s = snapRect({ x: 80, y: 200, width: 10, height: 10 }, [{ x: 0, y: 0, width: 50, height: 10 }], 5);
    expect(s).toMatchObject({ dx: 0, dy: 0, guides: [] });
  });
});
