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
  await page.getByRole('menuitem', { name: 'Export file…' }).click();
  await page.getByLabel(/localframe file/).check();
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  const data = JSON.parse(readFileSync(await json.path(), 'utf8'));
  expect(data.format).toBe('localframe-file');
  expect(data.nodes.length).toBeGreaterThanOrEqual(2);
});

test('pages, images, components, connectors and PDF export', async ({ page }) => {
  const errors = await newFile(page);
  const { at, drag } = await canvasHelpers(page);

  // a component with an instance
  await page.keyboard.press('f');
  await drag([60, 60], [220, 110]);
  await page.keyboard.press('Control+Alt+k');
  await expect(page.getByRole('region', { name: 'Component' })).toBeVisible();
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(page.getByRole('region', { name: 'Instance' })).toBeVisible();

  // a connector between two shapes
  await page.mouse.click(...at(850, 650));
  await page.keyboard.press('r');
  await drag([300, 300], [400, 360]);
  await page.keyboard.press('o');
  await drag([600, 300], [700, 360]);
  await page.keyboard.press('Shift+L');
  await drag([350, 330], [650, 330]);
  await expect(page.getByRole('region', { name: 'Connector' })).toContainText('Start on “Rectangle 1”');

  // an image through the file picker
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Place image' }).click()]);
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('treeitem', { name: 'dot' })).toBeVisible();

  // a second page
  await page.getByRole('button', { name: 'Add page' }).click();
  await expect(page.getByRole('option', { name: 'Page 2' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('r');
  await drag([200, 200], [300, 300]);
  await page.getByRole('option', { name: 'Page 1' }).click();
  await expect(page.getByRole('treeitem', { name: 'dot' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  // whole file as PDF: two frames on page 1, its loose layers, and page 2
  await page.getByRole('button', { name: 'Export file' }).click();
  await page.getByLabel(/^PDF \(\.pdf\)/).check();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  const pdfText = readFileSync(await pdf.path()).toString('latin1');
  expect(pdfText.startsWith('%PDF')).toBe(true);
  expect(pdfText).toContain('/Count 4');
  await page.getByRole('button', { name: 'Close' }).click();

  // everything survives a reload
  await page.reload();
  await expect(page.getByRole('option', { name: 'Page 2' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'dot' })).toBeVisible();
  expect(errors).toEqual([]);
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

test('crop an image and print a vector PDF', async ({ page }) => {
  await page.addInitScript(() => {
    // the print dialog can't be driven here; count calls instead (runs in the print frame too)
    window.print = () => {
      const top = window.top as unknown as { __printed?: number };
      top.__printed = (top.__printed ?? 0) + 1;
    };
  });
  const errors = await newFile(page);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Place image' }).click()]);
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('treeitem', { name: 'dot' })).toBeVisible();
  for (const [label, v] of [['Width', '300'], ['Height', '200']]) {
    const f = page.getByLabel(label, { exact: true });
    await f.fill(v);
    await f.press('Enter');
  }
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } });
  await page.getByRole('treeitem', { name: 'dot' }).click();
  await page.keyboard.press('Shift+2');
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.dblclick(cx, cy);
  const fit = page.getByLabel(/fit$/);
  await expect(fit).toHaveValue('crop');
  await expect(page.getByLabel(/zoom$/)).toHaveValue('100');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(fit).toHaveValue('crop');

  await page.getByRole('button', { name: 'Export file' }).click();
  await page.getByLabel(/^Vector PDF/).check();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText('Sent to the print dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBe(1);
  expect(errors).toEqual([]);
});

test('comments: pin a comment to a layer, reply, resolve, and it follows the layer', async ({ page }) => {
  const errors = await newFile(page);
  const { at, drag } = await canvasHelpers(page);
  await page.keyboard.press('r');
  await drag([200, 200], [400, 320]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  await page.keyboard.press('c');
  await expect(page.getByRole('complementary', { name: 'Comments' })).toBeVisible();
  await page.mouse.click(...at(300, 260));
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('Make this wider');
  await page.keyboard.press('Enter');
  const pin = page.getByRole('button', { name: /^Comment 1(, resolved)?: Make this wider/ });
  await expect(pin).toBeVisible();
  await page.getByRole('textbox', { name: 'Reply' }).fill('On it');
  await page.keyboard.press('Enter');
  await expect(page.getByText('On it')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await page.screenshot({ path: 'test-results/comments.png' });

  // the pin moves with its layer
  const before = (await pin.boundingBox())!;
  await page.keyboard.press('v');
  await drag([250, 220], [350, 320]);
  await page.keyboard.press('c');
  const after = (await pin.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(100, -1);
  expect(after.y - before.y).toBeCloseTo(100, -1);

  // still there after a reload, resolved and with its reply
  await page.reload();
  await expect(page.getByRole('treeitem', { name: /^Rectangle 1/ })).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: /^Comment 1, resolved: Make this wider/ })).toBeVisible();
  await page.getByLabel('Show resolved').check();
  await expect(page.getByRole('complementary', { name: 'Comments' })).toContainText('1 reply');
  expect(errors).toEqual([]);
});

test('version history: save a version, change the file, restore it', async ({ page }) => {
  const errors = await newFile(page);
  const { drag } = await canvasHelpers(page);
  await page.keyboard.press('r');
  await drag([100, 100], [200, 200]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Version history' }).click();
  await page.getByRole('textbox', { name: 'Version name' }).fill('One square');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByRole('list', { name: 'Versions' })).toContainText('One square');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.keyboard.press('o');
  await drag([300, 100], [400, 200]);
  await expect(page.getByRole('treeitem', { name: /^Ellipse 1/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Version history' }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'One square' });
  await item.getByRole('button', { name: 'Restore' }).click();
  await page.screenshot({ path: 'test-results/versions.png' });
  await item.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('treeitem', { name: /^Ellipse 1/ })).toBeHidden();
  await expect(page.getByRole('treeitem', { name: /^Rectangle 1/ })).toBeVisible();

  // the state before restoring is kept as an autosave, and editing keeps saving
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(page.getByRole('list', { name: 'Versions' }).getByRole('listitem').first()).toContainText('Autosave');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('r');
  await drag([300, 300], [350, 350]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });
  await page.reload();
  await expect(page.getByRole('treeitem', { name: /^Rectangle 2/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('prototype: link a button to another frame and click through the presentation', async ({ page }) => {
  const errors = await newFile(page);
  const { drag } = await canvasHelpers(page);
  await page.keyboard.press('f');
  await drag([60, 60], [260, 360]);
  await page.keyboard.press('f');
  await drag([400, 60], [600, 360]);
  await page.keyboard.press('r');
  await drag([100, 100], [200, 140]);

  await page.getByRole('tab', { name: 'Prototype' }).click();
  await page.getByRole('button', { name: 'Add interaction' }).click();
  const group = page.getByRole('group', { name: 'Interaction 1' });
  await group.getByLabel('Destination').selectOption({ label: 'Frame 2' });
  await group.getByLabel('Animation').selectOption('dissolve');
  await page.screenshot({ path: 'test-results/prototype-panel.png' });
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Present' }).click();
  const show = page.getByRole('dialog', { name: 'Presentation' });
  await expect(show).toContainText('Frame 1');
  await show.getByRole('button', { name: 'Rectangle 1' }).click();
  await expect(show).toContainText('Frame 2');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/presentation.png' });
  await page.keyboard.press('ArrowLeft');
  await expect(show).toContainText('Frame 1');
  await page.keyboard.press('Escape');
  await expect(show).toBeHidden();
  expect(errors).toEqual([]);
});

test('sections, polygons, layer search, find and replace, and Alt distances', async ({ page }) => {
  const errors = await newFile(page);
  const { at, drag } = await canvasHelpers(page);
  await page.keyboard.press('f');
  await drag([100, 100], [300, 300]);
  await page.getByRole('button', { name: 'Polygon' }).click();
  await drag([140, 140], [200, 200]);
  await page.keyboard.press('t');
  await page.mouse.click(...at(140, 240));
  await page.keyboard.type('Sign up now');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+S');
  await drag([60, 60], [360, 360]);
  const tree = page.getByRole('tree', { name: 'Layer tree' });
  await expect(tree.getByRole('treeitem', { name: 'Section 1' })).toHaveAttribute('aria-level', '1');
  await expect(tree.getByRole('treeitem', { name: 'Frame 1' })).toHaveAttribute('aria-level', '2');

  // layer search
  await page.getByLabel('Find layers').fill('poly');
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(tree.getByRole('treeitem', { name: 'Polygon 1' })).toBeVisible();
  await page.getByLabel('Find layers').fill('');

  // find and replace
  await page.mouse.click(...at(800, 650));
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: 'Find' }).fill('sign up');
  await expect(page.getByRole('dialog', { name: 'Find and replace' })).toContainText('1 match in 1 text layer');
  await page.getByRole('textbox', { name: 'Replace with' }).fill('Join');
  await page.getByRole('button', { name: 'Replace all' }).click();
  await expect(page.getByRole('dialog', { name: 'Find and replace' })).toContainText('Replaced 1 match');
  await page.getByRole('textbox', { name: 'Find' }).fill('Join now');
  await expect(page.getByRole('dialog', { name: 'Find and replace' })).toContainText('1 match in 1 text layer');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Find and replace' })).toBeHidden();

  // Alt: distances from the polygon to its frame
  await tree.getByRole('treeitem', { name: 'Polygon 1' }).click();
  await page.mouse.move(...at(700, 600));
  await page.keyboard.down('Alt');
  await page.screenshot({ path: 'test-results/measure.png' });
  await page.keyboard.up('Alt');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 5000 });
  await page.reload();
  await expect(page.getByRole('treeitem', { name: 'Section 1' })).toBeVisible();
  expect(errors).toEqual([]);
});
