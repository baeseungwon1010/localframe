import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type FileMeta,
  type SceneNode,
  type ExportedFile,
  SceneNodeSchema,
  validateTree,
  EXPORT_FORMAT,
  EXPORT_VERSION,
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
  version: number;
  created_at: string;
  updated_at: string;
  has_thumbnail: number;
};

function toMeta(r: FileRow): FileMeta {
  return {
    id: r.id,
    name: r.name,
    background: r.background,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasThumbnail: r.has_thumbnail === 1,
  };
}

const now = () => new Date().toISOString();
const META_COLS = 'id, name, background, version, created_at, updated_at, (thumbnail is not null) as has_thumbnail';

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

  createFile(name: string, background = '#F3F3F1'): FileMeta {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare('insert into files (id, name, background, version, created_at, updated_at) values (?, ?, ?, 0, ?, ?)')
      .run(id, name, background, t, t);
    return this.getMeta(id)!;
  }

  updateFile(id: string, patch: { name?: string; background?: string }): FileMeta | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    this.db
      .prepare('update files set name = ?, background = ?, updated_at = ? where id = ?')
      .run(patch.name ?? meta.name, patch.background ?? meta.background, now(), id);
    return this.getMeta(id);
  }

  deleteFile(id: string): boolean {
    return Number(this.db.prepare('delete from files where id = ?').run(id).changes) > 0;
  }

  getNodes(fileId: string): SceneNode[] {
    const rows = this.db.prepare('select data from nodes where file_id = ?').all(fileId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as SceneNode);
  }

  applyChanges(fileId: string, baseVersion: number, upserts: SceneNode[], deletes: string[]): number {
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
      const problem = validateTree(this.getNodes(fileId));
      if (problem) throw new InvalidError(problem);
      const version = meta.version + 1;
      this.db.prepare('update files set version = ?, updated_at = ? where id = ?').run(version, now(), fileId);
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

  exportFile(id: string): ExportedFile | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      name: meta.name,
      background: meta.background,
      nodes: this.getNodes(id),
    };
  }

  importFile(data: ExportedFile): FileMeta {
    const problem = validateTree(data.nodes);
    if (problem) throw new InvalidError(problem);
    return this.tx(() => {
      const meta = this.createFile(data.name, data.background);
      const put = this.db.prepare('insert into nodes (file_id, id, data) values (?, ?, ?)');
      for (const n of data.nodes) put.run(meta.id, n.id, JSON.stringify(SceneNodeSchema.parse(n)));
      if (data.nodes.length > 0) this.db.prepare('update files set version = 1 where id = ?').run(meta.id);
      return this.getMeta(meta.id)!;
    });
  }
}
