import { Suspense, lazy, useEffect, useState } from 'react';
import { FileList } from './FileList.tsx';
import { useTheme } from './hooks.ts';
import { useAppUpdate } from './pwa.ts';
import { SharedScreen } from './SharedScreen.tsx';
import { SHARE_ROUTE } from './shareLink.ts';

// the editor (canvas engine, panels, fonts) loads the first time a file is opened
const loadEditor = () => import('./editor/EditorScreen.tsx');
const EditorScreen = lazy(() => loadEditor().then((m) => ({ default: m.EditorScreen })));

/** Once the file list is up and the browser is idle, fetch the editor so opening a file is quick. */
function prefetchEditor() {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1500));
  idle(() => void loadEditor().catch(() => {}));
}

type Route = { name: 'files' } | { name: 'file'; id: string } | { name: 'shared'; payload: string };

function parseHash(): Route {
  const hash = window.location.hash;
  if (hash.startsWith(SHARE_ROUTE)) return { name: 'shared', payload: hash.slice(SHARE_ROUTE.length) };
  const m = /^#\/file\/([A-Za-z0-9_-]{1,64})$/.exec(hash);
  return m ? { name: 'file', id: m[1] } : { name: 'files' };
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

/** A new version has been downloaded: it takes over when you choose to reload. */
function UpdateBanner() {
  const update = useAppUpdate();
  if (!update.ready) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of localframe is ready.</span>
      <button type="button" className="btn primary small" onClick={update.apply}>
        Reload
      </button>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [theme, setTheme] = useTheme();

  useEffect(prefetchEditor, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      {route.name === 'file' ? (
        <Suspense fallback={<div className="center-message" aria-busy="true">Opening file…</div>}>
          <EditorScreen key={route.id} fileId={route.id} theme={theme} setTheme={setTheme} />
        </Suspense>
      ) : route.name === 'shared' ? (
        <SharedScreen payload={route.payload} />
      ) : (
        <FileList theme={theme} setTheme={setTheme} />
      )}
      <UpdateBanner />
    </>
  );
}
