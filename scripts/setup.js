#!/usr/bin/env node
// One-time setup: creates .env with a strong random APP_SECRET and the data folder.
// Safe to run again — it never overwrites an existing .env.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\n✖ NullChat needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  console.error('  Download the LTS version from https://nodejs.org and run this again.\n');
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.log('✔ .env already exists — leaving it untouched.');
} else {
  let text = fs.readFileSync(examplePath, 'utf8');
  const secret = crypto.randomBytes(48).toString('base64url');
  text = text.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`);
  fs.writeFileSync(envPath, text);
  console.log('✔ Created .env with a fresh random APP_SECRET.');
}

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
console.log('✔ Data folder ready (data/).');
console.log('\nNext steps:');
console.log('  npm run dev     → start NullChat in development mode (http://localhost:5173)');
console.log('  npm run seed    → (optional) create demo accounts and a demo server\n');
