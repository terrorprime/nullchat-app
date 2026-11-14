// Automatic database backups.
//
// Every few hours the whole database is copied (consistently, while the server keeps running)
// into DATA_DIR/backups as a small compressed file, and only the newest few are kept.
// On Fly.io this sits on the data disk next to the live database, alongside Fly's own daily
// disk snapshots. Uploaded files are not copied here (the disk snapshots cover those).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { db } from '../db.js';

export const BACKUP_DIR = path.join(config.dataDir, 'backups');
export const BACKUP_NAME = /^nullchat-\d{8}-\d{4}\.db\.gz$/;
const NAME = BACKUP_NAME;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function prune() {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => NAME.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - config.backups.keep))) {
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
}

export async function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = `nullchat-${stamp()}`;
  const tmp = path.join(BACKUP_DIR, `${base}.tmp`);
  const out = path.join(BACKUP_DIR, `${base}.db.gz`);
  try {
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${out}.part`));
    fs.renameSync(`${out}.part`, out);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${out}.part`, { force: true });
  }
  prune();
  return out;
}

/** The backups on disk, newest first. */
export function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((f) => NAME.test(f)); } catch { return []; }
  return names.sort().reverse().map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, size: st.size, createdAt: st.mtimeMs };
  });
}

export function startBackups() {
  if (!config.backups.enabled) return;
  const run = () => backupNow()
    .then((f) => console.log(`[backup] saved ${path.basename(f)}`))
    .catch((e) => console.error('[backup] failed:', e.message));
  // First one a couple of minutes after start-up, then on a schedule.
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, config.backups.everyHours * 3600 * 1000).unref();
}
