import { describe, expect, it } from 'vitest';
import { Editor, type PointerInput } from '../../src/engine/editor.ts';
import { instanceDoc } from '../../src/engine/instances.ts';
import { buildPdf } from '../../src/engine/pdf.ts';
import { buildZip, crc32, uniqueName } from '../../src/engine/zip.ts';
import { SceneNodeSchema, sniffImage, validateTree } from '../../shared/schema.ts';

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

const draw = (ed: Editor, tool: Parameters<Editor['setTool']>[0], from: [number, number], to: [number, number]) => {
  ed.setTool(tool);
  drag(ed, from, to);
  return ed.selection[0];
};

const valid = (ed: Editor) => {
  for (const n of ed.doc.all()) expect(SceneNodeSchema.safeParse(n).success).toBe(true);
  expect(validateTree(ed.doc.all(), ed.pages)).toBeNull();
};

describe('pages', () => {
  it('keeps layers per page, deletes and undoes whole pages', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    const page2 = ed.addPage()!;
    expect(ed.currentPage.id).toBe(page2);
    expect(ed.doc.children(null)).toEqual([]);
    const b = draw(ed, 'ellipse', [100, 100], [200, 200]);
    expect(ed.doc.children(null)).toEqual([b]);
    ed.switchPage(ed.pages[0].id);
    expect(ed.doc.children(null)).toEqual([a]);
    valid(ed);

    ed.deletePage(page2);
    expect(ed.pages).toHaveLength(1);
    expect(ed.doc.has(b)).toBe(false);
    ed.undo();
    expect(ed.pages).toHaveLength(2);
    expect(ed.doc.has(b)).toBe(true);
    valid(ed);
  });

  it('moves layers to another page and reorders pages without moving layers', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    const first = ed.pages[0].id;
    const second = ed.addPage()!;
    ed.switchPage(first);
    ed.setSelection([a]);
    ed.moveSelectionToPage(second);
    expect(ed.doc.pageOf(a)).toBe(second);
    ed.movePage(second, 0);
    expect(ed.pages[0].id).toBe(second);
    expect(ed.doc.pageOf(a)).toBe(second);
    valid(ed);
  });
});

describe('components and instances', () => {
  it('instances follow their component and keep their own text', () => {
    const ed = setup();
    const frame = draw(ed, 'frame', [100, 100], [300, 200]);
    ed.setTool('text');
    ed.pointerDown(ptr(120, 120));
    ed.pointerUp(ptr(120, 120));
    const text = ed.editingText!;
    ed.commitTextEdit('Button');
    ed.setSelection([frame]);
    ed.createComponent();
    expect(ed.doc.get(frame)!.type).toBe('COMPONENT');

    const inst = ed.createInstance(frame)!;
    expect(inst).toBeTruthy();
    const instNode = () => ed.doc.get(inst)!;
    expect(instNode().width).toBe(200);

    // change the main component's text: the instance shows it
    ed.updateNodes([text], (n) => ({ ...n, text: { ...n.text!, characters: 'Sign in' } }));
    const v1 = instanceDoc(ed.doc, instNode())!;
    expect(v1.get(`${inst}~${text}`)!.text!.characters).toBe('Sign in');

    // override in the instance
    ed.setOverride(inst, text, { characters: '로그인' });
    const v2 = instanceDoc(ed.doc, instNode())!;
    expect(v2.get(`${inst}~${text}`)!.text!.characters).toBe('로그인');

    // resizing the component box resizes instances that were not resized themselves
    ed.setSize(frame, 300, null, false);
    expect(instNode().width).toBe(300);
    valid(ed);

    // detach: a plain frame with a copy of the content
    ed.detachInstances([inst]);
    expect(ed.doc.get(inst)!.type).toBe('FRAME');
    expect(ed.doc.children(inst)).toHaveLength(1);
    valid(ed);
  });

  it('refuses an instance inside its own component, and detaches instances when the component is deleted', () => {
    const ed = setup();
    const frame = draw(ed, 'frame', [100, 100], [300, 300]);
    ed.createComponent();
    expect(ed.createInstance(frame, undefined, frame)).toBeNull();
    const inst = ed.createInstance(frame)!;
    ed.setSelection([frame]);
    ed.deleteSelection();
    expect(ed.doc.get(inst)!.type).toBe('FRAME');
    valid(ed);
  });
});

describe('auto layout', () => {
  it('stacks children, hugs them, and fills the container', () => {
    const ed = setup();
    const frame = draw(ed, 'frame', [0, 0], [400, 400]);
    const r1 = draw(ed, 'rect', [50, 50], [150, 100]);
    const r2 = draw(ed, 'rect', [50, 200], [100, 260]);
    ed.setSelection([frame]);
    ed.addAutoLayout();
    const f = () => ed.doc.get(frame)!;
    expect(f().layout?.mode).toBe('vertical');
    // padding 10, gap 10: r1 at y 10 (50 tall), r2 at y 70
    expect(ed.doc.get(r1)).toMatchObject({ x: 10, y: 10 });
    expect(ed.doc.get(r2)).toMatchObject({ x: 10, y: 70 });
    expect(f().height).toBe(10 + 50 + 10 + 60 + 10);
    expect(f().width).toBe(10 + 100 + 10);

    ed.updateNodes([frame], (n) => ({ ...n, layout: { ...n.layout!, mode: 'horizontal', gap: 20 } }));
    expect(ed.doc.get(r2)).toMatchObject({ x: 130, y: 10 });

    // fixed width + a fill child
    ed.setSize(frame, 500, null, false);
    expect(f().layout?.widthMode).toBe('fixed');
    ed.updateNodes([r2], (n) => ({ ...n, layoutChild: { horizontal: 'fill', vertical: 'fixed', absolute: false } }));
    expect(ed.doc.get(r2)!.width).toBe(500 - 10 - 100 - 20 - 10);
    valid(ed);
  });
});

describe('connectors', () => {
  it('an arrow drawn between two shapes stays attached when they move', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    const b = draw(ed, 'rect', [400, 100], [500, 200]);
    const arrow = draw(ed, 'arrow', [150, 150], [450, 150]);
    const line = () => ed.doc.get(arrow)!;
    expect(line().startBind?.nodeId).toBe(a);
    expect(line().endBind?.nodeId).toBe(b);
    // ends sit on the facing sides
    expect(line().x).toBe(200);
    expect(line().width).toBe(200);

    ed.setSelection([b]);
    drag(ed, [450, 150], [450, 450]);
    const l = line();
    const endX = l.x + l.width * Math.cos((l.rotation * Math.PI) / 180);
    const endY = l.y + l.width * Math.sin((l.rotation * Math.PI) / 180);
    expect(endX).toBeCloseTo(450, 0);
    expect(endY).toBeCloseTo(400, 0); // top side of the moved shape

    ed.setSelection([b]);
    ed.deleteSelection();
    expect(line().endBind).toBeUndefined();
    valid(ed);
  });
});

describe('file writers', () => {
  it('writes a PDF with one page per image', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const blob = buildPdf(
      [
        { jpeg, pxWidth: 1, pxHeight: 1, ptWidth: 100, ptHeight: 50 },
        { jpeg, pxWidth: 1, pxHeight: 1, ptWidth: 60, ptHeight: 60 },
      ],
      'Test (1)',
    );
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 100 50]');
    expect(text).toContain('/Title (Test \\(1\\))');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // xref offsets point at objects
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
  });

  it('writes a ZIP with correct checksums and safe unique names', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const used = new Set<string>();
    expect(uniqueName('a.png', used)).toBe('a.png');
    expect(uniqueName('a.png', used)).toBe('a 2.png');
    expect(uniqueName('../../etc/x.png', used)).toBe('_/_/etc/x.png');
    const blob = buildZip([{ name: '페이지/a.png', data: new Uint8Array([1, 2, 3]) }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const end = bytes.length - 22;
    expect([...bytes.subarray(end, end + 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('recognises image types by their bytes and refuses SVG', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
  });
});

describe('groups', () => {
  it('fit their children, scale them when resized, and disappear when empty', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    const b = draw(ed, 'ellipse', [300, 150], [400, 250]);
    ed.setSelection([a, b]);
    ed.groupSelection();
    const g = ed.selection[0];
    expect(ed.doc.get(g)).toMatchObject({ type: 'GROUP', x: 100, y: 100, width: 300, height: 150 });

    // clicking a child selects the group
    ed.setSelection([]);
    drag(ed, [150, 150], [150, 150]);
    expect(ed.selection).toEqual([g]);

    // moving a child refits the group without moving the other child on the page
    ed.updateNodes([b], (n) => ({ ...n, x: n.x + 100 }));
    expect(ed.doc.get(g)!.width).toBe(400);
    expect(ed.doc.worldBounds(a)).toMatchObject({ x: 100, y: 100 });

    // resizing the group scales the children
    ed.setSelection([g]);
    drag(ed, [500, 250], [300, 250]); // east handle at x=500
    expect(ed.doc.get(g)!.width).toBeCloseTo(200, 0);
    expect(ed.doc.get(a)!.width).toBeCloseTo(50, 0);

    // deleting every child removes the group
    ed.setSelection([a, b]);
    ed.deleteSelection();
    expect(ed.doc.has(g)).toBe(false);
    valid(ed);
  });
});

describe('gradients and effects', () => {
  it('validate, and export to SVG gradients and filters', async () => {
    const { svgMarkup } = await import('../../src/engine/export.ts');
    const ed = setup();
    const r = draw(ed, 'rect', [100, 100], [200, 200]);
    ed.updateNodes([r], (n) => ({
      ...n,
      fills: [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: '#FF0000', opacity: 1 }, { position: 1, color: '#0000FF', opacity: 1 }], from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, opacity: 1, visible: true }],
      effects: [
        { type: 'DROP_SHADOW', color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 8, spread: 2, visible: true },
        { type: 'INNER_SHADOW', color: '#FFFFFF', opacity: 0.5, x: 0, y: 1, blur: 0, spread: 0, visible: true },
        { type: 'LAYER_BLUR', radius: 2, visible: true },
      ],
    }));
    valid(ed);
    const { svg } = svgMarkup(ed.doc, { ids: [r], background: null });
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('<feMorphology');
    expect(svg).toContain('operator="arithmetic"');
    expect(svg).toContain('<feGaussianBlur in="m"');
  });

  it('groups cannot carry fills', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    ed.groupSelection();
    const g = ed.doc.get(ed.selection[0])!;
    expect(SceneNodeSchema.safeParse({ ...g, fills: [{ color: '#000000', opacity: 1, visible: true }] }).success).toBe(false);
    void a;
  });
});

describe('pen and vectors', () => {
  it('draws a closed curve, edits a point, and scales with its box', () => {
    const ed = setup();
    ed.setTool('pen');
    ed.pointerDown(ptr(100, 100));
    ed.pointerUp(ptr(100, 100));
    ed.pointerDown(ptr(200, 100));
    ed.pointerMove(ptr(230, 130)); // drag out handles
    ed.pointerUp(ptr(230, 130));
    ed.pointerDown(ptr(150, 200));
    ed.pointerUp(ptr(150, 200));
    ed.pointerDown(ptr(101, 101)); // back on the first point: close
    ed.pointerUp(ptr(101, 101));
    const v = ed.doc.get(ed.selection[0])!;
    expect(v.type).toBe('VECTOR');
    expect(v.vector!.closed).toBe(true);
    expect(v.vector!.points).toHaveLength(3);
    expect(v.vector!.points[1].out).toBeDefined();
    expect(ed.tool).toBe('move');
    expect(v.x).toBeLessThanOrEqual(100);
    valid(ed);

    // edit: drag the third point down by 50
    ed.startVectorEdit(v.id);
    const p3 = ed.vectorParts().find((p) => p.part === 'point' && p.index === 2)!;
    drag(ed, [p3.at.x, p3.at.y], [p3.at.x, p3.at.y + 50]);
    const after = ed.doc.get(v.id)!;
    expect(ed.doc.worldBounds(v.id).y + ed.doc.worldBounds(v.id).height).toBeCloseTo(250, 0);
    ed.exitVectorEdit();

    // resizing scales the points
    const w0 = after.width;
    ed.setSize(v.id, w0 * 2, null, false);
    const scaled = ed.doc.get(v.id)!;
    expect(Math.max(...scaled.vector!.points.map((p) => p.x))).toBeCloseTo(Math.max(...after.vector!.points.map((p) => p.x)) * 2, 0);
    valid(ed);
  });

  it('a single click is not a path', () => {
    const ed = setup();
    ed.setTool('pen');
    ed.pointerDown(ptr(100, 100));
    ed.pointerUp(ptr(100, 100));
    ed.keyDown({ code: 'Enter', key: 'Enter', shift: false, alt: false, mod: false, repeat: false });
    expect(ed.doc.size).toBe(0);
  });
});

describe('booleans and masks', () => {
  it('combines shapes and exports them as SVG masks', async () => {
    const { svgMarkup } = await import('../../src/engine/export.ts');
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [300, 300]);
    const b = draw(ed, 'ellipse', [200, 200], [400, 400]);
    ed.setSelection([a, b]);
    ed.booleanSelection('subtract');
    const bool = ed.doc.get(ed.selection[0])!;
    expect(bool).toMatchObject({ type: 'BOOLEAN', booleanOp: 'subtract', x: 100, y: 100, width: 300, height: 300 });
    expect(ed.doc.children(bool.id)).toEqual([a, b]);
    valid(ed);
    const { svg } = svgMarkup(ed.doc, { ids: [bool.id], background: null });
    expect(svg).toContain('<mask');
    expect(svg).toContain('fill="#000"');
    ed.booleanSelection('intersect');
    expect(ed.doc.get(bool.id)!.booleanOp).toBe('intersect');
  });

  it('use as mask groups the selection with the bottom layer clipping the rest', async () => {
    const { svgMarkup } = await import('../../src/engine/export.ts');
    const ed = setup();
    const a = draw(ed, 'ellipse', [100, 100], [300, 300]);
    const b = draw(ed, 'rect', [50, 50], [400, 400]);
    ed.setSelection([a, b]);
    ed.useAsMask();
    const g = ed.doc.get(ed.selection[0])!;
    expect(g).toMatchObject({ type: 'GROUP', name: 'Mask group' });
    expect(ed.doc.get(a)!.isMask).toBe(true);
    const { svg } = svgMarkup(ed.doc, { ids: [g.id], background: null });
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('clip-path=');
    valid(ed);
  });
});

describe('variants and component properties', () => {
  function buttonComponent(ed: Editor, x: number) {
    const f = draw(ed, 'frame', [x, 100], [x + 160, 150]);
    ed.setTool('text');
    ed.pointerDown(ptr(x + 20, 115));
    ed.pointerUp(ptr(x + 20, 115));
    const t = ed.editingText!;
    ed.commitTextEdit('Label');
    ed.rename(t, 'Label');
    ed.setSelection([f]);
    ed.createComponent();
    return { comp: f, text: t };
  }

  it('combines components into a set, switches variants and keeps overrides by layer name', () => {
    const ed = setup();
    const a = buttonComponent(ed, 100);
    const b = buttonComponent(ed, 300);
    ed.setSelection([a.comp, b.comp]);
    ed.combineAsVariants();
    const set = ed.doc.get(ed.selection[0])!;
    expect(set.type).toBe('COMPONENT_SET');
    expect(ed.doc.get(a.comp)!.variant).toEqual({ 'Property 1': 'Default' });
    expect(ed.doc.get(b.comp)!.name).toBe('Property 1=Variant2');
    valid(ed);

    const inst = ed.createInstance(a.comp, { x: 300, y: 500 })!;
    ed.setOverride(inst, a.text, { characters: 'Buy' });
    ed.setVariant(inst, 'Property 1', 'Variant2');
    const i = ed.doc.get(inst)!;
    expect(i.componentId).toBe(b.comp);
    expect(i.overrides?.[b.text]?.characters).toBe('Buy');

    ed.addVariant(set.id);
    expect(ed.doc.children(set.id)).toHaveLength(3);
    valid(ed);
  });

  it('text and boolean properties drive linked layers in instances', () => {
    const ed = setup();
    const { comp, text } = buttonComponent(ed, 100);
    ed.addComponentProp(comp, 'TEXT');
    ed.addComponentProp(comp, 'BOOLEAN');
    const [tp, bp] = ed.doc.get(comp)!.componentProps!;
    ed.linkProp(text, 'characters', tp.id);
    ed.linkProp(text, 'visible', bp.id);
    const inst = ed.createInstance(comp, { x: 400, y: 400 })!;
    const vtext = () => instanceDoc(ed.doc, ed.doc.get(inst)!)!.get(`${inst}~${text}`)!;
    expect(vtext().text!.characters).toBe('Text'); // the property's default
    ed.setPropValue(inst, tp.id, 'Checkout');
    expect(vtext().text!.characters).toBe('Checkout');
    ed.setPropValue(inst, bp.id, false);
    expect(vtext().visible).toBe(false);
    valid(ed);

    ed.removeComponentProp(comp, tp.id);
    expect(ed.doc.get(text)!.propRefs?.characters).toBeUndefined();
    expect(ed.doc.get(inst)!.propValues?.[tp.id]).toBeUndefined();
    valid(ed);
  });

  it('Ctrl-click picks a layer inside an instance', () => {
    const ed = setup();
    const { comp, text } = buttonComponent(ed, 100);
    const inst = ed.createInstance(comp, { x: 480, y: 425 })!; // box 400..560 x 400..450
    ed.setSelection([]);
    const textWorld = ed.doc.worldBounds(inst);
    ed.pointerDown(ptr(textWorld.x + 25, textWorld.y + 12, { mod: true }));
    ed.pointerUp(ptr(textWorld.x + 25, textWorld.y + 12, { mod: true }));
    expect(ed.inner).toEqual({ instanceId: inst, sourceId: text });
    ed.keyDown({ code: 'Escape', key: 'Escape', shift: false, alt: false, mod: false, repeat: false });
    expect(ed.inner).toBeNull();
  });
});

describe('styles', () => {
  it('apply, update everywhere, detach on direct edits, and survive deletion as plain values', () => {
    const ed = setup();
    const a = draw(ed, 'rect', [100, 100], [200, 200]);
    const b = draw(ed, 'rect', [300, 100], [400, 200]);
    ed.updateNodes([a], (n) => ({ ...n, fills: [{ color: '#C8106E', opacity: 1, visible: true }] }));
    const sid = ed.createStyle('fill', a, 'Brand/Primary')!;
    ed.applyStyle([b], 'fill', sid);
    expect(ed.doc.get(b)!.fills).toEqual(ed.doc.get(a)!.fills);

    ed.updateStyle(sid, { value: [{ color: '#6B35C9', opacity: 1, visible: true }] });
    expect((ed.doc.get(a)!.fills[0] as { color: string }).color).toBe('#6B35C9');
    expect((ed.doc.get(b)!.fills[0] as { color: string }).color).toBe('#6B35C9');

    // editing b's fill directly detaches it
    ed.updateNodes([b], (n) => ({ ...n, fills: [{ color: '#000000', opacity: 1, visible: true }] }));
    expect(ed.doc.get(b)!.fillStyleId).toBeUndefined();
    expect(ed.doc.get(a)!.fillStyleId).toBe(sid);

    ed.deleteStyle(sid);
    expect(ed.doc.get(a)!.fillStyleId).toBeUndefined();
    expect((ed.doc.get(a)!.fills[0] as { color: string }).color).toBe('#6B35C9');
    ed.undo();
    expect(ed.styles).toHaveLength(1);
    valid(ed);
  });

  it('text styles carry font settings', () => {
    const ed = setup();
    ed.pasteText('Heading');
    const t = ed.selection[0];
    ed.updateNodes([t], (n) => ({ ...n, text: { ...n.text!, fontSize: 32, fontWeight: 700 } }));
    const sid = ed.createStyle('text', t, 'H1')!;
    ed.pasteText('Other');
    const u = ed.selection[0];
    ed.applyStyle([u], 'text', sid);
    expect(ed.doc.get(u)!.text).toMatchObject({ fontSize: 32, fontWeight: 700, characters: 'Other' });
  });
});

describe('variables', () => {
  it('bind colours and numbers, follow modes chosen on frames, and update when values change', () => {
    const ed = setup();
    const frame = draw(ed, 'frame', [0, 0], [400, 400]);
    const r = draw(ed, 'rect', [50, 50], [150, 150]);
    const col = { id: 'theme', name: 'Theme', modes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }] };
    ed.setVariables({
      collections: [col],
      vars: [
        { id: 'bg', collectionId: 'theme', name: 'surface', type: 'COLOR', values: { light: '#FFFFFF', dark: '#111111' } },
        { id: 'rad', collectionId: 'theme', name: 'radius', type: 'NUMBER', values: { light: 4, dark: 12 } },
      ],
    });
    ed.bind([r], 'fill', 'bg');
    ed.bind([r], 'radius', 'rad');
    const color = () => (ed.doc.get(r)!.fills[0] as { color: string }).color;
    expect(color()).toBe('#FFFFFF');
    expect(ed.doc.get(r)!.radii).toEqual([4, 4, 4, 4]);

    ed.setMode([frame], 'theme', 'dark');
    expect(color()).toBe('#111111');
    expect(ed.doc.get(r)!.radii).toEqual([12, 12, 12, 12]);

    ed.setVariables({ ...ed.variables, vars: ed.variables.vars.map((v) => (v.id === 'bg' ? { ...v, values: { light: '#FFFFFF', dark: '#222222' } } : v)) });
    expect(color()).toBe('#222222');

    // a direct edit lets go of the binding
    ed.updateNodes([r], (n) => ({ ...n, radii: [0, 0, 0, 0] }));
    expect(ed.doc.get(r)!.bindings?.radius).toBeUndefined();
    expect(ed.doc.get(r)!.bindings?.fill).toBe('bg');
    valid(ed);
  });
});
