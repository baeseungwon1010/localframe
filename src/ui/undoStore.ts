/**
 * Undo history kept across visits, per file, in this browser (IndexedDB). It is only a convenience:
 * if it can't be read or no longer fits the file, the editor starts with an empty history.
 */

const DB = 'localframe-history';

function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no storage'));
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const r = fn(tx.objectStore('files'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(r.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export const loadHistory = (fileId: string): Promise<unknown> => store('readonly', (s) => s.get(fileId)).catch(() => null);

export const saveHistory = (fileId: string, history: unknown): Promise<void> =>
  store('readwrite', (s) => s.put(history, fileId)).then(
    () => undefined,
    () => undefined,
  );

export const forgetHistory = (fileId: string): Promise<void> =>
  store('readwrite', (s) => s.delete(fileId)).then(
    () => undefined,
    () => undefined,
  );
