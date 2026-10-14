import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { cssFor } from '../../src/engine/css.ts';
import { exportTargetFor, svgMarkup } from '../../src/engine/export.ts';
import { instanceDoc } from '../../src/engine/instances.ts';
import { isScreen, presentationDoc, setPresentationMode, swapVariant, tweenScreens } from '../../src/engine/prototype.ts';
import { imageFilter } from '../../src/engine/render.ts';
import { displayText, layoutText } from '../../src/engine/text.ts';
import { adjustRuns } from '../../src/engine/textRuns.ts';
import { simplifyPoints, smoothPath } from '../../src/engine/vector.ts';
import { type SceneNode, type TextStyle, SceneNodeSchema, TextRunSchema, validateTree } from '../../shared/schema.ts';

const ptr = (sx: number, sy: number): PointerInput => ({ sx, sy, button: 0, shift: false, alt: false, mod: false });
function drag(ed: Editor, from: [number, number], to: [number, number]) {
  ed.pointerDown(ptr(...from));
  ed.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  ed.pointerMove(ptr(...to));
  ed.pointerUp(ptr(...to));
}
function setup() {
  const ed = new Editor();
  ed.setViewSize(1000, 800);
  return ed;
}
const draw = (ed: Editor, tool: Parameters<Editor['setTool']>[0], from: [number, number], to: [number, number]) => {
  ed.setTool(tool);
  drag(ed, from, to);
  return ed.selection[0];
};
const valid = (ed: Editor) => {
  for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success, JSON.stringify(SceneNodeSchema.safeParse(n).error?.issues)).toBe(true);
  expect(validateTree(ed.doc.all(), ed.pages)).toBeNull();
};
const text = (characters: string, extra: Partial<TextStyle> = {}): TextStyle => ({
  characters,
  fontFamily: 'Inter',
  fontWeight: 400,
  fontSize: 10,
  lineHeight: 12,
  letterSpacing: 0,
  align: 'left',
  autoResize: 'height',
  ...extra,
});
// tests measure text roughly: half the font size per character
const measure = (s: string, font: string) => [...s].length * Number(/(\d+)px/.exec(font)![1]) * 0.5;

describe('code tab', () => {
  it('writes CSS for boxes and auto layout', () => {
    const ed = setup();
    const f = draw(ed, 'frame', [0, 0], [300, 200]);
    const r = draw(ed, 'rect', [10, 10], [60, 60]);
    ed.updateNodes([r], (n) => ({ ...n, radii: [8, 8, 8, 8], effects: [{ type: 'DROP_SHADOW', color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 8, spread: 0, visible: true }] }));
    const css = cssFor(ed.doc, ed.doc.get(r)!).join('\n');
    expect(css).toContain('border-radius: 8px;');
    expect(css).toContain('position: absolute;');
    expect(css).toContain('box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.25);');
    ed.setSelection([f]);
    ed.addAutoLayout();
    const fcss = cssFor(ed.doc, ed.doc.get(f)!).join('\n');
    expect(fcss).toContain('display: flex;');
    expect(fcss).toContain('flex-direction: column;');
  });
});

describe('drawing', () => {
  it('pencil strokes are simplified and smoothed into an open vector', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 2 ? 0.2 : 0 }));
    expect(simplifyPoints(pts, 1)).toHaveLength(2);
    const smooth = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
    expect(smooth[1].in).toBeDefined();
    expect(smooth[0].in).toBeUndefined();
    const ed = setup();
    ed.setTool('pencil');
    ed.pointerDown(ptr(100, 100));
    for (let i = 1; i <= 30; i++) ed.pointerMove(ptr(100 + i * 4, 100 + Math.sin(i / 3) * 30));
    ed.pointerUp(ptr(220, 100));
    const n = ed.doc.get(ed.selection[0])!;
    expect(n.type).toBe('VECTOR');
    expect(n.vector!.closed).toBe(false);
    expect(n.vector!.points.length).toBeLessThan(31);
    valid(ed);
  });

  it('flattens rectangles, ellipses and lines into vectors', () => {
    const ed = setup();
    const r = draw(ed, 'rect', [0, 0], [100, 60]);
    ed.updateNodes([r], (n) => ({ ...n, radii: [10, 0, 0, 0] }));
    const e = draw(ed, 'ellipse', [200, 0], [300, 60]);
    const l = draw(ed, 'line', [400, 0], [500, 50]);
    ed.setSelection([r, e, l]);
    ed.flattenSelection();
    expect(ed.doc.get(r)).toMatchObject({ type: 'VECTOR', width: 100, height: 60 });
    expect(ed.doc.get(r)!.vector!.points).toHaveLength(5); // rounded corner = 2 points
    expect(ed.doc.get(e)!.vector!.points).toHaveLength(4);
    expect(ed.doc.get(l)!.vector!.closed).toBe(false);
    valid(ed);
  });

  it('keeps stroke sides, caps, gradients, images and effects valid and exports them', () => {
    const ed = setup();
    const r = draw(ed, 'rect', [0, 0], [100, 60]);
    ed.updateNodes([r], (n) => ({
      ...n,
      strokes: [{ color: '#000000', opacity: 1, visible: true }],
      strokeSides: [0, 0, 4, 0],
      strokeJoin: 'bevel',
      fills: [{ type: 'GRADIENT_ANGULAR', stops: [{ position: 0, color: '#FF0000', opacity: 1 }, { position: 1, color: '#0000FF', opacity: 1 }], from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, opacity: 1, visible: true }],
      effects: [
        { type: 'NOISE', color: '#000000', amount: 0.2, size: 1, visible: true },
        { type: 'PROGRESSIVE_BLUR', start: 0, end: 10, direction: 'down', visible: true },
      ],
    }));
    valid(ed);
    const svg = svgMarkup(ed.doc, { ids: [r], background: null }).svg;
    expect(svg).toContain('feTurbulence');
    expect(svg).toMatch(/<rect x="0" y="56" width="100" height="4"/);
    expect(imageFilter({ type: 'IMAGE', imageId: 'a'.repeat(64), scaleMode: 'tile', opacity: 1, visible: true, adjust: { exposure: 50, contrast: 0, saturation: -100 } })).toBe(
      'brightness(1.5) contrast(1) saturate(0)',
    );
    expect(SceneNodeSchema.safeParse({ ...ed.doc.get(r)!, exportSettings: [{ format: 'png', scale: 2, suffix: '"><script>' }] }).success).toBe(false);
  });
});

describe('text', () => {
  it('lays out lists, paragraph spacing, case and a line limit', () => {
    const t = text('one\ntwo\nthree', { lists: ['bullet', 'number', 'number'], paragraphSpacing: 5 });
    const l = layoutText(t, 200, measure);
    expect(l.lines.map((x) => x.marker)).toEqual(['•', '1.', '2.']);
    expect(l.lines[1].top).toBe(12 + 5);
    expect(l.lines[0].indent).toBeGreaterThan(0);
    expect(displayText(text('hello world', { textCase: 'title' }))).toBe('Hello World');
    expect(displayText(text('straße', { textCase: 'upper' }))).toHaveLength(6);
    const long = layoutText(text('aaaa bbbb cccc dddd eeee', { maxLines: 2 }), 50, measure);
    expect(long.lines).toHaveLength(2);
    expect(long.lines[1].segments.at(-1)!.text).toBe('…');
  });

  it('keeps list items on their paragraphs while typing', () => {
    const t = text('a\nb', { lists: [null, 'bullet'] });
    expect(adjustRuns(t, 'x\na\nb').lists).toEqual([null, null, 'bullet']);
    expect(adjustRuns(t, 'a\nb\nc').lists).toEqual([null, 'bullet', 'bullet']);
  });

  it('accepts only web and mail links', () => {
    expect(TextRunSchema.safeParse({ start: 0, end: 1, link: 'https://example.com' }).success).toBe(true);
    expect(TextRunSchema.safeParse({ start: 0, end: 1, link: 'mailto:a@b.c' }).success).toBe(true);
    expect(TextRunSchema.safeParse({ start: 0, end: 1, link: 'javascript:alert(1)' }).success).toBe(false);
    expect(TextRunSchema.safeParse({ start: 0, end: 1, link: 'https://x" onload="y' }).success).toBe(false);
  });
});

describe('prototyping', () => {
  it('smart animate tweens layers that share a name, and fades the rest', () => {
    const ed = setup();
    const a = draw(ed, 'frame', [0, 0], [200, 200]);
    const ra = draw(ed, 'rect', [10, 10], [50, 50]);
    const b = draw(ed, 'frame', [300, 0], [500, 200]);
    const rb = draw(ed, 'rect', [400, 100], [480, 180]);
    ed.updateNodes([ra, rb], (n) => ({ ...n, name: 'Card' }));
    const extra = draw(ed, 'ellipse', [310, 10], [330, 30]);
    const mid = tweenScreens(ed.doc, a, ed.doc, b, 0.5);
    const card = mid.get(rb)!;
    expect(card.x).toBeCloseTo((10 + 100) / 2, 0);
    expect(card.width).toBeCloseTo((40 + 80) / 2, 0);
    expect(mid.get(extra)!.opacity).toBeCloseTo(0.5);
    expect(mid.get(b)!.x).toBe(300);
  });

  it('swaps variants, switches modes on a private copy, and finds screens in sections', () => {
    const ed = setup();
    const c1 = draw(ed, 'rect', [0, 0], [50, 50]);
    ed.setSelection([c1]);
    ed.createComponent();
    const comp1 = ed.selection[0];
    const c2 = draw(ed, 'rect', [100, 0], [150, 50]);
    ed.setSelection([c2]);
    ed.createComponent();
    const comp2 = ed.selection[0];
    ed.setSelection([comp1, comp2]);
    ed.combineAsVariants();
    const inst = ed.createInstance(comp1, { x: 400, y: 400 })!;
    const doc = presentationDoc(ed.doc);
    expect(swapVariant(doc, inst, comp2)).toBe(true);
    expect(doc.get(inst)!.componentId).toBe(comp2);
    expect(ed.doc.get(inst)!.componentId).toBe(comp1); // the design is untouched

    // modes
    ed.setVariables({
      collections: [{ id: 'c', name: 'Theme', modes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }] }],
      vars: [{ id: 'bg', collectionId: 'c', name: 'bg', type: 'COLOR', values: { light: '#FFFFFF', dark: '#000000' } }],
    });
    const r = draw(ed, 'rect', [600, 0], [650, 50]);
    ed.bind([r], 'fill', 'bg');
    const d2 = presentationDoc(ed.doc);
    setPresentationMode(d2, ed.variables, 'c', 'dark');
    expect((d2.get(r)!.fills[0] as { color: string }).color).toBe('#000000');
    expect((ed.doc.get(r)!.fills[0] as { color: string }).color).toBe('#FFFFFF');

    const f = draw(ed, 'frame', [0, 600], [100, 700]);
    draw(ed, 'section', [-20, 580], [200, 750]);
    expect(isScreen(ed.doc, f)).toBe(true);
    valid(ed);
  });
});

describe('components and variables', () => {
  it('instance swap shows the component the property picks', () => {
    const ed = setup();
    const icon1 = draw(ed, 'rect', [0, 0], [20, 20]);
    ed.setSelection([icon1]);
    ed.createComponent();
    const ic1 = ed.selection[0];
    const icon2 = draw(ed, 'ellipse', [50, 0], [70, 20]);
    ed.setSelection([icon2]);
    ed.createComponent();
    const ic2 = ed.selection[0];
    const btn = draw(ed, 'frame', [0, 100], [200, 160]);
    const nested = ed.createInstance(ic1, { x: 10, y: 110 }, btn)!;
    ed.setSelection([btn]);
    ed.createComponent();
    const button = ed.selection[0];
    ed.addComponentProp(button, 'INSTANCE_SWAP');
    const prop = ed.doc.get(button)!.componentProps![0];
    expect(prop).toMatchObject({ type: 'INSTANCE_SWAP', defaultValue: ic1 });
    ed.linkProp(nested, 'swap', prop.id);
    const inst = ed.createInstance(button, { x: 500, y: 500 })!;
    ed.setPropValue(inst, prop.id, ic2);
    const v = instanceDoc(ed.doc, ed.doc.get(inst)!)!;
    const swapped = [...v.all()].find((n) => n.type === 'INSTANCE')!;
    expect(swapped.componentId).toBe(ic2);
    valid(ed);
  });

  it('string and boolean variables drive text and visibility', () => {
    const ed = setup();
    ed.setVariables({
      collections: [{ id: 'c', name: 'Lang', modes: [{ id: 'en', name: 'English' }, { id: 'ko', name: 'Korean' }] }],
      vars: [
        { id: 'hi', collectionId: 'c', name: 'greeting', type: 'STRING', values: { en: 'Hello', ko: '안녕하세요' } },
        { id: 'show', collectionId: 'c', name: 'show', type: 'BOOLEAN', values: { en: true, ko: false } },
      ],
    });
    const f = draw(ed, 'frame', [0, 0], [300, 200]);
    ed.setTool('text');
    drag(ed, [20, 20], [200, 50]);
    const t = ed.editingText!;
    ed.commitTextEdit('x');
    ed.bind([t], 'characters', 'hi');
    expect(ed.doc.get(t)!.text!.characters).toBe('Hello');
    const r = draw(ed, 'rect', [20, 100], [60, 140]);
    ed.bind([r], 'visible', 'show');
    ed.setMode([f], 'c', 'ko');
    expect(ed.doc.get(t)!.text!.characters).toBe('안녕하세요');
    expect(ed.doc.get(r)!.visible).toBe(false);
    valid(ed);
  });

  it('copies a library component with what it uses, and updates it in place', () => {
    const lib = setup();
    const dot = draw(lib, 'ellipse', [0, 0], [10, 10]);
    lib.setSelection([dot]);
    lib.createComponent();
    const dotComp = lib.selection[0];
    const card = draw(lib, 'frame', [0, 100], [100, 160]);
    lib.createInstance(dotComp, { x: 5, y: 105 }, card);
    lib.setSelection([card]);
    lib.createComponent();
    const cardComp = lib.selection[0];

    const ed = setup();
    const source = { fileId: 'lib-file', nodes: [...lib.doc.all()] };
    const out = ed.importLibraryComponent(source, cardComp)!;
    expect(ed.pages.some((p) => p.name === 'Library components')).toBe(true);
    const local = ed.doc.get(out.id)!;
    expect(local.libraryRef).toMatchObject({ fileId: 'lib-file', componentId: cardComp });
    // the nested dot came along and the copy's instance points at the local dot
    const localDot = ed.libraryCopy('lib-file', dotComp)!;
    expect([...ed.doc.all()].some((n) => n.type === 'INSTANCE' && n.componentId === localDot.id)).toBe(true);
    const inst = ed.createInstance(out.id, { x: 0, y: 0 })!;
    valid(ed);

    // the library changes: same id, new content, the instance still follows
    lib.updateNodes([cardComp], (n) => ({ ...n, fills: [{ color: '#FF0000', opacity: 1, visible: true }] }));
    const again = ed.importLibraryComponent({ fileId: 'lib-file', nodes: [...lib.doc.all()] }, cardComp)!;
    expect(again.id).toBe(out.id);
    expect((ed.doc.get(out.id)!.fills[0] as { color: string }).color).toBe('#FF0000');
    expect(ed.doc.get(inst)!.componentId).toBe(out.id);
    valid(ed);
  });
});

describe('slices', () => {
  it('export the page under them, never draw, and hold nothing', () => {
    const ed = setup();
    const r = draw(ed, 'rect', [0, 0], [100, 100]);
    const s = draw(ed, 'slice', [50, 50], [150, 150]);
    const t = exportTargetFor(ed.doc, ed.doc.get(s)!, null, '#FFFFFF');
    expect(t.ids).toEqual([r]);
    expect(t.clip).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
    expect(svgMarkup(ed.doc, t).svg).toContain('viewBox="50 50 100 100"');
    const inside: SceneNode = { ...ed.doc.get(r)!, id: 'kid', parentId: s, pageId: undefined };
    expect(validateTree([...ed.doc.all(), inside], ed.pages)).toMatch(/slice/);
    valid(ed);
  });
});
