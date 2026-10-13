import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Channel, Editor } from '../engine/editor.ts';
import { FONT_FAMILIES } from '../engine/text.ts';

/** Re-renders when the editor emits on any of the given channels. */
export function useEditorRev(editor: Editor, ...channels: Channel[]): number {
  const key = channels.join(',');
  const subscribe = useCallback(
    (fn: () => void) => {
      const offs = key.split(',').map((c) => editor.subscribe(c as Channel, fn));
      return () => offs.forEach((off) => off());
    },
    [editor, key],
  );
  const snapshot = useCallback(() => key.split(',').reduce((s, c) => s + editor.revs[c as Channel], 0), [editor, key]);
  return useSyncExternalStore(subscribe, snapshot);
}

export type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('localframe.theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('localframe.theme', theme);
    } catch {
      /* private mode: theme just isn't remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}

/** Resolves once the bundled fonts are ready, so text is measured with the right glyphs. */
export function loadFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const loads: Promise<unknown>[] = [];
  for (const family of FONT_FAMILIES) {
    for (const weight of [400, 500, 600, 700]) loads.push(document.fonts.load(`${weight} 16px "${family}"`, 'Aa가'));
  }
  loads.push(document.fonts.load('500 12px "IBM Plex Sans"'));
  return Promise.race([Promise.allSettled(loads).then(() => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
}
