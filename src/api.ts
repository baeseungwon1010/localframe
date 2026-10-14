import type { Changes, Comment, ExportedFile, FileMeta, SceneNode, VersionMeta } from '../shared/schema.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

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

export const api = {
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
};
