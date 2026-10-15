import { useSyncExternalStore } from 'react';
import { ko } from './i18n/ko/index.ts';

/**
 * The interface in English or Korean. Code is written in English, and the English text is the key:
 * `t('New file')` shows 새 파일 in Korean, and English (or any text without a translation) as is.
 *
 * Conventions for strings:
 * - Values go in braces and are passed by name: t('Imported “{name}”.', { name }).
 * - Counts pick their sentence before translating: n === 1 ? t('1 file') : t('{n} files', { n }).
 * - Text that comes from elsewhere (an error from storage, a notice from the editor) is passed
 *   through t() where it is shown; it is translated when the dictionary knows it.
 * - Layer names and anything stored in files stay as they are.
 */

export type Lang = 'en' | 'ko';

const KEY = 'localframe.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ko') return saved;
  } catch {
    /* not remembered */
  }
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  return langs.some((l) => l?.toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}

let lang: Lang = detect();
const listeners = new Set<() => void>();
/** Texts asked for in Korean that have no translation yet (tests read it). */
const missing = new Set<string>();

if (typeof document !== 'undefined') document.documentElement.lang = lang;

export const getLang = () => lang;

/** The languages offered, named in themselves. */
export const LANGUAGES: { lang: Lang; name: string }[] = [
  { lang: 'en', name: 'English' },
  { lang: 'ko', name: '한국어' },
];

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* for this visit only */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((fn) => fn());
}

/** The current language; components using it draw again when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => lang,
    () => lang,
  );
}

/** The text in the current language, with {name} placeholders filled in. */
export function t(en: string, vars?: Record<string, string | number>): string {
  let s = en;
  if (lang === 'ko') {
    const k = ko[en];
    if (k !== undefined) s = k;
    else if (en.trim() && /[A-Za-z]/.test(en)) missing.add(en);
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : s;
}

export const missingTranslations = () => [...missing];

if (typeof window !== 'undefined') (window as unknown as { __localframeMissing: () => string[] }).__localframeMissing = missingTranslations;
