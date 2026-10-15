import { expect, test } from '@playwright/test';

async function boardWithAShape(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  const box = (await page.locator('canvas').boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 260, { steps: 4 });
  await page.mouse.up();
}

test('share goes to the device share sheet with the image or PDF', async ({ page }) => {
  // a phone's share sheet, recorded instead of shown
  await page.addInitScript(() => {
    const w = window as unknown as { shared: { name: string; type: string; size: number }[] };
    w.shared = [];
    Object.assign(navigator, {
      canShare: (d: ShareData) => !!d.files?.length,
      share: async (d: ShareData) => {
        for (const f of d.files ?? []) w.shared.push({ name: f.name, type: f.type, size: f.size });
      },
    });
  });
  await boardWithAShape(page);
  await page.getByRole('button', { name: 'File and view options' }).click();
  await page.getByRole('menuitem', { name: 'Share selection as image' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 500);
  await page.getByRole('button', { name: 'File and view options' }).click();
  await page.getByRole('menuitem', { name: 'Share page as PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(2);
  const shared = await page.evaluate(() => (window as unknown as { shared: { name: string; type: string; size: number }[] }).shared);
  expect(shared.map((f) => [f.name, f.type])).toEqual([
    ['Untitled.png', 'image/png'],
    ['Untitled.pdf', 'application/pdf'],
  ]);
  expect(shared.every((f) => f.size > 100)).toBe(true);
});

test('without a share sheet, sharing saves the file instead', async ({ page }) => {
  await page.addInitScript(() => Object.assign(navigator, { share: undefined, canShare: undefined }));
  await boardWithAShape(page);
  await page.getByRole('button', { name: 'File and view options' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Share selection as image' }).click()]);
  expect(download.suggestedFilename()).toBe('Untitled.png');
  await expect(page.getByRole('alert').filter({ hasText: 'saved to your downloads' })).toBeVisible();
});

test('copy the selection as a PNG picture or as SVG text', async ({ page }) => {
  // what reaches the clipboard, recorded (permissions differ per browser)
  await page.addInitScript(() => {
    const w = window as unknown as { copied: { type: string; size: number; text?: string }[] };
    w.copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: async (items: ClipboardItem[]) => {
          for (const item of items)
            for (const type of item.types) {
              const blob = await item.getType(type);
              w.copied.push({ type, size: blob.size, text: type === 'text/plain' ? await blob.text() : undefined });
            }
        },
        writeText: async (text: string) => void w.copied.push({ type: 'text/plain', size: text.length, text }),
        readText: async () => '',
      },
    });
  });
  await boardWithAShape(page);
  const box = (await page.locator('canvas').boundingBox())!;
  for (const [item, type] of [
    ['Copy as PNG', 'image/png'],
    ['Copy as SVG', 'text/plain'],
  ] as const) {
    await page.mouse.click(box.x + 250, box.y + 230, { button: 'right' });
    await page.getByRole('menuitem', { name: item }).click();
    await expect.poll(() => page.evaluate((t) => (window as unknown as { copied: { type: string }[] }).copied.some((c) => c.type === t), type)).toBe(true);
  }
  const copied = await page.evaluate(() => (window as unknown as { copied: { type: string; size: number; text?: string }[] }).copied);
  expect(copied.find((c) => c.type === 'image/png')!.size).toBeGreaterThan(100);
  expect(copied.find((c) => c.type === 'text/plain')!.text).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
});
