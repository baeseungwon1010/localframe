// localframe's MCP server: lets an AI agent (Claude Desktop, Claude Code, any MCP client) draw
// diagrams by describing them. It reads the guide, sends a spec, gets back a picture of the result
// and the problems a reader would trip over, fixes the spec and tries again; then saves the file
// or hands over a link that opens it in localframe.
//
//   node scripts/mcp.ts         (from this repo; .mcp.json registers it for Claude Code)
//
// It speaks MCP over stdio (JSON-RPC, one message per line) with no SDK, and runs on this
// machine only: nothing is sent anywhere. Logs go to stderr, as stdout carries the protocol.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { ExportedFileSchema, validateTree } from '../shared/schema.ts';
import { type Built, buildDiagram } from '../src/diagram/build.ts';
import { type Issue, lintDiagram } from '../src/diagram/lint.ts';
import { DiagramSpecSchema } from '../src/diagram/spec.ts';
import { Renderer, diagramSvg, findFonts } from './diagramRender.ts';

const VERSION = '0.1.0';
const here = import.meta.dirname;
/** Where links open: the public web app, or another copy of it (LOCALFRAME_URL). */
const APP_URL = (process.env.LOCALFRAME_URL ?? 'https://baeseungwon1010.github.io/localframe/').replace(/\/?$/, '/');
/** Chat apps may cut links longer than this. */
const LONG_LINK = 8000;

const firstFile = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? null;
// next to the server when packaged (scripts/mcpb.ts), else in the repo
const guidePath = firstFile(join(here, 'diagram-spec.md'), join(here, '../docs/diagram-spec.md'));
const renderer = new Renderer(findFonts(join(here, 'fonts'), join(here, '../node_modules/@fontsource')));

const log = (...a: unknown[]) => console.error('[localframe]', ...a);

// ------------------------------------------------------------------ the tools

const specSchema = z.toJSONSchema(DiagramSpecSchema);
delete (specSchema as { $schema?: string }).$schema;

const TOOLS = [
  {
    name: 'diagram_guide',
    title: 'How to describe a diagram',
    description:
      'The guide to diagram specs: what to write, the shapes and roles, what makes a diagram read well, and what each lint code means. Read it once before the first diagram_render.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'diagram_render',
    title: 'Draw a diagram',
    description:
      "Draws a diagram from a spec (boxes, what leads to what, groups; see diagram_guide) and returns a picture of it at the size a reader sees it, the problems found (lint) with what to change, and a link that opens it in localframe. Nothing is saved. Look at the picture, fix the spec, and draw it again until there's nothing left to fix.",
    inputSchema: { type: 'object', properties: { spec: specSchema }, required: ['spec'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'diagram_save',
    title: 'Save a diagram',
    description:
      'Saves the diagram a spec draws as a .localframe.json file (Import file in localframe opens it, fully editable), with a PNG of it next to it. Without a path it goes in ~/localframe, named after the title.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: specSchema,
        path: { type: 'string', description: 'Where to write it: an absolute path ending in .localframe.json (added if left out).' },
        picture: { type: 'boolean', description: 'Also write a PNG next to it (default true).' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Some clients send the spec as a JSON string. */
const specArg = (args: Record<string, unknown>) => (typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec);

function build(spec: unknown): Built {
  const built = buildDiagram(spec);
  const checked = ExportedFileSchema.safeParse(built.file);
  const problem = checked.success ? validateTree(checked.data.nodes, checked.data.pages) : checked.error.issues[0].message;
  if (problem) throw new Error(`The built file doesn't import (${problem}). This is a bug in localframe's diagram builder, not in the spec.`);
  return built;
}

function link(spec: unknown): string {
  return `${APP_URL}#/diagram/v1.${deflateRawSync(JSON.stringify(spec)).toString('base64url')}`;
}

function report(issues: Issue[]): string {
  if (!issues.length) return 'No problems found.';
  return issues.map((i) => `- ${i.level} [${i.code}]${i.at ? ` (${i.at})` : ''}: ${i.message}`).join('\n');
}

async function picture(built: Built, zoom: number): Promise<{ png: Buffer | null; why?: string }> {
  try {
    return { png: await renderer.png(diagramSvg(built), built.file.background, zoom) };
  } catch (e) {
    return { png: null, why: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

const slug = (s: string) => s.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'diagram';

const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  async diagram_guide() {
    if (!guidePath) return { content: [{ type: 'text', text: 'The guide is missing from this install of the localframe server.' }], isError: true };
    return { content: [{ type: 'text', text: readFileSync(guidePath, 'utf8') }] };
  },

  async diagram_render(args) {
    const spec = specArg(args);
    const built = build(spec);
    const lint = lintDiagram(built);
    const zoom = Renderer.viewZoom(lint.size.width);
    const pic = await picture(built, zoom);
    const url = link(spec);
    const errors = lint.issues.filter((i) => i.level === 'error').length;
    const text = [
      `Drawn: ${built.ids.nodes.size} boxes, ${built.ids.edges.length} edges, ${lint.size.width}×${lint.size.height}px.`,
      pic.png
        ? `The picture is shown at ${Math.round(zoom * 100)}%, the size it reads at in a 1600px-wide view.`
        : `No picture: ${pic.why}. Install Chrome or Edge, or run "npx playwright install chromium", to get one.`,
      '',
      'Problems:',
      report(lint.issues),
      '',
      `Open it in localframe: ${url}`,
      ...(url.length > LONG_LINK ? [`(The link is ${url.length} characters; chat apps may cut it. diagram_save writes a file instead.)`] : []),
    ].join('\n');
    return {
      content: [{ type: 'text', text }, ...(pic.png ? [{ type: 'image' as const, data: pic.png.toString('base64'), mimeType: 'image/png' }] : [])],
      structuredContent: { ok: errors === 0, size: lint.size, shownAt: zoom, issues: lint.issues, link: url },
    };
  },

  async diagram_save(args) {
    const spec = specArg(args);
    const built = build(spec);
    let path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : join(homedir(), 'localframe', slug(built.file.name));
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
    if (!isAbsolute(path)) path = resolve(path);
    if (!/\.localframe\.json$/i.test(path)) path = `${path.replace(/\.json$/i, '')}.localframe.json`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(built.file));
    const written = [path];
    let note = '';
    if (args.picture !== false) {
      const pic = await picture(built, 1);
      const png = path.replace(/\.localframe\.json$/i, '.png');
      if (pic.png) {
        writeFileSync(png, pic.png);
        written.push(png);
      } else note = `\n(No PNG: ${pic.why}.)`;
    }
    return {
      content: [{ type: 'text', text: `Saved:\n${written.join('\n')}\nIn localframe, Import file opens the .localframe.json.${note}` }],
      structuredContent: { files: written },
    };
  },
};

// ------------------------------------------------------------------ the protocol

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const send = (msg: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const fail = (id: Message['id'], code: number, message: string) => send({ id: id ?? null, error: { code, message } });

async function handle(msg: Message): Promise<void> {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return send({
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'localframe', title: 'localframe diagrams', version: VERSION },
          instructions:
            'Draws diagrams from a short description (a spec). Read diagram_guide once, then loop: diagram_render a spec, look at the picture and the problems, change the spec, render again. Never place or size anything yourself; the spec says what the diagram says. When it reads well, give the link from diagram_render, or diagram_save a file.',
        },
      });
    }
    case 'ping':
      return isRequest ? send({ id, result: {} }) : undefined;
    case 'tools/list':
      return send({ id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const run = handlers[name];
      if (!run) return fail(id, -32602, `No tool named "${name}".`);
      let result: ToolResult;
      try {
        result = await run((params.arguments as Record<string, unknown>) ?? {});
      } catch (e) {
        // a spec that doesn't hold together: the agent fixes it and tries again
        result = { content: [{ type: 'text', text: `The spec can't be drawn:\n${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
      return send({ id, result });
    }
    default:
      // notifications (initialized, cancelled, …) need no answer
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Message;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  // one at a time, in order: renders share one browser
  pending = pending.then(() => handle(msg)).catch((e) => log('error', e));
});
lines.on('close', () => void pending.then(() => renderer.close()).then(() => process.exit(0)));
log(`ready (${VERSION}), links open ${APP_URL}`);
