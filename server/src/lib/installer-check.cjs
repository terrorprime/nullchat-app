'use strict';
// Is an installer file whole? Shared by the server (which stops offering a damaged installer) and by
// scripts/check-downloads.cjs (which Deploy to Fly.io.bat runs before and after uploading).
//
// Two independent signs that a Windows installer is damaged:
//  1. NSIS (the installer format) writes into the file how long it is. A file shorter than that is cut short or torn, and the
//     installer itself then says "Installer integrity check has failed".
//  2. latest.yml, written next to the installer by the build, holds the installer's size and SHA-512. If either disagrees, the file
//     is not the one that was built (and the in-app updater would refuse it too).
const fs = require('node:fs');
const crypto = require('node:crypto');

const NSIS_MAGIC = Buffer.from([0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74]); // 0xdeadbeef + "NullsoftInst"
const HEAD_BYTES = 2 * 1024 * 1024; // the NSIS header sits right after the small Windows stub, well inside the first 2 MB

/** Where the installer says it ends, or null when this is not an NSIS installer. `head` is the start of the file. */
function nsisDeclaredEnd(head) {
  for (let at = head.indexOf(NSIS_MAGIC); at >= 4; at = head.indexOf(NSIS_MAGIC, at + 1)) {
    const start = at - 4;                      // the 4 bytes before the magic are the header's flags
    if (start % 512 !== 0 || start + 28 > head.length) continue;   // NSIS keeps its header on a 512-byte boundary
    if (head.readUInt32LE(start) & ~0xf) continue;                 // flags use only the low 4 bits
    return start + head.readUInt32LE(start + 24);                  // header start + length of all following data
  }
  return null;
}

/** The files listed in an electron-updater latest.yml: [{ url, sha512, size }]. */
function parseUpdateYml(text) {
  const files = [];
  let cur = null;
  let top = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^(\s*)(-\s+)?([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const [, indent, dash, key, rawVal] = m;
    const val = rawVal.replace(/^['"]|['"]$/g, '');
    if (dash && key === 'url') { cur = { url: val }; files.push(cur); continue; }
    if (indent.length >= 2 && cur && (key === 'sha512' || key === 'size')) cur[key] = key === 'size' ? Number(val) : val;
    else if (indent.length === 0) { top[key] = val; cur = null; }
  }
  if (!files.length && top.path) files.push({ url: top.path, sha512: top.sha512 || null, size: top.size ? Number(top.size) : null });
  return files;
}

/** SHA-256 (hex) and SHA-512 (base64, the form latest.yml uses) of a file, in one pass. */
function digestsOfFile(file) {
  return new Promise((resolve) => {
    const a = crypto.createHash('sha256');
    const b = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('data', (c) => { a.update(c); b.update(c); })
      .on('end', () => resolve({ sha256: a.digest('hex'), sha512: b.digest('base64') }))
      .on('error', () => resolve({ sha256: null, sha512: null }));
  });
}

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/**
 * What is wrong with this installer, in words an admin can act on, or null when it looks whole.
 * `digests` is { sha512 } for the file; `yml` is the text of the latest.yml next to it (or null).
 */
function installerProblem({ name, size, head, sha512, yml }) {
  if (/\.exe$/i.test(name)) {
    const end = nsisDeclaredEnd(head);
    if (end !== null && end > size) return `The file is cut short: it is ${size} bytes but the installer says it should be at least ${end}.`;
  }
  if (yml) {
    const entry = parseUpdateYml(yml).find((f) => String(f.url || '').toLowerCase() === name.toLowerCase());
    if (entry) {
      if (entry.size && entry.size !== size) return `It does not match latest.yml (that says ${entry.size} bytes, the file has ${size}).`;
      if (entry.sha512 && sha512 && entry.sha512 !== sha512) return 'It does not match latest.yml (the contents are not the build that file describes).';
    }
  }
  return null;
}

/** Inspect one file on disk (reads it once). Returns { sha256, sha512, problem }. */
async function inspectFile(file) {
  const name = require('node:path').basename(file);
  let size;
  try { size = fs.statSync(file).size; } catch { return { sha256: null, sha512: null, problem: null }; }
  const { sha256, sha512 } = await digestsOfFile(file);
  let yml = null;
  try { yml = fs.readFileSync(require('node:path').join(require('node:path').dirname(file), 'latest.yml'), 'utf8'); } catch { /* none */ }
  return { sha256, sha512, problem: installerProblem({ name, size, head: readHead(file), sha512, yml }) };
}

module.exports = { nsisDeclaredEnd, parseUpdateYml, digestsOfFile, readHead, installerProblem, inspectFile };
