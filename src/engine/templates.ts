/** Starting boards for diagram mode, as plain data the editor turns into layers. */

export type TemplateKind = 'flowchart' | 'brainstorm' | 'retro' | 'mindmap';

type Side = 'top' | 'right' | 'bottom' | 'left';

export type TemplateItem =
  /** A section; items with `parent` sit inside it, placed from its top-left corner. */
  | { key: string; kind: 'section'; name: string; x: number; y: number; w: number; h: number }
  | {
      key: string;
      kind: 'sticky' | 'box' | 'diamond' | 'ellipse';
      parent?: string;
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      /** A palette colour id (see DIAGRAM_COLORS); the tool's default if none. */
      color?: string;
    }
  | { key: string; kind: 'arrow'; from: string; fromSide: Side; to: string; toSide: Side; text?: string };

export const TEMPLATES: { kind: TemplateKind; name: string; description: string }[] = [
  { kind: 'flowchart', name: 'Flowchart', description: 'Steps, a decision and where each answer leads' },
  { kind: 'brainstorm', name: 'Brainstorm', description: 'A topic in the middle with prompts around it' },
  { kind: 'retro', name: 'Retrospective', description: 'What went well, what to improve, what to do next' },
  { kind: 'mindmap', name: 'Mind map', description: 'One idea branching out; Tidy up keeps it neat' },
];

function flowchart(): TemplateItem[] {
  return [
    { key: 'start', kind: 'ellipse', x: 0, y: 0, w: 160, h: 64, text: 'Start', color: 'green' },
    { key: 'step', kind: 'box', x: 0, y: 144, w: 160, h: 80, text: 'First step' },
    { key: 'decide', kind: 'diamond', x: -10, y: 304, w: 180, h: 120, text: 'Did it work?', color: 'yellow' },
    { key: 'fix', kind: 'box', x: 280, y: 324, w: 160, h: 80, text: 'Fix the problem', color: 'orange' },
    { key: 'next', kind: 'box', x: 0, y: 504, w: 160, h: 80, text: 'Next step' },
    { key: 'end', kind: 'ellipse', x: 0, y: 664, w: 160, h: 64, text: 'End', color: 'green' },
    { key: 'a1', kind: 'arrow', from: 'start', fromSide: 'bottom', to: 'step', toSide: 'top' },
    { key: 'a2', kind: 'arrow', from: 'step', fromSide: 'bottom', to: 'decide', toSide: 'top' },
    { key: 'a3', kind: 'arrow', from: 'decide', fromSide: 'bottom', to: 'next', toSide: 'top', text: 'Yes' },
    { key: 'a4', kind: 'arrow', from: 'decide', fromSide: 'right', to: 'fix', toSide: 'left', text: 'No' },
    { key: 'a5', kind: 'arrow', from: 'fix', fromSide: 'top', to: 'step', toSide: 'right' },
    { key: 'a6', kind: 'arrow', from: 'next', fromSide: 'bottom', to: 'end', toSide: 'top' },
  ];
}

function brainstorm(): TemplateItem[] {
  const prompts: [string, string][] = [
    ['Who is it for?', 'yellow'],
    ['What problem does it solve?', 'pink'],
    ['A wild idea', 'violet'],
    ['A quick win', 'green'],
    ['What could go wrong?', 'orange'],
    ['Open questions', 'blue'],
  ];
  const spots = [
    [40, 40],
    [360, 40],
    [680, 40],
    [40, 420],
    [360, 420],
    [680, 420],
  ];
  return [
    { key: 'board', kind: 'section', name: 'Brainstorm', x: 0, y: 0, w: 880, h: 620 },
    { key: 'topic', kind: 'box', parent: 'board', x: 340, y: 265, w: 200, h: 90, text: 'Our topic', color: 'violet' },
    ...prompts.map(([text, color], i): TemplateItem => ({
      key: `idea${i}`,
      kind: 'sticky',
      parent: 'board',
      x: spots[i][0],
      y: spots[i][1],
      w: 160,
      h: 160,
      text,
      color,
    })),
  ];
}

function retro(): TemplateItem[] {
  const columns: [string, string][] = [
    ['Went well', 'green'],
    ['To improve', 'pink'],
    ['Actions', 'blue'],
  ];
  return columns.flatMap(([name, color], c): TemplateItem[] => [
    { key: `col${c}`, kind: 'section', name, x: c * 360, y: 0, w: 320, h: 520 },
    ...[0, 1, 2, 3].map((i): TemplateItem => ({
      key: `note${c}-${i}`,
      kind: 'sticky',
      parent: `col${c}`,
      x: 20 + (i % 2) * 150,
      y: 40 + Math.floor(i / 2) * 150,
      w: 130,
      h: 130,
      text: '',
      color,
    })),
  ]);
}

/** Laid out roughly here; the editor tidies it as a tree once it is on the board. */
function mindmap(): TemplateItem[] {
  const branches: [string, string, string[]][] = [
    ['Goals', 'blue', ['Must have', 'Nice to have']],
    ['People', 'pink', ['Who decides']],
    ['Timeline', 'orange', ['First step', 'Deadline']],
    ['Risks', 'red', []],
  ];
  const items: TemplateItem[] = [{ key: 'root', kind: 'ellipse', x: 0, y: 160, w: 180, h: 80, text: 'Main idea', color: 'violet' }];
  let y = 0;
  branches.forEach(([name, color, leaves], i) => {
    items.push({ key: `b${i}`, kind: 'box', x: 260, y, w: 140, h: 56, text: name, color });
    items.push({ key: `rb${i}`, kind: 'arrow', from: 'root', fromSide: 'right', to: `b${i}`, toSide: 'left' });
    leaves.forEach((leaf, j) => {
      items.push({ key: `l${i}-${j}`, kind: 'box', x: 480, y: y + j * 70, w: 140, h: 48, text: leaf, color: 'grey' });
      items.push({ key: `bl${i}-${j}`, kind: 'arrow', from: `b${i}`, fromSide: 'right', to: `l${i}-${j}`, toSide: 'left' });
    });
    y += Math.max(1, leaves.length) * 70 + 20;
  });
  return items;
}

export function templateItems(kind: TemplateKind): TemplateItem[] {
  return kind === 'flowchart' ? flowchart() : kind === 'brainstorm' ? brainstorm() : kind === 'mindmap' ? mindmap() : retro();
}

/** The area a template covers, from its own origin. */
export function templateBounds(items: TemplateItem[]): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    if (it.kind === 'arrow' || ('parent' in it && it.parent)) continue;
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Stamps to drop on a board, like votes or reactions. */
export const STAMPS: { glyph: string; name: string }[] = [
  { glyph: '👍', name: 'Thumbs up' },
  { glyph: '❤️', name: 'Heart' },
  { glyph: '⭐', name: 'Star' },
  { glyph: '✅', name: 'Done' },
  { glyph: '❓', name: 'Question' },
  { glyph: '🔥', name: 'Fire' },
];
