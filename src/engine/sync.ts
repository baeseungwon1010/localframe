import { SceneNodeSchema } from '../../shared/schema.ts';
import { ApiError, BROWSER_STORAGE, api } from '../api.ts';
import type { CommitInfo, Editor } from './editor.ts';

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'conflict' | 'error';

const DEBOUNCE_MS = 300;
const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KB

/** Saves committed changes to storage (the local server, or this browser), in order, one batch at a time. */
export class SyncQueue {
  status: SaveStatus = 'saved';
  error: string | null = null;
  private dirty = new Set<string>();
  private pagesDirty = false;
  private stylesDirty = false;
  private variablesDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private retryMs = 1000;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private readonly fileId: string;
  private readonly editor: Editor;
  private version: number;
  private readonly onSaved: () => void;

  constructor(fileId: string, version: number, editor: Editor, onSaved: () => void) {
    this.fileId = fileId;
    this.version = version;
    this.editor = editor;
    this.onSaved = onSaved;
    this.unsubscribe = editor.onCommit((info) => this.add(info));
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(status: SaveStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    this.listeners.forEach((fn) => fn());
  }

  private get fileDirty() {
    return this.pagesDirty || this.stylesDirty || this.variablesDirty;
  }

  get pending() {
    return this.dirty.size > 0 || this.fileDirty || this.inflight;
  }

  private add({ patches, pagesChanged, stylesChanged, variablesChanged }: CommitInfo) {
    if (this.status === 'conflict') return;
    for (const p of patches) this.dirty.add(p.id);
    if (pagesChanged) this.pagesDirty = true;
    if (stylesChanged) this.stylesDirty = true;
    if (variablesChanged) this.variablesDirty = true;
    this.setStatus('saving');
    this.schedule(DEBOUNCE_MS);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private takeBatch() {
    const ids = [...this.dirty];
    const flags = { pages: this.pagesDirty, styles: this.stylesDirty, variables: this.variablesDirty };
    this.dirty.clear();
    this.pagesDirty = this.stylesDirty = this.variablesDirty = false;
    const upserts = ids.map((id) => this.editor.doc.get(id)).filter((n) => n !== undefined);
    const deletes = ids.filter((id) => !this.editor.doc.has(id));
    return {
      ids,
      pagesWereDirty: flags,
      changes: {
        baseVersion: this.version,
        upserts,
        deletes,
        ...(flags.pages ? { pages: this.editor.pages } : {}),
        ...(flags.styles ? { styles: this.editor.styles } : {}),
        ...(flags.variables ? { variables: this.editor.variables } : {}),
      },
    };
  }

  private restore(ids: string[], flags: { pages: boolean; styles: boolean; variables: boolean }) {
    for (const id of ids) this.dirty.add(id);
    if (flags.pages) this.pagesDirty = true;
    if (flags.styles) this.stylesDirty = true;
    if (flags.variables) this.variablesDirty = true;
  }

  async flush(): Promise<void> {
    if (this.inflight || this.status === 'conflict') return;
    if (this.dirty.size === 0 && !this.fileDirty) {
      if (this.status === 'saving') this.setStatus('saved');
      return;
    }
    this.inflight = true;
    const { ids, pagesWereDirty, changes } = this.takeBatch();
    const bad = changes.upserts.find((n) => !SceneNodeSchema.safeParse(n).success);
    if (bad) {
      // Don't send what the server will refuse; say which layer needs fixing.
      this.restore(ids, pagesWereDirty);
      this.inflight = false;
      this.setStatus('error', `Couldn't save: “${bad.name.slice(0, 60)}” has a value out of range. Undo the last change or fix that layer.`);
      return;
    }
    try {
      const res = await api.saveChanges(this.fileId, changes);
      this.version = res.version;
      this.retryMs = 1000;
      this.inflight = false;
      if (this.dirty.size > 0 || this.fileDirty) this.schedule(0);
      else {
        this.setStatus('saved');
        this.onSaved();
      }
    } catch (err) {
      this.inflight = false;
      if (err instanceof ApiError && err.status === 409) {
        this.setStatus('conflict', 'This file was changed in another tab. Reload to see the latest version.');
        return;
      }
      this.restore(ids, pagesWereDirty);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        this.setStatus('error', `Couldn't save: ${err.message}`);
        return;
      }
      this.setStatus(
        'offline',
        BROWSER_STORAGE
          ? "Couldn't save to this browser's storage. Changes are kept in this tab; export the file to keep a copy."
          : "Couldn't reach the local server. Changes are kept in this tab and saved when it's back.",
      );
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    }
  }

  /** Best effort save when the page is closing. */
  flushOnExit() {
    if ((this.dirty.size === 0 && !this.fileDirty) || this.inflight || this.status === 'conflict') return;
    const { changes } = this.takeBatch();
    if (JSON.stringify(changes).length < KEEPALIVE_LIMIT) void api.saveChanges(this.fileId, changes, true).catch(() => {});
  }

  dispose() {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }
}
