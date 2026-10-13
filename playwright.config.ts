import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 5198;
// Every run starts with an empty database.
const dataDir = mkdtempSync(join(tmpdir(), 'localframe-e2e-'));

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build && node server/index.ts',
    url: `http://localhost:${PORT}/api/files`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LOCALFRAME_API_PORT: String(PORT), LOCALFRAME_DATA_DIR: dataDir },
  },
});
