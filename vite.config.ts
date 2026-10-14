import { defineConfig } from 'vitest/config';
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

export default defineConfig(({ mode }) => ({
  plugins: mode === 'web' ? [react(), webCsp()] : [react()],
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
