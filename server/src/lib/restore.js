// Restoring a backup. Upload the backup file to the server's data folder as restore.db.gz (or restore.db) and
// restart: before the database is opened, the file is checked and swapped in. The database it replaces is kept in
// DATA_DIR/backups/before-restore-<time>/ so nothing is lost. A file that fails the checks is set aside and ignored.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

async function inspect(open, file, maxVersion) {
  const d = await open(file);
  try {
    const ic = d.prepare('PRAGMA integrity_check').get();
    if (Object.values(ic || {})[0] !== 'ok') return 'the file is damaged (it failed the database integrity check)';
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has('_meta') || !tables.has('users') || !tables.has('messages')) return 'this is not a NullChat database';
    const v = d.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get();
    if (!v) return 'this is not a NullChat database';
    if (Number(v.value) > maxVersion) return `it was made by a newer NullChat (version ${v.value}; this server understands up to ${maxVersion}). Update the app first`;
    return null;
  } catch (e) {
    return `it could not be read as a NullChat database (${e.message})`;
  } finally { try { d.close(); } catch { /* ignore */ } }
}

export async function applyPendingRestore({ dataDir, dbPath, open, maxVersion }) {
  const gz = path.join(dataDir, 'restore.db.gz');
  const raw = path.join(dataDir, 'restore.db');
  const src = fs.existsSync(gz) ? gz : fs.existsSync(raw) ? raw : null;
  if (!src) return;
  const t = stamp();
  const tmp = path.join(dataDir, `restore-check-${t}.db`);
  const reject = (why) => {
    const aside = path.join(dataDir, `restore-rejected-${t}${src === gz ? '.db.gz' : '.db'}`);
    try { fs.renameSync(src, aside); } catch { /* ignore */ }
    console.error(`[restore] NOT restored: ${why}. The file was set aside as ${path.basename(aside)}; the current database is unchanged.`);
  };
  try {
    if (src === gz) await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(tmp));
    else fs.copyFileSync(src, tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return reject(`the file could not be unpacked (${e.message})`);
  }
  const problem = await inspect(open, tmp, maxVersion);
  if (problem) { fs.rmSync(tmp, { force: true }); return reject(problem); }

  const keep = path.join(dataDir, 'backups', `before-restore-${t}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, path.join(keep, path.basename(dbPath) + suffix));
  }
  fs.renameSync(tmp, dbPath);
  fs.rmSync(src, { force: true });
  console.log(`[restore] restored the database from ${path.basename(src)}. The previous database was kept in ${path.relative(dataDir, keep)}/`);
}
