/**
 * Storage for the web build: the same operations as the local server, kept in this browser's
 * IndexedDB. Nothing leaves the browser. Every input is checked with the same schemas and limits
 * the server uses, because files and clipboard contents can come from anywhere.
 */
import {
  AUTO_VERSION_EVERY_MS,
  type Changes,
  ChangesSchema,
  type Comment,
  CommentPatchSchema,
  CreateFileSchema,
  EMPTY_VARIABLES,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportedFile,
  ExportedFileSchema,
  type FileMeta,
  IdSchema,
  IMAGE_TYPES,
  ImageIdSchema,
  MAX_AUTO_VERSIONS,
  MAX_COMMENTS_PER_FILE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PER_FILE,
  MAX_NAMED_VERSIONS,
  MAX_SNAPSHOT_CHARS,
  MAX_VERSION_BYTES_PER_FILE,
  NewCommentSchema,
  type Page,
  PagesSchema,
  type SceneNode,
  SceneNodeSchema,
  type Style,
  StylesSchema,
  ThumbnailSchema,
  UpdateFileSchema,
  type Variables,
  VariablesSchema,
  type VersionMeta,
  VersionNameSchema,
  sniffImage,
  validateTree,
} from '../shared/schema.ts';
import type { ZodType } from 'zod';
import { ApiError } from './apiError.ts';

/** Errors look like the server's HTTP errors, so callers treat both storages the same way. */
const StoreError = class extends ApiError {
  constructor(status: number, message: string, body: unknown = { error: message }) {
    super(status, message, body);
  }
};

type FileRecord = {
  id: string;
  name: string;
  pages: Page[];
  styles: Style[];
  variables: Variables;
  version: number;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
};
type NodesRecord = { fileId: string; nodes: SceneNode[] };
type ImageRecord = { fileId: string; id: string; mime: string; size: number; blob: Blob };
type VersionRecord = { id?: number; fileId: string; name: string | null; auto: boolean; createdAt: string; nodeCount: number; size: number; snapshot: string };
type CommentRecord = Comment & { fileId: string };
type Snapshot = { nodes: SceneNode[]; pages: Page[]; styles: Style[]; variables: Variables };

const DB_NAME = 'localframe';
const STORES = ['files', 'nodes', 'images', 'versions', 'comments'] as const;
type StoreName = (typeof STORES)[number];

const now = () => new Date().toISOString();
const defaultPages = (): Page[] => [{ id: 'page-1', name: 'Page 1', background: '#F3F3F1' }];

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new StoreError(400, `Invalid request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const imagesIn = (nodes: SceneNode[]) => {
  const used = new Set<string>();
  for (const n of nodes) {
    for (const p of n.fills) if (p.type === 'IMAGE') used.add(p.imageId);
    for (const o of Object.values(n.overrides ?? {})) for (const p of o.fills ?? []) if (p.type === 'IMAGE') used.add(p.imageId);
  }
  return used;
};

export class BrowserStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private readonly urls = new Map<string, string>();
  private readonly thumbs = new Map<string, string>();
  /** When an autosaved version was last skipped for a file (too large), so it isn't retried on every save. */
  private readonly skippedAt = new Map<string, number>();

  private readonly factory: IDBFactory;

  constructor(factory?: IDBFactory) {
    this.factory = factory ?? globalThis.indexedDB;
  }

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = this.factory.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('files', { keyPath: 'id' });
        db.createObjectStore('nodes', { keyPath: 'fileId' });
        db.createObjectStore('images', { keyPath: ['fileId', 'id'] }).createIndex('fileId', 'fileId');
        db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }).createIndex('fileId', 'fileId');
        db.createObjectStore('comments', { keyPath: 'id' }).createIndex('fileId', 'fileId');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Close other localframe tabs and reload.'));
    });
    return this.dbp;
  }

  /**
   * One atomic step over some stores. `fn` must only wait on requests of this transaction
   * (anything else lets it commit early), so hashing and reading blobs happen outside.
   */
  private async run<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (s: Record<StoreName, IDBObjectStore>) => Promise<T>): Promise<T> {
    const db = await this.db();
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('Storage step was cancelled'));
    });
    const s = Object.fromEntries(stores.map((n) => [n, t.objectStore(n)])) as Record<StoreName, IDBObjectStore>;
    let out: T;
    try {
      out = await fn(s);
    } catch (err) {
      try {
        t.abort();
      } catch {
        /* already finished */
      }
      await done.catch(() => {});
      throw err;
    }
    await done;
    return out;
  }

  private meta(f: FileRecord): FileMeta {
    if (f.thumbnail) this.thumbs.set(f.id, f.thumbnail);
    return {
      id: f.id,
      name: f.name,
      background: f.pages[0].background,
      pages: f.pages,
      styles: f.styles,
      variables: f.variables,
      version: f.version,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      hasThumbnail: !!f.thumbnail,
    };
  }

  private async file(s: Record<StoreName, IDBObjectStore>, id: string): Promise<FileRecord> {
    if (!IdSchema.safeParse(id).success) throw new StoreError(404, 'File not found');
    const f = (await req(s.files.get(id))) as FileRecord | undefined;
    if (!f) throw new StoreError(404, 'File not found');
    return f;
  }

  private async byFile<T>(store: IDBObjectStore, fileId: string): Promise<T[]> {
    return (await req(store.index('fileId').getAll(fileId))) as T[];
  }

  // ------------------------------------------------------------------ files

  async listFiles(): Promise<FileMeta[]> {
    const all = await this.run(['files'], 'readonly', async (s) => (await req(s.files.getAll())) as FileRecord[]);
    return all.map((f) => this.meta(f)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private newFile(name: string, pages = defaultPages(), styles: Style[] = [], variables: Variables = EMPTY_VARIABLES): FileRecord {
    const t = now();
    return { id: crypto.randomUUID(), name, pages, styles, variables, version: 0, createdAt: t, updatedAt: t };
  }

  async createFile(name?: string): Promise<FileMeta> {
    const body = parse(CreateFileSchema, name ? { name } : {});
    const f = this.newFile(body.name ?? 'Untitled');
    await this.run(['files', 'nodes'], 'readwrite', async (s) => {
      await req(s.files.add(f));
      await req(s.nodes.add({ fileId: f.id, nodes: [] } satisfies NodesRecord));
    });
    return this.meta(f);
  }

  async getFile(id: string): Promise<{ file: FileMeta; nodes: SceneNode[] }> {
    return this.run(['files', 'nodes'], 'readonly', async (s) => {
      const f = await this.file(s, id);
      const n = (await req(s.nodes.get(id))) as NodesRecord | undefined;
      return { file: this.meta(f), nodes: n?.nodes ?? [] };
    });
  }

  async updateFile(id: string, patch: { name?: string }): Promise<FileMeta> {
    const body = parse(UpdateFileSchema, patch);
    return this.run(['files'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      const next = { ...f, name: body.name ?? f.name, updatedAt: now() };
      await req(s.files.put(next));
      return this.meta(next);
    });
  }

  async deleteFile(id: string): Promise<void> {
    await this.run([...STORES], 'readwrite', async (s) => {
      await this.file(s, id);
      await req(s.files.delete(id));
      await req(s.nodes.delete(id));
      for (const store of [s.images, s.versions, s.comments]) {
        for (const key of await req(store.index('fileId').getAllKeys(id))) await req(store.delete(key));
      }
    });
    for (const [k, url] of this.urls) {
      if (k.startsWith(`${id}/`)) {
        URL.revokeObjectURL(url);
        this.urls.delete(k);
      }
    }
    this.thumbs.delete(id);
  }

  async saveChanges(id: string, changes: Changes): Promise<{ version: number }> {
    const body = parse(ChangesSchema, changes);
    return this.run(['files', 'nodes', 'versions'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      if (f.version !== body.baseVersion) throw new StoreError(409, 'conflict', { error: 'conflict', version: f.version });
      const rec = ((await req(s.nodes.get(id))) as NodesRecord | undefined) ?? { fileId: id, nodes: [] };
      // the file as it was before this editing session, kept as an autosaved version
      if (f.version > 0) await this.autosave(s, f, rec.nodes);
      const map = new Map(rec.nodes.map((n) => [n.id, n]));
      for (const d of body.deletes) map.delete(d);
      for (const n of body.upserts) map.set(n.id, n);
      const nodes = [...map.values()];
      const pages = body.pages ?? f.pages;
      const problem = validateTree(nodes, pages);
      if (problem) throw new StoreError(400, problem);
      const next: FileRecord = {
        ...f,
        pages,
        styles: body.styles ?? f.styles,
        variables: body.variables ?? f.variables,
        version: f.version + 1,
        updatedAt: now(),
      };
      await req(s.nodes.put({ fileId: id, nodes } satisfies NodesRecord));
      await req(s.files.put(next));
      return { version: next.version };
    });
  }

  async putThumbnail(id: string, dataUrl: string): Promise<void> {
    const body = parse(ThumbnailSchema, { dataUrl });
    await this.run(['files'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      await req(s.files.put({ ...f, thumbnail: body.dataUrl }));
    });
    this.thumbs.set(id, body.dataUrl);
  }

  thumbnailUrl(id: string): string {
    return this.thumbs.get(id) ?? '';
  }

  // ----------------------------------------------------------------- images

  async uploadImage(id: string, blob: Blob): Promise<{ id: string; mime: string }> {
    if (!(IMAGE_TYPES as readonly string[]).includes(blob.type)) throw new StoreError(415, 'Images must be PNG, JPEG, WebP or GIF');
    if (blob.size > MAX_IMAGE_BYTES) throw new StoreError(413, 'Images can be up to 20 MB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime) throw new StoreError(415, 'That file is not a PNG, JPEG, WebP or GIF image');
    const hash = await sha256Hex(bytes);
    await this.run(['files', 'images'], 'readwrite', async (s) => {
      await this.file(s, id);
      await this.putImage(s, id, hash, mime, bytes);
    });
    return { id: hash, mime };
  }

  private async putImage(s: Record<StoreName, IDBObjectStore>, fileId: string, id: string, mime: string, bytes: Uint8Array) {
    if (await req(s.images.get([fileId, id]))) return;
    const used = (await this.byFile<ImageRecord>(s.images, fileId)).reduce((sum, r) => sum + r.size, 0);
    if (used + bytes.length > MAX_IMAGE_BYTES_PER_FILE) throw new StoreError(400, 'this file already holds 1 GB of images');
    const rec: ImageRecord = { fileId, id, mime, size: bytes.length, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }) };
    await req(s.images.put(rec));
  }

  /** An object URL for drawing an image, made once per image. */
  async imageUrl(fileId: string, id: string): Promise<string | null> {
    const key = `${fileId}/${id}`;
    const hit = this.urls.get(key);
    if (hit) return hit;
    if (!ImageIdSchema.safeParse(id).success) return null;
    const rec = await this.run(['images'], 'readonly', async (s) => (await req(s.images.get([fileId, id]))) as ImageRecord | undefined);
    if (!rec) return null;
    const url = URL.createObjectURL(rec.blob);
    this.urls.set(key, url);
    return url;
  }

  async copyImages(id: string, from: string, ids: string[]): Promise<{ copied: number }> {
    const list = parse(ImageIdSchema.array().max(500), ids);
    return this.run(['files', 'images'], 'readwrite', async (s) => {
      await this.file(s, id);
      await this.file(s, from);
      let copied = 0;
      for (const imageId of list) {
        if (await req(s.images.get([id, imageId]))) continue;
        const src = (await req(s.images.get([from, imageId]))) as ImageRecord | undefined;
        if (!src) continue;
        const used = (await this.byFile<ImageRecord>(s.images, id)).reduce((sum, r) => sum + r.size, 0);
        if (used + src.size > MAX_IMAGE_BYTES_PER_FILE) throw new StoreError(400, 'this file already holds 1 GB of images');
        await req(s.images.put({ ...src, fileId: id }));
        copied++;
      }
      return { copied };
    });
  }

  // ------------------------------------------------------- export and import

  async exportFile(id: string): Promise<ExportedFile> {
    const { f, nodes, images } = await this.run(['files', 'nodes', 'images'], 'readonly', async (s) => {
      const f = await this.file(s, id);
      const nodes = ((await req(s.nodes.get(id))) as NodesRecord | undefined)?.nodes ?? [];
      const images: ImageRecord[] = [];
      for (const imageId of imagesIn(nodes)) {
        const r = (await req(s.images.get([id, imageId]))) as ImageRecord | undefined;
        if (r) images.push(r);
      }
      return { f, nodes, images };
    });
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      name: f.name,
      background: f.pages[0].background,
      pages: f.pages,
      styles: f.styles,
      variables: f.variables,
      nodes,
      images: await Promise.all(
        images.map(async (r) => ({ id: r.id, mime: r.mime as (typeof IMAGE_TYPES)[number], data: toBase64(new Uint8Array(await r.blob.arrayBuffer())) })),
      ),
    };
  }

  async importFile(data: unknown): Promise<FileMeta> {
    const file = parse(ExportedFileSchema, data);
    const pages = file.pages ?? [{ id: 'page-1', name: 'Page 1', background: file.background }];
    const problem = validateTree(file.nodes, pages);
    if (problem) throw new StoreError(400, problem);
    // only images the layers use, and only if they are what they claim to be
    const used = imagesIn(file.nodes);
    const images: { id: string; mime: string; bytes: Uint8Array }[] = [];
    for (const img of file.images ?? []) {
      if (!used.has(img.id)) continue;
      const bytes = fromBase64(img.data);
      if ((await sha256Hex(bytes)) !== img.id || sniffImage(bytes) !== img.mime) throw new StoreError(400, `image ${img.id.slice(0, 8)} is damaged`);
      images.push({ id: img.id, mime: img.mime, bytes });
    }
    const f = { ...this.newFile(file.name, pages, file.styles ?? [], file.variables ?? EMPTY_VARIABLES), version: file.nodes.length ? 1 : 0 };
    await this.run(['files', 'nodes', 'images'], 'readwrite', async (s) => {
      await req(s.files.add(f));
      await req(s.nodes.add({ fileId: f.id, nodes: file.nodes.map((n) => SceneNodeSchema.parse(n)) } satisfies NodesRecord));
      for (const img of images) await this.putImage(s, f.id, img.id, img.mime, img.bytes);
    });
    return this.meta(f);
  }

  // --------------------------------------------------------------- versions

  /** Saves a version from what is stored now. Returns null when an autosave is skipped. */
  private async snapshot(s: Record<StoreName, IDBObjectStore>, f: FileRecord, nodes: SceneNode[], name: string | null, auto: boolean): Promise<number | null> {
    const json = JSON.stringify({ nodes, pages: f.pages, styles: f.styles, variables: f.variables } satisfies Snapshot);
    if (json.length > MAX_SNAPSHOT_CHARS) {
      if (auto) return null;
      throw new StoreError(400, 'this file is too large to save as a version');
    }
    const versions = await this.byFile<VersionRecord>(s.versions, f.id);
    if (!auto && versions.filter((v) => !v.auto).length >= MAX_NAMED_VERSIONS)
      throw new StoreError(400, `a file keeps up to ${MAX_NAMED_VERSIONS} named versions; delete some first`);
    // keep all versions of a file under the byte cap: old autosaves make room first
    const autos = versions.filter((v) => v.auto).sort((a, b) => a.id! - b.id!);
    let used = versions.reduce((sum, v) => sum + v.size, 0);
    while (used + json.length > MAX_VERSION_BYTES_PER_FILE) {
      const old = autos.shift();
      if (!old) {
        if (auto) return null;
        throw new StoreError(400, 'versions of this file take up 1 GB; delete some first');
      }
      await req(s.versions.delete(old.id!));
      used -= old.size;
    }
    const rec: VersionRecord = { fileId: f.id, name, auto, createdAt: now(), nodeCount: nodes.length, size: json.length, snapshot: json };
    const id = Number(await req(s.versions.add(rec)));
    if (auto) {
      autos.push({ ...rec, id });
      while (autos.length > MAX_AUTO_VERSIONS) await req(s.versions.delete(autos.shift()!.id!));
    }
    return id;
  }

  private async autosave(s: Record<StoreName, IDBObjectStore>, f: FileRecord, nodes: SceneNode[]) {
    const last = (await this.byFile<VersionRecord>(s.versions, f.id)).filter((v) => v.auto).sort((a, b) => b.id! - a.id!)[0];
    const due = !last || Date.now() - Date.parse(last.createdAt) >= AUTO_VERSION_EVERY_MS;
    const skipped = this.skippedAt.get(f.id);
    if (!due || (skipped && Date.now() - skipped < AUTO_VERSION_EVERY_MS)) return;
    if ((await this.snapshot(s, f, nodes, null, true)) === null) this.skippedAt.set(f.id, Date.now());
    else this.skippedAt.delete(f.id);
  }

  private versionMeta = (v: VersionRecord): VersionMeta => ({ id: v.id!, name: v.name, auto: v.auto, createdAt: v.createdAt, nodeCount: v.nodeCount });

  async listVersions(id: string): Promise<VersionMeta[]> {
    return this.run(['files', 'versions'], 'readonly', async (s) => {
      await this.file(s, id);
      return (await this.byFile<VersionRecord>(s.versions, id)).sort((a, b) => b.id! - a.id!).map(this.versionMeta);
    });
  }

  async saveVersion(id: string, name: string): Promise<VersionMeta> {
    const body = parse(VersionNameSchema, { name });
    return this.run(['files', 'nodes', 'versions'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      const nodes = ((await req(s.nodes.get(id))) as NodesRecord | undefined)?.nodes ?? [];
      const vid = (await this.snapshot(s, f, nodes, body.name, false))!;
      return this.versionMeta((await req(s.versions.get(vid))) as VersionRecord);
    });
  }

  private async version(s: Record<StoreName, IDBObjectStore>, fileId: string, vid: number): Promise<VersionRecord> {
    const v = Number.isSafeInteger(vid) && vid > 0 ? ((await req(s.versions.get(vid))) as VersionRecord | undefined) : undefined;
    if (!v || v.fileId !== fileId) throw new StoreError(404, 'Version not found');
    return v;
  }

  async renameVersion(id: string, vid: number, name: string): Promise<void> {
    const body = parse(VersionNameSchema, { name });
    await this.run(['versions'], 'readwrite', async (s) => {
      const v = await this.version(s, id, vid);
      // naming an autosave keeps it for good
      await req(s.versions.put({ ...v, name: body.name, auto: false }));
    });
  }

  async deleteVersion(id: string, vid: number): Promise<void> {
    await this.run(['versions'], 'readwrite', async (s) => {
      await this.version(s, id, vid);
      await req(s.versions.delete(vid));
    });
  }

  /** Puts a version back. What was there is saved as an autosave first, or nothing is replaced. */
  async restoreVersion(id: string, vid: number): Promise<FileMeta> {
    return this.run(['files', 'nodes', 'versions'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      const v = await this.version(s, id, vid);
      let raw: Partial<Snapshot>;
      try {
        raw = JSON.parse(v.snapshot) as Partial<Snapshot>;
      } catch {
        throw new StoreError(400, 'this version can no longer be read');
      }
      const nodes = SceneNodeSchema.array().safeParse(raw.nodes);
      const pages = PagesSchema.safeParse(raw.pages);
      const styles = StylesSchema.safeParse(raw.styles ?? []);
      const variables = VariablesSchema.safeParse(raw.variables ?? EMPTY_VARIABLES);
      if (!nodes.success || !pages.success || !styles.success || !variables.success) throw new StoreError(400, 'this version can no longer be read');
      const problem = validateTree(nodes.data, pages.data);
      if (problem) throw new StoreError(400, problem);
      const current = ((await req(s.nodes.get(id))) as NodesRecord | undefined)?.nodes ?? [];
      if ((await this.snapshot(s, f, current, null, true)) === null) throw new StoreError(400, 'this file is too large to keep a copy before restoring');
      const next: FileRecord = { ...f, pages: pages.data, styles: styles.data, variables: variables.data, version: f.version + 1, updatedAt: now() };
      await req(s.nodes.put({ fileId: id, nodes: nodes.data } satisfies NodesRecord));
      await req(s.files.put(next));
      return this.meta(next);
    });
  }

  // --------------------------------------------------------------- comments

  async listComments(id: string): Promise<Comment[]> {
    return this.run(['files', 'comments'], 'readonly', async (s) => {
      await this.file(s, id);
      return (await this.byFile<CommentRecord>(s.comments, id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(({ fileId: _f, ...c }) => c);
    });
  }

  async addComment(id: string, input: unknown): Promise<Comment> {
    const c = parse(NewCommentSchema, input);
    return this.run(['files', 'comments'], 'readwrite', async (s) => {
      const f = await this.file(s, id);
      const all = await this.byFile<CommentRecord>(s.comments, id);
      if (all.length >= MAX_COMMENTS_PER_FILE) throw new StoreError(400, `a file keeps up to ${MAX_COMMENTS_PER_FILE} comments`);
      let place = { pageId: c.pageId, nodeId: c.nodeId ?? null, offset: c.offset ?? null, x: c.x, y: c.y };
      if (c.parentId) {
        // replies live in their thread: same page and place, and threads are one level deep
        const parent = all.find((p) => p.id === c.parentId);
        if (!parent || parent.parentId) throw new StoreError(400, 'that comment thread does not exist');
        place = { pageId: parent.pageId, nodeId: parent.nodeId, offset: parent.offset, x: parent.x, y: parent.y };
      } else if (!f.pages.some((p) => p.id === c.pageId)) throw new StoreError(400, 'that page does not exist');
      const t = now();
      const rec: CommentRecord = { fileId: id, id: crypto.randomUUID(), parentId: c.parentId ?? null, ...place, body: c.body, resolved: false, createdAt: t, updatedAt: t };
      await req(s.comments.add(rec));
      const { fileId: _f, ...out } = rec;
      return out;
    });
  }

  async updateComment(id: string, cid: string, input: unknown): Promise<Comment> {
    const patch = parse(CommentPatchSchema, input);
    return this.run(['comments'], 'readwrite', async (s) => {
      const row = (await req(s.comments.get(cid))) as CommentRecord | undefined;
      if (!row || row.fileId !== id) throw new StoreError(404, 'Comment not found');
      const moves = patch.x !== undefined || patch.y !== undefined || patch.nodeId !== undefined || patch.offset !== undefined;
      if (row.parentId && moves) throw new StoreError(400, 'move the thread, not a reply');
      const place = {
        x: patch.x ?? row.x,
        y: patch.y ?? row.y,
        nodeId: patch.nodeId === undefined ? row.nodeId : patch.nodeId,
        offset: patch.nodeId === undefined ? row.offset : patch.nodeId ? (patch.offset ?? null) : null,
      };
      const next: CommentRecord = { ...row, ...place, body: patch.body ?? row.body, resolved: patch.resolved ?? row.resolved, updatedAt: now() };
      await req(s.comments.put(next));
      // a thread moves with its replies
      if (moves) for (const r of await this.byFile<CommentRecord>(s.comments, id)) if (r.parentId === cid) await req(s.comments.put({ ...r, ...place }));
      const { fileId: _f, ...out } = next;
      return out;
    });
  }

  async deleteComment(id: string, cid: string): Promise<void> {
    await this.run(['comments'], 'readwrite', async (s) => {
      const row = (await req(s.comments.get(cid))) as CommentRecord | undefined;
      if (!row || row.fileId !== id) throw new StoreError(404, 'Comment not found');
      await req(s.comments.delete(cid));
      // deleting a thread deletes its replies
      for (const r of await this.byFile<CommentRecord>(s.comments, id)) if (r.parentId === cid) await req(s.comments.delete(r.id));
    });
  }
}
