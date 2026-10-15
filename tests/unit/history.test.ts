import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';

const ptr = (sx: number, sy: number): PointerInput => ({ sx, sy, button: 0, shift: false, alt: false, mod: false });

function drawTwo() {
  const ed = new Editor();
  ed.setViewSize(1000, 800);
  for (const x of [100, 400]) {
    ed.setTool('rect');
    ed.pointerDown(ptr(x, 100));
    ed.pointerMove(ptr(x + 50, 150));
    ed.pointerUp(ptr(x + 100, 200));
  }
  ed.updateNodes([ed.selection[0]], (n) => ({ ...n, opacity: 0.5 }));
  return ed;
}

/** A copy of the file as storage would hand it back: same data, keys in another order. */
const reloaded = (ed: Editor) => [...ed.doc.all()].map((n) => Object.fromEntries(Object.entries(structuredClone(n)).reverse()) as typeof n);

describe('undo history across visits', () => {
  it('comes back for the same file and undoes as before', () => {
    const ed = drawTwo();
    const saved = structuredClone(ed.historySnapshot());
    const next = new Editor();
    next.load(reloaded(ed), ed.pages);
    expect(next.restoreHistory(saved)).toBe(true);
    expect(next.canUndo).toBe(true);
    next.undo();
    expect([...next.doc.all()].find((n) => n.type === 'RECTANGLE' && n.x > 300)!.opacity).toBe(1);
    next.undo();
    next.undo();
    expect(next.doc.size).toBe(0);
    // redo works again within the visit
    next.redo();
    expect(next.doc.size).toBe(1);
  });

  it('is dropped when the file changed since (another tab, a restored version)', () => {
    const ed = drawTwo();
    const saved = structuredClone(ed.historySnapshot());
    const nodes = reloaded(ed);
    nodes[0] = { ...nodes[0], x: nodes[0].x + 10 };
    const next = new Editor();
    next.load(nodes, ed.pages);
    expect(next.restoreHistory(saved)).toBe(false);
    expect(next.canUndo).toBe(false);
  });

  it('refuses damaged data and keeps within its size limit', () => {
    const ed = drawTwo();
    expect(ed.restoreHistory({ undo: [{ patches: [{ id: 'x', before: { bogus: true }, after: null }], selBefore: [], selAfter: [] }], redo: [] })).toBe(false);
    expect(ed.restoreHistory('nonsense')).toBe(false);
    const small = ed.historySnapshot(100, 2000);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(2000);
    expect(ed.historySnapshot(1).undo).toHaveLength(1);
  });

  it('is dropped when pages changed elsewhere, and only takes pages, styles and variables from a step', () => {
    const ed = drawTwo();
    ed.addPage();
    const saved = structuredClone(ed.historySnapshot());
    // another tab removed the page this history added
    const next = new Editor();
    next.load(reloaded(ed), ed.pages.slice(0, 1));
    expect(next.restoreHistory(saved)).toBe(false);
    // a damaged step's file state is refused
    const bad = structuredClone(saved);
    (bad.undo[bad.undo.length - 1] as { fileBefore?: unknown }).fileBefore = { pages: 'garbage', styles: [], variables: {} };
    const again = new Editor();
    again.load(reloaded(ed), ed.pages);
    expect(again.restoreHistory(bad)).toBe(false);
  });

  it('saving stays quick: each step is measured once', () => {
    const ed = drawTwo();
    for (let i = 0; i < 50; i++) ed.updateNodes([ed.selection[0]], (n) => ({ ...n, x: n.x + 1 }));
    ed.historySnapshot();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) ed.historySnapshot();
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
