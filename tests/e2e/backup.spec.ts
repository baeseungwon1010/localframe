import { expect, test } from '@playwright/test';

test('back up every file to one ZIP, delete them, and restore them from it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  // two files: the sample (with its images and components) and a renamed blank one
  await page.getByRole('button', { name: 'Sample file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.file-name').first()).toBeVisible();
  // other tests may have left files here too: all of them go in the backup
  const names = await page.locator('.file-name').allTextContents();
  expect(names.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Backup' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Back up all files' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^localframe-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await download.path();
  await expect(page.getByRole('status').filter({ hasText: /Backed up \d+ files?/ })).toBeVisible();

  // delete everything
  page.on('dialog', (d) => d.accept());
  for (let left = names.length; left > 0; left--) {
    await page.getByRole('button', { name: /^More actions for / }).first().click();
    await page.getByRole('menuitem', { name: 'Delete file' }).click();
    await expect(page.locator('.file-name')).toHaveCount(left - 1);
  }
  await expect(page.getByText('No files yet')).toBeVisible();

  await page.getByLabel('Backup to restore').setInputFiles(zip);
  await expect(page.getByRole('status').filter({ hasText: `Restored ${names.length}` })).toBeVisible();
  await expect(page.locator('.file-name')).toHaveCount(names.length);
  expect((await page.locator('.file-name').allTextContents()).sort()).toEqual([...names].sort());
  expect(errors).toEqual([]);
});
