import { ApiError, api } from '../api.ts';
import type { Patch } from './doc.ts';
import type { Editor } from './editor.ts';

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'conflict' | 'error';

const DEBOUNCE_MS = 300;
const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KB

/** Saves committed changes to the local server, in order, one batch at a time. */
export class SyncQueue {
  status: SaveStatus = 'saved';
  error: string | null = null;
  private dirty = new Set<string>();
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
    this.unsubscribe = editor.onCommit((patches) => this.add(patches));
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

  get pending() {
    return this.dirty.size > 0 || this.inflight;
  }

  private add(patches: Patch[]) {
    if (this.status === 'conflict') return;
    for (const p of patches) this.dirty.add(p.id);
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
    this.dirty.clear();
    const upserts = ids.map((id) => this.editor.doc.get(id)).filter((n) => n !== undefined);
    const deletes = ids.filter((id) => !this.editor.doc.has(id));
    return { ids, changes: { baseVersion: this.version, upserts, deletes } };
  }

  async flush(): Promise<void> {
    if (this.inflight || this.status === 'conflict') return;
    if (this.dirty.size === 0) {
      if (this.status === 'saving') this.setStatus('saved');
      return;
    }
    this.inflight = true;
    const { ids, changes } = this.takeBatch();
    try {
      const res = await api.saveChanges(this.fileId, changes);
      this.version = res.version;
      this.retryMs = 1000;
      this.inflight = false;
      if (this.dirty.size > 0) this.schedule(0);
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
      for (const id of ids) this.dirty.add(id);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        this.setStatus('error', `Couldn't save: ${err.message}`);
        return;
      }
      this.setStatus('offline', "Couldn't reach the local server. Changes are kept in this tab and saved when it's back.");
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    }
  }

  /** Best effort save when the page is closing. */
  flushOnExit() {
    if (this.dirty.size === 0 || this.inflight || this.status === 'conflict') return;
    const { changes } = this.takeBatch();
    if (JSON.stringify(changes).length < KEEPALIVE_LIMIT) void api.saveChanges(this.fileId, changes, true).catch(() => {});
  }

  dispose() {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }
}
