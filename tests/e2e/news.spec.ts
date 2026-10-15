import { expect, test } from '@playwright/test';

test("what's new: not on a first visit, once after an update, gone when seen", async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New file' }).first()).toBeVisible();
  const files = await page.locator('.file-name').count();
  test.skip(files > 0, 'needs a browser that has not used the app (the local server keeps files between tests)');
  await expect(page.getByRole('heading', { name: "What's new" })).toHaveCount(0);

  // someone who used an older version (files, but no record of the news) sees it once
  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('localframe.newsSeen'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "What's new" })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('heading', { name: "What's new" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.file-name').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: "What's new" })).toHaveCount(0);
});
