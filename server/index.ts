import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db.ts';
import { createApp } from './app.ts';

const dev = process.env.LOCALFRAME_DEV === '1';
const port = Number(process.env.LOCALFRAME_API_PORT ?? 5174);
const dataDir = resolve(process.env.LOCALFRAME_DATA_DIR ?? 'data');
const distDir = resolve('dist');

if (!dev && !existsSync(distDir)) {
  console.error('No build found. Run "npm run build" first, or "npm run dev" for development.');
  process.exit(1);
}

const store = new Store(resolve(dataDir, 'localframe.db'));
const handler = createApp({
  store,
  allowedPorts: dev ? [port, 5173] : [port],
  staticDir: dev ? null : distDir,
});

const server = createServer(handler);
// Loopback only: the editor is never reachable from other machines.
server.listen(port, '127.0.0.1', () => {
  if (dev) console.log(`localframe API on http://127.0.0.1:${port} (open http://localhost:5173)`);
  else console.log(`localframe is running at http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
