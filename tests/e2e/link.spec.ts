import { expect, test } from '@playwright/test';

/** Links carry a whole file after the "#": only the web version offers them (files live in the browser). */
test('share a file as a link and open a copy from it', async ({ page, context }) => {
  // what the app copies, kept where the test can read it (clipboard permissions differ per browser)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void ((window as unknown as { copied: string }).copied = t), readText: async () => '' },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'File and view options' }).click();
  const item = page.getByRole('menuitem', { name: 'Share as link' });
  test.skip((await item.count()) === 0, 'links are for the web version');
  await page.keyboard.press('Escape');

  await page.keyboard.press('n');
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + 400, box.y + 300);
  await page.getByRole('textbox', { name: 'Shape text' }).fill('Sent by link');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'File and view options' }).click();
  await page.getByRole('menuitem', { name: 'Share as link' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Link copied' })).toBeVisible();
  const url = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(url).toMatch(/#\/shared\/v1\.[A-Za-z0-9_-]+$/);

  // someone else opens it (a fresh browser: nothing stored)
  const other = await context.browser()!.newContext();
  const p2 = await other.newPage();
  await p2.goto(url);
  await expect(p2.getByRole('heading', { name: 'Untitled' })).toBeVisible();
  await expect(p2.getByRole('img', { name: /first page of Untitled/ })).toBeVisible();
  await p2.getByRole('button', { name: 'Save a copy to my files' }).click();
  await expect(p2.locator('canvas')).toBeVisible();
  await expect(p2.getByRole('treeitem', { name: /^Sticky 1/ })).toBeVisible();

  // a cut-off link says so instead of failing silently
  await p2.goto(url.slice(0, url.length - 20));
  await expect(p2.getByRole('alert')).toContainText(/damaged|cut short/);
  await other.close();
});
