import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { sampleFile } from './sampleFile.ts';
import { ArchiveRestore, Download, FilePlus2, MoreHorizontal, Upload, X } from 'lucide-react';
import type { FileMeta } from '../../shared/schema.ts';
import { ApiError, api, BROWSER_STORAGE, STORAGE_DOWN } from '../api.ts';
import { navigate } from './App.tsx';
import { IconButton, LanguageMenu, Menu, type MenuItem, ThemeToggle, dateLocale, relativeTime } from './components.tsx';
import { type Theme, rememberDiagramMode } from './hooks.ts';
import { useInstall } from './pwa.ts';
import { backupDue, backupFolder, canBackUpToFolder, forgetBackupFolder, lastBackup, markBackedUp, snoozeBackupReminder } from './backupStatus.ts';

/** Backing up and restoring (ZIP writing and reading) load when first used. */
const backupWork = () => import('./backup.ts');
import { downloadBlob } from './download.ts';
import { t } from './i18n.ts';
import { forgetHistory } from './undoStore.ts';

// exporting draws every page, so it brings the canvas engine: loaded when first used
const ExportFileDialog = lazy(() => import('./ExportFileDialog.tsx').then((m) => ({ default: m.ExportFileDialog })));

const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

const backedUpToFolder = (n: number, folder: string) =>
  n === 1
    ? t('Backed up 1 file to the “{folder}” folder.', { folder })
    : t('Backed up {n} files to the “{folder}” folder.', { n, folder });

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
      setError(t(STORAGE_DOWN));
    }
  }, []);

  useEffect(() => {
    document.title = t('Files · localframe');
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
      if (!changed) return;
      const { backUpToFolder, folderReady } = await backupWork();
      if (cancelled || !(await folderReady(dir))) return;
      const n = await backUpToFolder(dir, false).catch(() => null);
      if (!cancelled && n !== null) setNotice(backedUpToFolder(n, dir.name));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const backUpNow = async () => {
    setBusy(true);
    try {
      const { backUpToFolder, makeBackup } = await backupWork();
      if (folder) {
        const n = await backUpToFolder(folder, true);
        if (n === null) return setError(t("Couldn't write to the “{folder}” folder: permission was not given.", { folder: folder.name }));
        setNotice(backedUpToFolder(n, folder.name));
      } else {
        const { blob, filename, count, createdAt } = await makeBackup();
        downloadBlob(blob, filename);
        markBackedUp(createdAt);
        setNotice(
          count === 1
            ? t('Backed up 1 file to {filename}. Keep it somewhere safe, such as a cloud drive.', { filename })
            : t('Backed up {n} files to {filename}. Keep it somewhere safe, such as a cloud drive.', { n: count, filename }),
        );
      }
      setError(null);
    } catch (e) {
      setError(t("Couldn't back up: {reason}", { reason: e instanceof Error ? t(e.message) : t('storage is not available') }));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { restoreBackup } = await backupWork();
      const { restored, failed } = await restoreBackup(file);
      const vars = { n: restored.length, failed: failed.length, list: failed.join(', ') };
      setNotice(
        failed.length
          ? restored.length === 1
            ? t('Restored 1 file; {failed} could not be read: {list}.', vars)
            : t('Restored {n} files; {failed} could not be read: {list}.', vars)
          : restored.length === 1
            ? t('Restored 1 file.')
            : t('Restored {n} files.', vars),
      );
      setError(null);
      await refresh();
    } catch (e) {
      setError(t("Couldn't restore: {reason}", { reason: e instanceof Error ? t(e.message) : t('unknown problem') }));
    } finally {
      setBusy(false);
      if (restoreRef.current) restoreRef.current.value = '';
      if (importRef.current) importRef.current.value = '';
    }
  };

  const backupItems: MenuItem[] = [
    { label: folder ? t('Back up to “{folder}” now', { folder: folder.name }) : t('Back up all files'), onSelect: () => void backUpNow() },
    { label: t('Restore from a backup…'), onSelect: () => restoreRef.current?.click() },
    ...(canBackUpToFolder()
      ? (['separator',
          folder
            ? {
                label: t('Stop backing up to this folder'),
                onSelect: async () => {
                  await forgetBackupFolder();
                  setFolder(null);
                  setNotice(t('Backups go to your downloads again.'));
                },
              }
            : {
                label: t('Back up to a folder automatically…'),
                onSelect: async () => {
                  try {
                    const { backUpToFolder, chooseBackupFolder } = await backupWork();
                    const dir = await chooseBackupFolder();
                    if (!dir) return;
                    setFolder(dir);
                    const n = await backUpToFolder(dir, true);
                    if (n !== null)
                      setNotice(
                        n === 1
                          ? t('Backed up 1 file to “{folder}”. It updates whenever you come back to this list.', { folder: dir.name })
                          : t('Backed up {n} files to “{folder}”. It updates whenever you come back to this list.', { n, folder: dir.name }),
                      );
                  } catch {
                    /* picker closed */
                  }
                },
              },
        ] as MenuItem[])
      : []),
  ];

  /** A new file; a board opens in diagram mode, with its templates. */
  const create = async (board = false) => {
    try {
      const f = await api.createFile(board ? t('Untitled board') : t('Untitled'));
      if (board) rememberDiagramMode(f.id);
      navigate(`#/file/${f.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? t("Couldn't create a file: {reason}", { reason: t(e.message) }) : t(STORAGE_DOWN));
    }
  };

  const openSample = async () => {
    try {
      const meta = await api.importFile(sampleFile());
      navigate(`#/file/${meta.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? t("Couldn't open the sample: {reason}", { reason: t(e.message) }) : t(STORAGE_DOWN));
    }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (/\.zip$/i.test(file.name)) return onRestore(file);
    if (file.size > MAX_IMPORT_BYTES) return setError(t('That file is larger than 150 MB, which is the import limit.'));
    try {
      const data = JSON.parse(await file.text());
      const meta = await api.importFile(data);
      setNotice(t('Imported “{name}”.', { name: meta.name }));
      await refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? t("Couldn't import that file: {reason}", { reason: t(e.message) })
          : t("Couldn't import that file: it isn't a localframe export (.localframe.json)."),
      );
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const menuItems = (f: FileMeta): MenuItem[] => [
    { label: t('Open'), onSelect: () => navigate(`#/file/${f.id}`) },
    { label: t('Rename'), onSelect: () => setRenaming(f.id) },
    { label: t('Export file…'), onSelect: () => setExporting(f) },
    'separator',
    {
      label: t('Delete file'),
      danger: true,
      onSelect: async () => {
        if (!window.confirm(t("Delete “{name}”? This can't be undone.", { name: f.name }))) return;
        await api.deleteFile(f.id);
        void forgetHistory(f.id);
        setNotice(t('Deleted “{name}”.', { name: f.name }));
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

  const [iosHintBefore, iosHintAfter = ''] = t('Use localframe like an app, offline too: tap Share, then {button}.').split('{button}');

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
            {t('Sample file')}
          </button>
          <button type="button" className="btn secondary" aria-label={t('Import file')} onClick={() => importRef.current?.click()}>
            <Upload size={14} strokeWidth={1.75} /> <span className="btn-label">{t('Import file')}</span>
          </button>
          <button type="button" className="btn primary" aria-label={t('New file')} onClick={() => void create()}>
            <FilePlus2 size={14} strokeWidth={1.75} /> <span className="btn-label">{t('New file')}</span>
          </button>
          <button
            type="button"
            className="btn secondary"
            aria-label={t('Backup')}
            aria-haspopup="menu"
            disabled={busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setBackupMenu({ x: r.right - 260, y: r.bottom + 4 });
            }}
          >
            <ArchiveRestore size={14} strokeWidth={1.75} /> <span className="btn-label">{t('Backup')}</span>
          </button>
          {app.canInstall && (
            <button type="button" className="btn secondary" aria-label={t('Install app')} onClick={app.install}>
              <Download size={14} strokeWidth={1.75} /> <span className="btn-label">{t('Install app')}</span>
            </button>
          )}
          <LanguageMenu />
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
            aria-label={t('Backup to restore')}
            onChange={(e) => onRestore(e.target.files?.[0])}
          />
        </div>
      </header>

      <main className="files-main">
        <h1>{t('Files')}</h1>
        {/* the welcome says this on a first visit */}
        {BROWSER_STORAGE && !!files?.length && (
          <p className="browser-note">
            {t(
              'Files are saved in this browser only, on this device. Nothing is uploaded. Clearing site data removes them, so use Export to keep a copy.',
            )}
          </p>
        )}
        {BROWSER_STORAGE && files && !reminderHidden && backupDue(files) && (
          <div className="install-hint backup-reminder" role="note">
            <p>
              {lastBackup()
                ? t('Your last backup was on {date}, and files have changed since.', { date: lastBackup()!.toLocaleDateString(dateLocale()) })
                : t('These files exist only in this browser.')}{' '}
              {t('A backup keeps them safe if site data is cleared or you change devices.')}
            </p>
            <span className="reminder-actions">
              <button type="button" className="btn primary small" disabled={busy} onClick={() => void backUpNow()}>
                {t('Back up now')}
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  snoozeBackupReminder();
                  setReminderHidden(true);
                }}
              >
                {t('Later')}
              </button>
            </span>
          </div>
        )}
        {app.iosHint && (
          <div className="install-hint" role="note">
            <p>
              {iosHintBefore}
              <strong>{t('Add to Home Screen')}</strong>
              {iosHintAfter} {t("Safari may clear files of sites you don't visit for a while; on the Home Screen they are kept.")}
            </p>
            <IconButton label={t('Dismiss')} onClick={app.dismissHint}>
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
          <section className="welcome" aria-labelledby="welcome-title">
            <div className="welcome-text">
              <h2 id="welcome-title">{t('Design screens and draw diagrams, right in your browser')}</h2>
              <ul>
                <li>
                  {BROWSER_STORAGE
                    ? t('Nothing to sign up for. Your files are saved in this browser, on this device.')
                    : t('Nothing to sign up for. Your files are saved on this computer.')}
                </li>
                {BROWSER_STORAGE && <li>{t('Once it has loaded it works offline, and it installs like an app.')}</li>}
                <li>{BROWSER_STORAGE ? t('Share a board as an image, a PDF or a link.') : t('Share a board as an image, a PDF.')}</li>
              </ul>
              <div className="files-empty-actions">
                <button type="button" className="btn primary" onClick={() => void create()}>
                  <FilePlus2 size={14} strokeWidth={1.75} /> {t('New file')}
                </button>
                <button type="button" className="btn secondary" onClick={() => void create(true)}>
                  {t('Start a board')}
                </button>
                <button type="button" className="btn ghost" onClick={openSample}>
                  {t('Open a sample file')}
                </button>
              </div>
            </div>
            <img className="welcome-art" src={`${import.meta.env.BASE_URL}board-sketch.svg`} alt="" width="360" height="240" />
          </section>
        )}
        {files && files.length > 0 && (
          <ul className="file-grid">
            {files.map((f) => (
              <li key={f.id} className="file-card">
                <a className="file-link" href={`#/file/${f.id}`} aria-label={t('Open {name}', { name: f.name })}>
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
                        aria-label={t('File name')}
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
                    label={t('More actions for {name}', { name: f.name })}
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
      {menu && <Menu label={t('File actions')} x={menu.x} y={menu.y} items={menuItems(menu.file)} onClose={() => setMenu(null)} />}
      {backupMenu && <Menu label={t('Backup')} x={backupMenu.x} y={backupMenu.y} items={backupItems} onClose={() => setBackupMenu(null)} />}
      {exporting && (
        <Suspense fallback={null}>
          <ExportFileDialog fileId={exporting.id} fileName={exporting.name} onClose={() => setExporting(null)} />
        </Suspense>
      )}
    </div>
  );
}
