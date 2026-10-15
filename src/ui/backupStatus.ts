import type { FileMeta } from '../../shared/schema.ts';

/**
 * What the file list needs to know about backups without loading the backup code: when the last
 * one was, whether one is due, and the folder chosen for automatic backups. The work itself is
 * in backup.ts, loaded when used.
 */

const LAST_KEY = 'localframe.lastBackup';
const SNOOZE_KEY = 'localframe.backupSnoozedUntil';
const DAY = 24 * 60 * 60 * 1000;

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

export type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/** Chrome and Edge on a computer can write into a folder you pick. */
export const canBackUpToFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const DB = 'localframe-settings';

/** The chosen folder is kept in this browser (a handle can't go in localStorage). */
export function settings<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export async function forgetBackupFolder() {
  await settings('readwrite', (s) => s.delete('backupFolder'));
}

