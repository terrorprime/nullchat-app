import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const SERVER_DIR = path.resolve(__dirname, '..');

// Load .env from the project root (Node >= 20.12 has a built-in loader).
const envFile = process.env.NULLCHAT_ENV_FILE || path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) { console.warn('[config] could not load .env:', e.message); }
}

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const bool = (k, d) => { const v = env(k); return v === undefined ? d : /^(1|true|yes|on)$/i.test(v); };

const isProd = env('NODE_ENV', 'development') === 'production';

function resolveDir(p) {
  return path.resolve(ROOT_DIR, p); // (also tidies any "../" in an absolute path, which the static file check relies on)
}

export const config = {
  isProd,
  port: Number(env('PORT', 3001)),
  host: env('HOST', '0.0.0.0'),
  // Public URL people use to reach NullChat (used in emails and invite links).
  publicUrl: env('PUBLIC_URL', isProd ? 'http://localhost:3001' : 'http://localhost:5173').replace(/\/$/, ''),
  // Notifications while the app is closed (Web Push). Subscriptions are only accepted for the big browsers' push services, so a
  // person can't make the server send requests to arbitrary addresses. PUSH_ANY_ENDPOINT=1 is for automated tests only.
  pushAnyEndpoint: bool('PUSH_ANY_ENDPOINT', false),
  // Which SQLite to use: 'auto' (Node's built-in node:sqlite, or better-sqlite3 where that is missing), or force one of 'node:sqlite' / 'better-sqlite3'.
  dbDriver: env('DB_DRIVER', 'auto'),
  dataDir: resolveDir(env('DATA_DIR', 'data')),
  secret: env('APP_SECRET', ''),
  trustProxy: bool('TRUST_PROXY', false),
  // Automatic database backups into DATA_DIR/backups (on by default in production).
  backups: {
    enabled: bool('BACKUPS', isProd),
    keep: Math.max(1, Number(env('BACKUP_KEEP', 3))),
    everyHours: Math.max(1, Number(env('BACKUP_EVERY_HOURS', 12))),
  },
  maxUploadMb: Number(env('MAX_UPLOAD_MB', 150)),
  registrationOpen: bool('REGISTRATION_OPEN', true),
  // Site admins: usernames or emails, comma separated. Empty = the oldest account is the admin.
  adminUsers: env('ADMIN_USERS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  smtp: {
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', 587)),
    secure: bool('SMTP_SECURE', false),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('MAIL_FROM', 'NullChat <no-reply@nullchat.local>'),
  },
  giphyKey: env('GIPHY_API_KEY', ''),
  linkPreviews: bool('LINK_PREVIEWS', true),
  // WebRTC ICE servers handed to clients. TURN is strongly recommended for internet deployments.
  iceServers: (() => {
    const list = [];
    const stun = env('STUN_URLS', 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302');
    if (stun) list.push({ urls: stun.split(',').map((s) => s.trim()).filter(Boolean) });
    const turn = env('TURN_URLS', '');
    if (turn) list.push({ urls: turn.split(',').map((s) => s.trim()), username: env('TURN_USERNAME', ''), credential: env('TURN_CREDENTIAL', '') });
    return list;
  })(),
  // Optional voice relay borrowed from Cloudflare (lib/ice.js): both values come from a TURN key made in the Cloudflare dashboard.
  cloudflareTurn: (() => {
    const keyId = env('CLOUDFLARE_TURN_KEY_ID', '').trim(), token = env('CLOUDFLARE_TURN_API_TOKEN', '').trim();
    return keyId && token ? { keyId, token, api: env('CLOUDFLARE_TURN_API', 'https://rtc.live.cloudflare.com').replace(/\/+$/, '') } : null;
  })(),
  // Optional "big calls": a LiveKit server carries the voice channels' audio and video. Needs all three settings; see docs/BIG_CALLS.md.
  sfu: (() => {
    const url = env('LIVEKIT_URL', ''), apiKey = env('LIVEKIT_API_KEY', ''), secret = env('LIVEKIT_API_SECRET', '');
    if (!url && !apiKey && !secret) return null;
    if (!url || !apiKey || !secret) { console.warn('[config] Big calls are off: LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must all be set.'); return null; }
    if (!/^wss?:\/\/[^\s/]+/i.test(url)) { console.warn('[config] Big calls are off: LIVEKIT_URL must look like wss://your-livekit-host'); return null; }
    if (isProd && /^ws:\/\//i.test(url) && !/^ws:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url)) console.warn('[config] LIVEKIT_URL starts with ws:// (not wss://): browsers on an https site will refuse to connect to it.');
    return { url: url.replace(/\/+$/, ''), apiKey, secret };
  })(),
  // Optional phone apps (docs/PHONE_APPS.md): notifications to the Android app go through Firebase Cloud Messaging, to the iPhone app
  // through Apple's push service. Each needs its own credentials; either, both or neither can be set.
  fcm: (() => {
    const raw = env('FCM_SERVICE_ACCOUNT', '') || (env('FCM_SERVICE_ACCOUNT_B64', '') ? Buffer.from(env('FCM_SERVICE_ACCOUNT_B64', ''), 'base64').toString('utf8') : '');
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      if (!j.project_id || !j.client_email || !j.private_key) throw new Error('it needs project_id, client_email and private_key');
      return { projectId: String(j.project_id), clientEmail: String(j.client_email), privateKey: String(j.private_key).replace(/\\n/g, '\n') };
    } catch (e) {
      console.warn(`[config] Android notifications are off: FCM_SERVICE_ACCOUNT is not a Firebase service account key file (${e.message}).`);
      return null;
    }
  })(),
  apns: (() => {
    const key = (env('APNS_KEY', '') || (env('APNS_KEY_B64', '') ? Buffer.from(env('APNS_KEY_B64', ''), 'base64').toString('utf8') : '')).replace(/\\n/g, '\n');
    const keyId = env('APNS_KEY_ID', ''), teamId = env('APNS_TEAM_ID', ''), bundleId = env('APNS_BUNDLE_ID', '');
    if (!key && !keyId && !teamId && !bundleId) return null;
    if (!key || !keyId || !teamId || !bundleId) { console.warn('[config] iPhone notifications are off: APNS_KEY (or APNS_KEY_B64), APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID must all be set.'); return null; }
    if (!/-----BEGIN PRIVATE KEY-----/.test(key)) { console.warn('[config] iPhone notifications are off: APNS_KEY is not an Apple .p8 key file.'); return null; }
    return { key, keyId, teamId, bundleId, sandbox: bool('APNS_SANDBOX', false) };
  })(),
  clientDist: resolveDir(env('CLIENT_DIST', 'client/dist')),
};

if (!config.secret) {
  if (isProd) {
    console.error('[config] APP_SECRET must be set in production. Run `npm run setup` or set it in .env');
    process.exit(1);
  }
  config.secret = 'dev-insecure-secret-change-me';
}

fs.mkdirSync(config.dataDir, { recursive: true });
export const UPLOAD_DIR = path.join(config.dataDir, 'uploads');
for (const sub of ['attachments', 'avatars', 'banners', 'icons', 'emojis', 'stickers', 'decorations', 'gifs', 'tagbadges', 'memberavatars', 'voicesounds', 'profilesongs']) {
  fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true });
}
