import { t } from './i18n.ts';

/**
 * What changed, newest first, as shown once on the file list after an update. Each entry's id is
 * a date; texts are English and translated where shown.
 */
export const NEWS: { id: string; items: string[] }[] = [
  {
    id: '2026-10-16',
    items: [
      'The interface is now in Korean too: it follows your browser, or pick a language at the top right.',
      'Undo now reaches back past a reload.',
      'Paste or drop an SVG to turn it into editable shapes.',
      'Present a board: its sections or frames, one after another.',
    ],
  },
];

const SEEN_KEY = 'localframe.newsSeen';

function seen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markNewsSeen() {
  try {
    localStorage.setItem(SEEN_KEY, NEWS[0].id);
  } catch {
    /* shown again next time */
  }
}

/**
 * The news to show, if any: entries newer than the last one seen. Someone opening the app for the
 * first time has nothing "new" to catch up on, so that visit just records where they start.
 */
export function unseenNews(firstVisit: boolean): { id: string; items: string[] }[] {
  const last = seen();
  if (!last) {
    if (firstVisit) markNewsSeen();
    return firstVisit ? [] : NEWS.slice(0, 1);
  }
  return NEWS.filter((n) => n.id > last);
}

/**
 * Where feedback goes: a new GitHub issue for this project, filled with the app's version and
 * the browser (shown to the person, who edits it before sending). Null when the build doesn't say.
 */
export function feedbackUrl(): string | null {
  const base = import.meta.env.VITE_FEEDBACK_URL as string | undefined;
  if (!base || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/.test(base)) return null;
  const body = [
    t('What happened, or what would you like?'),
    '',
    '',
    '---',
    `localframe ${(import.meta.env.VITE_BUILD as string | undefined) ?? ''}`.trim(),
    navigator.userAgent,
  ].join('\n');
  return `${base}?${new URLSearchParams({ body }).toString()}`;
}
