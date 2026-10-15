import type { FileMeta } from '../../shared/schema.ts';
import { ApiError, api } from '../api.ts';
import { buildZip, readZip, uniqueName } from '../engine/zip.ts';
import { safeFileName } from './download.ts';

/**
 * Backups: every file in one ZIP (each one the same .localframe.json an export makes, images
 * included), restored by importing each file again. In the web version files live only in this
 * browser, so a backup is the copy that survives clearing site data or changing devices.
 */

const MANIFEST = 'localframe-backup.json';
const LAST_KEY = 'localframe.lastBackup';
const SNOOZE_KEY = 'localframe.backupSnoozedUntil';
const DAY = 24 * 60 * 60 * 1000;

/** The backup as a ZIP. Call `markBackedUp(createdAt)` once it is safely saved somewhere. */
export async function makeBackup(): Promise<{ blob: Blob; filename: string; count: number; createdAt: string }> {
  const files = await api.listFiles();
  const used = new Set<string>([MANIFEST]);
  const enc = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];
  const listed: { name: string; entry: string; updatedAt: string }[] = [];
  for (const f of files) {
    const data = await api.exportFile(f.id);
    const entry = uniqueName(`${safeFileName(f.name, 'Untitled')}.localframe.json`, used);
    entries.push({ name: entry, data: enc.encode(JSON.stringify(data)) });
    listed.push({ name: f.name, entry, updatedAt: f.updatedAt });
  }
  const createdAt = new Date().toISOString();
  entries.unshift({ name: MANIFEST, data: enc.encode(JSON.stringify({ format: 'localframe-backup', version: 1, createdAt, files: listed }, null, 2)) });
  return { blob: buildZip(entries), filename: `localframe-backup-${createdAt.slice(0, 10)}.zip`, count: files.length, createdAt };
}

/** Imports every file in a backup (as new files next to the ones here). */
/** Larger files than this aren't read (it all has to fit in memory, on phones too). */
export const MAX_BACKUP_BYTES = 600 * 1024 * 1024;

export async function restoreBackup(file: Blob): Promise<{ restored: string[]; failed: string[] }> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('That backup is larger than 600 MB, which is the limit.');
  const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
  const dec = new TextDecoder();
  const restored: string[] = [];
  const failed: string[] = [];
  for (const e of entries) {
    if (e.name === MANIFEST || !e.name.endsWith('.json')) continue;
    try {
      const meta = await api.importFile(JSON.parse(dec.decode(e.data)));
      restored.push(meta.name);
    } catch (err) {
      failed.push(`${e.name}${err instanceof ApiError ? ` (${err.message})` : ''}`);
    }
  }
  if (!restored.length && !failed.length) throw new Error("That ZIP file isn't a localframe backup.");
  return { restored, failed };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

export const lastBackup = (): Date | null => {
  const v = read(LAST_KEY);
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;
};

export function markBackedUp(iso: string) {
  write(LAST_KEY, iso);
}

export const snoozeBackupReminder = (days = 3) => write(SNOOZE_KEY, new Date(Date.now() + days * DAY).toISOString());

/**
 * Whether to remind about backing up: there are changes since the last backup, and either there
 * never was one (and the work is over a day old) or it is a week old. "Later" quiets it for days.
 */
export function backupDue(files: FileMeta[], now = Date.now()): boolean {
  if (!files.length) return false;
  const snooze = read(SNOOZE_KEY);
  if (snooze && Date.parse(snooze) > now) return false;
  const newest = Math.max(...files.map((f) => Date.parse(f.updatedAt)));
  const oldest = Math.min(...files.map((f) => Date.parse(f.createdAt)));
  const last = lastBackup()?.getTime();
  if (last === undefined) return now - oldest > DAY;
  return newest > last && now - last > 7 * DAY;
}

// ------------------------------------------------------- automatic backups to a folder

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/** Chrome and Edge on a computer can write into a folder you pick. */
export const canBackUpToFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const DB = 'localframe-settings';

/** The chosen folder is kept in this browser (a handle can't go in localStorage). */
function settings<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(r.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function backupFolder(): Promise<DirHandle | null> {
  if (!canBackUpToFolder()) return null;
  try {
    return ((await settings('readonly', (s) => s.get('backupFolder'))) as DirHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function chooseBackupFolder(): Promise<DirHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const dir = await pick({ id: 'localframe-backup', mode: 'readwrite' });
  await settings('readwrite', (s) => s.put(dir, 'backupFolder'));
  return dir;
}

export async function forgetBackupFolder() {
  await settings('readwrite', (s) => s.delete('backupFolder'));
}

/** Can we write there without asking? (Browsers ask again after a restart.) */
export async function folderReady(dir: DirHandle): Promise<boolean> {
  return (await dir.queryPermission?.({ mode: 'readwrite' })) === 'granted';
}

/**
 * Writes a backup into the folder: the newest as localframe-backup.zip, the one before it kept as
 * localframe-backup-previous.zip. Asks for permission first when `ask` (needs a click).
 */
export async function backUpToFolder(dir: DirHandle, ask: boolean): Promise<number | null> {
  if (!(await folderReady(dir))) {
    if (!ask || (await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') return null;
  }
  const { blob, count, createdAt } = await makeBackup();
  try {
    const old = await dir.getFileHandle('localframe-backup.zip');
    const prev = await dir.getFileHandle('localframe-backup-previous.zip', { create: true });
    const w = await prev.createWritable();
    await w.write(await old.getFile());
    await w.close();
  } catch {
    /* no earlier backup to keep */
  }
  const fh = await dir.getFileHandle('localframe-backup.zip', { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  // only now is it safe: a folder that was moved or full leaves the backup due
  markBackedUp(createdAt);
  return count;
}
