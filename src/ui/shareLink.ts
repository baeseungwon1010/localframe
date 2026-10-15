import type { ExportedFile } from '../../shared/schema.ts';

/**
 * Links that carry a whole file: compressed JSON after the "#", which browsers never send to a
 * server, so the file goes only where the link goes. Images are left out to keep links short.
 */

export const SHARE_ROUTE = '#/shared/';
const VERSION = 'v1.';
/** Longest link made (most browsers take a few MB; messaging apps often cut far shorter ones). */
export const MAX_LINK_CHARS = 2_000_000;
/** Links longer than this may be cut by chat apps: the person is told. */
export const LONG_LINK_CHARS = 8000;
/** A shared file opens to at most this much JSON. */
const MAX_JSON_BYTES = 40 * 1024 * 1024;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('The shared file is too large to open.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The link for a file (without its images). */
export async function makeShareLink(file: ExportedFile): Promise<{ url: string; droppedImages: boolean }> {
  const { images, ...rest } = file;
  const json = new TextEncoder().encode(JSON.stringify(rest));
  const packed = await pipe(json, new CompressionStream('deflate-raw'), Infinity);
  const url = `${location.origin}${import.meta.env.BASE_URL}${SHARE_ROUTE}${VERSION}${toBase64Url(packed)}`;
  if (url.length > MAX_LINK_CHARS) throw new Error('This file is too big to share as a link. Export it instead.');
  return { url, droppedImages: !!images?.length };
}

/** The file a link carries, as untrusted data (check it like an import). */
export async function readSharedFile(payload: string): Promise<unknown> {
  if (!payload.startsWith(VERSION) || payload.length > MAX_LINK_CHARS || !/^[A-Za-z0-9_-]+$/.test(payload.slice(VERSION.length)))
    throw new Error("This link isn't a localframe file link, or it was cut short.");
  let bytes: Uint8Array;
  try {
    bytes = await pipe(fromBase64Url(payload.slice(VERSION.length)), new DecompressionStream('deflate-raw'), MAX_JSON_BYTES);
  } catch (e) {
    if (e instanceof Error && /too large/.test(e.message)) throw e;
    throw new Error('This link is damaged or was cut short. Ask for it again.');
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('This link is damaged or was cut short. Ask for it again.');
  }
}
