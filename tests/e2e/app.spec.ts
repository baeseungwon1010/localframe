import { expect, test } from '@playwright/test';

/** The web build as an installable app; the local build has no service worker, so this skips there. */
test('installable app: manifest, icons, and it opens offline with its files', async ({ page, context, browserName }) => {
  await page.goto('/');
  const manifest = await page.request.get('manifest.webmanifest');
  test.skip(!manifest.ok(), 'only the web build is an installable app');
  const m = await manifest.json();
  expect(m).toMatchObject({ name: 'localframe', display: 'standalone', start_url: './' });
  for (const icon of m.icons) expect((await page.request.get(icon.src)).ok(), icon.src).toBe(true);
  expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  // the service worker takes over this page once it has stored the app
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready) && !!navigator.serviceWorker.controller, null, { timeout: 15_000 });

  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.keyboard.press('n');
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + 300, box.y + 300);
  await page.getByRole('textbox', { name: 'Shape text' }).fill('Works offline');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });
  const fileUrl = page.url();

  // Playwright's offline switch in WebKit fails navigations before the service worker sees them,
  // so there the check is that everything the app needs is stored, which is what offline uses
  if (browserName === 'webkit') {
    const missing = await page.evaluate(async () => {
      const urls = [location.origin + '/', ...performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/assets\/.*\.(js|css)$/.test(u))];
      const out: string[] = [];
      for (const u of urls) if (!(await caches.match(u))) out.push(u);
      return out;
    });
    expect(missing).toEqual([]);
    return;
  }

  // no network: the app, the file list and the editor all still open, with the file
  await context.setOffline(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await page.goto(fileUrl);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /^Sticky 1/ })).toBeVisible();
  await context.setOffline(false);
});
