// Builds diagrams from specs: npm run diagram -- <spec.json>... [--out <dir>] [--no-png]
//
// For each spec it writes, next to it (or in --out):
//   <name>.localframe.json   the file, to import into localframe and keep editing
//   <name>.svg / <name>.png  a picture of it, to look at (the PNG needs a Chromium, Chrome or Edge)
//   <name>.lint.json         what a reader would trip over, with what to change in the spec
// and prints the lint. Exits 1 if a spec can't be built or has errors, so an agent can loop on it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ExportedFileSchema, validateTree } from '../shared/schema.ts';
import { buildDiagram } from '../src/diagram/build.ts';
import { lintDiagram } from '../src/diagram/lint.ts';
import { Renderer, diagramSvg, findFonts } from './diagramRender.ts';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : null;
const png = !args.includes('--no-png');
const specs = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!specs.length) {
  console.error('usage: npm run diagram -- <spec.json>... [--out <dir>] [--no-png]');
  process.exit(2);
}

const renderer = new Renderer(findFonts(resolve(import.meta.dirname, '../node_modules/@fontsource')));

let failed = false;
const pictures: { svg: string; background: string; png: string }[] = [];
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
  const svg = diagramSvg(built);
  writeFileSync(join(dir, `${name}.svg`), svg);
  if (png) pictures.push({ svg, background: built.file.background, png: join(dir, `${name}.png`) });
  const errors = lint.issues.filter((i) => i.level === 'error').length;
  if (errors) failed = true;
  console.log(`${errors ? '✗' : '✓'} ${path} → ${file} (${lint.size.width}×${lint.size.height}, shown at ${Math.round(lint.scale * 100)}% to fit 1600px)`);
  for (const i of lint.issues) console.log(`  ${i.level}: [${i.code}] ${i.message}`);
}

try {
  for (const p of pictures) writeFileSync(p.png, await renderer.png(p.svg, p.background));
} catch (e) {
  console.log(`(no PNG: ${e instanceof Error ? e.message.split('\n')[0] : e})`);
} finally {
  await renderer.close();
}
process.exit(failed ? 1 : 0);
