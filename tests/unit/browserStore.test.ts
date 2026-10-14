import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ApiError } from '../../src/apiError.ts';
import { BrowserStore, sha256Hex } from '../../src/browserStore.ts';
import type { SceneNode } from '../../shared/schema.ts';

// smallest valid PNG: 1x1 transparent pixel
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function rect(id: string, parentId: string | null = null, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: 'RECTANGLE',
    parentId,
    order: 'a0',
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'inside',
    strokeDash: [],
    radii: [0, 0, 0, 0],
    ...(parentId === null ? { pageId: 'page-1' } : {}),
    ...extra,
  };
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    throw e;
  }
};

let store: BrowserStore;
beforeEach(() => {
  store = new BrowserStore(new IDBFactory());
});

describe('browser storage', () => {
  it('creates, saves, reloads, renames and deletes files', async () => {
    const f = await store.createFile('Board');
    expect(f).toMatchObject({ name: 'Board', version: 0 });
    let r = await store.saveChanges(f.id, { baseVersion: 0, upserts: [rect('a'), rect('b')], deletes: [] });
    expect(r.version).toBe(1);
    r = await store.saveChanges(f.id, { baseVersion: 1, upserts: [rect('c')], deletes: ['a'] });
    const got = await store.getFile(f.id);
    expect(got.nodes.map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(got.file.version).toBe(2);
    // a stale base version is a conflict, like the server's 409
    expect(await status(store.saveChanges(f.id, { baseVersion: 1, upserts: [], deletes: [] }))).toBe(409);
    await store.updateFile(f.id, { name: 'Renamed' });
    expect((await store.listFiles())[0].name).toBe('Renamed');
    await store.deleteFile(f.id);
    expect(await store.listFiles()).toEqual([]);
    expect(await status(store.getFile(f.id))).toBe(404);
  });

  it('checks every change like the server: schema, tree, ids', async () => {
    const f = await store.createFile();
    // a cycle
    expect(await status(store.saveChanges(f.id, { baseVersion: 0, upserts: [rect('x', 'y'), rect('y', 'x')], deletes: [] }))).toBe(400);
    // not a node at all
    expect(await status(store.saveChanges(f.id, { baseVersion: 0, upserts: [{ id: 'z' } as unknown as SceneNode], deletes: [] }))).toBe(400);
    // nothing was written
    expect((await store.getFile(f.id)).nodes).toEqual([]);
    expect(await status(store.getFile('../etc'))).toBe(404);
  });

  it('stores images by hash, refuses what is not an image, and exports and imports them', async () => {
    const f = await store.createFile();
    const { id } = await store.uploadImage(f.id, new Blob([PNG], { type: 'image/png' }));
    expect(id).toBe(await sha256Hex(PNG));
    expect(await status(store.uploadImage(f.id, new Blob(['<svg onload="alert(1)"/>'], { type: 'image/png' })))).toBe(415);
    expect(await status(store.uploadImage(f.id, new Blob(['<svg/>'], { type: 'image/svg+xml' })))).toBe(415);
    const img = rect('r', null, { fills: [{ type: 'IMAGE', imageId: id, scaleMode: 'fill', opacity: 1, visible: true }] });
    await store.saveChanges(f.id, { baseVersion: 0, upserts: [img], deletes: [] });

    const data = await store.exportFile(f.id);
    expect(data.images).toHaveLength(1);
    const copy = await store.importFile(JSON.parse(JSON.stringify(data)));
    expect((await store.getFile(copy.id)).nodes).toHaveLength(1);
    // a damaged image is refused
    const bad = { ...data, images: [{ ...data.images![0], data: btoa('not a png') }] };
    expect(await status(store.importFile(bad))).toBe(400);

    // copying into another file (pasting between files)
    const other = await store.createFile();
    expect((await store.copyImages(other.id, f.id, [id])).copied).toBe(1);
    expect((await store.copyImages(other.id, f.id, [id])).copied).toBe(0);
    expect(await status(store.copyImages(other.id, f.id, ['../x']))).toBe(400);
  });

  it('keeps versions: named ones, an autosave before a session, and restores', async () => {
    const f = await store.createFile();
    await store.saveChanges(f.id, { baseVersion: 0, upserts: [rect('a')], deletes: [] });
    expect(await store.listVersions(f.id)).toEqual([]);
    const v1 = await store.saveVersion(f.id, 'One');
    await store.saveChanges(f.id, { baseVersion: 1, upserts: [rect('b')], deletes: [] });
    await store.saveChanges(f.id, { baseVersion: 2, upserts: [rect('c')], deletes: [] });
    expect((await store.listVersions(f.id)).map((v) => v.auto)).toEqual([true, false]);
    const meta = await store.restoreVersion(f.id, v1.id);
    expect(meta.version).toBe(4);
    expect((await store.getFile(f.id)).nodes.map((n) => n.id)).toEqual(['a']);
    const list = await store.listVersions(f.id);
    expect(list[0]).toMatchObject({ auto: true, nodeCount: 3 });
    await store.renameVersion(f.id, list[0].id, 'Before');
    expect((await store.listVersions(f.id))[0]).toMatchObject({ name: 'Before', auto: false });
    // another file's version can't be reached
    const other = await store.createFile();
    expect(await status(store.restoreVersion(other.id, v1.id))).toBe(404);
    expect(await status(store.deleteVersion(other.id, v1.id))).toBe(404);
    expect(await status(store.saveVersion(f.id, ''))).toBe(400);
  });

  it('keeps comment threads with the same rules as the server', async () => {
    const f = await store.createFile();
    const c = await store.addComment(f.id, { pageId: 'page-1', x: 1, y: 2, body: ' Hi ' });
    expect(c).toMatchObject({ body: 'Hi', parentId: null, offset: null });
    const reply = await store.addComment(f.id, { parentId: c.id, pageId: 'other', x: 9, y: 9, body: 'Yes' });
    expect(reply).toMatchObject({ pageId: 'page-1', x: 1, y: 2 });
    expect(await status(store.addComment(f.id, { pageId: 'nope', x: 0, y: 0, body: 'x' }))).toBe(400);
    expect(await status(store.updateComment(f.id, reply.id, { x: 5 }))).toBe(400);
    await store.updateComment(f.id, c.id, { x: 50, y: 60, nodeId: 'r1', offset: { x: 1, y: 1 } });
    const all = await store.listComments(f.id);
    expect(all.find((x) => x.id === reply.id)).toMatchObject({ x: 50, y: 60, nodeId: 'r1' });
    await store.deleteComment(f.id, c.id);
    expect(await store.listComments(f.id)).toEqual([]);
    // deleting the file takes its comments
    await store.addComment(f.id, { pageId: 'page-1', x: 0, y: 0, body: 'x' });
    await store.deleteFile(f.id);
    const g = await store.createFile();
    expect(await store.listComments(g.id)).toEqual([]);
  });
});
