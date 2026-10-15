import { useEffect, useState } from 'react';
import { type ExportedFile, ExportedFileSchema, validateTree } from '../../shared/schema.ts';
import { ApiError, api } from '../api.ts';
import { navigate } from './App.tsx';
import { readSharedFile } from './shareLink.ts';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; file: ExportedFile; preview: string | null };

/** A file someone sent as a link: what it is, a picture of its first page, and a copy to keep. */
export function SharedScreen({ payload }: { payload: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    document.title = 'Shared file · localframe';
    void (async () => {
      try {
        const parsed = ExportedFileSchema.safeParse(await readSharedFile(payload));
        if (!parsed.success) throw new Error("This link doesn't hold a file this app can open.");
        const file = parsed.data;
        const problem = validateTree(file.nodes, file.pages ?? [{ id: 'page-1', name: 'Page 1', background: file.background }]);
        if (problem) throw new Error(`This file is damaged: ${problem}`);
        // the picture needs the canvas engine: it loads only here
        const preview = await import('./sharePreview.ts').then((m) => m.previewImage(file)).catch(() => null);
        if (!cancelled) setState({ kind: 'ready', file, preview });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : "This link couldn't be opened." });
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
      setState({ kind: 'error', message: e instanceof ApiError ? `Couldn't save the copy: ${e.message}` : "Couldn't save the copy." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="shared-screen">
      {state.kind === 'loading' && <p aria-busy="true">Opening the shared file…</p>}
      {state.kind === 'error' && (
        <>
          <h1>Couldn't open this link</h1>
          <p role="alert">{state.message}</p>
          <button type="button" className="btn secondary" onClick={() => navigate('#/')}>
            Go to your files
          </button>
        </>
      )}
      {state.kind === 'ready' && (
        <>
          <p className="shared-kicker">Someone shared a file with you</p>
          <h1>{state.file.name}</h1>
          <p className="shared-facts">
            {(state.file.pages?.length ?? 1) === 1 ? '1 page' : `${state.file.pages!.length} pages`}, {state.file.nodes.length}{' '}
            {state.file.nodes.length === 1 ? 'layer' : 'layers'}. Links carry no images.
          </p>
          {state.preview && <img className="shared-preview" src={state.preview} alt={`The first page of ${state.file.name}`} />}
          <div className="shared-actions">
            <button type="button" className="btn primary" disabled={saving} onClick={() => void save(state.file)}>
              Save a copy to my files
            </button>
            <button type="button" className="btn ghost" onClick={() => navigate('#/')}>
              Not now
            </button>
          </div>
          <p className="shared-note">The copy is yours: changes you make stay on this device and don't reach whoever sent the link.</p>
        </>
      )}
    </main>
  );
}
