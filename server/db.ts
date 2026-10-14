import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  type ExportedFile,
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
];

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
