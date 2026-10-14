import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  type Comment,
  type ExportedFile,
  type VersionMeta,
  MAX_COMMENTS_PER_FILE,
  type FileMeta,
  type Page,
  type SceneNode,
  type Style,
  type Variables,
  EMPTY_VARIABLES,
  StylesSchema,
  VariablesSchema,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  IMAGE_TYPES,
  PagesSchema,
  SceneNodeSchema,
  sniffImage,
  validateTree,
} from '../shared/schema.ts';

const MIGRATIONS = [
  `create table files (
     id          text primary key,
     name        text not null,
     background  text not null default '#F3F3F1',
     version     integer not null default 0,
     thumbnail   blob,
     created_at  text not null,
     updated_at  text not null
   );
   create index files_updated_at on files (updated_at desc);
   create table nodes (
     file_id  text not null references files(id) on delete cascade,
     id       text not null,
     data     text not null check (json_valid(data)),
     primary key (file_id, id)
   );`,
  `alter table files add column pages text check (pages is null or json_valid(pages));
   create table images (
     file_id  text not null references files(id) on delete cascade,
     id       text not null,
     mime     text not null,
     data     blob not null,
     primary key (file_id, id)
   );`,
  `alter table files add column styles text check (styles is null or json_valid(styles));
   alter table files add column variables text check (variables is null or json_valid(variables));`,
  `create table versions (
     id          integer primary key,
     file_id     text not null references files(id) on delete cascade,
     name        text,
     auto        integer not null check (auto in (0, 1)),
     created_at  text not null,
     node_count  integer not null,
     snapshot    text not null check (json_valid(snapshot))
   );
   create index versions_file on versions (file_id, id desc);`,
  `create table comments (
     id          text primary key,
     file_id     text not null references files(id) on delete cascade,
     parent_id   text references comments(id) on delete cascade,
     page_id     text not null,
     node_id     text,
     ox          real,
     oy          real,
     x           real not null,
     y           real not null,
     body        text not null check (length(body) between 1 and 5000),
     resolved    integer not null default 0 check (resolved in (0, 1)),
     created_at  text not null,
     updated_at  text not null
   );
   create index comments_file on comments (file_id, created_at);`,
];

/** Autosaved versions: one at the start of each editing session (after this long without one). */
export const AUTO_VERSION_EVERY_MS = 10 * 60 * 1000;
export const MAX_AUTO_VERSIONS = 50;
export const MAX_NAMED_VERSIONS = 200;
/** Larger files skip autosaved versions (each one is a full copy). */
export const MAX_SNAPSHOT_CHARS = 64 * 1024 * 1024;
/** All of a file's versions together, like its images. */
export const MAX_VERSION_BYTES_PER_FILE = 1024 * 1024 * 1024;

type Snapshot = { nodes: SceneNode[]; pages: Page[]; styles: Style[]; variables: Variables };
type CommentRow = {
  id: string;
  parent_id: string | null;
  page_id: string;
  node_id: string | null;
  ox: number | null;
  oy: number | null;
  x: number;
  y: number;
  body: string;
  resolved: number;
  created_at: string;
  updated_at: string;
};
const toComment = (r: CommentRow): Comment => ({
  id: r.id,
  parentId: r.parent_id,
  pageId: r.page_id,
  nodeId: r.node_id,
  offset: r.node_id && r.ox !== null && r.oy !== null ? { x: r.ox, y: r.oy } : null,
  x: r.x,
  y: r.y,
  body: r.body,
  resolved: r.resolved === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ConflictError extends Error {
  readonly version: number;
  constructor(version: number) {
    super('version conflict');
    this.version = version;
  }
}

export class InvalidError extends Error {}

type FileRow = {
  id: string;
  name: string;
  background: string;
  pages: string | null;
  styles: string | null;
  variables: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  has_thumbnail: number;
};

export const defaultPages = (background: string): Page[] => [{ id: 'page-1', name: 'Page 1', background }];

function toMeta(r: FileRow): FileMeta {
  let pages: Page[] = defaultPages(r.background);
  if (r.pages) {
    const parsed = PagesSchema.safeParse(JSON.parse(r.pages));
    if (parsed.success) pages = parsed.data;
  }
  const styles = r.styles ? StylesSchema.safeParse(JSON.parse(r.styles)) : null;
  const variables = r.variables ? VariablesSchema.safeParse(JSON.parse(r.variables)) : null;
  return {
    id: r.id,
    name: r.name,
    background: pages[0].background,
    pages,
    styles: styles?.success ? styles.data : [],
    variables: variables?.success ? variables.data : EMPTY_VARIABLES,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasThumbnail: r.has_thumbnail === 1,
  };
}

const now = () => new Date().toISOString();
const META_COLS = 'id, name, background, pages, styles, variables, version, created_at, updated_at, (thumbnail is not null) as has_thumbnail';

export const MAX_IMAGE_BYTES_PER_FILE = 1024 * 1024 * 1024;

export const imageHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class Store {
  readonly db: DatabaseSync;
  /** When an autosaved version was last skipped for a file, so the check isn't repeated on every save. */
  private readonly skippedAt = new Map<string, number>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 2000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec('create table if not exists schema_migrations (version integer primary key, applied_at text not null)');
    const row = this.db.prepare('select max(version) as v from schema_migrations').get() as { v: number | null };
    const current = row.v ?? 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(i + 1, now());
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try {
      const out = fn();
      this.db.exec('commit');
      return out;
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  listFiles(): FileMeta[] {
    const rows = this.db.prepare(`select ${META_COLS} from files order by updated_at desc`).all() as FileRow[];
    return rows.map(toMeta);
  }

  getMeta(id: string): FileMeta | null {
    const row = this.db.prepare(`select ${META_COLS} from files where id = ?`).get(id) as FileRow | undefined;
    return row ? toMeta(row) : null;
  }

  createFile(name: string, pages: Page[] = defaultPages('#F3F3F1'), styles: Style[] = [], variables: Variables = EMPTY_VARIABLES): FileMeta {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        'insert into files (id, name, background, pages, styles, variables, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(id, name, pages[0].background, JSON.stringify(pages), JSON.stringify(styles), JSON.stringify(variables), t, t);
    return this.getMeta(id)!;
  }

  updateFile(id: string, patch: { name?: string }): FileMeta | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    this.db.prepare('update files set name = ?, updated_at = ? where id = ?').run(patch.name ?? meta.name, now(), id);
    return this.getMeta(id);
  }

  deleteFile(id: string): boolean {
    return Number(this.db.prepare('delete from files where id = ?').run(id).changes) > 0;
  }

  getNodes(fileId: string): SceneNode[] {
    const rows = this.db.prepare('select data from nodes where file_id = ?').all(fileId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as SceneNode);
  }

  applyChanges(
    fileId: string,
    baseVersion: number,
    upserts: SceneNode[],
    deletes: string[],
    pages?: Page[],
    styles?: Style[],
    variables?: Variables,
  ): number {
    return this.tx(() => {
      const meta = this.getMeta(fileId);
      if (!meta) throw new InvalidError('file not found');
      if (meta.version !== baseVersion) throw new ConflictError(meta.version);
      // the file as it was before this editing session, kept as an autosaved version
      const last = this.db.prepare('select created_at from versions where file_id = ? and auto = 1 order by id desc limit 1').get(fileId) as
        | { created_at: string }
        | undefined;
      const due = !last || Date.now() - Date.parse(last.created_at) >= AUTO_VERSION_EVERY_MS;
      const skipped = this.skippedAt.get(fileId);
      if (meta.version > 0 && due && !(skipped && Date.now() - skipped < AUTO_VERSION_EVERY_MS)) {
        // a skipped autosave (file too large) waits as long as a saved one would
        if (this.snapshot(fileId, null, true) === null) this.skippedAt.set(fileId, Date.now());
        else this.skippedAt.delete(fileId);
      }
      const del = this.db.prepare('delete from nodes where file_id = ? and id = ?');
      for (const id of deletes) del.run(fileId, id);
      const put = this.db.prepare(
        'insert into nodes (file_id, id, data) values (?, ?, ?) on conflict (file_id, id) do update set data = excluded.data',
      );
      for (const n of upserts) put.run(fileId, n.id, JSON.stringify(n));
      const finalPages = pages ?? meta.pages;
      const problem = validateTree(this.getNodes(fileId), finalPages);
      if (problem) throw new InvalidError(problem);
      const version = meta.version + 1;
      this.db
        .prepare('update files set version = ?, pages = ?, background = ?, styles = ?, variables = ?, updated_at = ? where id = ?')
        .run(
          version,
          JSON.stringify(finalPages),
          finalPages[0].background,
          JSON.stringify(styles ?? meta.styles),
          JSON.stringify(variables ?? meta.variables),
          now(),
          fileId,
        );
      return version;
    });
  }

  setThumbnail(id: string, png: Uint8Array): boolean {
    return Number(this.db.prepare('update files set thumbnail = ? where id = ?').run(png, id).changes) > 0;
  }

  getThumbnail(id: string): Uint8Array | null {
    const row = this.db.prepare('select thumbnail from files where id = ?').get(id) as
      | { thumbnail: Uint8Array | null }
      | undefined;
    return row?.thumbnail ?? null;
  }

  /** Stores image bytes under their hash. Returns null when the bytes are not a supported image. */
  putImage(fileId: string, bytes: Uint8Array): { id: string; mime: string } | null {
    const mime = sniffImage(bytes);
    if (!mime) return null;
    const id = imageHash(bytes);
    const used = this.db.prepare('select coalesce(sum(length(data)), 0) as n from images where file_id = ?').get(fileId) as { n: number };
    if (Number(used.n) + bytes.length > MAX_IMAGE_BYTES_PER_FILE && !this.getImage(fileId, id))
      throw new InvalidError('this file already holds 1 GB of images');
    this.db
      .prepare('insert into images (file_id, id, mime, data) values (?, ?, ?, ?) on conflict (file_id, id) do nothing')
      .run(fileId, id, mime, bytes);
    return { id, mime };
  }

  /** Copies images from one file to another (for pasting between files). Returns how many were copied. */
  copyImages(fromFile: string, toFile: string, ids: string[]): number {
    let copied = 0;
    this.tx(() => {
      for (const id of ids) {
        if (this.getImage(toFile, id)) continue;
        const img = this.getImage(fromFile, id);
        if (img && this.putImage(toFile, img.data)) copied++;
      }
    });
    return copied;
  }

  getImage(fileId: string, id: string): { mime: string; data: Uint8Array } | null {
    const row = this.db.prepare('select mime, data from images where file_id = ? and id = ?').get(fileId, id) as
      | { mime: string; data: Uint8Array }
      | undefined;
    return row ?? null;
  }

  // --------------------------------------------------------------- versions

  /** Saves the file's current content as a version. Autosaves of very large files are skipped. */
  private snapshot(fileId: string, name: string | null, auto: boolean): number | null {
    // size first, without loading the file: autosaves of very large files are skipped cheaply
    const size = this.db.prepare('select coalesce(sum(length(data)), 0) as n from nodes where file_id = ?').get(fileId) as { n: number };
    if (Number(size.n) > MAX_SNAPSHOT_CHARS) {
      if (auto) return null;
      throw new InvalidError('this file is too large to save as a version');
    }
    if (!auto) {
      const named = this.db.prepare('select count(*) as n from versions where file_id = ? and auto = 0').get(fileId) as { n: number };
      if (Number(named.n) >= MAX_NAMED_VERSIONS) throw new InvalidError(`a file keeps up to ${MAX_NAMED_VERSIONS} named versions; delete some first`);
    }
    const meta = this.getMeta(fileId)!;
    const nodes = this.getNodes(fileId);
    const data: Snapshot = { nodes, pages: meta.pages, styles: meta.styles, variables: meta.variables };
    const json = JSON.stringify(data);
    if (json.length > MAX_SNAPSHOT_CHARS) {
      if (auto) return null;
      throw new InvalidError('this file is too large to save as a version');
    }
    // keep all versions of a file under the byte cap: old autosaves make room first
    const used = () =>
      Number((this.db.prepare('select coalesce(sum(length(snapshot)), 0) as n from versions where file_id = ?').get(fileId) as { n: number }).n);
    const oldestAuto = this.db.prepare('select id from versions where file_id = ? and auto = 1 order by id limit 1');
    while (used() + json.length > MAX_VERSION_BYTES_PER_FILE) {
      const old = oldestAuto.get(fileId) as { id: number } | undefined;
      if (!old) {
        if (auto) return null;
        throw new InvalidError('versions of this file take up 1 GB; delete some first');
      }
      this.db.prepare('delete from versions where id = ?').run(old.id);
    }
    const r = this.db
      .prepare('insert into versions (file_id, name, auto, created_at, node_count, snapshot) values (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, auto ? 1 : 0, now(), nodes.length, json);
    if (auto) {
      this.db
        .prepare(
          'delete from versions where file_id = ? and auto = 1 and id not in (select id from versions where file_id = ? and auto = 1 order by id desc limit ?)',
        )
        .run(fileId, fileId, MAX_AUTO_VERSIONS);
    }
    return Number(r.lastInsertRowid);
  }

  listVersions(fileId: string): VersionMeta[] {
    const rows = this.db
      .prepare('select id, name, auto, created_at, node_count from versions where file_id = ? order by id desc')
      .all(fileId) as { id: number; name: string | null; auto: number; created_at: string; node_count: number }[];
    return rows.map((r) => ({ id: Number(r.id), name: r.name, auto: r.auto === 1, createdAt: r.created_at, nodeCount: Number(r.node_count) }));
  }

  saveVersion(fileId: string, name: string): VersionMeta {
    const id = this.tx(() => this.snapshot(fileId, name, false))!;
    return this.listVersions(fileId).find((v) => v.id === id)!;
  }

  /** Naming an autosave keeps it for good. */
  renameVersion(fileId: string, versionId: number, name: string): boolean {
    return Number(this.db.prepare('update versions set name = ?, auto = 0 where file_id = ? and id = ?').run(name, fileId, versionId).changes) > 0;
  }

  deleteVersion(fileId: string, versionId: number): boolean {
    return Number(this.db.prepare('delete from versions where file_id = ? and id = ?').run(fileId, versionId).changes) > 0;
  }

  /** Puts a version's content back. What was there is saved as an autosave first, so a restore can be undone. */
  restoreVersion(fileId: string, versionId: number): FileMeta | null {
    return this.tx(() => {
      const row = this.db.prepare('select name, created_at, snapshot from versions where file_id = ? and id = ?').get(fileId, versionId) as
        | { name: string | null; created_at: string; snapshot: string }
        | undefined;
      if (!row) return null;
      const raw = JSON.parse(row.snapshot) as Partial<Snapshot>;
      const nodes = SceneNodeSchema.array().safeParse(raw.nodes);
      const pages = PagesSchema.safeParse(raw.pages);
      const styles = StylesSchema.safeParse(raw.styles ?? []);
      const variables = VariablesSchema.safeParse(raw.variables ?? EMPTY_VARIABLES);
      if (!nodes.success || !pages.success || !styles.success || !variables.success) throw new InvalidError('this version can no longer be read');
      const problem = validateTree(nodes.data, pages.data);
      if (problem) throw new InvalidError(problem);
      const meta = this.getMeta(fileId)!;
      // what is there now is kept first, or nothing is replaced
      if (this.snapshot(fileId, null, true) === null) throw new InvalidError("this file is too large to keep a copy before restoring");
      this.db.prepare('delete from nodes where file_id = ?').run(fileId);
      const put = this.db.prepare('insert into nodes (file_id, id, data) values (?, ?, ?)');
      for (const n of nodes.data) put.run(fileId, n.id, JSON.stringify(n));
      this.db
        .prepare('update files set version = ?, pages = ?, background = ?, styles = ?, variables = ?, updated_at = ? where id = ?')
        .run(meta.version + 1, JSON.stringify(pages.data), pages.data[0].background, JSON.stringify(styles.data), JSON.stringify(variables.data), now(), fileId);
      return this.getMeta(fileId);
    });
  }

  // --------------------------------------------------------------- comments

  listComments(fileId: string): Comment[] {
    const rows = this.db.prepare('select * from comments where file_id = ? order by created_at, id').all(fileId) as CommentRow[];
    return rows.map(toComment);
  }

  addComment(
    fileId: string,
    c: { parentId?: string; pageId: string; nodeId?: string; offset?: { x: number; y: number }; x: number; y: number; body: string },
  ): Comment {
    return this.tx(() => {
      const count = this.db.prepare('select count(*) as n from comments where file_id = ?').get(fileId) as { n: number };
      if (Number(count.n) >= MAX_COMMENTS_PER_FILE) throw new InvalidError(`a file keeps up to ${MAX_COMMENTS_PER_FILE} comments`);
      if (!c.parentId && !this.getMeta(fileId)?.pages.some((p) => p.id === c.pageId)) throw new InvalidError('that page does not exist');
      let { pageId, nodeId, x, y } = c;
      let ox = c.offset?.x ?? null;
      let oy = c.offset?.y ?? null;
      if (c.parentId) {
        // replies live in their thread: same page and place, and threads are one level deep
        const parent = this.db.prepare('select * from comments where file_id = ? and id = ?').get(fileId, c.parentId) as CommentRow | undefined;
        if (!parent || parent.parent_id) throw new InvalidError('that comment thread does not exist');
        ({ page_id: pageId, x, y, ox, oy } = parent);
        nodeId = parent.node_id ?? undefined;
      }
      const id = randomUUID();
      const t = now();
      this.db
        .prepare(
          'insert into comments (id, file_id, parent_id, page_id, node_id, ox, oy, x, y, body, resolved, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        )
        .run(id, fileId, c.parentId ?? null, pageId, nodeId ?? null, ox, oy, x, y, c.body, t, t);
      return toComment(this.db.prepare('select * from comments where id = ?').get(id) as CommentRow);
    });
  }

  updateComment(
    fileId: string,
    id: string,
    patch: { body?: string; resolved?: boolean; x?: number; y?: number; nodeId?: string | null; offset?: { x: number; y: number } | null },
  ): Comment | null {
    const row = this.db.prepare('select * from comments where file_id = ? and id = ?').get(fileId, id) as CommentRow | undefined;
    if (!row) return null;
    // replies sit with their thread; move the thread instead
    if (row.parent_id && (patch.x !== undefined || patch.y !== undefined || patch.nodeId !== undefined || patch.offset !== undefined))
      throw new InvalidError('move the thread, not a reply');
    const next = {
      body: patch.body ?? row.body,
      resolved: patch.resolved === undefined ? row.resolved : patch.resolved ? 1 : 0,
      x: patch.x ?? row.x,
      y: patch.y ?? row.y,
      node_id: patch.nodeId === undefined ? row.node_id : patch.nodeId,
      ox: patch.nodeId === undefined ? row.ox : (patch.offset?.x ?? null),
      oy: patch.nodeId === undefined ? row.oy : (patch.offset?.y ?? null),
    };
    this.tx(() => {
      // a thread moves with its replies
      this.db
        .prepare('update comments set body = ?, resolved = ?, updated_at = ? where id = ?')
        .run(next.body, next.resolved, now(), id);
      this.db
        .prepare('update comments set x = ?, y = ?, node_id = ?, ox = ?, oy = ? where id = ? or parent_id = ?')
        .run(next.x, next.y, next.node_id, next.ox, next.oy, id, id);
    });
    return toComment(this.db.prepare('select * from comments where id = ?').get(id) as CommentRow);
  }

  deleteComment(fileId: string, id: string): boolean {
    return Number(this.db.prepare('delete from comments where file_id = ? and id = ?').run(fileId, id).changes) > 0;
  }

  exportFile(id: string): ExportedFile | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    const nodes = this.getNodes(id);
    const used = new Set<string>();
    for (const n of nodes) {
      for (const p of n.fills) if (p.type === 'IMAGE') used.add(p.imageId);
      for (const o of Object.values(n.overrides ?? {})) for (const p of o.fills ?? []) if (p.type === 'IMAGE') used.add(p.imageId);
    }
    const images = [...used]
      .map((imageId) => {
        const img = this.getImage(id, imageId);
        return img
          ? { id: imageId, mime: img.mime as (typeof IMAGE_TYPES)[number], data: Buffer.from(img.data).toString('base64') }
          : null;
      })
      .filter((x) => x !== null);
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      name: meta.name,
      background: meta.background,
      pages: meta.pages,
      styles: meta.styles,
      variables: meta.variables,
      nodes,
      images,
    };
  }

  importFile(data: ExportedFile): FileMeta {
    const pages = data.pages ?? defaultPages(data.background);
    const problem = validateTree(data.nodes, pages);
    if (problem) throw new InvalidError(problem);
    // only keep images the layers actually use
    const used = new Set<string>();
    for (const n of data.nodes) {
      for (const p of n.fills) if (p.type === 'IMAGE') used.add(p.imageId);
      for (const o of Object.values(n.overrides ?? {})) for (const p of o.fills ?? []) if (p.type === 'IMAGE') used.add(p.imageId);
    }
    const images = (data.images ?? []).filter((img) => used.has(img.id)).map((img) => {
      const bytes = Buffer.from(img.data, 'base64');
      if (imageHash(bytes) !== img.id || sniffImage(bytes) !== img.mime) throw new InvalidError(`image ${img.id.slice(0, 8)} is damaged`);
      return bytes;
    });
    return this.tx(() => {
      const meta = this.createFile(data.name, pages, data.styles ?? [], data.variables ?? EMPTY_VARIABLES);
      const put = this.db.prepare('insert into nodes (file_id, id, data) values (?, ?, ?)');
      for (const n of data.nodes) put.run(meta.id, n.id, JSON.stringify(SceneNodeSchema.parse(n)));
      for (const bytes of images) this.putImage(meta.id, bytes);
      if (data.nodes.length > 0) this.db.prepare('update files set version = 1 where id = ?').run(meta.id);
      return this.getMeta(meta.id)!;
    });
  }
}
