import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../../server/db.ts';
import { createApp } from '../../server/app.ts';
import type { SceneNode } from '../../shared/schema.ts';

let server: Server;
let store: Store;
let base: string;
let origin: string;

beforeAll(async () => {
  store = new Store(':memory:');
  let handler: ReturnType<typeof createApp> = () => Promise.resolve();
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  handler = createApp({ store, allowedPorts: [port], staticDir: null });
  base = `http://127.0.0.1:${port}`;
  origin = base;
});

afterAll(() => {
  server.close();
  store.close();
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { Origin: origin } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rect(id: string, parentId: string | null = null, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: 'RECTANGLE',
    parentId,
    order: 'a0',
    name: 'Rectangle',
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    fills: [{ color: '#D9D9D9', opacity: 1, visible: true }],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside',
    strokeDash: [],
    radii: [0, 0, 0, 0],
    ...extra,
  };
}

describe('files api', () => {
  it('creates, saves changes, reloads, exports and imports a file', async () => {
    const created = await (await call('POST', '/api/files', { name: 'Flow' })).json();
    expect(created.name).toBe('Flow');
    expect(created.version).toBe(0);

    const frame = { ...rect('f1'), type: 'FRAME' as const, name: 'Frame', clipsContent: true };
    let r = await call('POST', `/api/files/${created.id}/changes`, {
      baseVersion: 0,
      upserts: [frame, rect('r1', 'f1')],
      deletes: [],
    });
    expect(r.status).toBe(200);
    expect((await r.json()).version).toBe(1);

    // stale version is a conflict, not an overwrite
    r = await call('POST', `/api/files/${created.id}/changes`, { baseVersion: 0, upserts: [], deletes: ['r1'] });
    expect(r.status).toBe(409);

    const loaded = await (await call('GET', `/api/files/${created.id}`)).json();
    expect(loaded.nodes).toHaveLength(2);

    const exported = await (await call('GET', `/api/files/${created.id}/export`)).json();
    const imported = await (await call('POST', '/api/files/import', exported)).json();
    expect(imported.name).toBe('Flow');
    const again = await (await call('GET', `/api/files/${imported.id}`)).json();
    expect(again.nodes).toHaveLength(2);
  });

  it('rejects trees that would be invalid', async () => {
    const f = await (await call('POST', '/api/files', {})).json();
    // child of a rectangle
    let r = await call('POST', `/api/files/${f.id}/changes`, {
      baseVersion: 0,
      upserts: [rect('a'), rect('b', 'a')],
      deletes: [],
    });
    expect(r.status).toBe(400);
    // missing parent
    r = await call('POST', `/api/files/${f.id}/changes`, { baseVersion: 0, upserts: [rect('c', 'nope')], deletes: [] });
    expect(r.status).toBe(400);
    // unknown property is refused by the strict schema
    r = await call('POST', `/api/files/${f.id}/changes`, {
      baseVersion: 0,
      upserts: [{ ...rect('d'), onclick: 'x' }],
      deletes: [],
    });
    expect(r.status).toBe(400);
    const meta = await (await call('GET', `/api/files/${f.id}`)).json();
    expect(meta.file.version).toBe(0);
    expect(meta.nodes).toHaveLength(0);
  });
});

// smallest valid PNG: 1x1 transparent pixel
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('images and pages', () => {
  it('stores images by hash, serves them back, and refuses SVG and spoofed types', async () => {
    const f = await (await call('POST', '/api/files', {})).json();
    const up = await fetch(`${base}/api/files/${f.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Origin: origin },
      body: PNG,
    });
    expect(up.status).toBe(201);
    const { id } = await up.json();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const back = await fetch(`${base}/api/files/${f.id}/images/${id}`);
    expect(back.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await back.arrayBuffer()).equals(PNG)).toBe(true);

    const svg = await fetch(`${base}/api/files/${f.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/svg+xml', Origin: origin },
      body: '<svg onload="alert(1)"/>',
    });
    expect(svg.status).toBe(415);
    const spoofed = await fetch(`${base}/api/files/${f.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Origin: origin },
      body: '<svg onload="alert(1)"/>',
    });
    expect(spoofed.status).toBe(415);
    const noOrigin = await fetch(`${base}/api/files/${f.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(noOrigin.status).toBe(403);
  });

  it('saves pages with changes and carries pages and images through export and import', async () => {
    const f = await (await call('POST', '/api/files', { name: 'Paged' })).json();
    const up = await fetch(`${base}/api/files/${f.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Origin: origin },
      body: PNG,
    });
    const { id: imageId } = await up.json();
    const pages = [
      { id: 'page-1', name: 'Page 1', background: '#FFFFFF' },
      { id: 'p2', name: 'Flows', background: '#101010' },
    ];
    const img = { ...rect('r1'), pageId: 'p2', fills: [{ type: 'IMAGE', imageId, scaleMode: 'fill', opacity: 1, visible: true }] };
    let r = await call('POST', `/api/files/${f.id}/changes`, { baseVersion: 0, upserts: [img], deletes: [], pages });
    expect(r.status).toBe(200);
    // a layer on a page that doesn't exist is refused
    r = await call('POST', `/api/files/${f.id}/changes`, { baseVersion: 1, upserts: [{ ...rect('x'), pageId: 'nope' }], deletes: [] });
    expect(r.status).toBe(400);

    const exported = await (await call('GET', `/api/files/${f.id}/export`)).json();
    expect(exported.pages).toHaveLength(2);
    expect(exported.images).toHaveLength(1);
    const imported = await (await call('POST', '/api/files/import', exported)).json();
    expect(imported.pages.map((p: { name: string }) => p.name)).toEqual(['Page 1', 'Flows']);
    const back = await fetch(`${base}/api/files/${imported.id}/images/${imageId}`);
    expect(back.status).toBe(200);

    // a damaged image in an import is refused
    const broken = { ...exported, images: [{ ...exported.images[0], data: Buffer.from('nope').toString('base64') }] };
    expect((await call('POST', '/api/files/import', broken)).status).toBe(400);
  });

  it('refuses a component that contains an instance of itself', async () => {
    const f = await (await call('POST', '/api/files', {})).json();
    const comp = { ...rect('c1'), type: 'COMPONENT', clipsContent: false };
    const inst = { ...rect('i1', 'c1'), type: 'INSTANCE', componentId: 'c1', radii: undefined, fills: [] };
    const r = await call('POST', `/api/files/${f.id}/changes`, { baseVersion: 0, upserts: [comp, inst], deletes: [] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/instance of itself/);
  });
});

describe('import limits', () => {
  it('refuses a deeply nested file quickly instead of stalling the server', async () => {
    const nodes = Array.from({ length: 15_000 }, (_, i) => ({
      ...rect(`f${i}`, i === 0 ? null : `f${i - 1}`),
      type: 'FRAME' as const,
      clipsContent: false,
    }));
    const t0 = Date.now();
    const r = await call('POST', '/api/files/import', {
      format: 'localframe-file',
      version: 1,
      name: 'deep',
      background: '#FFFFFF',
      nodes,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/nested more than/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('local-only guards', () => {
  it('refuses writes from other origins', async () => {
    const r = await call('POST', '/api/files', {}, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('refuses writes without an Origin header', async () => {
    const r = await fetch(base + '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('refuses non-JSON bodies (no simple cross-site form posts)', async () => {
    const r = await fetch(base + '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: origin },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });

  it('refuses unknown Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: '/api/files', headers: { Host: 'attacker.example:80' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('rejects thumbnails that are not PNG', async () => {
    const f = await (await call('POST', '/api/files', {})).json();
    const r = await call('PUT', `/api/files/${f.id}/thumbnail`, {
      dataUrl: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64'),
    });
    expect(r.status).toBe(400);
  });
});
