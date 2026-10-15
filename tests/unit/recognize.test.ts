import { describe, expect, it } from 'vitest';
import { recognizeStroke } from '../../src/engine/recognize.ts';

type P = { x: number; y: number };
/** A seeded wobble, so hand-drawn strokes are the same every run. */
function wobbly(points: P[], amount: number, seed = 1): P[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return points.map((p) => ({ x: p.x + rnd() * amount, y: p.y + rnd() * amount }));
}
function along(corners: P[], perSide = 20, close = true): P[] {
  const out: P[] = [];
  const n = close ? corners.length : corners.length - 1;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let k = 0; k < perSide; k++) out.push({ x: a.x + ((b.x - a.x) * k) / perSide, y: a.y + ((b.y - a.y) * k) / perSide });
  }
  out.push(close ? { ...corners[0] } : corners[corners.length - 1]);
  return out;
}
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 80): P[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: cx + rx * Math.cos((i / n) * Math.PI * 2), y: cy + ry * Math.sin((i / n) * Math.PI * 2) }));

describe('hand-drawn shapes', () => {
  it('knows rectangles, ellipses, diamonds and triangles, even shaky ones', () => {
    for (const seed of [1, 2, 3]) {
      expect(recognizeStroke(wobbly(along([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }]), 4, seed))?.kind).toBe('rect');
      expect(recognizeStroke(wobbly(ellipse(100, 60, 100, 60), 4, seed))?.kind).toBe('ellipse');
      expect(recognizeStroke(wobbly(along([{ x: 100, y: 0 }, { x: 200, y: 80 }, { x: 100, y: 160 }, { x: 0, y: 80 }]), 4, seed))?.kind).toBe('diamond');
      expect(recognizeStroke(wobbly(along([{ x: 100, y: 0 }, { x: 200, y: 170 }, { x: 0, y: 170 }]), 3, seed))?.kind).toBe('triangle');
    }
  });

  it('a rectangle keeps the size it was drawn at', () => {
    const r = recognizeStroke(along([{ x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 140 }, { x: 10, y: 140 }]))!;
    expect(r).toMatchObject({ kind: 'rect', box: { x: 10, y: 20 } });
    if (r.kind !== 'line') {
      expect(r.box.width).toBeCloseTo(200, 0);
      expect(r.box.height).toBeCloseTo(120, 0);
    }
  });

  it('a nearly straight stroke is a line from where it began to where it ended', () => {
    const r = recognizeStroke(wobbly(along([{ x: 0, y: 0 }, { x: 300, y: 40 }], 40, false), 2));
    expect(r?.kind).toBe('line');
  });

  it('scribbles, open curves and tiny marks stay drawings', () => {
    const zigzag = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: i % 2 ? 0 : 60 }));
    expect(recognizeStroke(zigzag)).toBeNull();
    const arc = ellipse(100, 100, 100, 100, 80).slice(0, 45);
    expect(recognizeStroke(arc)).toBeNull();
    expect(recognizeStroke(along([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }]))).toBeNull();
    // a spiral closes nowhere near a shape
    const spiral = Array.from({ length: 120 }, (_, i) => ({ x: 100 + (i / 2) * Math.cos(i / 6), y: 100 + (i / 2) * Math.sin(i / 6) }));
    expect(recognizeStroke(spiral)).toBeNull();
  });

  it('on a board the pencil turns a drawn box into a diagram box, and a line between shapes into an arrow', async () => {
    const { Editor } = await import('../../src/engine/editor.ts');
    const ed = new Editor();
    ed.setViewSize(1000, 800);
    ed.recognizeShapes = true;
    const ptr = (sx: number, sy: number, shift = false) => ({ sx, sy, button: 0, shift, alt: false, mod: false });
    const stroke = (pts: P[], shift = false) => {
      ed.setTool('pencil');
      ed.pointerDown(ptr(pts[0].x, pts[0].y));
      for (const p of pts.slice(1)) ed.pointerMove(ptr(p.x, p.y));
      ed.pointerUp(ptr(pts[pts.length - 1].x, pts[pts.length - 1].y, shift));
    };
    stroke(wobbly(along([{ x: 100, y: 100 }, { x: 260, y: 100 }, { x: 260, y: 180 }, { x: 100, y: 180 }]), 3));
    const box = ed.doc.get(ed.selection[0])!;
    expect(box).toMatchObject({ type: 'RECTANGLE', radii: [12, 12, 12, 12] });
    expect(box.label).toBeDefined();
    stroke(wobbly(ellipse(600, 140, 80, 50), 3));
    const circle = ed.doc.get(ed.selection[0])!;
    expect(circle.type).toBe('ELLIPSE');
    // a line from the box to the circle connects them
    stroke(along([{ x: 200, y: 140 }, { x: 590, y: 145 }], 30, false));
    const arrow = ed.doc.get(ed.selection[0])!;
    expect(arrow).toMatchObject({ type: 'LINE', arrowEnd: true, startBind: { nodeId: box.id }, endBind: { nodeId: circle.id } });
    // Shift keeps a drawing as drawn
    stroke(wobbly(along([{ x: 100, y: 400 }, { x: 260, y: 400 }, { x: 260, y: 480 }, { x: 100, y: 480 }]), 3), true);
    expect(ed.doc.get(ed.selection[0])!.type).toBe('VECTOR');
    // one stroke is one undo step, and no leftover drawing
    expect([...ed.doc.all()].filter((n) => n.type === 'VECTOR')).toHaveLength(1);
    ed.undo();
    expect([...ed.doc.all()].filter((n) => n.type === 'VECTOR')).toHaveLength(0);
  });
});
