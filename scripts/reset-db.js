#!/usr/bin/env node
// Deletes the NullChat database and uploaded files. Asks for confirmation unless --yes is given.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* ignore */ } }
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This permanently deletes ALL NullChat accounts, servers, messages and uploads in\n  ${dataDir}\nType "reset" to continue: `);
  rl.close();
  if (answer.trim() !== 'reset') { console.log('Cancelled.'); process.exit(0); }
}

for (const f of ['nullchat.db', 'nullchat.db-wal', 'nullchat.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
console.log('✔ Database and uploads removed. Restart the server to create a fresh database.');
