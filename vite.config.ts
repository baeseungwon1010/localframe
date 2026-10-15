import { defineConfig } from 'vitest/config';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.LOCALFRAME_API_PORT ?? 5174);

/**
 * The web build (`vite build --mode web`) stores files in the browser and is served as static
 * files (GitHub Pages), where there are no response headers to set: the page carries its own CSP.
 */
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function webCsp(): Plugin {
  return {
    name: 'localframe-web-csp',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />`),
  };
}

/**
 * The bundled fonts list a .woff fallback after each .woff2 file. Every browser this app runs in
 * reads woff2, so the fallbacks only made the font CSS longer and the build twice the size.
 */
function woff2Only(): Plugin {
  return {
    name: 'localframe-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].*\.css$/.test(id)) return null;
      return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null };
    },
  };
}

/** The service worker: the app's files kept on the device, so it opens offline. Template below. */
function serviceWorker(version: string, core: string[]): string {
  return `// localframe ${version}: generated at build time (vite.config.ts)
const SHELL = 'localframe-shell-${version}';
const RUNTIME = 'localframe-runtime';
const CORE = ${JSON.stringify(core)};
const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  // waits (no skipWaiting) until the page asks, so a running editor never meets new files; the
  // files come from the server, never from the browser's HTTP cache (an older page could be there)
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(CORE.map((path) => new Request(scoped(path), { cache: 'reload' })))));
});

const KEPT = 'localframe-kept';

self.addEventListener('activate', (event) => {
  // the version before this one stays too: other open tabs still run it and load its files later
  event.waitUntil(
    (async () => {
      const kept = await caches.open(KEPT);
      const previous = (await (await kept.match('previous'))?.text()) ?? null;
      const current = (await (await kept.match('current'))?.text()) ?? null;
      const keep = new Set([SHELL, current !== SHELL ? current : previous].filter(Boolean));
      await kept.put('previous', new Response(current !== SHELL ? (current ?? '') : (previous ?? '')));
      await kept.put('current', new Response(SHELL));
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('localframe-shell-') && !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  // the app is one page (routes are in the hash): every navigation gets the cached page
  if (req.mode === 'navigate') {
    event.respondWith(caches.match(scoped('./'), { cacheName: SHELL }).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // fonts and images are kept once used (their names change when their content does)
          if (res.ok && /\\.(woff2|png|svg)$/.test(new URL(req.url).pathname)) {
            const copy = res.clone();
            caches.open(RUNTIME).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;
}

/**
 * The web build as an installable app (PWA): a manifest with icons, the service worker that keeps
 * the app's files on the device, and the page tags phones read (theme colour, home screen icon).
 */
function installableApp(): Plugin {
  return {
    name: 'localframe-pwa',
    transformIndexHtml: (html) =>
      html
        .replace('content="width=device-width, initial-scale=1.0, maximum-scale=1.0"', 'content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover"')
        .replace(
          '<title>',
          [
            '<link rel="manifest" href="./manifest.webmanifest" />',
            '<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />',
            '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F7F7F8" />',
            '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1F2125" />',
            '<meta name="mobile-web-app-capable" content="yes" />',
            '<meta name="apple-mobile-web-app-title" content="localframe" />',
            '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
            '<title>',
          ].join('\n    '),
        ),
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle);
      // the app itself, plus the Latin faces of every font so text looks right offline from the start
      const core = [
        './',
        'favicon.svg',
        'manifest.webmanifest',
        'icons/icon-192.png',
        ...files.filter((f) => /\.(js|css)$/.test(f) || /-latin-[0-9]+-normal-[^/]*\.woff2$/.test(f)),
      ].sort();
      const version = createHash('sha256').update(core.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker(version, core) });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(
          {
            name: 'localframe',
            short_name: 'localframe',
            description: 'Design and diagram on your own device. Files stay in this browser.',
            id: './',
            start_url: './',
            scope: './',
            display: 'standalone',
            background_color: '#E8E9EB',
            theme_color: '#F7F7F8',
            icons: [
              { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          null,
          2,
        ),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: mode === 'web' ? [react(), woff2Only(), webCsp(), installableApp()] : [react(), woff2Only()],
  base: mode === 'web' ? (process.env.LOCALFRAME_BASE ?? '/localframe/') : '/',
  define: mode === 'web' ? { 'import.meta.env.VITE_STORAGE': JSON.stringify('browser') } : {},
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Same-origin only: other local pages must not read project files or the dev database.
    cors: false,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/*.db', '**/*.db-*', '**/.claude/**', '**/replica/**'],
    },
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  build: {
    outDir: mode === 'web' ? 'dist-web' : 'dist',
    sourcemap: false,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
}));
