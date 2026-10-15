import { useCallback, useEffect, useState } from 'react';
import type { VersionMeta } from '../../../shared/schema.ts';
import { api } from '../../api.ts';
import { t } from '../i18n.ts';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Saved and autosaved versions of the file: save one, rename, delete, or put one back. */
export function VersionHistory(props: {
  fileId: string;
  onClose: () => void;
  /** Saves pending edits first, so a new version has everything on screen. */
  beforeSave: () => Promise<void>;
  onRestore: (versionId: number) => Promise<void>;
}) {
  const { fileId, onClose } = props;
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setVersions(await api.listVersions(fileId));
    } catch (e) {
      setError(t("Couldn't load versions: {error}", { error: e instanceof Error ? t(e.message) : t('unknown error') }));
    }
  }, [fileId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? t(e.message) : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await props.beforeSave();
      await api.saveVersion(fileId, name.trim());
      setName('');
    });

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="versions-title">
        <h2 id="versions-title">{t('Version history')}</h2>
        <form
          className="version-save"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <input
            className="hex-input override-input"
            value={name}
            maxLength={120}
            placeholder={t('Name this version')}
            aria-label={t('Version name')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            autoFocus
          />
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {t('Save version')}
          </button>
        </form>
        <p className="field-caption">
          {t('The file is also saved here on its own when you start editing again after ten minutes. Restoring keeps what you have now as an autosave.')}
        </p>
        {error && (
          <p className="field-caption error-text" role="alert">
            {error}
          </p>
        )}
        <ul className="version-list" aria-label={t('Versions')} aria-busy={versions === null}>
          {versions?.length === 0 && <li className="version-empty">{t('No versions yet. Name one above to keep this state of the file.')}</li>}
          {versions?.map((v) => (
            <li key={v.id} className="version-item">
              {renaming === v.id ? (
                <input
                  className="hex-input override-input"
                  defaultValue={v.name ?? ''}
                  maxLength={120}
                  aria-label={t('Version name')}
                  autoFocus
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    const value = (e.target as HTMLInputElement).value.trim();
                    if (e.key === 'Enter' && value) {
                      setRenaming(null);
                      void run(() => api.renameVersion(fileId, v.id, value));
                    }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <div className="version-text">
                  <span className="version-name">{v.name ?? t('Autosave')}</span>
                  <span className="file-time">
                    {when.format(new Date(v.createdAt))}, {v.nodeCount === 1 ? t('1 layer') : t('{n} layers', { n: v.nodeCount })}
                  </span>
                </div>
              )}
              {confirming === v.id ? (
                <div className="version-actions">
                  <span className="field-caption">{t('Replace the file with this version?')}</span>
                  <button type="button" className="mini-btn wide" onClick={() => setConfirming(null)}>
                    {t('Cancel')}
                  </button>
                  <button
                    type="button"
                    className="mini-btn wide danger"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      void run(() => props.onRestore(v.id));
                    }}
                  >
                    {t('Restore')}
                  </button>
                </div>
              ) : (
                <div className="version-actions">
                  <button type="button" className="mini-btn wide" disabled={busy} onClick={() => setConfirming(v.id)}>
                    {t('Restore')}
                  </button>
                  <button type="button" className="mini-btn wide" disabled={busy} onClick={() => setRenaming(v.id)}>
                    {v.auto ? t('Name') : t('Rename')}
                  </button>
                  <button type="button" className="mini-btn wide" disabled={busy} aria-label={v.name != null ? t('Delete {name}', { name: v.name }) : t('Delete autosave')} onClick={() => void run(() => api.deleteVersion(fileId, v.id))}>
                    {t('Delete')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
