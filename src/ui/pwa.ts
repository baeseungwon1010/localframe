import { useEffect, useState, useSyncExternalStore } from 'react';
import { BROWSER_STORAGE } from '../api.ts';

/**
 * The web build as an app: the service worker that keeps it working offline, a new version
 * waiting until you choose to reload, installing it on the home screen, and asking the browser
 * to keep its storage (files live only in this browser).
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const state: { waiting: ServiceWorker | null; install: InstallPrompt | null; applying: boolean } = { waiting: null, install: null, applying: false };
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Opened from the home screen (or as an installed desktop app). */
export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

const isIos = () => typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export function startApp() {
  if (!BROWSER_STORAGE || !import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const base = import.meta.env.BASE_URL;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.install = e as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    state.install = null;
    changed();
  });
  // an installed app keeps its files: browsers grant this to apps on the home screen
  if (isStandalone()) void navigator.storage?.persist?.().catch(() => {});

  // reload only when you chose the new version (the first install also takes control of the page,
  // and that must not reload it under you)
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!state.applying || reloading) return;
    reloading = true;
    window.location.reload();
  });
  void navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then((reg) => {
      // a new version that finished installing while an older one runs this page
      const offer = (sw: ServiceWorker | null) => {
        if (sw && navigator.serviceWorker.controller) {
          state.waiting = sw;
          changed();
        }
      };
      offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => sw.state === 'installed' && offer(sw));
      });
    })
    .catch(() => {
      /* no offline copy: the app still works online */
    });
}

/** A new version is ready: `apply` switches to it and reloads the page. */
export function useAppUpdate(): { ready: boolean; apply: () => void } {
  const waiting = useSyncExternalStore(subscribe, () => state.waiting, () => null);
  return {
    ready: waiting !== null,
    apply: () => {
      state.applying = true;
      waiting?.postMessage('skip-waiting');
    },
  };
}

const HINT_KEY = 'localframe.installHintDismissed';

/**
 * How this browser can install the app: a button where the browser offers it (Chrome, Edge,
 * Android), or on an iPhone or iPad the Share menu steps, until dismissed.
 */
export function useInstall(): { canInstall: boolean; install: () => void; iosHint: boolean; dismissHint: () => void } {
  const prompt = useSyncExternalStore(subscribe, () => state.install, () => null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [standalone, setStandalone] = useState(isStandalone);
  useEffect(() => {
    const mq = window.matchMedia?.('(display-mode: standalone)');
    const on = () => setStandalone(isStandalone());
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  return {
    canInstall: prompt !== null && !standalone,
    install: () => {
      if (!prompt) return;
      void prompt.prompt();
      void prompt.userChoice.finally(() => {
        state.install = null;
        changed();
      });
    },
    iosHint: BROWSER_STORAGE && isIos() && !standalone && !dismissed,
    dismissHint: () => {
      setDismissed(true);
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        /* shown again next time */
      }
    },
  };
}
