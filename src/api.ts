import type { Changes, Comment, ExportedFile, FileMeta, SceneNode, VersionMeta } from '../shared/schema.ts';
import { ApiError } from './apiError.ts';
import { BrowserStore } from './browserStore.ts';

export { ApiError };

/** The web build keeps files in the browser; the local app talks to its own server. */
export const BROWSER_STORAGE = import.meta.env.VITE_STORAGE === 'browser';


async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    ...init,
  });
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

const httpApi = {
  listFiles: () => request<FileMeta[]>('GET', '/api/files'),
  createFile: (name?: string) => request<FileMeta>('POST', '/api/files', name ? { name } : {}),
  getFile: (id: string) => request<{ file: FileMeta; nodes: SceneNode[] }>('GET', `/api/files/${encodeURIComponent(id)}`),
  updateFile: (id: string, patch: { name?: string }) =>
    request<FileMeta>('PATCH', `/api/files/${encodeURIComponent(id)}`, patch),
  deleteFile: (id: string) => request<void>('DELETE', `/api/files/${encodeURIComponent(id)}`),
  saveChanges: (id: string, changes: Changes, keepalive = false) =>
    request<{ version: number }>('POST', `/api/files/${encodeURIComponent(id)}/changes`, changes, { keepalive }),
  putThumbnail: (id: string, dataUrl: string) =>
    request<void>('PUT', `/api/files/${encodeURIComponent(id)}/thumbnail`, { dataUrl }),
  exportFile: (id: string) => request<ExportedFile>('GET', `/api/files/${encodeURIComponent(id)}/export`),
  importFile: (data: unknown) => request<FileMeta>('POST', '/api/files/import', data),
  listVersions: (id: string) => request<VersionMeta[]>('GET', `/api/files/${encodeURIComponent(id)}/versions`),
  saveVersion: (id: string, name: string) => request<VersionMeta>('POST', `/api/files/${encodeURIComponent(id)}/versions`, { name }),
  renameVersion: (id: string, vid: number, name: string) =>
    request<void>('PATCH', `/api/files/${encodeURIComponent(id)}/versions/${vid}`, { name }),
  deleteVersion: (id: string, vid: number) => request<void>('DELETE', `/api/files/${encodeURIComponent(id)}/versions/${vid}`),
  restoreVersion: (id: string, vid: number) => request<FileMeta>('POST', `/api/files/${encodeURIComponent(id)}/versions/${vid}/restore`),
  listComments: (id: string) => request<Comment[]>('GET', `/api/files/${encodeURIComponent(id)}/comments`),
  addComment: (
    id: string,
    c: { parentId?: string; pageId: string; nodeId?: string; offset?: { x: number; y: number }; x: number; y: number; body: string },
  ) =>
    request<Comment>('POST', `/api/files/${encodeURIComponent(id)}/comments`, c),
  updateComment: (
    id: string,
    cid: string,
    patch: { body?: string; resolved?: boolean; x?: number; y?: number; nodeId?: string | null; offset?: { x: number; y: number } | null },
  ) =>
    request<Comment>('PATCH', `/api/files/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}`, patch),
  deleteComment: (id: string, cid: string) => request<void>('DELETE', `/api/files/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}`),
  copyImages: (id: string, from: string, ids: string[]) =>
    request<{ copied: number }>('POST', `/api/files/${encodeURIComponent(id)}/images/copy`, { from, ids }),
  uploadImage: async (id: string, file: Blob): Promise<{ id: string; mime: string }> => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}/images`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText, data);
    return data as { id: string; mime: string };
  },
  thumbnailUrl: (id: string, updatedAt: string) =>
    `/api/files/${encodeURIComponent(id)}/thumbnail?v=${encodeURIComponent(updatedAt)}`,
  imageUrl: async (file: string, id: string): Promise<string | null> => `/api/files/${encodeURIComponent(file)}/images/${id}`,
};

export type Api = typeof httpApi;

function browserApi(): Api {
  const store = new BrowserStore();
  return {
    listFiles: () => store.listFiles(),
    createFile: (name) => store.createFile(name),
    getFile: (id) => store.getFile(id),
    updateFile: (id, patch) => store.updateFile(id, patch),
    deleteFile: (id) => store.deleteFile(id),
    saveChanges: (id, changes) => store.saveChanges(id, changes),
    putThumbnail: (id, dataUrl) => store.putThumbnail(id, dataUrl),
    exportFile: (id) => store.exportFile(id),
    importFile: (data) => store.importFile(data),
    listVersions: (id) => store.listVersions(id),
    saveVersion: (id, name) => store.saveVersion(id, name),
    renameVersion: (id, vid, name) => store.renameVersion(id, vid, name),
    deleteVersion: (id, vid) => store.deleteVersion(id, vid),
    restoreVersion: (id, vid) => store.restoreVersion(id, vid),
    listComments: (id) => store.listComments(id),
    addComment: (id, c) => store.addComment(id, c),
    updateComment: (id, cid, patch) => store.updateComment(id, cid, patch),
    deleteComment: (id, cid) => store.deleteComment(id, cid),
    copyImages: (id, from, ids) => store.copyImages(id, from, ids),
    uploadImage: (id, file) => store.uploadImage(id, file),
    thumbnailUrl: (id) => store.thumbnailUrl(id),
    imageUrl: (file, id) => store.imageUrl(file, id),
  };
}

/** What to tell the user when storage can't be reached. */
export const STORAGE_DOWN = BROWSER_STORAGE
  ? "Couldn't open this browser's storage. It may be turned off (private window or blocked site data)."
  : "Couldn't reach the local server. Start it with npm run dev (or npm start) and reload.";

export const api: Api = BROWSER_STORAGE ? browserApi() : httpApi;
