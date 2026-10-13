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

describe('components cannot blow up', () => {
  // component L holds `fan` instances of component L+1
  function chainOfComponents(fan: number, levels: number): SceneNode[] {
    const nodes: SceneNode[] = [];
    for (let l = 0; l < levels; l++) {
      nodes.push({ ...frame(`c${l}`, null), type: 'COMPONENT', x: l * 100 });
      if (l + 1 < levels)
        for (let i = 0; i < fan; i++)
          nodes.push({ ...frame(`c${l}i${i}`, `c${l}`), type: 'INSTANCE', componentId: `c${l + 1}`, radii: undefined, clipsContent: undefined });
    }
    return nodes;
  }

  it('refuses files whose instances expand exponentially', () => {
    expect(validateTree(chainOfComponents(4, 4))).toBeNull();
    expect(validateTree(chainOfComponents(10, 8))).toMatch(/expands to more than/);
  });

  it('finds cycles through components nested inside components', () => {
    const nodes: SceneNode[] = [
      { ...frame('A', null), type: 'COMPONENT' },
      { ...frame('B', 'A'), type: 'COMPONENT' },
      { ...frame('i', 'B'), type: 'INSTANCE', componentId: 'A', radii: undefined, clipsContent: undefined },
    ];
    expect(validateTree(nodes)).toMatch(/instance of itself/);
  });

  it('the editor refuses to place such an instance', () => {
    const ed = new Editor();
    ed.setViewSize(1000, 800);
    ed.load([{ ...frame('A', null), type: 'COMPONENT', width: 400, height: 400 }, { ...frame('B', 'A'), type: 'COMPONENT' }], '#FFFFFF');
    expect(ed.createInstance('A', undefined, 'B')).toBeNull();
  });
});

describe('derived geometry stays saveable', () => {
  it('a hugging auto layout frame never grows past the size limit', () => {
    const ed = new Editor();
    ed.load(
      [
        { ...frame('f', null), layout: { mode: 'horizontal', gap: 0, padding: [0, 0, 0, 0], primaryAlign: 'start', crossAlign: 'start', widthMode: 'hug', heightMode: 'hug' } },
        { ...frame('a', 'f', { order: 'a0' }), type: 'RECTANGLE', clipsContent: undefined, width: 6e6 },
        { ...frame('b', 'f', { order: 'a1' }), type: 'RECTANGLE', clipsContent: undefined, width: 6e6 },
      ],
      '#FFFFFF',
    );
    ed.updateNodes(['a'], (n) => ({ ...n, name: 'x' }));
    for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success).toBe(true);
  });
});

describe('export details', () => {
  it('embeds an image once however often it is used', () => {
    const doc = new SceneDoc();
    const img = { type: 'IMAGE' as const, imageId: 'a'.repeat(64), scaleMode: 'fill' as const, opacity: 1, visible: true };
    doc.load([
      { ...frame('r1', null), type: 'RECTANGLE', clipsContent: undefined, fills: [img] },
      { ...frame('r2', null, { order: 'a1' }), type: 'RECTANGLE', clipsContent: undefined, fills: [img] },
    ]);
    const images = new Map([[img.imageId, { url: 'data:image/png;base64,AAAA', width: 10, height: 10 }]]);
    const { svg } = svgMarkup(doc, { ids: ['r1', 'r2'], background: null }, { images });
    expect(svg.split('data:image/png').length - 1).toBe(1);
    expect(svg.split('<use ').length - 1).toBe(2);
  });

  it('file names avoid names Windows cannot use', () => {
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('...')).toBe('export');
    expect(safeFileName('report. ')).toBe('report');
  });
});
