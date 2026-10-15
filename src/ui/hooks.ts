import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Channel, Editor } from '../engine/editor.ts';
import { FONT_FAMILIES, type UsedFace } from '../engine/text.ts';

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

/**
 * Resolves once bundled fonts are ready, so text is measured with the right glyphs: the given
 * faces (with the subsets their characters need), or every family and weight.
 */
export function loadFonts(faces?: UsedFace[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const loads: Promise<unknown>[] = [];
  if (faces) {
    for (const f of faces) loads.push(document.fonts.load(`${f.weight} 16px "${f.family}"`, `Aa${f.text}`));
  } else {
    for (const family of FONT_FAMILIES) {
      for (const weight of [400, 500, 600, 700]) loads.push(document.fonts.load(`${weight} 16px "${family}"`, 'Aa가'));
    }
  }
  loads.push(document.fonts.load('500 12px "IBM Plex Sans"'));
  return Promise.race([Promise.allSettled(loads).then(() => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
}

/** A boolean UI choice kept in this browser (for example, whether extra options are shown). */
export function useRemembered(name: string, initial: boolean): [boolean, (v: boolean) => void] {
  const key = `localframe.ui.${name}`;
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* not remembered */
    }
  };
  return [value, set];
}

const DIAGRAM_FILES = 'localframe.diagramFiles';

/** Whether a file opens in diagram mode (the simple board view), kept per file in this browser. */
export function useDiagramMode(fileId: string): [boolean, (v: boolean) => void] {
  const read = (): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(DIAGRAM_FILES) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const [value, setValue] = useState(() => read().includes(fileId));
  useEffect(() => setValue(read().includes(fileId)), [fileId]);
  const set = (v: boolean) => {
    setValue(v);
    try {
      // the newest choices are kept; old ones fall off so the list stays small
      const next = [...read().filter((id) => id !== fileId), ...(v ? [fileId] : [])].slice(-500);
      localStorage.setItem(DIAGRAM_FILES, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  return [value, set];
}

/** Whether a CSS media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
