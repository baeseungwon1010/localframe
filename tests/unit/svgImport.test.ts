import { describe, expect, it } from 'vitest';
import { type GradientPaint, type SceneNode, type SolidPaint, SceneNodeSchema, validateTree } from '../../shared/schema.ts';
import { SceneDoc } from '../../src/engine/doc.ts';
import { type Point, apply } from '../../src/engine/math.ts';
import { importSvg, parsePathData } from '../../src/engine/svgImport.ts';

const AT = { x: 100, y: 200 };

/** Imports into a fresh document, checks the result is valid, and returns the document too. */
function load(svg: string, existing: SceneNode[] = []) {
  const doc = new SceneDoc();
  doc.load(existing);
  const nodes = importSvg(doc, svg, { parentId: null, at: AT, name: 'Imported' });
  for (const n of nodes) {
    const r = SceneNodeSchema.safeParse(n);
    expect(r.success, `${n.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
  }
  doc.load([...existing, ...nodes]);
  expect(validateTree(doc.all())).toBeNull();
  const frame = nodes[0];
  const kids = (id: string) => doc.children(id).map((c) => doc.get(c)!);
  return { doc, nodes, frame, kids, top: kids(frame.id) };
}

/** Anchor points of every path of a vector, on the page. */
function worldPoints(doc: SceneDoc, n: SceneNode): Point[][] {
  const m = doc.world(n.id);
  return [n.vector!, ...(n.vector!.extra ?? [])].map((p) => p.points.map((q) => apply(m, q)));
}

/** World box relative to the frame's top-left. */
function box(doc: SceneDoc, n: SceneNode) {
  const b = doc.worldBounds(n.id);
  return { x: b.x - AT.x, y: b.y - AT.y, width: b.width, height: b.height };
}

const near = (a: Point, b: Point, tol = 0.02) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
const color = (n: SceneNode, list: 'fills' | 'strokes' = 'fills') => (n[list][0] as SolidPaint | undefined)?.color;

describe('importSvg', () => {
  it('imports a stroke icon (Lucide style) into a frame', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-house">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
      <circle cx="12" cy="12" r="3"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>`;
    const { frame, top, doc } = load(svg);
    expect(frame).toMatchObject({ type: 'FRAME', name: 'Imported', x: 100, y: 200, width: 48, height: 48, fills: [], clipsContent: false, parentId: null });
    expect(top.map((n) => n.type)).toEqual(['VECTOR', 'VECTOR', 'ELLIPSE', 'LINE']);
    for (const n of top) {
      expect(n.fills).toEqual([]);
      expect(color(n, 'strokes')).toBe('#000000');
      expect(n.strokeWeight).toBe(4); // 2 × the viewBox scale
      expect(n.strokeCap).toBe('round');
      expect(n.strokeJoin).toBe('round');
    }
    expect(top[0].vector!.closed).toBe(true);
    expect(top[1].vector!.closed).toBe(false);
    expect(box(doc, top[2])).toEqual({ x: 18, y: 18, width: 12, height: 12 });
    const line = top[3];
    expect(line).toMatchObject({ x: 4, y: 4, rotation: 45 });
    expect(line.width).toBeCloseTo(Math.hypot(40, 40), 1);
    // the house's roof top (12, 2) lands at (24, 4) in the frame
    expect(worldPoints(doc, top[0])[0].some((p) => near(p, { x: 124, y: 204 }))).toBe(true);
  });

  it('keeps sibling paint order and goes on top of the existing layers', () => {
    const existing = load('<svg width="10" height="10"><rect width="5" height="5"/></svg>').nodes;
    const { frame, top, doc } = load(
      '<svg width="10" height="10"><rect id="first" width="1" height="1"/><rect id="second" width="1" height="1"/><rect id="third" width="1" height="1"/></svg>',
      existing,
    );
    expect(top.map((n) => n.name)).toEqual(['first', 'second', 'third']);
    expect(doc.children(null).at(-1)).toBe(frame.id);
  });

  it('imports a filled multi-path logo with even-odd holes', () => {
    const svg = `<svg viewBox="0 0 100 100"><path fill="#336699" fill-rule="evenodd"
      d="M0 0H100V100H0Z M25 25H75V75H25Z M40 40h20v20h-20z"/></svg>`;
    const { top, frame } = load(svg);
    expect(frame.width).toBe(100);
    const v = top[0];
    expect(v.type).toBe('VECTOR');
    expect(v.name).toBe('Vector');
    expect(v.vector!.fillRule).toBe('evenodd');
    expect(v.vector!.closed).toBe(true);
    expect(v.vector!.points).toHaveLength(4);
    expect(v.vector!.extra).toHaveLength(2);
    expect(v.vector!.extra!.every((p) => p.closed && p.points.length === 4)).toBe(true);
    expect(color(v)).toBe('#336699');
    expect(v.strokes).toEqual([]);
  });

  it('reads every path command, relative and absolute, including arcs', () => {
    const d =
      'M10 10 L20 10 l0 10 H30 h5 V40 v-5 C40 40 50 40 50 30 c0-5 5-5 10 0 S70 30 70 20 s5-5 10 0 ' +
      'Q90 10 90 20 q5 5 10 0 T110 20 t10 0 A10 10 0 0 1 140 20 a10 10 0 0 0 20 0 Z';
    const { top, doc } = load(`<svg width="200" height="100"><path stroke="red" fill="none" d="${d}"/></svg>`);
    const v = top[0];
    const pts = worldPoints(doc, v)[0].map((p) => ({ x: p.x - AT.x, y: p.y - AT.y }));
    const expected = [
      [10, 10], [20, 10], [20, 20], [30, 20], [35, 20], [35, 40], [35, 35], [50, 30], [60, 30], [70, 20], [80, 20],
      [90, 20], [100, 20], [110, 20], [120, 20], [130, 10], [140, 20], [150, 30], [160, 20],
    ].map(([x, y]) => ({ x, y }));
    expect(pts).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(near(pts[i], e), `point ${i}: ${JSON.stringify(pts[i])}`).toBe(true));
    expect(v.vector!.closed).toBe(true);
    // smooth curve: S reflects the previous control point
    const local = v.vector!.points;
    const o = { x: v.x, y: v.y };
    const out60 = local[8].out!;
    expect(near({ x: out60.x + o.x, y: out60.y + o.y }, { x: 65, y: 35 })).toBe(true);
    // T reflects the quadratic control (95, 25) about (100, 20) → (105, 15), raised to a cubic
    const out100 = local[12].out!;
    expect(near({ x: out100.x + o.x, y: out100.y + o.y }, { x: 100 + (2 / 3) * 5, y: 20 - (2 / 3) * 5 })).toBe(true);
  });

  it('parses compact numbers, exponents, implicit repeats and packed arc flags', () => {
    const [a] = parsePathData('M10-5.5.5.5');
    expect(a.points).toEqual([{ x: 10, y: -5.5 }, { x: 0.5, y: 0.5 }]);
    const [b] = parsePathData('M1e1 2E0 l1-1 1 1');
    expect(b.points.map((p) => [p.x, p.y])).toEqual([[10, 2], [11, 1], [12, 2]]);
    const [c] = parsePathData('M0 0a5 5 0 1010 0');
    const end = c.points.at(-1)!;
    expect(near(end, { x: 10, y: 0 })).toBe(true);
    // relative moveto after a close starts from the subpath's start
    const paths = parsePathData('M10 10h10v10z m5 5h1v1z');
    expect(paths).toHaveLength(2);
    expect(paths[1].points[0]).toEqual({ x: 15, y: 15 });
    // an error stops the path where it is
    expect(parsePathData('M0 0 L10 10 L oops 5')[0].points).toHaveLength(2);
    expect(parsePathData('L10 10')).toEqual([]);
  });

  it('bakes nested transforms into world positions', () => {
    const svg = `<svg width="200" height="200">
      <g id="outer" transform="translate(50 50)">
        <g transform="rotate(90)"><rect id="turned" width="20" height="10" fill="red"/></g>
        <rect id="scaled" transform="scale(2)" x="5" y="5" width="10" height="10" rx="2"/>
        <circle id="squashed" transform="translate(10,0) scale(2 1)" r="5"/>
      </g>
      <rect id="spun" transform="rotate(180 10 10)" width="5" height="5"/>
      <path id="skewed" stroke="#000" transform="matrix(1 0 0 1 5 5) skewX(45)" d="M0 0 L0 10"/>
    </svg>`;
    const { doc, nodes } = load(svg);
    const byName = (name: string) => nodes.find((n) => n.name === name)!;
    expect(byName('outer').type).toBe('GROUP');
    const turned = byName('turned');
    expect(turned.type).toBe('VECTOR');
    expect(box(doc, turned)).toEqual({ x: 40, y: 50, width: 10, height: 20 });
    const scaled = byName('scaled');
    expect(scaled.type).toBe('RECTANGLE');
    expect(box(doc, scaled)).toEqual({ x: 60, y: 60, width: 20, height: 20 });
    expect(scaled.radii).toEqual([4, 4, 4, 4]);
    const squashed = byName('squashed');
    expect(squashed.type).toBe('ELLIPSE');
    expect(box(doc, squashed)).toEqual({ x: 50, y: 45, width: 20, height: 10 });
    const spun = byName('spun');
    expect(spun.type).toBe('VECTOR');
    expect(box(doc, spun)).toEqual({ x: 15, y: 15, width: 5, height: 5 });
    const skewed = worldPoints(doc, byName('skewed'))[0];
    expect(near(skewed[0], { x: 105, y: 205 })).toBe(true);
    expect(near(skewed[1], { x: 115, y: 215 })).toBe(true);
    // the group wraps its children
    expect(box(doc, byName('outer'))).toEqual({ x: 40, y: 45, width: 40, height: 35 });
  });

  it('turns rotated circles into vectors that keep their shape', () => {
    const { top, doc } = load('<svg width="100" height="100"><ellipse transform="rotate(90 50 50)" cx="50" cy="50" rx="20" ry="10"/></svg>');
    expect(top[0].type).toBe('VECTOR');
    const b = box(doc, top[0]);
    expect(b.x).toBeCloseTo(40, 1);
    expect(b.width).toBeCloseTo(20, 1);
    expect(b.height).toBeCloseTo(40, 1);
    expect(top[0].vector!.closed).toBe(true);
  });

  it('applies class rules, style attributes, presentation attributes and inheritance', () => {
    const svg = `<svg viewBox="0 0 10 10">
      <style><![CDATA[ .a { fill: #f00 } #b { stroke: blue } rect.c { fill: #00ff00 } g .d { fill: hsl(120, 100%, 50%) } /* note */ ]]></style>
      <g fill="#123456" stroke-width="3" opacity="0.8">
        <rect class="a" width="1" height="1"/>
        <rect id="b" width="1" height="1"/>
        <rect class="c" style="fill: rgb(0, 0, 255); opacity: .5" width="1" height="1"/>
        <rect fill-opacity="0.25" width="1" height="1"/>
        <rect class="d" width="1" height="1"/>
        <rect fill="rebeccapurple" width="1" height="1"/>
        <rect fill="#f008" width="1" height="1"/>
        <rect display="none" width="1" height="1"/>
        <rect style="visibility:hidden" width="1" height="1"/>
        <rect fill="none" width="1" height="1"/>
      </g>
    </svg>`;
    const { top, kids } = load(svg);
    expect(top).toHaveLength(1);
    const g = top[0];
    expect(g).toMatchObject({ type: 'GROUP', opacity: 0.8 });
    const r = kids(g.id);
    expect(r).toHaveLength(7);
    expect(color(r[0])).toBe('#FF0000');
    expect(color(r[1])).toBe('#123456');
    expect(color(r[1], 'strokes')).toBe('#0000FF');
    expect(r[1].strokeWeight).toBe(3);
    expect(color(r[2])).toBe('#0000FF');
    expect(r[2].opacity).toBe(0.5);
    expect(r[3].fills[0].opacity).toBe(0.25);
    expect(color(r[4])).toBe('#00FF00');
    expect(color(r[5])).toBe('#663399');
    expect(color(r[6])).toBe('#FF0000');
    expect(r[6].fills[0].opacity).toBeCloseTo(0.533, 2);
    expect(r.every((n) => n.type === 'RECTANGLE')).toBe(true);
    expect(r.map((n) => n.name)).toEqual(['Rectangle', 'b', 'Rectangle', 'Rectangle', 'Rectangle', 'Rectangle', 'Rectangle']);
  });

  it('imports text with its font, size, weight, colour and baseline', () => {
    const svg = `<svg width="300" height="100">
      <text x="10" y="30" font-size="20" font-family="'IBM Plex Sans', sans-serif" font-weight="bold" fill="#333">Hello
        <tspan fill="red">world</tspan></text>
      <text x="10" y="80" style="font: 12px Comic Sans; font-family: Comic Sans" font-style="italic"><tspan x="10" y="60">One</tspan><tspan x="10" y="80">Two</tspan></text>
      <text x="150" y="50" text-anchor="middle" font-size="10">mid</text>
    </svg>`;
    const { top } = load(svg);
    expect(top.map((n) => n.type)).toEqual(['TEXT', 'TEXT', 'TEXT']);
    const [a, b, c] = top;
    expect(a.text).toMatchObject({ characters: 'Hello world', fontSize: 20, fontWeight: 700, fontFamily: 'IBM Plex Sans' });
    expect(a.name).toBe('Hello world');
    expect(color(a)).toBe('#333333');
    expect(a.x).toBe(10);
    expect(a.y).toBe(14);
    expect(b.text).toMatchObject({ characters: 'One\nTwo', fontFamily: 'Inter', italic: true });
    expect(c.x + c.width / 2).toBeCloseTo(150, 1);
  });

  it('imports linear and radial gradients', () => {
    const svg = `<svg width="100" height="100">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ff0000"/>
          <stop offset="50%" style="stop-color: blue; stop-opacity: 0.5"/>
          <stop offset="1" stop-color="white"/>
        </linearGradient>
        <linearGradient id="linked" xlink:href="#lg" x2="1" y2="0"/>
        <radialGradient id="rg" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="25">
          <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
        </radialGradient>
        <linearGradient id="one"><stop offset="0" stop-color="#abcdef"/></linearGradient>
        <clipPath id="clip"><rect width="10" height="10"/></clipPath>
      </defs>
      <rect width="100" height="50" fill="url(#lg)"/>
      <rect y="50" width="100" height="50" fill="url('#linked')" clip-path="url(#clip)"/>
      <rect x="25" y="25" width="50" height="50" fill="url(#rg)"/>
      <rect width="10" height="10" fill="url(#one)"/>
      <rect width="10" height="10" fill="url(#missing) #00ff00"/>
    </svg>`;
    const { top } = load(svg);
    expect(top).toHaveLength(5);
    const lg = top[0].fills[0] as GradientPaint;
    expect(lg.type).toBe('GRADIENT_LINEAR');
    expect(lg.from).toEqual({ x: 0, y: 0 });
    expect(lg.to).toEqual({ x: 0, y: 1 });
    expect(lg.stops).toEqual([
      { position: 0, color: '#FF0000', opacity: 1 },
      { position: 0.5, color: '#0000FF', opacity: 0.5 },
      { position: 1, color: '#FFFFFF', opacity: 1 },
    ]);
    const linked = top[1].fills[0] as GradientPaint;
    expect(linked.to).toEqual({ x: 1, y: 0 });
    expect(linked.stops).toHaveLength(3);
    const rg = top[2].fills[0] as GradientPaint;
    expect(rg.type).toBe('GRADIENT_RADIAL');
    expect(rg.from).toEqual({ x: 0.5, y: 0.5 });
    expect(rg.to).toEqual({ x: 1, y: 0.5 });
    expect(color(top[3])).toBe('#ABCDEF');
    expect(color(top[4])).toBe('#00FF00');
  });

  it('decodes entities and never expands DTD entities', () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
        <!ENTITY boom "BOOM">
        <!ENTITY ext SYSTEM "file:///etc/passwd">
      ]>
      <!-- a comment with <rect/> inside -->
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <text id="t &amp; &quot;q&quot;" y="20">A &amp; B &lt;3 &#65;&#x42; &apos;&gt; &boom;&ext;</text>
      </svg>`;
    const { top } = load(svg);
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe('t & "q"');
    expect(top[0].text!.characters).toBe("A & B <3 AB '> &boom;&ext;");
  });

  it('resolves <use> once and skips scripts, images, foreign objects and loops', () => {
    const svg = `<svg width="100" height="100" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs><path id="dot" d="M0 0h4v4h-4z"/>
        <symbol id="sym" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="blue"/></symbol></defs>
      <use href="#dot" x="10" y="20" fill="red"/>
      <use xlink:href="#sym" x="50" y="50" width="20" height="20"/>
      <g id="loop"><use href="#loop"/></g>
      <use href="#nothing"/>
      <use href="http://example.com/a.svg#x"/>
      <script>alert(1)</script>
      <image href="x.png" width="10" height="10"/>
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
      <unknown-thing><rect width="5" height="5"/></unknown-thing>
      <g/>
      <a href="https://example.com" onclick="evil()"><rect width="5" height="5" onload="evil()"/></a>
    </svg>`;
    const { top, doc, kids } = load(svg);
    expect(top.map((n) => n.type)).toEqual(['VECTOR', 'GROUP', 'GROUP']);
    expect(color(top[0])).toBe('#FF0000');
    expect(box(doc, top[0])).toEqual({ x: 10, y: 20, width: 4, height: 4 });
    const sym = kids(top[1].id)[0];
    expect(sym.type).toBe('ELLIPSE');
    expect(box(doc, sym)).toEqual({ x: 50, y: 50, width: 20, height: 20 });
    expect(kids(top[2].id)[0].type).toBe('RECTANGLE');
  });

  it('sizes the frame from the viewBox, width/height or content', () => {
    expect(load('<svg viewBox="0 0 50 25"><rect width="5" height="5"/></svg>').frame).toMatchObject({ width: 50, height: 25 });
    expect(load('<svg width="10cm" viewBox="0 0 50 25"><rect width="5" height="5"/></svg>').frame.height).toBeCloseTo(188.98, 1);
    expect(load('<svg><rect x="10" y="10" width="30" height="20"/></svg>').frame).toMatchObject({ width: 40, height: 30 });
    // meet: a wide viewBox in a square viewport is centred vertically
    const { top, doc } = load('<svg width="100" height="100" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>');
    expect(box(doc, top[0])).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it('refuses things that are not SVG files', () => {
    const doc = new SceneDoc();
    const opts = { parentId: null, at: { x: 0, y: 0 }, name: 'x' };
    for (const bad of ['hello', '', '<html><body/></html>', '<svg width="10"', '<svg><!-- never closed', '\u0089PNG\r\n<svg>', '{"svg": 1}']) {
      expect(() => importSvg(doc, bad, opts), bad).toThrow("This isn't an SVG file.");
    }
  });

  it('refuses oversized, too deep or too complex input', () => {
    const doc = new SceneDoc();
    const opts = { parentId: null, at: { x: 0, y: 0 }, name: 'x' };
    const huge = `<svg><!--${'x'.repeat(5 * 1024 * 1024)}--></svg>`;
    expect(() => importSvg(doc, huge, opts)).toThrow('This SVG is too large to import.');
    const deep = `<svg>${'<g>'.repeat(70)}<rect width="1" height="1"/>${'</g>'.repeat(70)}</svg>`;
    expect(() => importSvg(doc, deep, opts)).toThrow('This SVG is nested too deeply to import.');
    const many = `<svg>${'<rect width="1" height="1"/>'.repeat(10_001)}</svg>`;
    expect(() => importSvg(doc, many, opts)).toThrow('This SVG is too large to import.');
    const points = `<svg><path d="M0 0${' l1 1'.repeat(10_001)}"/></svg>`;
    expect(() => importSvg(doc, points, opts)).toThrow('This SVG is too large to import.');
    const far = '<svg><rect x="1e12" width="1" height="1"/></svg>';
    expect(() => importSvg(doc, far, opts)).toThrow('This SVG is too large to import.');
    // nested <use> that would multiply out is cut off
    let bomb = '<svg><defs><rect id="u0" width="1" height="1"/>';
    for (let i = 1; i < 12; i++) bomb += `<g id="u${i}">${`<use href="#u${i - 1}"/>`.repeat(10)}</g>`;
    bomb += '</defs><use href="#u11"/></svg>';
    expect(() => importSvg(doc, bomb, opts)).toThrow('This SVG is too large to import.');
  });

  it('imports into a parent frame with valid order keys', () => {
    const parent = load('<svg width="10" height="10"><rect width="1" height="1"/></svg>').frame;
    const doc = new SceneDoc();
    doc.load([parent]);
    const nodes = importSvg(doc, '<svg width="5" height="5"><rect width="1" height="1"/></svg>', { parentId: parent.id, at: { x: 2, y: 3 }, name: 'Inner' });
    expect(nodes[0]).toMatchObject({ parentId: parent.id, x: 2, y: 3 });
    expect(nodes[0].pageId).toBeUndefined();
    doc.load([parent, ...nodes]);
    expect(validateTree(doc.all())).toBeNull();
    expect(doc.children(parent.id)).toEqual([nodes[0].id]);
    expect(doc.children(nodes[0].id).map((id) => doc.get(id)!.type)).toEqual(['RECTANGLE']);
  });
});
