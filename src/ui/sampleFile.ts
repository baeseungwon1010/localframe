import { generateNKeysBetween } from 'fractional-indexing';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportedFile, type SceneNode } from '../../shared/schema.ts';

/**
 * A small finished design to explore: two phone screens, a button component with a text property,
 * gradients, shadows, noise, a curved path, and a smart animate link between the screens.
 * Built here, so opening it needs no network.
 */
export function sampleFile(): ExportedFile {
  const keys = generateNKeysBetween(null, null, 40);
  let k = 0;
  const order = () => keys[k++];
  const base = { visible: true, locked: false, opacity: 1, rotation: 0, strokes: [], strokeWeight: 1, strokeAlign: 'inside' as const, strokeDash: [] };
  const solid = (color: string) => ({ color, opacity: 1, visible: true });
  const text = (characters: string, fontSize: number, fontWeight: number) => ({
    characters,
    fontFamily: 'Inter',
    fontWeight,
    fontSize,
    lineHeight: null,
    letterSpacing: 0,
    align: 'left' as const,
    autoResize: 'width' as const,
  });
  const top = (n: Partial<SceneNode>) => ({ ...base, parentId: null, pageId: 'page-1', order: order(), ...n }) as SceneNode;
  const kid = (parentId: string, n: Partial<SceneNode>) => ({ ...base, parentId, order: order(), ...n }) as SceneNode;
  const shadow = [{ type: 'DROP_SHADOW' as const, color: '#1B1D21', opacity: 0.12, x: 0, y: 8, blur: 24, spread: 0, visible: true }];
  const plans = [
    { title: 'Morning run', meta: '6:30, 5 km', color: '#C8106E' },
    { title: 'Design review', meta: '10:00, 45 min', color: '#2B6CEE' },
    { title: 'Read 20 pages', meta: 'Tonight', color: '#F2994A' },
  ];
  const nodes: SceneNode[] = [
    top({
      id: 'button',
      type: 'COMPONENT',
      name: 'Button',
      x: 40,
      y: 760,
      width: 160,
      height: 48,
      fills: [solid('#C8106E')],
      radii: [12, 12, 12, 12],
      clipsContent: true,
      layout: { mode: 'horizontal', gap: 8, padding: [12, 24, 12, 24], primaryAlign: 'center', crossAlign: 'center', widthMode: 'hug', heightMode: 'fixed' },
      componentProps: [{ id: 'label', name: 'Label', type: 'TEXT', defaultValue: 'Get started' }],
    }),
    kid('button', { id: 'button-label', type: 'TEXT', name: 'Label', x: 24, y: 14, width: 90, height: 20, fills: [solid('#FFFFFF')], text: text('Get started', 16, 600), propRefs: { characters: 'label' } }),
    top({ id: 'home', type: 'FRAME', name: 'Home', x: 40, y: 40, width: 375, height: 680, fills: [solid('#FFF8F2')], radii: [0, 0, 0, 0], clipsContent: true }),
    kid('home', { id: 'home-title', type: 'TEXT', name: 'Good morning', x: 24, y: 56, width: 220, height: 40, fills: [solid('#1B1D21')], text: text('Good morning', 32, 700) }),
    kid('home', { id: 'home-sub', type: 'TEXT', name: 'Three plans are waiting for you', x: 24, y: 100, width: 240, height: 20, fills: [solid('#6B6F76')], text: text('Three plans are waiting for you', 16, 400) }),
    ...plans.flatMap((p, i) => [
      kid('home', { id: `card-${i}`, type: 'RECTANGLE', name: 'Card', x: 24, y: 148 + i * 132, width: 327, height: 116, fills: [solid('#FFFFFF')], radii: [20, 20, 20, 20], effects: shadow }),
      kid('home', {
        id: `badge-${i}`,
        type: 'ELLIPSE',
        name: 'Badge',
        x: 44,
        y: 168 + i * 132,
        width: 48,
        height: 48,
        fills: [
          {
            type: 'GRADIENT_ANGULAR',
            stops: [
              { position: 0, color: p.color, opacity: 1 },
              { position: 1, color: '#F2C94C', opacity: 1 },
            ],
            from: { x: 0.5, y: 0.5 },
            to: { x: 1, y: 0.5 },
            opacity: 1,
            visible: true,
          },
        ],
      }),
      kid('home', { id: `card-title-${i}`, type: 'TEXT', name: p.title, x: 108, y: 172 + i * 132, width: 160, height: 22, fills: [solid('#1B1D21')], text: text(p.title, 17, 600) }),
      kid('home', { id: `card-meta-${i}`, type: 'TEXT', name: p.meta, x: 108, y: 198 + i * 132, width: 120, height: 18, fills: [solid('#6B6F76')], text: text(p.meta, 14, 400) }),
    ]),
    kid('home', {
      id: 'home-button',
      type: 'INSTANCE',
      name: 'Button',
      componentId: 'button',
      x: 107,
      y: 580,
      width: 160,
      height: 48,
      fills: [],
      overrides: {},
      reactions: [{ trigger: 'click', action: 'navigate', destinationId: 'plan', transition: 'smart-animate', duration: 400, easing: 'ease-out' }],
    }),
    top({ id: 'plan', type: 'FRAME', name: 'Plan', x: 475, y: 40, width: 375, height: 680, fills: [solid('#1B1D21')], radii: [0, 0, 0, 0], clipsContent: true }),
    kid('plan', { id: 'plan-title', type: 'TEXT', name: 'Morning run', x: 24, y: 56, width: 200, height: 40, fills: [solid('#FFFFFF')], text: text('Morning run', 32, 700) }),
    kid('plan', {
      id: 'plan-card',
      type: 'RECTANGLE',
      name: 'Card',
      x: 24,
      y: 148,
      width: 327,
      height: 260,
      fills: [solid('#2A2C31')],
      radii: [24, 24, 24, 24],
      effects: [{ type: 'NOISE', color: '#FFFFFF', amount: 0.08, size: 1, visible: true }],
    }),
    kid('plan', {
      id: 'plan-route',
      type: 'VECTOR',
      name: 'Route',
      x: 60,
      y: 200,
      width: 255,
      height: 150,
      fills: [],
      strokes: [solid('#F2C94C')],
      strokeWeight: 6,
      strokeAlign: 'center',
      strokeCap: 'round',
      vector: {
        closed: false,
        points: [
          { x: 0, y: 150, out: { x: 60, y: 150 } },
          { x: 100, y: 40, in: { x: 60, y: 60 }, out: { x: 140, y: 20 } },
          { x: 255, y: 0, in: { x: 200, y: 0 } },
        ],
      },
    }),
    kid('plan', { id: 'plan-sub', type: 'TEXT', name: '5 km along the river', x: 24, y: 432, width: 180, height: 20, fills: [solid('#A3A6AD')], text: text('5 km along the river', 16, 400) }),
    top({
      id: 'note',
      type: 'TEXT',
      name: 'Try it',
      x: 900,
      y: 60,
      width: 260,
      height: 40,
      fills: [solid('#6B6F76')],
      text: text('Press Present, then click the button\nto smart-animate to the plan.', 14, 500),
    }),
  ];
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    name: 'Sample: Daily planner',
    background: '#EDEEF0',
    pages: [{ id: 'page-1', name: 'App', background: '#EDEEF0', prototypeStart: 'home', device: 'phone' }],
    nodes,
    images: [],
  };
}
