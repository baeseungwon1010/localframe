// Starts the local API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, LOCALFRAME_DEV: '1' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
