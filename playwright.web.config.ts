import { defineConfig, devices } from '@playwright/test';

const PORT = 5196;

/** The same browser tests against the web build, where files live in the browser (IndexedDB). */
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
  // Chromium by default; E2E_BROWSERS=chromium,firefox,webkit picks others (WebKit is Safari's engine)
  projects: (['chromium', 'firefox', 'webkit'] as const)
    .filter((b) => (process.env.E2E_BROWSERS ?? 'chromium').split(',').includes(b))
    .map((b) => ({
      name: `${b}-web`,
      use: { ...devices[b === 'chromium' ? 'Desktop Chrome' : b === 'firefox' ? 'Desktop Firefox' : 'Desktop Safari'], viewport: { width: 1440, height: 900 } },
    })),
  webServer: {
    // served at / here, so the tests' paths are the same as for the local app
    command: `npm run build:web && npx vite preview --mode web --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LOCALFRAME_BASE: '/' },
  },
});
