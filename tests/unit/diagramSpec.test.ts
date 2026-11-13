import { describe, expect, it } from 'vitest';
import { ExportedFileSchema, validateTree } from '../../shared/schema.ts';
import { buildDiagram } from '../../src/diagram/build.ts';
import { lintDiagram } from '../../src/diagram/lint.ts';
import { readSpec } from '../../src/diagram/spec.ts';

const flow = {
  title: 'Checkout',
  groups: [{ id: 'pay', title: 'Payment', nodes: ['card', 'charge'] }],
  nodes: ['cart: Cart', { id: 'card', text: 'Card details', note: 'Number, expiry, CVC' }, 'charge: Charge', { id: 'ok', text: 'Paid', role: 'ok' }, { id: 'fail', text: 'Declined', role: 'danger' }],
  edges: ['cart -> card: Pay', 'card -> charge', 'charge -> ok: approved', 'charge -> fail: declined', 'fail --> card: try again'],
};

describe('diagram specs', () => {
  it('spell out their shorthands', () => {
    const d = readSpec(flow);
    expect(d.direction).toBe('right');
    expect(d.nodes[0]).toEqual({ id: 'cart', text: 'Cart', shape: 'box', role: 'default' });
    expect(d.nodes[1].group).toBe('pay');
    expect(d.edges[4]).toEqual({ from: 'fail', to: 'card', label: 'try again', dashed: true, arrow: 'end' });
    expect(readSpec({ nodes: ['a', 'b'], edges: ['a <-> b', 'a -- b'] }).edges.map((e) => e.arrow)).toEqual(['both', 'none']);
  });

  it('say everything that is wrong at once', () => {
    expect(() => readSpec({ nodes: ['a', 'a'], edges: ['a -> nowhere', 'what'] })).toThrow(/listed twice[\s\S]*no node "nowhere"[\s\S]*can't read "what"/);
    expect(() => readSpec({ nodes: [] })).toThrow(/nodes/);
  });

  it('build a file that imports, laid out along the flow with nothing overlapping', () => {
    const b = buildDiagram(flow);
    const file = ExportedFileSchema.parse(b.file);
    expect(validateTree(file.nodes, file.pages)).toBeNull();
    const box = (id: string) => b.doc.get(b.ids.nodes.get(id)!)!;
    // left to right, the loop back doesn't push the card after the failure
    expect(box('cart').x).toBeLessThan(box('card').x);
    expect(box('card').x).toBeLessThan(box('charge').x);
    expect(box('charge').x).toBeLessThan(box('ok').x);
    // every edge is bound to its boxes, and the fan of outcomes has its words on its own stretch
    const lines = b.ids.edges.map((id) => b.doc.get(id)!);
    expect(lines.every((l) => l.startBind && l.endBind && l.elbow)).toBe(true);
    expect(lines[2].labelAt).toBeGreaterThan(0.5);
    // the group frame holds its boxes
    const frame = b.doc.get(b.ids.groups.get('pay')!)!;
    for (const id of ['card', 'charge']) {
      const n = box(id);
      expect(n.x).toBeGreaterThan(frame.x);
      expect(n.x + n.width).toBeLessThan(frame.x + frame.width);
    }
    const lint = lintDiagram(b);
    expect(lint.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('flag what a reader would trip over', () => {
    const chain = Array.from({ length: 14 }, (_, i) => `n${i}: Step number ${i + 1}`);
    const long = lintDiagram(buildDiagram({ nodes: chain, edges: chain.slice(1).map((_, i) => `n${i} -> n${i + 1}`) }));
    expect(long.issues.map((i) => i.code)).toContain('tiny-text');
    const busy = lintDiagram(
      buildDiagram({
        nodes: [
          { id: 'a', text: 'A box that tries to say far too much in its one line of text', role: 'primary' },
          { id: 'b', role: 'danger' },
          { id: 'c', role: 'ok' },
          { id: 'd', role: 'warning' },
          { id: 'e', role: 'external' },
        ],
      }),
    );
    expect(busy.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['long-text', 'too-much-colour']));
  });
});

describe('diagram specs in the app', () => {
  it('are told apart from localframe files', async () => {
    const { isDiagramSpec } = await import('../../src/ui/diagramFile.ts');
    expect(isDiagramSpec(flow)).toBe(true);
    expect(isDiagramSpec(buildDiagram(flow).file)).toBe(false);
    expect(isDiagramSpec({ nodes: [{ id: 'a', type: 'RECTANGLE' }] })).toBe(false);
    expect(isDiagramSpec([flow])).toBe(false);
  });

  it('come in links, plain or packed', async () => {
    const { readDiagramLink } = await import('../../src/ui/shareLink.ts');
    expect(await readDiagramLink(encodeURIComponent(JSON.stringify(flow)))).toEqual(flow);
    const { deflateRawSync } = await import('node:zlib');
    const packed = `v1.${deflateRawSync(JSON.stringify(flow)).toString('base64url')}`;
    expect(await readDiagramLink(packed)).toEqual(flow);
    await expect(readDiagramLink('%7Bnope')).rejects.toThrow(/diagram link/);
  });
});
