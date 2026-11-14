// A small, dependency-free HTTP router with JSON handling, error handling and static file serving.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.extra = extra;
  }
}
export const bad = (msg, code = 'bad_request', extra) => new HttpError(400, msg, code, extra);
export const unauthorized = (msg = 'You need to be logged in.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, 'not_found');

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  /** `pathname` is the path exactly as it was sent (still %-encoded): each part of it is decoded here, once, after the path has been split. */
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return { badPath: true }; }   // a stray "%" that is not part of an escape
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// ---- compression ------------------------------------------------------------
// The app's files are text and shrink to roughly a quarter of their size, which is the difference between a slow and
// a quick first load on a phone. Static files are compressed once (brotli or gzip, whatever the browser accepts) and kept
// in memory; big API answers are gzipped on the fly. Uploads, downloads and Range requests are left alone.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/;
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);

/** 'br', 'gzip' or null, from the request's Accept-Encoding (honouring q=0). */
export function preferredEncoding(req, { brotli: allowBr = true } = {}) {
  const header = String(req?.headers?.['accept-encoding'] || '');
  if (!header) return null;
  const ok = new Set();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
    if (!q || Number(q[1]) > 0) ok.add(name.trim());
  }
  if (allowBr && ok.has('br')) return 'br';
  return ok.has('gzip') ? 'gzip' : null;
}

const zcache = new Map(); // key|encoding -> Promise<Buffer>
let zbytes = 0;
const ZCACHE_MAX = 24 * 1024 * 1024;
/** Compress a buffer (cached by `key`, which must change whenever the content does). */
export function compressCached(key, buf, encoding) {
  const k = `${key}|${encoding}`;
  let hit = zcache.get(k);
  if (hit) return hit;
  hit = (encoding === 'br'
    ? brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzip(buf, { level: 9 })
  ).then((out) => {
    zbytes += out.length;
    if (zbytes > ZCACHE_MAX) { zcache.clear(); zbytes = out.length; zcache.set(k, Promise.resolve(out)); }
    return out;
  });
  zcache.set(k, hit);
  hit.catch(() => zcache.delete(k));
  return hit;
}

/** Compress every text file under `dir` in the background, so the first visitor after a start is not the one waiting. */
export function warmCompression(dir) {
  (async () => {
    const walk = async (d, depth = 0) => {
      for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) await walk(f, depth + 1);
        else if (e.isFile() && COMPRESSIBLE.test(mimeFor(f))) {
          const st = await fs.promises.stat(f);
          if (st.size < 1024 || st.size > 4 * 1024 * 1024) continue;
          const buf = await fs.promises.readFile(f), key = `${f}|${st.mtimeMs}|${st.size}`;
          await compressCached(key, buf, 'br'); await compressCached(key, buf, 'gzip');
        }
      }
    };
    await walk(dir);
  })().catch(() => {});
}

/** Compress a small in-memory body (like the HTML page) when the browser accepts it. */
export async function encodeBody(req, contentType, buf, key) {
  const encoding = buf.length >= 1024 && COMPRESSIBLE.test(contentType) ? preferredEncoding(req) : null;
  if (!encoding) return { body: buf, encoding: null };
  try { return { body: await compressCached(key, buf, encoding), encoding }; } catch { return { body: buf, encoding: null }; }
}

export function sendJson(res, status, data) {
  let body = data === undefined ? '' : JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  // Message lists and similar answers compress well; tiny ones are not worth the work, and very large ones would
  // hold up the server while they compress.
  if (body.length >= 1400 && body.length <= 512 * 1024) {
    const encoding = preferredEncoding(res.req, { brotli: false });
    if (encoding) { body = zlib.gzipSync(body, { level: 5 }); headers['Content-Encoding'] = encoding; headers.Vary = 'Accept-Encoding'; }
  }
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

export function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large.', 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

export function formatError(err) {
  if (err instanceof ZodError) {
    const errors = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!errors[key]) errors[key] = issue.message;
    }
    const first = err.issues[0];
    return { status: 400, body: { message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.', code: 'validation', errors } };
  }
  if (err instanceof HttpError) return { status: err.status, body: { message: err.message, code: err.code, ...(err.extra || {}) } };
  console.error('[http] unexpected error:', err);
  return { status: 500, body: { message: 'Something went wrong on our end.', code: 'internal' } };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};
export function mimeFor(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

/**
 * Pipe a file to the response. The file can be deleted between the stat() and the open() (a user swapping their
 * avatar or decoration while someone is loading it), and an unhandled stream 'error' would take the whole server down.
 */
function streamFile(res, filePath, range) {
  const stream = fs.createReadStream(filePath, range);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * What part of a file a Range header asks for: {start, end} (both inclusive), 'none' when it is unsatisfiable (416), or null when the header
 * should simply be ignored and the whole file sent (more than one range, or something that isn't a byte range: the standard allows both).
 */
export function parseRange(header, size) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header || ''));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {                                   // the last N bytes
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'none' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[2] !== '' && end < start) return null;           // "bytes=9-3" is not a range at all
  if (start >= size) return 'none';
  return { start, end: Math.min(end, size - 1) };        // an end past the last byte means "to the end"
}

/** Serve a file with Range support. Returns false if the file does not exist. `opts.compress` turns on compression (for the app's own files). */
export function serveFile(req, res, filePath, extraHeaders = {}, opts = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  // The validators let a browser know whether the file is still the one it started: a resumed download (Range + If-Range) of a file that has
  // been replaced since must start over, never join the old first half to the new second half (that is a broken installer).
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  const headers = { 'Content-Type': mimeFor(filePath), 'Accept-Ranges': 'bytes', 'Last-Modified': lastModified, ETag: etag, ...extraHeaders };
  if (opts.compress) headers.Vary = 'Accept-Encoding';
  const inm = req.headers['if-none-match'];
  const unchanged = inm
    ? inm.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag)
    : !!req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(lastModified);
  if (unchanged) { res.writeHead(304, headers); res.end(); return true; }
  const ifRange = (req.headers['if-range'] || '').trim();
  const sameFile = !ifRange || ifRange === etag || ifRange === lastModified;
  const range = req.headers.range && sameFile ? parseRange(req.headers.range, stat.size) : null;
  if (range === 'none') { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true; }
  if (range) {
    const { start, end } = range;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return true; }
    streamFile(res, filePath, { start, end });
    return true;
  }
  const encoding = opts.compress && stat.size >= 1024 && stat.size <= 4 * 1024 * 1024 && COMPRESSIBLE.test(headers['Content-Type']) ? preferredEncoding(req) : null;
  if (encoding) {
    fs.promises.readFile(filePath).then((buf) => compressCached(`${filePath}|${stat.mtimeMs}|${stat.size}`, buf, encoding)).then((out) => {
      const { 'Accept-Ranges': _ranges, ...h } = headers;
      res.writeHead(200, { ...h, 'Content-Encoding': encoding, 'Content-Length': out.length });
      res.end(req.method === 'HEAD' ? undefined : out);
    }).catch(() => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      if (req.method === 'HEAD') res.end(); else streamFile(res, filePath);
    });
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') { res.end(); return true; }
  streamFile(res, filePath);
  return true;
}

// ---- simple in-memory rate limiter -------------------------------------------
const buckets = new Map();
/** Returns 0 if allowed, otherwise ms until the next slot. */
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) return b.reset - now;
  return 0;
}
export function enforceRateLimit(key, max, windowMs, message = 'You are doing that too fast. Slow down a little.') {
  const wait = rateLimit(key, max, windowMs);
  if (wait) throw new HttpError(429, message, 'rate_limited', { retryAfter: Math.ceil(wait / 1000) });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();
