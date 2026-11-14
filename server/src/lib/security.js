import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// ---- IDs ----------------------------------------------------------------
// 19-character, time-sortable string IDs: 13-digit ms timestamp + 6-digit sequence.
let lastMs = 0;
let seq = 0;
export function newId() {
  let ms = Date.now();
  if (ms <= lastMs) { ms = lastMs; seq++; if (seq > 999999) { lastMs++; ms = lastMs; seq = 0; } }
  else { lastMs = ms; seq = Math.floor(Math.random() * 1000); }
  return String(ms).padStart(13, '0') + String(seq).padStart(6, '0');
}
export function idToTimestamp(id) {
  return Number(String(id).slice(0, 13));
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function randomCode(len = 8) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---- Passwords (scrypt) ----------------------------------------------------
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}

// ---- TOTP (RFC 6238) for two-factor authentication ----------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}
export function totp(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 30000));
}
export function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const now = Date.now();
  for (const drift of [-1, 0, 1]) {
    const expected = hotp(secret, Math.floor(now / 30000) + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) return true;
  }
  return false;
}

// ---- Signed short-lived tickets (used for MFA login step) -------------------
export function signTicket(payload, secret, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyTicket(ticket, secret) {
  if (typeof ticket !== 'string' || !ticket.includes('.')) return null;
  const [body, sig] = ticket.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
