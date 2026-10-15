import { Suspense, lazy, useEffect, useState } from 'react';
import { FileList } from './FileList.tsx';
import { useTheme } from './hooks.ts';

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

type Route = { name: 'files' } | { name: 'file'; id: string };

function parseHash(): Route {
  const m = /^#\/file\/([A-Za-z0-9_-]{1,64})$/.exec(window.location.hash);
  return m ? { name: 'file', id: m[1] } : { name: 'files' };
}

export function navigate(hash: string) {
  window.location.hash = hash;
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

  if (route.name === 'file')
    return (
      <Suspense fallback={<div className="center-message" aria-busy="true">Opening file…</div>}>
        <EditorScreen key={route.id} fileId={route.id} theme={theme} setTheme={setTheme} />
      </Suspense>
    );
  return <FileList theme={theme} setTheme={setTheme} />;
}
