// Raw-body file uploads (the client PUTs/POSTs the file bytes directly — no multipart parsing needed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPLOAD_DIR } from '../config.js';
import { HttpError, bad } from './http.js';

const IMAGE_SIGNATURES = [
  { type: 'image/png', ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: '.gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { type: 'image/webp', ext: '.webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

export function sniffImage(buf) {
  return IMAGE_SIGNATURES.find((s) => s.test(buf)) || null;
}

/** Stream the request body into `dir` with a random name. Returns { storedName, size, filePath, head }. */
export function receiveUpload(req, subdir, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) { reject(new HttpError(413, `That file is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'too_large')); req.resume(); return; }
    const storedName = crypto.randomBytes(16).toString('hex');
    const filePath = path.join(UPLOAD_DIR, subdir, storedName);
    const out = fs.createWriteStream(filePath);
    let size = 0;
    let head = Buffer.alloc(0);
    let failed = false;
    const fail = (err) => {
      if (failed) return; failed = true;
      out.destroy(); fs.rm(filePath, { force: true }, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk.slice(0, 16 - head.length)]);
      if (size > maxBytes) { fail(new HttpError(413, `That file is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'too_large')); req.destroy(); return; }
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (size === 0) { fs.rm(filePath, { force: true }, () => {}); reject(bad('The file is empty.')); return; }
        resolve({ storedName, size, filePath, head });
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

/** Receive an image upload, verify it really is an image, and rename it with the proper extension. */
export async function receiveImage(req, subdir, maxBytes = 8 * 1024 * 1024) {
  const up = await receiveUpload(req, subdir, maxBytes);
  const sig = sniffImage(up.head);
  if (!sig) { fs.rmSync(up.filePath, { force: true }); throw bad('Please upload a PNG, JPEG, GIF or WebP image.'); }
  const finalName = up.storedName + sig.ext;
  fs.renameSync(up.filePath, path.join(UPLOAD_DIR, subdir, finalName));
  return { ...up, storedName: finalName, contentType: sig.type, animated: sig.type === 'image/gif' };
}

export function removeUpload(subdir, name) {
  if (!name || /[\\/]/.test(name)) return;
  // Synchronous on purpose: once the request that replaced a file has answered, the old URL must already be gone.
  try { fs.rmSync(path.join(UPLOAD_DIR, subdir, name), { force: true }); } catch { /* best effort */ }
}

/**
 * Give an existing upload a second, independent name (a hard link, so it takes no extra disk space; a copy if the disk can't link).
 * Used when a message with files is forwarded: deleting either message then never breaks the other. Returns the new stored name.
 */
export function duplicateUpload(subdir, storedName) {
  if (!storedName || /[\\/]/.test(storedName)) throw new Error('bad name');
  const ext = path.extname(storedName).replace(/[^.a-z0-9]/gi, '').slice(0, 10);
  const newName = crypto.randomBytes(16).toString('hex') + ext;
  const from = path.join(UPLOAD_DIR, subdir, storedName);
  const to = path.join(UPLOAD_DIR, subdir, newName);
  try { fs.linkSync(from, to); } catch (e) {
    if (e.code === 'ENOENT') throw e;
    fs.copyFileSync(from, to);
  }
  return newName;
}

/** Convert a stored URL like /uploads/avatars/x.png back to its file name. */
export function storedNameFromUrl(url) {
  return url ? String(url).split('/').pop() : null;
}

export function safeFilename(name) {
  const cleaned = String(name || 'file').normalize('NFKC').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 180);
}
