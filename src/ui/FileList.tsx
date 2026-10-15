import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { sampleFile } from './sampleFile.ts';
import { FilePlus2, MoreHorizontal, Upload } from 'lucide-react';
import type { FileMeta } from '../../shared/schema.ts';
import { ApiError, api, BROWSER_STORAGE, STORAGE_DOWN } from '../api.ts';
import { navigate } from './App.tsx';
import { IconButton, Menu, type MenuItem, ThemeToggle, relativeTime } from './components.tsx';
import type { Theme } from './hooks.ts';

// exporting draws every page, so it brings the canvas engine: loaded when first used
const ExportFileDialog = lazy(() => import('./ExportFileDialog.tsx').then((m) => ({ default: m.ExportFileDialog })));

const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

export function FileList({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ file: FileMeta; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [exporting, setExporting] = useState<FileMeta | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await api.listFiles());
      setError(null);
    } catch {
      setError(STORAGE_DOWN);
    }
  }, []);

  useEffect(() => {
    document.title = 'Files · localframe';
    void refresh();
  }, [refresh]);

  const create = async () => {
    try {
      const f = await api.createFile('Untitled');
      navigate(`#/file/${f.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `Couldn't create a file: ${e.message}` : STORAGE_DOWN);
    }
  };

  const openSample = async () => {
    try {
      const meta = await api.importFile(sampleFile());
      navigate(`#/file/${meta.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `Couldn't open the sample: ${e.message}` : STORAGE_DOWN);
    }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setError('That file is larger than 150 MB, which is the import limit.');
    try {
      const data = JSON.parse(await file.text());
      const meta = await api.importFile(data);
      setNotice(`Imported “${meta.name}”.`);
      await refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Couldn't import that file: ${e.message}`
          : "Couldn't import that file: it isn't a localframe export (.localframe.json).",
      );
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const menuItems = (f: FileMeta): MenuItem[] => [
    { label: 'Open', onSelect: () => navigate(`#/file/${f.id}`) },
    { label: 'Rename', onSelect: () => setRenaming(f.id) },
    { label: 'Export file…', onSelect: () => setExporting(f) },
    'separator',
    {
      label: 'Delete file',
      danger: true,
      onSelect: async () => {
        if (!window.confirm(`Delete “${f.name}”? This can't be undone.`)) return;
        await api.deleteFile(f.id);
        setNotice(`Deleted “${f.name}”.`);
        await refresh();
      },
    },
  ];

  const commitRename = async (f: FileMeta, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === f.name) return;
    await api.updateFile(f.id, { name: trimmed });
    await refresh();
  };

  return (
    <div className="files-screen">
      <header className="files-header">
        <div className="brand" aria-label="localframe">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="currentColor" />
            <path d="M9 7v18M23 7v18M7 9h18M7 23h18" stroke="var(--color-surface)" strokeWidth="2" strokeLinecap="round" />
            <rect x="12" y="12" width="8" height="8" fill="var(--color-accent)" />
          </svg>
          <span className="brand-name">localframe</span>
        </div>
        <div className="files-actions">
          <button type="button" className="btn ghost" onClick={openSample}>
            Sample file
          </button>
          <button type="button" className="btn secondary" aria-label="Import file" onClick={() => importRef.current?.click()}>
            <Upload size={14} strokeWidth={1.75} /> <span className="btn-label">Import file</span>
          </button>
          <button type="button" className="btn primary" aria-label="New file" onClick={create}>
            <FilePlus2 size={14} strokeWidth={1.75} /> <span className="btn-label">New file</span>
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => onImport(e.target.files?.[0])}
          />
        </div>
      </header>

      <main className="files-main">
        <h1>Files</h1>
        {BROWSER_STORAGE && (
          <p className="browser-note">
            Files are saved in this browser only, on this device. Nothing is uploaded. Clearing site data removes them, so use
            Export to keep a copy.
          </p>
        )}
        {error && (
          <p className="status-line error" role="alert">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className="status-line" role="status">
            {notice}
          </p>
        )}
        {files && files.length === 0 && (
          <div className="files-empty">
            <p>No files yet. Start a blank file, or open a finished sample to see how it's built.</p>
            <div className="files-empty-actions">
              <button type="button" className="btn primary" onClick={create}>
                <FilePlus2 size={14} strokeWidth={1.75} /> New file
              </button>
              <button type="button" className="btn secondary" onClick={openSample}>
                Open a sample file
              </button>
            </div>
          </div>
        )}
        {files && files.length > 0 && (
          <ul className="file-grid">
            {files.map((f) => (
              <li key={f.id} className="file-card">
                <a className="file-link" href={`#/file/${f.id}`} aria-label={`Open ${f.name}`}>
                  <div className="file-thumb" style={{ background: f.background }}>
                    {f.hasThumbnail && <img src={api.thumbnailUrl(f.id, f.updatedAt)} alt="" loading="lazy" />}
                  </div>
                </a>
                <div className="file-meta">
                  <div className="file-text">
                    {renaming === f.id ? (
                      <input
                        className="inline-input"
                        defaultValue={f.name}
                        aria-label="File name"
                        autoFocus
                        maxLength={200}
                        onBlur={(e) => commitRename(f, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <a className="file-name" href={`#/file/${f.id}`}>
                        {f.name}
                      </a>
                    )}
                    <span className="file-time">{relativeTime(f.updatedAt)}</span>
                  </div>
                  <IconButton
                    label={`More actions for ${f.name}`}
                    onClick={() => {
                      const el = document.activeElement as HTMLElement;
                      const r = el.getBoundingClientRect();
                      setMenu({ file: f, x: r.left, y: r.bottom + 4 });
                    }}
                  >
                    <MoreHorizontal size={16} strokeWidth={1.5} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      {menu && <Menu label="File actions" x={menu.x} y={menu.y} items={menuItems(menu.file)} onClose={() => setMenu(null)} />}
      {exporting && (
        <Suspense fallback={null}>
          <ExportFileDialog fileId={exporting.id} fileName={exporting.name} onClose={() => setExporting(null)} />
        </Suspense>
      )}
    </div>
  );
}
