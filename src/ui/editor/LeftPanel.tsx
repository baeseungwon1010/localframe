import { useEffect, useRef, useState } from 'react';
import { LibraryPanel } from './LibraryPanel.tsx';
import { ChevronDown, ChevronRight, Component, FileText, Plus } from 'lucide-react';
import type { SceneNode } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { drawNode } from '../../engine/render.ts';
import { IconButton, Menu, type MenuItem } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';
import { LayersPanel } from './LayersPanel.tsx';
import { StylesList, VariablesDialog } from './assetsPanels.tsx';

export function LeftPanel({ editor }: { editor: Editor }) {
  const [tab, setTab] = useState<'layers' | 'assets'>('layers');
  return (
    <aside className="layers" aria-label="Layers and pages">
      <PagesSection editor={editor} />
      <div className="tabs" role="tablist" aria-label="Left panel">
        <button type="button" role="tab" aria-selected={tab === 'layers'} className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>
          Layers
        </button>
        <button type="button" role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
          Assets
        </button>
      </div>
      {tab === 'layers' ? <LayersPanel editor={editor} /> : <AssetsPanel editor={editor} />}
    </aside>
  );
}

function PagesSection({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'pages');
  // one page: a single row; the list opens when there are more (or when asked)
  const many = editor.pages.length > 1;
  const [open, setOpen] = useState(many);
  useEffect(() => {
    if (many) setOpen(true);
  }, [many]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const current = editor.currentPage.id;

  const items = (id: string): MenuItem[] => {
    const i = editor.pages.findIndex((p) => p.id === id);
    return [
      { label: 'Rename', onSelect: () => setRenaming(id) },
      { label: 'Duplicate page', onSelect: () => editor.duplicatePage(id) },
      { label: 'Move up', disabled: i <= 0, onSelect: () => editor.movePage(id, i - 1) },
      { label: 'Move down', disabled: i >= editor.pages.length - 1, onSelect: () => editor.movePage(id, i + 1) },
      'separator',
      {
        label: 'Delete page',
        danger: true,
        disabled: editor.pages.length <= 1,
        onSelect: () => {
          const page = editor.pages.find((p) => p.id === id);
          if (page && window.confirm(`Delete “${page.name}” and everything on it? You can undo this.`)) editor.deletePage(id);
        },
      },
    ];
  };

  return (
    <section className="pages" aria-label="Pages">
      <div className="pages-head">
        <button type="button" className="pages-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
          Pages
          {!open && <span className="pages-current">{editor.currentPage.name}</span>}
        </button>
        <IconButton label="Add page" onClick={() => editor.addPage()}>
          <Plus size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
      {open && (
        <ul className="page-list" role="listbox" aria-label="Pages">
          {editor.pages.map((p) => (
            <li
              key={p.id}
              role="option"
              aria-selected={p.id === current}
              aria-label={p.name}
              className={`page-row ${p.id === current ? 'selected' : ''}`}
              tabIndex={0}
              onClick={() => editor.switchPage(p.id)}
              onDoubleClick={() => setRenaming(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setRenaming(p.id);
                if (e.key === ' ') editor.switchPage(p.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: p.id, x: e.clientX, y: e.clientY });
              }}
            >
              <FileText size={12} strokeWidth={1.5} className="page-icon" />
              {renaming === p.id ? (
                <input
                  className="inline-input row-input"
                  defaultValue={p.name}
                  aria-label="Page name"
                  autoFocus
                  maxLength={200}
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    editor.renamePage(p.id, e.target.value);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="row-name">{p.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {menu && <Menu label="Page actions" x={menu.x} y={menu.y} items={items(menu.id)} onClose={() => setMenu(null)} />}
    </section>
  );
}

/** A small rendering of a component for the assets list. */
function ComponentPreview({ editor, node }: { editor: Editor; node: SceneNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEditorRev(editor, 'doc');
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const size = 40;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = Math.min((size - 6) / Math.max(1, node.width), (size - 6) / Math.max(1, node.height));
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (size - node.width * s) / 2, dpr * (size - node.height * s) / 2);
    drawNode(ctx, editor.doc, { ...node, x: 0, y: 0, rotation: 0, opacity: 1, visible: true });
  });
  return <canvas ref={ref} className="asset-preview" style={{ width: 40, height: 40 }} aria-hidden="true" />;
}

function AssetsPanel({ editor }: { editor: Editor }) {
  const [varsOpen, setVarsOpen] = useState(false);
  return (
    <div className="assets-body">
      <div className="assets-actions">
        <button type="button" className="btn secondary small" onClick={() => setVarsOpen(true)}>
          Variables ({editor.variables.vars.length})
        </button>
      </div>
      <h4 className="asset-heading">Components</h4>
      <ComponentList editor={editor} />
      <LibraryPanel editor={editor} />
      <StylesList editor={editor} />
      {varsOpen && <VariablesDialog editor={editor} onClose={() => setVarsOpen(false)} />}
    </div>
  );
}

function ComponentList({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'doc', 'pages');
  // a component set shows once; inserting it places its first variant
  const comps = editor.components().filter((c) => editor.doc.get(c.parentId ?? '')?.type !== 'COMPONENT_SET');
  for (const n of editor.doc.all()) if (n.type === 'COMPONENT_SET') {
    const first = editor.doc.children(n.id)[0];
    if (first) comps.push({ ...editor.doc.get(first)!, name: n.name });
  }
  comps.sort((a, b) => a.name.localeCompare(b.name));
  const pageName = (id: string) => editor.pages.find((p) => p.id === editor.doc.pageOf(id))?.name ?? '';
  if (comps.length === 0) {
    return (
      <p className="panel-empty">
        No components yet. Select a frame and press Ctrl+Alt+K (⌘⌥K on Mac) to make one. Its instances update when you change it.
      </p>
    );
  }
  return (
    <ul className="asset-list" aria-label="Components">
      {comps.map((c) => (
        <li key={c.id} className="asset-row">
          <ComponentPreview editor={editor} node={c} />
          <div className="asset-text">
            <span className="row-name">
              <Component size={12} strokeWidth={1.5} className="component-ink" /> {c.name}
            </span>
            <span className="file-time">{pageName(c.id)}</span>
          </div>
          <button
            type="button"
            className="btn secondary small"
            onClick={() => {
              const at = editor.toWorld(editor.viewSize.width / 2, editor.viewSize.height / 2);
              editor.createInstance(c.id, at);
            }}
          >
            Insert
          </button>
        </li>
      ))}
    </ul>
  );
}
