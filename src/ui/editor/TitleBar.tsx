import { useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, Ellipsis, Play, Redo2, Search, SlidersHorizontal, Undo2 } from 'lucide-react';
import type { FileMeta } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import type { SaveStatus } from '../../engine/sync.ts';
import { navigate } from '../App.tsx';
import { ALT, IconButton, MOD, Menu, SHIFT } from '../components.tsx';
import { type Theme, useEditorRev } from '../hooks.ts';

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Not saved',
  conflict: 'Not saved',
  error: 'Not saved',
};

export function TitleBar(props: {
  editor: Editor;
  file: FileMeta;
  saveStatus: SaveStatus;
  saveError: string | null;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onRename: (name: string) => Promise<void>;
  onExportFile: () => void;
  onShare: (format: 'png' | 'pdf') => void;
  onHistory: () => void;
  onPresent: () => void;
  onQuickActions: () => void;
  diagramMode: boolean;
  /** On a phone: opens or closes the panel sheet. */
  onPanels?: () => void;
  panelsOpen?: boolean;
  /** Absent when the screen can only show the board (then there's no switch). */
  onDiagramMode?: (on: boolean) => void;
}) {
  const { editor, file, saveStatus, saveError } = props;
  useEditorRev(editor, 'view', 'doc');
  const [renaming, setRenaming] = useState(false);
  const [zoomMenu, setZoomMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLSpanElement>(null);

  const commit = async (value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (name && name !== file.name) await props.onRename(name);
  };

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <IconButton label="Back to files" onClick={() => navigate('#/')}>
          <ChevronLeft size={16} strokeWidth={1.5} />
        </IconButton>
        {renaming ? (
          <input
            className="inline-input title-input"
            defaultValue={file.name}
            aria-label="File name"
            autoFocus
            maxLength={200}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button type="button" className="title-name" onDoubleClick={() => setRenaming(true)} onClick={() => setRenaming(true)} aria-label={`File name: ${file.name}. Click to rename`}>
            {file.name}
          </button>
        )}
        <span className={`save-status ${saveStatus === 'saved' || saveStatus === 'saving' ? '' : 'error'}`} role="status" title={saveError ?? undefined}>
          {saveError && saveStatus !== 'saving' ? saveError : STATUS_TEXT[saveStatus]}
        </span>
      </div>
      <div className="titlebar-right">
        {props.onDiagramMode && (
          <div className="mode-switch" role="group" aria-label="Editor mode">
            <button type="button" aria-pressed={!props.diagramMode} onClick={() => props.onDiagramMode?.(false)} title="Every tool and panel">
              Design
            </button>
            <button type="button" aria-pressed={props.diagramMode} onClick={() => props.onDiagramMode?.(true)} title="Just the board: sticky notes, shapes and connectors">
              Diagram
            </button>
          </div>
        )}
        {props.onPanels && (
          <IconButton label={props.panelsOpen ? 'Hide panels' : 'Show panels'} pressed={props.panelsOpen} onClick={props.onPanels}>
            <SlidersHorizontal size={16} strokeWidth={1.5} />
          </IconButton>
        )}
        <button type="button" className="quick-btn" onClick={props.onQuickActions} aria-label="Quick actions" data-tip={`Quick actions  ${MOD}/`} data-tip-side="bottom">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Search commands</span>
          <kbd>{MOD}/</kbd>
        </button>
        <IconButton label="Undo" shortcut={`${MOD}Z`} disabled={!editor.canUndo} onClick={() => editor.undo()}>
          <Undo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="Redo" shortcut={`${MOD}${SHIFT}Z`} disabled={!editor.canRedo} onClick={() => editor.redo()}>
          <Redo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <button
          type="button"
          className="zoom-btn"
          aria-label="Zoom options"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setZoomMenu({ x: r.right - 200, y: r.bottom + 4 });
          }}
        >
          {Math.round(editor.viewport.zoom * 100)}%
          <ChevronDown size={14} strokeWidth={1.5} />
        </button>
        <span ref={moreRef} className="more-anchor">
          <IconButton
            label="File and view options"
            onClick={() => {
              const r = moreRef.current!.getBoundingClientRect();
              setMoreMenu({ x: r.right - 220, y: r.bottom + 4 });
            }}
          >
            <Ellipsis size={16} strokeWidth={1.5} />
          </IconButton>
        </span>
        <button type="button" className="btn primary small present-btn" onClick={props.onPresent} title={`Present (${MOD}${ALT}Enter)`}>
          <Play size={12} strokeWidth={2} /> <span className="present-label">Present</span>
        </button>
      </div>
      {moreMenu && (
        <Menu
          label="File and view options"
          x={moreMenu.x}
          y={moreMenu.y}
          onClose={() => setMoreMenu(null)}
          items={[
            { label: editor.selection.length ? 'Share selection as image' : 'Share page as image', onSelect: () => props.onShare('png') },
            { label: editor.selection.length ? 'Share selection as PDF' : 'Share page as PDF', onSelect: () => props.onShare('pdf') },
            'separator',
            { label: 'Export file…', shortcut: `${MOD}${SHIFT}E`, onSelect: props.onExportFile },
            { label: 'Version history…', onSelect: props.onHistory },
            'separator',
            ...(['system', 'light', 'dark'] as const).map((t) => ({
              label: `${props.theme === t ? '✓ ' : ''}Theme: ${t === 'system' ? 'match system' : t}`,
              onSelect: () => props.setTheme(t),
            })),
          ]}
        />
      )}
      {zoomMenu && (
        <Menu
          label="Zoom"
          x={zoomMenu.x}
          y={zoomMenu.y}
          onClose={() => setZoomMenu(null)}
          items={[
            { label: 'Zoom in', shortcut: `${MOD}+`, onSelect: () => editor.zoomAt(2, editor.viewSize.width / 2, editor.viewSize.height / 2) },
            { label: 'Zoom out', shortcut: `${MOD}−`, onSelect: () => editor.zoomAt(0.5, editor.viewSize.width / 2, editor.viewSize.height / 2) },
            'separator',
            { label: 'Zoom to fit', shortcut: `${SHIFT}1`, onSelect: () => editor.zoomToFit() },
            { label: 'Zoom to selection', shortcut: `${SHIFT}2`, onSelect: () => editor.zoomToSelection(), disabled: editor.selection.length === 0 },
            { label: 'Zoom to 100%', shortcut: `${SHIFT}0`, onSelect: () => editor.zoomTo(1) },
            'separator',
            { label: editor.outlineMode ? 'Show fills (leave outline mode)' : 'Outline mode', shortcut: `${MOD}Y`, onSelect: () => editor.toggleOutlineMode() },
            { label: editor.pixelPreview ? 'Smooth preview' : 'Pixel preview', onSelect: () => editor.toggleView('pixelPreview') },
            { label: editor.showPixelGrid ? 'Hide pixel grid' : 'Show pixel grid', onSelect: () => editor.toggleView('showPixelGrid') },
            { label: editor.snapToPixels ? "Don't snap to pixels" : 'Snap to pixel grid', onSelect: () => editor.toggleView('snapToPixels') },
            { label: editor.showRulers ? 'Hide rulers' : 'Show rulers', shortcut: `${SHIFT}R`, onSelect: () => editor.toggleRulers() },
            { label: editor.showGrids ? 'Hide layout grids' : 'Show layout grids', shortcut: `${MOD}${SHIFT}4`, onSelect: () => editor.toggleGrids() },
            { label: 'Remove guides on this page', disabled: !(editor.currentPage.guides ?? []).length, onSelect: () => editor.clearGuides() },
          ]}
        />
      )}
    </header>
  );
}
