import type { Changes, ExportedFile, FileMeta, SceneNode } from '../shared/schema.ts';

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
