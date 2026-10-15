import { useEffect, useState } from 'react';
import { type ExportedFile, ExportedFileSchema, validateTree } from '../../shared/schema.ts';
import { ApiError, api } from '../api.ts';
import { navigate } from './App.tsx';
import { t } from './i18n.ts';
import { readSharedFile } from './shareLink.ts';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; file: ExportedFile; preview: string | null };

/** A file someone sent as a link: what it is, a picture of its first page, and a copy to keep. */
export function SharedScreen({ payload }: { payload: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    document.title = t('Shared file · localframe');
    void (async () => {
      try {
        const parsed = ExportedFileSchema.safeParse(await readSharedFile(payload));
        if (!parsed.success) throw new Error("This link doesn't hold a file this app can open.");
        const file = parsed.data;
        const problem = validateTree(file.nodes, file.pages ?? [{ id: 'page-1', name: 'Page 1', background: file.background }]);
        if (problem) {
          if (!cancelled) setState({ kind: 'error', message: t('This file is damaged: {problem}', { problem: t(problem) }) });
          return;
        }
        // the picture needs the canvas engine: it loads only here
        const preview = await import('./sharePreview.ts').then((m) => m.previewImage(file)).catch(() => null);
        if (!cancelled) setState({ kind: 'ready', file, preview });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? t(e.message) : t("This link couldn't be opened.") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const save = async (file: ExportedFile) => {
    setSaving(true);
    try {
      const meta = await api.importFile(file);
      navigate(`#/file/${meta.id}`);
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError ? t("Couldn't save the copy: {reason}", { reason: t(e.message) }) : t("Couldn't save the copy.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="shared-screen">
      {state.kind === 'loading' && <p aria-busy="true">{t('Opening the shared file…')}</p>}
      {state.kind === 'error' && (
        <>
          <h1>{t("Couldn't open this link")}</h1>
          <p role="alert">{state.message}</p>
          <button type="button" className="btn secondary" onClick={() => navigate('#/')}>
            {t('Go to your files')}
          </button>
        </>
      )}
      {state.kind === 'ready' && (
        <>
          <p className="shared-kicker">{t('Someone shared a file with you')}</p>
          <h1>{state.file.name}</h1>
          <p className="shared-facts">
            {t('{pages}, {layers}. Links carry no images.', {
              pages: (state.file.pages?.length ?? 1) === 1 ? t('1 page') : t('{n} pages', { n: state.file.pages!.length }),
              layers: state.file.nodes.length === 1 ? t('1 layer') : t('{n} layers', { n: state.file.nodes.length }),
            })}
          </p>
          {state.preview && <img className="shared-preview" src={state.preview} alt={t('The first page of {name}', { name: state.file.name })} />}
          <div className="shared-actions">
            <button type="button" className="btn primary" disabled={saving} onClick={() => void save(state.file)}>
              {t('Save a copy to my files')}
            </button>
            <button type="button" className="btn ghost" onClick={() => navigate('#/')}>
              {t('Not now')}
            </button>
          </div>
          <p className="shared-note">{t("The copy is yours: changes you make stay on this device and don't reach whoever sent the link.")}</p>
        </>
      )}
    </main>
  );
}
