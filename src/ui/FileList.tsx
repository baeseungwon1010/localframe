import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { sampleFile } from './sampleFile.ts';
import { ArchiveRestore, Download, FilePlus2, MoreHorizontal, Upload, X } from 'lucide-react';
import type { FileMeta } from '../../shared/schema.ts';
import { ApiError, api, BROWSER_STORAGE, STORAGE_DOWN } from '../api.ts';
import { navigate } from './App.tsx';
import { IconButton, Menu, type MenuItem, ThemeToggle, relativeTime } from './components.tsx';
import type { Theme } from './hooks.ts';
import { useInstall } from './pwa.ts';
import {
  backUpToFolder,
  backupDue,
  backupFolder,
  canBackUpToFolder,
  chooseBackupFolder,
  folderReady,
  forgetBackupFolder,
  lastBackup,
  makeBackup,
  markBackedUp,
  restoreBackup,
  snoozeBackupReminder,
} from './backup.ts';
import { downloadBlob } from './download.ts';

// exporting draws every page, so it brings the canvas engine: loaded when first used
const ExportFileDialog = lazy(() => import('./ExportFileDialog.tsx').then((m) => ({ default: m.ExportFileDialog })));

const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

export function FileList({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const app = useInstall();
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ file: FileMeta; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [exporting, setExporting] = useState<FileMeta | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  const [backupMenu, setBackupMenu] = useState<{ x: number; y: number } | null>(null);
  const [folder, setFolder] = useState<Awaited<ReturnType<typeof backupFolder>>>(null);
  const [busy, setBusy] = useState(false);
  const [reminderHidden, setReminderHidden] = useState(false);

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

  // a folder chosen for automatic backups gets the latest files whenever this list opens
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dir = await backupFolder();
      if (cancelled || !dir) return;
      setFolder(dir);
      const list = await api.listFiles().catch(() => [] as FileMeta[]);
      const last = lastBackup()?.getTime() ?? 0;
      const changed = list.some((f) => Date.parse(f.updatedAt) > last);
      if (!changed || !(await folderReady(dir))) return;
      const n = await backUpToFolder(dir, false).catch(() => null);
      if (!cancelled && n !== null) setNotice(`Backed up ${n} ${n === 1 ? 'file' : 'files'} to the “${dir.name}” folder.`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const backUpNow = async () => {
    setBusy(true);
    try {
      if (folder) {
        const n = await backUpToFolder(folder, true);
        if (n === null) return setError(`Couldn't write to the “${folder.name}” folder: permission was not given.`);
        setNotice(`Backed up ${n} ${n === 1 ? 'file' : 'files'} to the “${folder.name}” folder.`);
      } else {
        const { blob, filename, count, createdAt } = await makeBackup();
        downloadBlob(blob, filename);
        markBackedUp(createdAt);
        setNotice(`Backed up ${count} ${count === 1 ? 'file' : 'files'} to ${filename}. Keep it somewhere safe, such as a cloud drive.`);
      }
      setError(null);
    } catch (e) {
      setError(`Couldn't back up: ${e instanceof Error ? e.message : 'storage is not available'}`);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { restored, failed } = await restoreBackup(file);
      setNotice(
        `Restored ${restored.length} ${restored.length === 1 ? 'file' : 'files'}${failed.length ? `; ${failed.length} could not be read: ${failed.join(', ')}` : ''}.`,
      );
      setError(null);
      await refresh();
    } catch (e) {
      setError(`Couldn't restore: ${e instanceof Error ? e.message : 'unknown problem'}`);
    } finally {
      setBusy(false);
      if (restoreRef.current) restoreRef.current.value = '';
      if (importRef.current) importRef.current.value = '';
    }
  };

  const backupItems: MenuItem[] = [
    { label: folder ? `Back up to “${folder.name}” now` : 'Back up all files', onSelect: () => void backUpNow() },
    { label: 'Restore from a backup…', onSelect: () => restoreRef.current?.click() },
    ...(canBackUpToFolder()
      ? (['separator',
          folder
            ? {
                label: 'Stop backing up to this folder',
                onSelect: async () => {
                  await forgetBackupFolder();
                  setFolder(null);
                  setNotice('Backups go to your downloads again.');
                },
              }
            : {
                label: 'Back up to a folder automatically…',
                onSelect: async () => {
                  try {
                    const dir = await chooseBackupFolder();
                    if (!dir) return;
                    setFolder(dir);
                    const n = await backUpToFolder(dir, true);
                    if (n !== null) setNotice(`Backed up ${n} ${n === 1 ? 'file' : 'files'} to “${dir.name}”. It updates whenever you come back to this list.`);
                  } catch {
                    /* picker closed */
                  }
                },
              },
        ] as MenuItem[])
      : []),
  ];

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
    if (/\.zip$/i.test(file.name)) return onRestore(file);
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
          <button
            type="button"
            className="btn secondary"
            aria-label="Backup"
            aria-haspopup="menu"
            disabled={busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setBackupMenu({ x: r.right - 260, y: r.bottom + 4 });
            }}
          >
            <ArchiveRestore size={14} strokeWidth={1.75} /> <span className="btn-label">Backup</span>
          </button>
          {app.canInstall && (
            <button type="button" className="btn secondary" aria-label="Install app" onClick={app.install}>
              <Download size={14} strokeWidth={1.75} /> <span className="btn-label">Install app</span>
            </button>
          )}
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json,.zip,application/zip"
            hidden
            onChange={(e) => onImport(e.target.files?.[0])}
          />
          <input
            ref={restoreRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Backup to restore"
            onChange={(e) => onRestore(e.target.files?.[0])}
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
        {BROWSER_STORAGE && files && !reminderHidden && backupDue(files) && (
          <div className="install-hint backup-reminder" role="note">
            <p>
              {lastBackup()
                ? `Your last backup was on ${lastBackup()!.toLocaleDateString()}, and files have changed since.`
                : 'These files exist only in this browser.'}{' '}
              A backup keeps them safe if site data is cleared or you change devices.
            </p>
            <span className="reminder-actions">
              <button type="button" className="btn primary small" disabled={busy} onClick={() => void backUpNow()}>
                Back up now
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  snoozeBackupReminder();
                  setReminderHidden(true);
                }}
              >
                Later
              </button>
            </span>
          </div>
        )}
        {app.iosHint && (
          <div className="install-hint" role="note">
            <p>
              Use localframe like an app, offline too: tap Share, then <strong>Add to Home Screen</strong>. Safari may clear
              files of sites you don't visit for a while; on the Home Screen they are kept.
            </p>
            <IconButton label="Dismiss" onClick={app.dismissHint}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
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
      {backupMenu && <Menu label="Backup" x={backupMenu.x} y={backupMenu.y} items={backupItems} onClose={() => setBackupMenu(null)} />}
      {exporting && (
        <Suspense fallback={null}>
          <ExportFileDialog fileId={exporting.id} fileName={exporting.name} onClose={() => setExporting(null)} />
        </Suspense>
      )}
    </div>
  );
}
