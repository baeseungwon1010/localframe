// Packs the MCP server (scripts/mcp.ts) as a Claude Desktop extension: npm run build:mcpb
//
// Writes dist-mcpb/localframe.mcpb, a zip that Claude Desktop installs with a double-click (or by
// dropping it on Settings → Extensions), so nobody has to edit a config file. Inside:
//   manifest.json           what the extension is and how to start it
//   icon.png
//   server/index.mjs        the server and the diagram engine, bundled into plain JavaScript
//   server/diagram-spec.md  the guide diagram_guide returns
//   server/fonts/           the faces diagrams use, so pictures look like the app
//   server/node_modules/playwright-core   drives a browser on the machine for the pictures
// Claude Desktop runs it with the Node.js it ships with.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist-mcpb');
const stage = join(out, 'localframe');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });

// the server, with everything but the browser driver in one file
await build({
  entryPoints: [join(root, 'scripts/mcp.ts')],
  outfile: join(stage, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['playwright-core'],
  // bundled CommonJS may call require()
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

cpSync(join(root, 'docs/diagram-spec.md'), join(stage, 'server/diagram-spec.md'));
cpSync(join(root, 'public/icons/icon-512.png'), join(stage, 'icon.png'));
cpSync(join(root, 'node_modules/playwright-core'), join(stage, 'server/node_modules/playwright-core'), { recursive: true });

// the fonts' CSS for the weights diagrams use, and the woff2 files it names
for (const family of ['inter', 'noto-sans-kr']) {
  const from = join(root, 'node_modules/@fontsource', family);
  const to = join(stage, 'server/fonts', family);
  mkdirSync(join(to, 'files'), { recursive: true });
  for (const weight of [400, 500, 600, 700]) {
    const css = readFileSync(join(from, `${weight}.css`), 'utf8').replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '');
    writeFileSync(join(to, `${weight}.css`), css);
    for (const [, file] of css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) cpSync(join(from, 'files', file), join(to, 'files', file));
  }
  cpSync(join(from, 'LICENSE'), join(to, 'LICENSE'));
}

const tool = (name: string, description: string) => ({ name, description });
const manifest = {
  manifest_version: '0.2',
  name: 'localframe',
  display_name: 'localframe diagrams',
  version: pkg.version,
  description: 'Draw clear diagrams by describing them: the layout, type and colours are done for you, and Claude checks the picture before handing it over.',
  long_description:
    'Claude writes a short description of a diagram (its boxes, what leads to what, which boxes belong together) and localframe lays it out, sizes and colours it, then shows Claude a picture and a list of what reads badly, so it can fix the description and try again. The result opens in localframe (in the browser, no sign-up) as a fully editable diagram, or is saved as a file.\n\nEverything runs on your computer. Nothing is sent anywhere: the link it gives you carries the diagram after the "#", which browsers never send to a server.\n\nPictures are drawn with a browser on your computer (Chrome or Edge).',
  author: { name: 'baeseungwon1010', url: 'https://github.com/baeseungwon1010' },
  homepage: 'https://baeseungwon1010.github.io/localframe/',
  repository: { type: 'git', url: 'https://github.com/baeseungwon1010/localframe' },
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs'], env: {} },
  },
  tools: [
    tool('diagram_guide', 'How to describe a diagram so it reads well'),
    tool('diagram_render', 'Draw a diagram from its description: a picture, the problems found and a link to open it'),
    tool('diagram_save', 'Save the diagram as a localframe file, with a PNG'),
  ],
  keywords: ['diagram', 'flowchart', 'architecture', 'whiteboard', 'design'],
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.11.0' } },
};
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ------------------------------------------------------------------ the zip

function files(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

/** A plain zip (deflated entries, UTF-8 names, fixed dates so the same input packs the same). */
function zip(paths: string[], base: string): Buffer {
  const DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const path of paths) {
    const name = Buffer.from(relative(base, path).split(sep).join('/'));
    const data = readFileSync(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4); // made on Unix, so the mode below is read
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

const all = files(stage);
const target = join(out, 'localframe.mcpb');
writeFileSync(target, zip(all, stage));
if (!existsSync(target)) throw new Error('no extension written');
console.log(`${relative(root, target)}: ${all.length} files, ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB`);
