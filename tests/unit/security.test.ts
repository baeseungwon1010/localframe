import { describe, expect, it } from 'vitest';
import { Editor } from '../../src/engine/editor.ts';
import { svgMarkup } from '../../src/engine/export.ts';
import { SceneDoc } from '../../src/engine/doc.ts';
import { MAX_DEPTH, SceneNodeSchema, isValidOrderKey, validateTree, type SceneNode } from '../../shared/schema.ts';
import { safeFileName } from '../../src/ui/download.ts';

function frame(id: string, parentId: string | null, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: 'FRAME',
    parentId,
    order: 'a0',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 1,
    y: 1,
    width: 10,
    height: 10,
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside',
    strokeDash: [],
    radii: [0, 0, 0, 0],
    clipsContent: false,
    ...extra,
  };
}

function chain(n: number): SceneNode[] {
  return Array.from({ length: n }, (_, i) => frame(`f${i}`, i === 0 ? null : `f${i - 1}`));
}

const clip = (data: unknown) => 'localframe-clipboard:' + JSON.stringify(data);

describe('clipboard paste is validated', () => {
  const bad = [
    { roots: ['x'], nodes: [{ ...frame('x', null), fills: [{ color: '"/><script>alert(1)</script>', opacity: 1, visible: true }] }] },
    { roots: ['x'], nodes: [{ ...frame('x', null), extra: 1 }] },
    { roots: ['x'], nodes: [null] },
    { roots: ['a'], nodes: [frame('a', 'b'), frame('b', 'a')] },
    { roots: ['r'], nodes: [{ ...frame('r', null), type: 'RECTANGLE', clipsContent: undefined }, frame('c', 'r')] },
    { roots: ['t'], nodes: [{ ...frame('t', null), type: 'TEXT', clipsContent: undefined, radii: undefined }] },
    { roots: 'x', nodes: [] },
  ];
  for (const [i, data] of bad.entries()) {
    it(`ignores malformed clipboard data #${i + 1}`, () => {
      const ed = new Editor();
      expect(() => ed.pasteText(clip(data))).not.toThrow();
      expect(ed.doc.size).toBe(0);
      // and the editor still records new steps afterwards
      ed.pasteText('hello');
      expect(ed.doc.size).toBe(1);
      expect(ed.canUndo).toBe(true);
    });
  }

  it('still pastes valid data', () => {
    const ed = new Editor();
    ed.pasteText(clip({ roots: ['a'], nodes: [frame('a', null), { ...frame('b', 'a') }] }));
    expect(ed.doc.size).toBe(2);
  });
});

describe('transactions', () => {
  it('roll back and close when a step throws', () => {
    const ed = new Editor();
    ed.pasteText('one');
    const id = ed.selection[0];
    expect(() =>
      ed.transact(() => {
        ed.put({ ...ed.doc.get(id)!, name: 'changed' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ed.doc.get(id)!.name).not.toBe('changed');
    ed.rename(id, 'after');
    expect(ed.doc.get(id)!.name).toBe('after');
    ed.undo();
    expect(ed.doc.get(id)!.name).not.toBe('after');
  });
});

describe('tree validation', () => {
  it('is linear: a 50 000 layer chain is checked quickly and refused for depth', () => {
    const t0 = performance.now();
    expect(validateTree(chain(50_000))).toMatch(/nested more than/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('allows nesting up to the limit', () => {
    expect(validateTree(chain(MAX_DEPTH))).toBeNull();
    expect(validateTree(chain(MAX_DEPTH + 1))).toMatch(/nested more than/);
  });

  it('finds cycles and missing parents', () => {
    expect(validateTree([frame('a', 'b'), frame('b', 'a')])).toMatch(/cycle/);
    expect(validateTree([frame('a', 'zzz')])).toMatch(/missing parent/);
  });

  it('deep trees do not overflow the client', () => {
    const doc = new SceneDoc();
    doc.load(chain(20_000));
    expect(doc.descendants('f0')).toHaveLength(19_999);
    expect(doc.world('f19999')[4]).toBe(20_000);
  });
});

describe('schema', () => {
  it('rejects order keys the editor cannot insert next to', () => {
    for (const k of ['a', '~', 'a00', 'a0 ', '0']) expect(isValidOrderKey(k)).toBe(false);
    for (const k of ['a0', 'a1', 'Zz', 'b00x']) expect(isValidOrderKey(k)).toBe(true);
    expect(SceneNodeSchema.safeParse(frame('x', null, { order: 'a' })).success).toBe(false);
  });
});

describe('limits and escaping', () => {
  it('auto-sized text never exceeds the size the server accepts', () => {
    const ed = new Editor();
    ed.pasteText('x'.repeat(20_000));
    const id = ed.selection[0];
    ed.updateNodes([id], (n) => ({ ...n, text: { ...n.text!, fontSize: 2000 } }));
    expect(SceneNodeSchema.safeParse(ed.doc.get(id)).success).toBe(true);
  });

  it('escapes colours in SVG even if a bad value got in', () => {
    const doc = new SceneDoc();
    doc.load([{ ...frame('a', null), fills: [{ color: '"/><script>x</script>', opacity: 1, visible: true }] }]);
    expect(svgMarkup(doc, { ids: ['a'], background: null }).svg).not.toContain('<script>');
  });

  it('download names drop bidi controls', () => {
    expect(safeFileName('report‮gnp.svg')).toBe('report_gnp.svg');
  });
});
