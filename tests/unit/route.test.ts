import { describe, expect, it } from 'vitest';
import { settleLine } from '../../src/engine/connectors.ts';
import { SceneDoc } from '../../src/engine/doc.ts';
import { linePoints } from '../../src/engine/geometry.ts';
import { apply } from '../../src/engine/math.ts';
import { createNode } from '../../src/engine/nodes.ts';
import { pathBlocked, routeAround } from '../../src/engine/route.ts';
import type { SceneNode } from '../../shared/schema.ts';

function board(withBlocker: boolean) {
  const doc = new SceneDoc();
  doc.load([], 'page-1');
  const add = (n: SceneNode) => {
    doc.set(n);
    return n;
  };
  const a = add(createNode(doc, 'RECTANGLE', null, { x: 0, y: 0, width: 100, height: 60 }));
  const c = add(createNode(doc, 'RECTANGLE', null, { x: 400, y: 0, width: 100, height: 60 }));
  const b = withBlocker ? add(createNode(doc, 'RECTANGLE', null, { x: 200, y: -20, width: 100, height: 100 })) : null;
  const line = createNode(doc, 'LINE', null, { x: 0, y: 0, width: 1, height: 0 });
  const settled = settleLine(doc, { ...line, elbow: true, arrowEnd: true, startBind: { nodeId: a.id, anchor: 'right' }, endBind: { nodeId: c.id, anchor: 'left' } });
  doc.set(settled);
  const world = linePoints(settled).map((p) => apply(doc.world(settled.id), p));
  return { doc, world, b: b && doc.worldBounds(b.id) };
}

describe('connectors around shapes', () => {
  it('a clear path stays the simple straight elbow', () => {
    const { world } = board(false);
    expect(world).toHaveLength(2);
    expect(world[0]).toMatchObject({ x: 100, y: 30 });
    expect(world[1].x).toBeCloseTo(400, 5);
  });

  it('goes around a shape in the way, keeping clear of it, and still meets both sides', () => {
    const { world, b } = board(true);
    expect(world.length).toBeGreaterThan(2);
    expect(pathBlocked(world, [b!])).toBe(false);
    expect(world[0].x).toBeCloseTo(100, 5);
    expect(world[world.length - 1].x).toBeCloseTo(400, 5);
    // every piece is horizontal or vertical
    for (let i = 1; i < world.length; i++) expect(Math.abs(world[i].x - world[i - 1].x) < 0.01 || Math.abs(world[i].y - world[i - 1].y) < 0.01).toBe(true);
  });

  it('goes the long way round a tall wall, and gives up (null) when an end is boxed in', () => {
    const wall = { x: 200, y: -1000, width: 50, height: 2000 };
    const around = routeAround([wall], { x: 100, y: 30 }, { x: 1, y: 0 }, 20, { x: 400, y: 30 }, { x: -1, y: 0 }, 20)!;
    expect(pathBlocked([{ x: 100, y: 30 }, ...around, { x: 400, y: 30 }], [wall])).toBe(false);
    const box = { x: 350, y: -100, width: 200, height: 300 };
    expect(routeAround([box], { x: 100, y: 30 }, { x: 1, y: 0 }, 20, { x: 400, y: 30 }, { x: -1, y: 0 }, 20)).toBeNull();
  });
});
