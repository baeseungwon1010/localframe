import { expect, test, type Page } from '@playwright/test';

/** A browser set to Korean gets the interface in Korean, with nothing left in English. */
test.use({ locale: 'ko-KR' });

const missing = (page: Page) => page.evaluate(() => (window as unknown as { __localframeMissing: () => string[] }).__localframeMissing());

test('Korean: every screen and menu shown has its translation', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('button', { name: '새 파일' }).first()).toBeVisible();

  // the sample in design mode: panels, tabs and menus
  await page.getByRole('button', { name: '샘플 파일' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('treeitem').nth(3).click();
  for (const tab of ['프로토타입', '코드', '디자인']) await page.getByRole('tab', { name: tab, exact: true }).click();
  await page.getByRole('button', { name: '파일 및 보기 옵션' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '확대/축소 옵션' }).click();
  await page.keyboard.press('Escape');
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 200, { button: 'right' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+/');
  await page.keyboard.press('Escape');

  // a new board: templates, the dock and its menus, the text bar
  await page.goto('/');
  await page.getByRole('button', { name: '새 파일' }).first().click();
  await page.getByRole('group', { name: '편집 모드' }).getByRole('button', { name: '다이어그램' }).click();
  await expect(page.getByRole('region', { name: '템플릿으로 시작하기' })).toBeVisible();
  await page.getByRole('button', { name: /순서도/ }).click();
  await expect(page.getByText('잘 됐나요?')).toHaveCount(0); // labels are drawn on the canvas, not as text
  await page.getByRole('group', { name: '편집 모드' }).getByRole('button', { name: '디자인' }).click();
  await expect(page.getByRole('treeitem').first()).toBeVisible();

  expect(await missing(page)).toEqual([]);
});

test('switching language redraws the screen and is remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '언어' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
  await expect(page.getByRole('button', { name: 'New file' }).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('button', { name: 'New file' }).first()).toBeVisible();

  // and back, from inside the editor
  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'File and view options' }).click();
  await page.getByRole('menuitem', { name: /한국어/ }).click();
  await expect(page.getByRole('button', { name: '빠른 실행' })).toBeVisible();
  await expect(page.getByRole('group', { name: '편집 모드' })).toBeVisible();
});
