/** Loads and caches the images of the open file for the canvas, exports and thumbnails. */

type Entry = {
  img: HTMLImageElement | null;
  ready: boolean;
  failed: boolean;
  promise: Promise<void>;
};

let fileId: string | null = null;
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

export const imageUrl = (file: string, id: string) => `/api/files/${encodeURIComponent(file)}/images/${id}`;

/** Images are per file; the editor and exporters say which file they draw. Returns the previous one. */
export function useImagesOf(file: string | null): string | null {
  const prev = fileId;
  fileId = file;
  return prev;
}

/** Forgets images that failed to load, so they are fetched again (after they were copied in). */
export function retryFailedImages() {
  for (const [k, e] of cache) if (e.failed) cache.delete(k);
}

export function onImageLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load(id: string): Entry | null {
  if (!fileId || typeof Image === 'undefined') return null;
  const key = `${fileId}/${id}`;
  let e = cache.get(key);
  if (e) return e;
  const img = new Image();
  img.decoding = 'async';
  const entry: Entry = { img, ready: false, failed: false, promise: Promise.resolve() };
  entry.promise = new Promise<void>((resolve) => {
    img.onload = () => {
      entry.ready = true;
      listeners.forEach((fn) => fn());
      resolve();
    };
    img.onerror = () => {
      entry.failed = true;
      resolve();
    };
  });
  img.src = imageUrl(fileId, id);
  cache.set(key, entry);
  e = entry;
  return e;
}

/** The decoded image, or null while it loads (the canvas redraws when it arrives). */
export function getImage(id: string): HTMLImageElement | null {
  const e = load(id);
  return e && e.ready ? e.img : null;
}

export function imageSize(id: string): { width: number; height: number } | null {
  const img = getImage(id);
  return img ? { width: img.naturalWidth, height: img.naturalHeight } : null;
}

/** Waits until the given images are decoded (or failed), for exports. */
export async function ensureImages(ids: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(ids)].map((id) => load(id)?.promise ?? Promise.resolve()));
}

/** Image bytes as a data URL, for embedding in SVG. */
export async function imageDataUrl(id: string): Promise<string | null> {
  if (!fileId) return null;
  const res = await fetch(imageUrl(fileId, id));
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/** Reads a picked or dropped file's natural size. */
export function readImageSize(file: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    img.src = url;
  });
}
