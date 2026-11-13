// Builds diagrams from specs: npm run diagram -- <spec.json>... [--out <dir>] [--no-png]
//
// For each spec it writes, next to it (or in --out):
//   <name>.localframe.json   the file, to import into localframe and keep editing
//   <name>.svg / <name>.png  a picture of it, to look at (the PNG needs Playwright's Chromium)
//   <name>.lint.json         what a reader would trip over, with what to change in the spec
// and prints the lint. Exits 1 if a spec can't be built or has errors, so an agent can loop on it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExportedFileSchema, validateTree } from '../shared/schema.ts';
import { buildDiagram } from '../src/diagram/build.ts';
import { lintDiagram } from '../src/diagram/lint.ts';
import { svgMarkup } from '../src/engine/export.ts';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : null;
const png = !args.includes('--no-png');
const specs = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!specs.length) {
  console.error('usage: npm run diagram -- <spec.json>... [--out <dir>] [--no-png]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const fontCss = ['inter/400', 'inter/500', 'inter/600', 'inter/700', 'noto-sans-kr/400', 'noto-sans-kr/500', 'noto-sans-kr/600', 'noto-sans-kr/700']
  .map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(root, 'node_modules/@fontsource', `${f}.css`))}">`)
  .join('');

let failed = false;
const pictures: { html: string; png: string }[] = [];
for (const path of specs) {
  const name = basename(path).replace(/\.(spec\.)?json$/i, '');
  const dir = outDir ?? dirname(path);
  mkdirSync(dir, { recursive: true });
  let built;
  try {
    built = buildDiagram(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.log(`✗ ${path}\n${String(e instanceof Error ? e.message : e).replace(/^/gm, '  ')}`);
    failed = true;
    continue;
  }
  // the file must import as it is
  const checked = ExportedFileSchema.safeParse(built.file);
  const tree = checked.success ? validateTree(checked.data.nodes, checked.data.pages) : null;
  if (!checked.success || tree) {
    console.log(`✗ ${path}: the built file doesn't import (${checked.success ? tree : checked.error.issues[0].message}). This is a bug in the builder.`);
    failed = true;
    continue;
  }
  const lint = lintDiagram(built);
  const file = join(dir, `${name}.localframe.json`);
  writeFileSync(file, JSON.stringify(built.file));
  writeFileSync(join(dir, `${name}.lint.json`), JSON.stringify(lint, null, 2));
  const { svg } = svgMarkup(built.doc, { ids: built.doc.children(null), background: built.file.background });
  writeFileSync(join(dir, `${name}.svg`), svg);
  if (png) {
    const html = join(dir, `.${name}.render.html`);
    writeFileSync(html, `<!doctype html><meta charset="utf-8">${fontCss}<style>body{margin:0}div{display:inline-block;padding:40px;background:${built.file.background}}</style><div>${svg}</div>`);
    pictures.push({ html, png: join(dir, `${name}.png`) });
  }
  const errors = lint.issues.filter((i) => i.level === 'error').length;
  if (errors) failed = true;
  console.log(`${errors ? '✗' : '✓'} ${path} → ${file} (${lint.size.width}×${lint.size.height}, shown at ${Math.round(lint.scale * 100)}% to fit 1600px)`);
  for (const i of lint.issues) console.log(`  ${i.level}: [${i.code}] ${i.message}`);
}

if (pictures.length) {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const p of pictures) {
      await page.goto(pathToFileURL(p.html).href);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('div').first().screenshot({ path: p.png });
    }
    await browser.close();
  } catch (e) {
    console.log(`(no PNG: ${e instanceof Error ? e.message.split('\n')[0] : e})`);
  } finally {
    const { rmSync } = await import('node:fs');
    for (const p of pictures) rmSync(p.html, { force: true });
  }
}
process.exit(failed ? 1 : 0);
