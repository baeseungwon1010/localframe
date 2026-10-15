import { ApiError, api } from '../api.ts';
import { buildZip, readZip, uniqueName } from '../engine/zip.ts';
import { safeFileName } from './download.ts';
import { type DirHandle, markBackedUp, settings } from './backupStatus.ts';

/**
 * Backups: every file in one ZIP (each one the same .localframe.json an export makes, images
 * included), restored by importing each file again. In the web version files live only in this
 * browser, so a backup is the copy that survives clearing site data or changing devices.
 */

const MANIFEST = 'localframe-backup.json';

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

export async function chooseBackupFolder(): Promise<DirHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const dir = await pick({ id: 'localframe-backup', mode: 'readwrite' });
  await settings('readwrite', (s) => s.put(dir, 'backupFolder'));
  return dir;
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
