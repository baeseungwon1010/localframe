import { useEffect, useState } from 'react';
import { FileList } from './FileList.tsx';
import { EditorScreen } from './editor/EditorScreen.tsx';
import { useTheme } from './hooks.ts';

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

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route.name === 'file') return <EditorScreen key={route.id} fileId={route.id} theme={theme} setTheme={setTheme} />;
  return <FileList theme={theme} setTheme={setTheme} />;
}
