import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ZodType } from 'zod';
import {
  ChangesSchema,
  CreateFileSchema,
  ExportedFileSchema,
  IMAGE_TYPES,
  ImageIdSchema,
  MAX_IMAGE_BYTES,
  MAX_IMPORT_BYTES,
  ThumbnailSchema,
  UpdateFileSchema,
} from '../shared/schema.ts';
import { ConflictError, InvalidError, type Store } from './db.ts';

export type AppOptions = {
  store: Store;
  /** Ports whose localhost origins may call the API (the server's own port, plus Vite's in dev). */
  allowedPorts: number[];
  /** Built client to serve, or null in dev (Vite serves it). */
  staticDir: string | null;
  maxBodyBytes?: number;
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': API_CSP,
    'Cache-Control': 'no-store',
    ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(json);
}

async function readJson<T>(req: IncomingMessage, schema: ZodType<T>, limit: number): Promise<T> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, `Invalid request: ${first.path.join('.') || 'body'} ${first.message}`);
  }
  return result.data;
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'File is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'File is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createApp(opts: AppOptions) {
  const { store, staticDir } = opts;
  const limit = opts.maxBodyBytes ?? 25 * 1024 * 1024;
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const port of opts.allowedPorts) {
    for (const host of ['localhost', '127.0.0.1']) {
      allowedHosts.add(`${host}:${port}`);
      allowedOrigins.add(`http://${host}:${port}`);
    }
  }
  const staticRoot = staticDir ? resolve(staticDir) : null;

  function checkRequest(req: IncomingMessage) {
    // DNS rebinding guard: only answer requests addressed to a loopback name.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) throw new HttpError(421, 'Unknown host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF guard: other websites in the same browser must not be able to change local files.
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, 'Cross-origin request refused');
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string[]) {
    const method = req.method ?? 'GET';
    // /api/files ...
    if (path[0] !== 'files') throw new HttpError(404, 'Not found');

    if (path.length === 1) {
      if (method === 'GET') return send(res, 200, store.listFiles());
      if (method === 'POST') {
        const body = await readJson(req, CreateFileSchema, limit);
        return send(res, 201, store.createFile(body.name ?? 'Untitled'));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path.length === 2 && path[1] === 'import') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req, ExportedFileSchema, Math.max(limit, MAX_IMPORT_BYTES));
      return send(res, 201, store.importFile(body));
    }

    const id = path[1];
    if (!ID.test(id)) throw new HttpError(404, 'File not found');

    if (path.length === 2) {
      if (method === 'GET') {
        const meta = store.getMeta(id);
        if (!meta) throw new HttpError(404, 'File not found');
        return send(res, 200, { file: meta, nodes: store.getNodes(id) });
      }
      if (method === 'PATCH') {
        const body = await readJson(req, UpdateFileSchema, limit);
        const meta = store.updateFile(id, body);
        if (!meta) throw new HttpError(404, 'File not found');
        return send(res, 200, meta);
      }
      if (method === 'DELETE') {
        if (!store.deleteFile(id)) throw new HttpError(404, 'File not found');
        return send(res, 204, undefined);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path.length === 3 && path[2] === 'changes') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req, ChangesSchema, limit);
      if (!store.getMeta(id)) throw new HttpError(404, 'File not found');
      try {
        const version = store.applyChanges(id, body.baseVersion, body.upserts, body.deletes, body.pages);
        return send(res, 200, { version });
      } catch (err) {
        if (err instanceof ConflictError) return send(res, 409, { error: 'conflict', version: err.version });
        throw err;
      }
    }

    if (path.length === 3 && path[2] === 'images') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new HttpError(415, 'Images must be PNG, JPEG, WebP or GIF');
      if (!store.getMeta(id)) throw new HttpError(404, 'File not found');
      const bytes = await readBytes(req, MAX_IMAGE_BYTES);
      const saved = store.putImage(id, bytes);
      if (!saved) throw new HttpError(415, 'That file is not a PNG, JPEG, WebP or GIF image');
      return send(res, 201, saved);
    }

    if (path.length === 4 && path[2] === 'images') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      if (!ImageIdSchema.safeParse(path[3]).success) throw new HttpError(404, 'Image not found');
      const img = store.getImage(id, path[3]);
      if (!img) throw new HttpError(404, 'Image not found');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Security-Policy': API_CSP,
        'Content-Type': img.mime,
        // content-addressed: the bytes for this URL never change
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      return res.end(Buffer.from(img.data));
    }

    if (path.length === 3 && path[2] === 'thumbnail') {
      if (method === 'GET') {
        const png = store.getThumbnail(id);
        if (!png) throw new HttpError(404, 'No thumbnail');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Security-Policy': API_CSP,
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        });
        return res.end(Buffer.from(png));
      }
      if (method === 'PUT') {
        const body = await readJson(req, ThumbnailSchema, limit);
        const png = Buffer.from(body.dataUrl.slice('data:image/png;base64,'.length), 'base64');
        if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new HttpError(400, 'Not a PNG');
        if (!store.setThumbnail(id, png)) throw new HttpError(404, 'File not found');
        return send(res, 204, undefined);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path.length === 3 && path[2] === 'export') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const data = store.exportFile(id);
      if (!data) throw new HttpError(404, 'File not found');
      const ascii = data.name.replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 80) || 'file';
      const utf8 = encodeURIComponent(`${data.name.slice(0, 80)}.localframe.json`);
      return send(res, 200, data, {
        'Content-Disposition': `attachment; filename="${ascii}.localframe.json"; filename*=UTF-8''${utf8}`,
      });
    }

    throw new HttpError(404, 'Not found');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!staticRoot) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad path');
    let file = normalize(join(staticRoot, rel));
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) throw new HttpError(404, 'Not found');
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      if (extname(rel)) throw new HttpError(404, 'Not found');
      file = join(staticRoot, 'index.html'); // client-side routes
      info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(404, 'Not found');
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    // pipeline handles a file that vanishes mid-read (e.g. a rebuild) without crashing the server
    pipeline(createReadStream(file), res, (err) => {
      if (err) res.destroy();
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      checkRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const parts = url.pathname.split('/').filter(Boolean).slice(1);
        await api(req, res, parts);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof InvalidError) return send(res, 400, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  };
}
