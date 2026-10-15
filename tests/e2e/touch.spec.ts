import { expect, test, type CDPSession, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

type Pt = { x: number; y: number; id: number };

/** Real touch events (several fingers at once), as a phone sends them. */
async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

async function zoomText(page: Page) {
  // hidden on a phone, but it still says the zoom
  return Number((await page.locator('.zoom-btn').textContent())!.replace(/\D/g, ''));
}

test('on a phone: the board view, pinch zoom, double tap to write and a long press menu', async ({ page, browserName }) => {
  // several fingers at once can only be simulated through Chromium's DevTools protocol
  test.skip(browserName !== 'chromium', 'multi-touch needs the Chromium DevTools protocol');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).first().click();

  // no panels and no mode switch: just the board and the dock
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Properties' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Editor mode' })).toHaveCount(0);
  await page.getByRole('button', { name: /Brainstorm/ }).tap();
  await expect(page.getByRole('region', { name: 'Start with a template' })).toHaveCount(0);

  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // pinch out: two fingers moving apart zoom in
  const before = await zoomText(page);
  await touches(cdp, 'touchStart', [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }]);
  for (let i = 1; i <= 5; i++) await touches(cdp, 'touchMove', [{ x: cx - 40 - i * 16, y: cy, id: 1 }, { x: cx + 40 + i * 16, y: cy, id: 2 }]);
  await touches(cdp, 'touchEnd', []);
  const after = await zoomText(page);
  expect(after).toBeGreaterThan(before * 1.5);

  // empty canvas: tap to clear, then double tap the topic box (in the middle) to write in it
  const tap = async (x: number, y: number) => {
    await touches(cdp, 'touchStart', [{ x, y, id: 3 }]);
    await touches(cdp, 'touchEnd', []);
  };
  await tap(cx, cy);
  await tap(cx, cy);
  await expect(page.getByRole('textbox', { name: 'Shape text' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Shape text' }).fill('Phones');
  await tap(box.x + 10, box.y + 10);
  await expect(page.getByRole('textbox', { name: 'Shape text' })).toHaveCount(0);

  // hold a finger still: the canvas menu
  await touches(cdp, 'touchStart', [{ x: cx, y: cy, id: 4 }]);
  await page.waitForTimeout(800);
  await expect(page.getByRole('menu', { name: 'Canvas actions' })).toBeVisible();
  await touches(cdp, 'touchEnd', []);
  // lifting the finger over the menu doesn't pick an item
  await page.waitForTimeout(300);
  await expect(page.getByRole('menu', { name: 'Canvas actions' })).toBeVisible();
  await page.getByRole('menuitem', { name: /Duplicate/ }).tap();
  await expect(page.getByRole('menu', { name: 'Canvas actions' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/phone.png' });
  expect(errors).toEqual([]);
});

test('on a phone: the panels open in a sheet from the bottom', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).first().click();
  await page.getByRole('button', { name: /Flowchart/ }).tap();

  await page.getByRole('button', { name: 'Show panels' }).tap();
  const sheet = page.getByRole('region', { name: 'Edit panel' });
  await expect(sheet).toBeVisible();
  // the template is selected: its properties, then its layers
  await expect(sheet.getByRole('complementary', { name: 'Properties' })).toBeVisible();
  await sheet.getByRole('tab', { name: 'Layers' }).tap();
  await expect(sheet.getByRole('treeitem', { name: /^Circle 1/ })).toBeVisible();
  await sheet.getByRole('treeitem', { name: /^Box 1/ }).tap();
  await sheet.getByRole('tab', { name: 'Properties' }).tap();
  await expect(sheet.getByLabel('Width', { exact: true })).toHaveValue('160');
  await sheet.getByRole('button', { name: 'Show more' }).tap();
  await page.screenshot({ path: 'test-results/phone-sheet.png' });
  await sheet.getByRole('button', { name: 'Close panel' }).tap();
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});
