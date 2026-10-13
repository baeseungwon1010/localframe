import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function canvasHelpers(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  const at = (x: number, y: number) => [box.x + x, box.y + y] as const;
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 });
    await page.mouse.move(...at(...to), { steps: 4 });
    await page.mouse.up();
  };
  return { at, drag };
}

async function newFile(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await page.getByRole('button', { name: 'New file' }).first().click();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Press F to draw a frame')).toBeVisible();
  return errors;
}

test('create a file, draw a diagram, and it survives a reload', async ({ page }) => {
  const errors = await newFile(page);
  const { at, drag } = await canvasHelpers(page);

  await page.keyboard.press('f');
  await drag([100, 100], [800, 600]);
  await page.keyboard.press('r');
  await drag([150, 150], [330, 230]);
  await page.keyboard.press('o');
  await drag([500, 150], [680, 230]);
  await page.keyboard.press('Shift+L');
  await drag([340, 190], [490, 190]);
  await page.keyboard.press('t');
  await page.mouse.click(...at(170, 180));
  await page.keyboard.type('Start');
  await page.keyboard.press('Escape');

  const tree = page.getByRole('tree', { name: 'Layer tree' });
  for (const name of ['Frame 1', 'Rectangle 1', 'Ellipse 1', 'Arrow 1', 'Text 1']) {
    await expect(tree.getByRole('treeitem', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  // the shapes were drawn inside the frame
  await expect(tree.getByRole('treeitem', { name: /^Rectangle 1/ })).toHaveAttribute('aria-level', '2');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  await page.reload();
  await expect(page.getByRole('treeitem', { name: /^Text 1/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /^Arrow 1/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('select, move, resize, edit values, undo and redo', async ({ page }) => {
  await newFile(page);
  const { at, drag } = await canvasHelpers(page);
  await page.keyboard.press('r');
  await drag([200, 200], [300, 300]);
  const width = page.getByLabel('Width', { exact: true });
  await expect(width).toHaveValue('100');

  // drag the south-east handle
  await drag([300, 300], [400, 350]);
  await expect(width).toHaveValue('200');
  await expect(page.getByLabel('Height', { exact: true })).toHaveValue('150');

  // move it
  const x = page.getByLabel('X', { exact: true });
  const x0 = Number(await x.inputValue());
  await drag([250, 250], [300, 250]);
  await expect(x).toHaveValue(String(x0 + 50));

  // type maths into a field
  await width.fill('200/4');
  await width.press('Enter');
  await expect(width).toHaveValue('50');

  await page.mouse.click(...at(850, 650));
  await page.mouse.click(...at(10, 10));
  await page.keyboard.press('Control+z');
  await page.getByRole('treeitem', { name: /^Rectangle 1/ }).click();
  await expect(width).toHaveValue('200');
  await page.locator('canvas').click({ position: { x: 850, y: 650 } });
  await page.keyboard.press('Control+Shift+z');
  await page.getByRole('treeitem', { name: /^Rectangle 1/ }).click();
  await expect(width).toHaveValue('50');
});

test('layers panel renames, hides and locks', async ({ page }) => {
  await newFile(page);
  const { drag } = await canvasHelpers(page);
  await page.keyboard.press('r');
  await drag([200, 200], [300, 300]);
  const row = page.getByRole('treeitem', { name: /^Rectangle 1/ });
  await row.dblclick();
  const input = page.getByLabel('Layer name');
  await input.fill('Login box');
  await input.press('Enter');
  const renamed = page.getByRole('treeitem', { name: /^Login box/ });
  await expect(renamed).toBeVisible();
  await renamed.hover();
  await page.getByRole('button', { name: 'Hide Login box' }).click();
  await expect(page.getByRole('button', { name: 'Show Login box' })).toBeVisible();
  await page.getByRole('button', { name: 'Lock Login box' }).click();
  await expect(page.getByRole('button', { name: 'Unlock Login box' })).toBeVisible();
});

test('export PNG and SVG of a frame, and the whole file as JSON', async ({ page }) => {
  await newFile(page);
  const { at, drag } = await canvasHelpers(page);
  await page.keyboard.press('f');
  await drag([100, 100], [400, 300]);
  await page.keyboard.press('t');
  await page.mouse.click(...at(150, 150));
  await page.keyboard.type('Hello <world> & 안녕');
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: /^Frame 1/ }).click();

  const [png] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Frame 1' }).click()]);
  expect(png.suggestedFilename()).toBe('Frame 1@2x.png');
  const pngBytes = readFileSync(await png.path());
  expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
  expect(pngBytes.readUInt32BE(16)).toBe(600); // 300 px wide at 2x

  await page.getByLabel('Export format').selectOption('svg');
  const [svg] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Frame 1' }).click()]);
  const svgText = readFileSync(await svg.path(), 'utf8');
  expect(svgText.startsWith('<svg')).toBe(true);
  expect(svgText).toContain('Hello &lt;world&gt; &amp; 안녕');

  await page.getByRole('button', { name: 'Back to files' }).click();
  await page.getByRole('button', { name: /More actions for Untitled/ }).first().click();
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export file' }).click()]);
  const data = JSON.parse(readFileSync(await json.path(), 'utf8'));
  expect(data.format).toBe('localframe-file');
  expect(data.nodes.length).toBeGreaterThanOrEqual(2);
});

test('canvas text: double-click to edit, Korean input, empty text is removed', async ({ page }) => {
  await newFile(page);
  const { at } = await canvasHelpers(page);
  await page.keyboard.press('t');
  await page.mouse.click(...at(300, 300));
  await page.keyboard.type('첫 번째');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: /^Text 1/ })).toBeVisible();

  await page.mouse.dblclick(...at(310, 310));
  const editor = page.getByRole('textbox', { name: 'Text' });
  await expect(editor).toBeVisible();
  await editor.fill('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: /^Text 1/ })).toHaveCount(0);
});
