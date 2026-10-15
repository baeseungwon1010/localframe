import type { Editor, Tool } from '../../engine/editor.ts';
import { TEMPLATES } from '../../engine/templates.ts';
import { ALT, MOD, SHIFT } from '../components.tsx';

export type Command = {
  id: string;
  group: string;
  label: string;
  shortcut?: string;
  /** Extra words to match when searching. */
  keywords?: string;
  /** Why it can't run right now (null when it can). */
  unavailable: () => string | null;
  run: () => void;
};

/** What the editor screen can open (things outside the canvas engine). */
export type ScreenActions = {
  exportFile: () => void;
  present: () => void;
  history: () => void;
  find: () => void;
  placeImage: () => void;
  rename: () => void;
  share?: (format: 'png' | 'pdf') => void;
  diagramMode: boolean;
  /** Absent when the screen can only show the board. */
  setDiagramMode?: (on: boolean) => void;
};

const TOOL_COMMANDS: { tool: Tool; label: string; shortcut: string; keywords?: string }[] = [
  { tool: 'move', label: 'Move', shortcut: 'V', keywords: 'select pointer' },
  { tool: 'hand', label: 'Hand', shortcut: 'H', keywords: 'pan scroll' },
  { tool: 'frame', label: 'Frame', shortcut: 'F', keywords: 'artboard screen' },
  { tool: 'section', label: 'Section', shortcut: `${SHIFT}S` },
  { tool: 'slice', label: 'Slice', shortcut: 'S', keywords: 'export area' },
  { tool: 'rect', label: 'Rectangle', shortcut: 'R', keywords: 'box square shape' },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O', keywords: 'circle oval shape' },
  { tool: 'polygon', label: 'Polygon', shortcut: '', keywords: 'triangle hexagon shape' },
  { tool: 'star', label: 'Star', shortcut: '', keywords: 'shape' },
  { tool: 'line', label: 'Line', shortcut: 'L' },
  { tool: 'arrow', label: 'Arrow', shortcut: `${SHIFT}L`, keywords: 'connector' },
  { tool: 'pen', label: 'Pen', shortcut: 'P', keywords: 'vector path bezier' },
  { tool: 'pencil', label: 'Pencil', shortcut: `${SHIFT}P`, keywords: 'freehand draw' },
  { tool: 'text', label: 'Text', shortcut: 'T', keywords: 'type write' },
  { tool: 'sticky', label: 'Sticky note', shortcut: 'N', keywords: 'note figjam post-it' },
  { tool: 'box', label: 'Rounded box', shortcut: '', keywords: 'process step diagram flowchart rectangle' },
  { tool: 'diamond', label: 'Diamond', shortcut: '', keywords: 'decision diagram flowchart' },
  { tool: 'parallelogram', label: 'Parallelogram', shortcut: '', keywords: 'input output diagram flowchart' },
  { tool: 'cylinder', label: 'Cylinder', shortcut: '', keywords: 'database storage diagram' },
  { tool: 'document', label: 'Document', shortcut: '', keywords: 'page diagram flowchart' },
  { tool: 'chevron', label: 'Chevron', shortcut: '', keywords: 'step process diagram' },
  { tool: 'stamp', label: 'Stamp', shortcut: 'E', keywords: 'vote reaction emoji like' },
  { tool: 'comment', label: 'Comment', shortcut: 'C', keywords: 'note feedback' },
];

/** Every command the quick actions palette offers, with when each one applies. */
export function buildCommands(editor: Editor, screen: ScreenActions): Command[] {
  const sel = () => editor.selectedNodes();
  const needSel = () => (editor.selection.length ? null : 'Select a layer first');
  const needTwo = () => (editor.selection.length > 1 ? null : 'Select two or more layers');
  const always = (): string | null => null;
  const cmd = (group: string, id: string, label: string, run: () => void, unavailable: () => string | null = always, shortcut?: string, keywords?: string): Command => ({
    id,
    group,
    label,
    run,
    unavailable,
    shortcut,
    keywords,
  });
  return [
    ...TOOL_COMMANDS.map((t) => cmd('Tools', `tool-${t.tool}`, t.label, () => editor.setTool(t.tool), always, t.shortcut || undefined, t.keywords)),
    cmd('Tools', 'image', 'Place image', screen.placeImage, always, `${MOD}${SHIFT}K`, 'picture photo upload'),

    ...TEMPLATES.map((t) => cmd('Insert', `template-${t.kind}`, `Insert ${t.name.toLowerCase()} template`, () => editor.insertTemplate(t.kind), always, undefined, `board diagram start ${t.description}`)),

    cmd('Edit', 'undo', 'Undo', () => editor.undo(), () => (editor.canUndo ? null : 'Nothing to undo'), `${MOD}Z`),
    cmd('Edit', 'redo', 'Redo', () => editor.redo(), () => (editor.canRedo ? null : 'Nothing to redo'), `${MOD}${SHIFT}Z`),
    cmd('Edit', 'select-all', 'Select all', () => editor.selectAll(), always, `${MOD}A`),
    cmd('Edit', 'select-matching', 'Select matching layers', () => editor.selectMatching(), needSel, `${MOD}${ALT}A`, 'same similar'),
    cmd('Edit', 'duplicate', 'Duplicate', () => editor.duplicateSelection(), needSel, `${MOD}D`, 'copy clone'),
    cmd('Edit', 'delete', 'Delete', () => editor.deleteSelection(), needSel, 'Del', 'remove'),
    cmd('Edit', 'rename', 'Rename layers', screen.rename, needSel, `${MOD}R`),
    cmd('Edit', 'find', 'Find and replace text', screen.find, always, `${MOD}F`, 'search'),

    cmd('Arrange', 'group', 'Group selection', () => editor.groupSelection(), needSel, `${MOD}G`),
    cmd('Arrange', 'frame-selection', 'Wrap in frame', () => editor.wrapInFrame(), needSel, `${MOD}${ALT}G`),
    cmd('Arrange', 'ungroup', 'Ungroup or remove frame', () => editor.unwrapFrames(), () =>
      sel().some((n) => n.type === 'GROUP' || n.type === 'FRAME') ? null : 'Select a group or frame', `${MOD}${SHIFT}G`),
    cmd('Arrange', 'auto-layout', 'Add auto layout', () => editor.addAutoLayout(), needSel, `${SHIFT}A`, 'flex stack'),
    cmd('Arrange', 'front', 'Bring to front', () => editor.reorder('front'), needSel, `${MOD}${SHIFT}]`),
    cmd('Arrange', 'forward', 'Bring forward', () => editor.reorder('forward'), needSel, `${MOD}]`),
    cmd('Arrange', 'backward', 'Send backward', () => editor.reorder('backward'), needSel, `${MOD}[`),
    cmd('Arrange', 'back', 'Send to back', () => editor.reorder('back'), needSel, `${MOD}${SHIFT}[`),
    ...(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'] as const).map((op) =>
      cmd('Arrange', `align-${op}`, `Align ${{ left: 'left', hcenter: 'horizontal centres', right: 'right', top: 'top', vcenter: 'vertical centres', bottom: 'bottom' }[op]}`, () => editor.align(op), needSel),
    ),
    cmd('Arrange', 'distribute-x', 'Distribute horizontally', () => editor.distribute('x'), needTwo, undefined, 'space evenly'),
    cmd('Arrange', 'distribute-y', 'Distribute vertically', () => editor.distribute('y'), needTwo, undefined, 'space evenly'),
    cmd('Arrange', 'hide', 'Show or hide', () => editor.toggleVisible(), needSel, `${MOD}${SHIFT}H`, 'visible'),
    cmd('Arrange', 'lock', 'Lock or unlock', () => editor.toggleLocked(), needSel, `${MOD}${SHIFT}L`),

    cmd('Shapes', 'flatten', 'Flatten', () => editor.flattenSelection(), needSel, `${MOD}E`, 'vector convert'),
    cmd('Shapes', 'outline-stroke', 'Outline stroke', () => editor.outlineStroke(), needSel, `${MOD}${SHIFT}O`, 'expand convert'),
    cmd('Shapes', 'mask', 'Use as mask', () => editor.useAsMask(), needSel, `${MOD}${ALT}M`, 'clip'),
    ...(['union', 'subtract', 'intersect', 'exclude'] as const).map((op) =>
      cmd('Shapes', `bool-${op}`, `Boolean: ${op}`, () => editor.booleanSelection(op), needTwo, undefined, 'combine merge'),
    ),

    cmd('Components', 'component', 'Create component', () => editor.createComponent(), needSel, `${MOD}${ALT}K`, 'symbol reusable'),
    cmd('Components', 'variants', 'Combine as variants', () => editor.combineAsVariants(), () =>
      sel().length > 1 && sel().every((n) => n.type === 'COMPONENT') ? null : 'Select two or more components', `${MOD}${ALT}${SHIFT}K`),
    cmd('Components', 'detach', 'Detach instance', () => editor.detachInstances(), () =>
      sel().some((n) => n.type === 'INSTANCE') ? null : 'Select an instance', `${MOD}${ALT}B`),

    ...(!screen.setDiagramMode
      ? []
      : screen.diagramMode
        ? [cmd('View', 'design-mode', 'Switch to design mode', () => screen.setDiagramMode?.(false), always, undefined, 'panels layers properties full')]
        : [cmd('View', 'diagram-mode', 'Switch to diagram mode', () => screen.setDiagramMode?.(true), always, undefined, 'figjam board whiteboard simple')]),
    cmd('View', 'zoom-fit', 'Zoom to fit', () => editor.zoomToFit(), always, `${SHIFT}1`),
    cmd('View', 'zoom-selection', 'Zoom to selection', () => editor.zoomToSelection(), needSel, `${SHIFT}2`),
    cmd('View', 'zoom-100', 'Zoom to 100%', () => editor.zoomTo(1), always, `${SHIFT}0`),
    cmd('View', 'outline', 'Outline mode', () => editor.toggleOutlineMode(), always, `${MOD}Y`, 'wireframe'),
    cmd('View', 'rulers', 'Show or hide rulers', () => editor.toggleRulers(), always, `${SHIFT}R`, 'guides'),
    cmd('View', 'grids', 'Show or hide layout grids', () => editor.toggleGrids(), always, `${MOD}${SHIFT}4`),
    cmd('View', 'pixel-preview', 'Pixel preview', () => editor.toggleView('pixelPreview'), always),
    cmd('View', 'pixel-grid', 'Show or hide pixel grid', () => editor.toggleView('showPixelGrid'), always),
    cmd('View', 'pixel-snap', 'Snap to pixel grid', () => editor.toggleView('snapToPixels'), always),

    cmd('File', 'present', 'Present', screen.present, () => (editor.topFrames().length ? null : 'Draw a frame first'), `${MOD}${ALT}Enter`, 'play prototype'),
    ...(screen.share
      ? [
          cmd('File', 'share-png', 'Share as image', () => screen.share?.('png'), always, undefined, 'send png picture message'),
          cmd('File', 'share-pdf', 'Share as PDF', () => screen.share?.('pdf'), always, undefined, 'send document message'),
        ]
      : []),
    cmd('File', 'export', 'Export file', screen.exportFile, always, `${MOD}${SHIFT}E`, 'download png pdf svg'),
    cmd('File', 'history', 'Version history', screen.history, always, undefined, 'restore save'),
    cmd('File', 'add-page', 'Add page', () => editor.addPage(), always),
  ];
}

/** Commands matching a search: every word must appear in the label, group or keywords. */
export function filterCommands(all: Command[], query: string): Command[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  return all.filter((c) => {
    const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
