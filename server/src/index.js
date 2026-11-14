import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config, UPLOAD_DIR, ROOT_DIR } from './config.js';
import { all, run, get, db } from './db.js';
import { clientIp } from './lib/ip.js';
import { startBackups } from './lib/backup.js';
import { startIce, relayStatus } from './lib/ice.js';
import { Router, sendJson, readJsonBody, formatError, serveFile, notFound, unauthorized, forbidden, enforceRateLimit, encodeBody, warmCompression } from './lib/http.js';
import { authenticate } from './lib/auth.js';
import { attachGateway } from './gateway.js';
import { devOutbox } from './lib/mailer.js';
import { removeUpload } from './lib/uploads.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import guildRoutes, { invitePreview } from './routes/guilds.js';
import channelRoutes from './routes/channels.js';
import messageRoutes, { runAutomod, checkVerification } from './routes/messages.js';
import quietRoutes from './routes/quiet.js';
import catchupRoutes from './routes/catchup.js';
import moodRoutes from './routes/mood.js';
import streakRoutes from './routes/streaks.js';
import birthdayRoutes from './routes/birthdays.js';
import musicRoutes from './routes/music.js';
import voiceSoundRoutes from './routes/voicesounds.js';
import profileSongRoutes from './routes/profilesong.js';
import modFileRoutes from './routes/modfile.js';
import gifRoutes, { removeStarterGifs, purgeGifFavorites } from './routes/gifs.js';
import adminRoutes from './routes/admin.js';
import modRoutes from './routes/mod.js';
import appealRoutes from './routes/appeals.js';
import insightRoutes from './routes/insights.js';
import forumRoutes from './routes/forum.js';
import serverTagRoutes from './routes/servertags.js';
import communityRoutes, { sweepMemberAvatars } from './routes/community.js';
import extraRoutes from './routes/extras.js';
import savedRoutes, { startReminders } from './routes/saved.js';
import scheduledRoutes, { startScheduler } from './routes/scheduled.js';
import pushRoutes from './routes/push.js';
import reportRoutes, { purgeReports } from './routes/reports.js';
import { ensureLounge } from './lib/lounge.js';
import exportRoutes from './routes/export.js';
import botRoutes, { botMayCall } from './routes/bots.js';
import webhookRoutes, { sweepWebhookUsers } from './routes/webhooks.js';
import templateRoutes from './routes/templates.js';
import createDiscordApi, { cdnRoutes } from './routes/discord.js';
import { originOfRequest } from './lib/discord.js';
import { sweepBotUsers } from './lib/bots.js';
import { pruneMemberLog } from './lib/raid.js';
import { sweepTagBadges } from './lib/servertag.js';
import { registrationOpen, getAnnouncement } from './lib/site.js';

const router = new Router();
// Wrap router methods so routes can pass an options object: r.get(path, { auth: false, raw: true }, handler)
const r = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  r[m] = (p, optsOrHandler, maybeHandler) => {
    const opts = typeof optsOrHandler === 'function' ? {} : optsOrHandler;
    const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
    router[m](p, { opts, handler });
  };
}
authRoutes(r);
userRoutes(r);
guildRoutes(r);
channelRoutes(r);
messageRoutes(r);
quietRoutes(r, { runAutomod, checkVerification });
catchupRoutes(r);
moodRoutes(r);
streakRoutes(r);
birthdayRoutes(r);
musicRoutes(r);
voiceSoundRoutes(r);
profileSongRoutes(r);
modFileRoutes(r);
gifRoutes(r);
adminRoutes(r);
modRoutes(r);
appealRoutes(r);
insightRoutes(r);
forumRoutes(r);
serverTagRoutes(r);
communityRoutes(r);
botRoutes(r);
webhookRoutes(r);
templateRoutes(r);
extraRoutes(r);
savedRoutes(r);
scheduledRoutes(r);
pushRoutes(r);
reportRoutes(r);
exportRoutes(r);
cdnRoutes(r);
// The Discord-compatible API for bots (/api/v10/...): translated into the bot calls above (see routes/discord.js).
const discordApi = createDiscordApi({ router, botMayCall });

// ---- app build id ----
// A short fingerprint of the built web client. index.html names the hashed JS/CSS files, so the fingerprint
// changes whenever you deploy a new client. It is reported by /api/health and written into the served page,
// so an open browser tab or the desktop app can notice a newer version and offer an "Update" button.
let indexCache = { file: null, mtime: 0, html: '', build: null };
function loadIndex() {
  const file = path.join(config.clientDist, 'index.html');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (indexCache.file === file && indexCache.mtime === st.mtimeMs) return indexCache;
  const raw = fs.readFileSync(file, 'utf8');
  const build = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  const tag = `<meta name="nullchat-build" content="${build}" />`;
  const html = raw.includes('</head>') ? raw.replace('</head>', `  ${tag}\n</head>`) : tag + raw;
  indexCache = { file, mtime: st.mtimeMs, html, build };
  return indexCache;
}
function serveIndex(req, res) {
  const idx = loadIndex();
  if (!idx) return false;
  encodeBody(req, 'text/html', Buffer.from(idx.html), `index|${idx.build}`).then(({ body, encoding }) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP,
      Vary: 'Accept-Encoding', ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }).catch(() => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
  return true;
}

// An invite link pasted into another app (Discord, iMessage, WhatsApp, Slack, a social post…) gets a preview card made from these tags:
// the server's name and picture and how many people are in it. It is what anyone with the link can already see on the invite page.
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function serveInvitePage(req, res, code, pathname) {
  const idx = loadIndex();
  if (!idx) return false;
  try { enforceRateLimit(`invitelookup:${req.ip}`, 60, 60_000); } catch { return false; }
  const inv = invitePreview(code);
  if (!inv) return false;   // invalid or used up: the normal page opens and says so
  const origin = originOfRequest(req, config.publicUrl);
  const absolute = (u) => (u ? (/^https?:/i.test(u) ? u : `${origin}${u.startsWith('/') ? '' : '/'}${u}`) : null);
  const g = inv.guild;
  const title = `Join ${g.name} on NullChat`;
  const counts = `${inv.onlineCount} online · ${inv.memberCount} ${inv.memberCount === 1 ? 'member' : 'members'}`;
  const description = g.description ? `${counts} — ${String(g.description).slice(0, 160)}` : counts;
  const image = absolute(g.icon) || `${origin}/apple-touch-icon.png`;
  const tags = [
    ['property', 'og:site_name', 'NullChat'], ['property', 'og:type', 'website'], ['property', 'og:title', title], ['property', 'og:description', description],
    ['property', 'og:image', image], ['property', 'og:url', `${origin}${pathname}`],
    ['name', 'twitter:card', 'summary'], ['name', 'twitter:title', title], ['name', 'twitter:description', description], ['name', 'twitter:image', image],
  ].map(([k, n, v]) => `<meta ${k}="${n}" content="${escHtml(v)}" />`).join('\n    ');
  let html = idx.html
    .replace(/<meta name="description"[^>]*>\s*/i, () => `<meta name="description" content="${escHtml(description)}" />\n    `)
    .replace(/<title>[^<]*<\/title>/i, () => `<title>${escHtml(title)}</title>`);
  html = html.includes('</head>') ? html.replace('</head>', () => `  ${tags}\n  </head>`) : tags + html;
  const body = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// Used by Fly's health check: also proves the database is readable, not just that the process is up.
r.get('/api/health', { auth: false }, async () => {
  get('SELECT 1 AS ok');
  return { ok: true, time: Date.now(), build: loadIndex()?.build || null };
});
r.get('/api/announcement', { auth: false }, async () => ({ announcement: getAnnouncement() }));
r.get('/api/config', { auth: false }, async () => ({
  registrationOpen: registrationOpen(),
  maxUploadMb: config.maxUploadMb,
  voiceRelay: relayStatus().relay,   // whether calls have a relay to fall back on (a TURN server, or Cloudflare's)
  giphy: !!config.giphyKey,
  // Can this server deliver email (used for password resets)? In development, emails are shown in the terminal instead.
  emailEnabled: !!config.smtp.host || !config.isProd,
  devMail: !config.isProd && !config.smtp.host,
}));
// App files (desktop installers, the Android app) are offered on the "Get the app" screens. They come from
// DATA_DIR/downloads (copy files there on the server) and from the project's own downloads/ folder, which
// is shipped with every deploy, so the simplest way to publish one is to drop it in downloads/ and redeploy.
const DOWNLOAD_DIR = path.join(config.dataDir, 'downloads');
const BUNDLED_DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const downloadDirs = () => [DOWNLOAD_DIR, BUNDLED_DOWNLOAD_DIR];
// What the server knows about each download (its SHA-256, and whether the file is damaged: see lib/installer-check.cjs), worked out
// once per version of the file and kept. The key is the file's and its latest.yml's size and modified time.
const require = createRequire(import.meta.url);
const { inspectFile } = require('./lib/installer-check.cjs');
const inspectCache = new Map();
const statKey = (f) => { try { const s = fs.statSync(f); return `${s.size}|${Math.floor(s.mtimeMs)}`; } catch { return '-'; } };
const inspectDownload = (file, st) => {
  const key = `${file}|${st.size}|${Math.floor(st.mtimeMs)}|${statKey(path.join(path.dirname(file), 'latest.yml'))}`;
  if (!inspectCache.has(key)) {
    for (const k of inspectCache.keys()) if (k.startsWith(file + '|')) inspectCache.delete(k);   // an older version of the same file
    const p = inspectFile(file).catch(() => ({ sha256: null, problem: null }));
    p.then((r) => { if (r.problem) console.warn(`[downloads] ${path.basename(file)} is damaged: ${r.problem} Run "Deploy to Fly.io.bat" again (after "Build Installer.bat" has finished).`); });
    inspectCache.set(key, p);
  }
  return inspectCache.get(key);
};
// The folder a download is served from is the first one that has it.
const findDownload = (name) => {
  for (const dir of downloadDirs()) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not in this folder */ }
  }
  return null;
};
r.get('/api/downloads', { auth: false }, async () => {
  const describe = (n) => {
    // "launcher" files (see scripts/launchers) open NullChat in its own window using the visitor's Chrome, Edge or
    // Brave. They are labelled as such so nobody mistakes them for the full desktop app.
    const launcher = /launcher/i.test(n);
    if (/\.(exe|msi)$/i.test(n)) return { platform: 'windows', label: 'Windows installer (64-bit)' };
    if (/\.(dmg|pkg)$/i.test(n) || (/mac|darwin/i.test(n) && /\.zip$/i.test(n))) {
      if (launcher) return { platform: 'mac', label: 'Mac app (zip) · needs Chrome, Edge or Brave', launcher: true };
      const arch = /arm64|aarch64|apple.?silicon/i.test(n) ? 'Apple Silicon (M1/M2/M3/M4)' : /universal/i.test(n) ? 'Universal (any Mac)' : 'Intel';
      return { platform: 'mac', label: `${arch} · ${/\.zip$/i.test(n) ? 'zip' : 'disk image'}`, recommended: !/\.zip$/i.test(n) };
    }
    if (/\.appimage$/i.test(n)) return { platform: 'linux', label: 'AppImage (any distro)' };
    if (/\.deb$/i.test(n)) return launcher ? { platform: 'linux', label: 'Debian / Ubuntu (.deb) · needs Chrome, Chromium, Edge or Brave', launcher: true } : { platform: 'linux', label: 'Debian / Ubuntu (.deb)' };
    if (/\.rpm$/i.test(n)) return { platform: 'linux', label: 'Fedora / openSUSE (.rpm)' };
    if (/linux/i.test(n) && /\.tar\.gz$/i.test(n)) return { platform: 'linux', label: 'Any Linux (.tar.gz) · needs Chrome, Chromium, Edge or Brave', ...(launcher ? { launcher: true } : {}) };
    if (/\.apk$/i.test(n)) return { platform: 'android', label: 'Android app (APK)' };
    return null;
  };
  const seen = new Map();
  for (const dir of downloadDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (!d.isFile() || !describe(d.name) || seen.has(d.name)) continue; // the first folder wins
      const file = path.join(dir, d.name);
      const st = fs.statSync(file);
      seen.set(d.name, { name: d.name, ...describe(d.name), size: st.size, url: `/downloads/${encodeURIComponent(d.name)}`, _file: file, _st: st });
    }
  }
  // A checksum for each file, so a person can tell a damaged download from a good one (see the "Get the app" window). A file that is
  // damaged on the server itself (cut short, or not the build its latest.yml describes) is marked, and is no longer offered.
  const list = await Promise.all([...seen.values()].map(async ({ _file, _st, ...f }) => {
    const info = await inspectDownload(_file, _st);
    return { ...f, sha256: info.sha256, ...(info.problem ? { damaged: info.problem } : {}) };
  }));
  // Once a system has its full desktop app here, its light "launcher" version (the one that needs Chrome) is no longer offered.
  const full = new Set(list.filter((f) => !f.launcher && !f.damaged).map((f) => f.platform));
  return list.filter((f) => !(f.launcher && full.has(f.platform)))
    .sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) || a.name.localeCompare(b.name));
});
if (!config.isProd) {
  // Development helper: see emails that would have been sent (no SMTP configured).
  r.get('/api/dev/outbox', { auth: false }, async () => devOutbox);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https://*.giphy.com",   // (giphy: so "Download" can fetch a GIPHY GIF to save it)
  'frame-src https://www.youtube-nocookie.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|mp4))$/;

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  // A web address with a broken %-escape in it ("/a%zz", a lone "%") is the caller's mistake, not ours: no server error. A program calling
  // the API gets a 400; a person who followed a broken link to a page gets the app (which then shows its own "not found").
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 400, { message: 'That web address is not valid.', code: 'bad_request' });
    pathname = url.pathname;
  }
  req.ip = clientIp(req);

  // ---- Discord-compatible API for bots ----
  if (/^\/api\/v\d{1,2}(\/|$)/.test(url.pathname)) return discordApi.handle(req, res, url);

  // ---- API ----
  if (pathname.startsWith('/api/')) {
    // Routed on the path as sent: it is split into parts first and each part decoded once (decoding the whole path first turned "%2F" into a
    // slash that split the part in two, and decoding the parts again broke on a real "%").
    const match = router.match(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { message: 'Unknown endpoint.', code: 'not_found' });
    if (match.badPath) return sendJson(res, 400, { message: 'That web address is not valid.', code: 'bad_request' });
    if (match.methodNotAllowed) return sendJson(res, 405, { message: 'Method not allowed.', code: 'method_not_allowed' });
    const { opts, handler } = match.route.handlers[0];
    try {
      const authed = authenticate(req);
      if (opts.auth !== false && !authed) throw unauthorized();
      if (authed?.bot) {
        // Bots only get the endpoints listed in routes/bots.js, and a generous request limit of their own.
        if (!botMayCall(req.method, match.route.pattern)) throw forbidden('Bots can’t use this endpoint.');
        enforceRateLimit(`botreq:${authed.user.id}`, 600, 60_000, 'Your bot is sending requests too quickly.');
      }
      const ctx = {
        req, res, ip: req.ip,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        user: authed?.user || null,
        session: authed?.session || null,
        body: {},
      };
      if (!opts.raw && req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJsonBody(req);
      const result = await handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (opts.raw && !req.complete) req.resume();
      const { status, body } = formatError(err);
      if (!res.headersSent) {
        if (body.retryAfter) res.setHeader('Retry-After', String(body.retryAfter));
        sendJson(res, status, body);
      }
    }
    return;
  }

  // ---- custom emoji by id (stable URL usable from any server) ----
  const emojiMatch = /^\/emojis\/(\d{19})$/.exec(pathname);
  if (emojiMatch) {
    const e = get('SELECT stored_name FROM emojis WHERE id = ?', emojiMatch[1]);
    if (!e) return sendJson(res, 404, { message: 'Unknown emoji.' });
    res.writeHead(302, { Location: `/uploads/emojis/${e.stored_name}`, 'Cache-Control': 'public, max-age=3600' });
    res.end();
    return;
  }

  // ---- Android: lets the installed Android app open NullChat full screen (no browser bar) ----
  // Put the assetlinks.json that PWABuilder gives you in downloads/ (or DATA_DIR) and it is served here.
  if (pathname === '/.well-known/assetlinks.json') {
    const file = [BUNDLED_DOWNLOAD_DIR, DOWNLOAD_DIR, config.dataDir].map((d) => path.join(d, 'assetlinks.json')).find((f) => fs.existsSync(f));
    if (!file || !serveFile(req, res, file, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })) sendJson(res, 404, { message: 'Not found.' });
    return;
  }

  // ---- app downloads (desktop installers, Android app) ----
  if (pathname.startsWith('/downloads/')) {
    const name = path.basename(pathname.slice('/downloads/'.length));
    const type = /\.apk$/i.test(name) ? 'application/vnd.android.package-archive' : 'application/octet-stream';
    // Never hand out an installer that is known to be damaged: the person would only meet "integrity check has failed".
    if (/\.(exe|msi|apk|dmg|pkg|deb|rpm|appimage)$/i.test(name)) {
      const file = findDownload(name);
      if (file && (await inspectDownload(file, fs.statSync(file))).problem) return sendJson(res, 503, { message: 'This installer file is damaged on the server, so it is not being offered. Server admins: run "Deploy to Fly.io.bat" again.', code: 'damaged_download' });
    }
    const served = downloadDirs().some((dir) => serveFile(req, res, path.join(dir, name), { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-cache' }));
    if (!served) sendJson(res, 404, { message: 'File not found.' });
    return;
  }

  // ---- uploaded files ----
  if (pathname.startsWith('/uploads/')) {
    const rel = path.normalize(pathname.slice('/uploads/'.length));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return sendJson(res, 400, { message: 'Bad path' });
    const file = path.join(UPLOAD_DIR, rel);
    const headers = {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    let type = 'application/octet-stream';
    const ext = path.extname(file).toLowerCase();
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
    if (map[ext]) type = map[ext];
    headers['Content-Type'] = type;
    // `?download=1` (the Download buttons): send even a picture or a video as a file to keep, since phones ignore the link's own "download" hint.
    if (!INLINE_TYPES.test(type) || url.searchParams.get('download') === '1') {
      const name = url.searchParams.get('name') || path.basename(file);
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    if (!serveFile(req, res, file, headers)) sendJson(res, 404, { message: 'File not found.' });
    return;
  }

  // ---- built client (production) ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    const indexFile = path.join(config.clientDist, 'index.html');
    if (!fs.existsSync(indexFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>NullChat API</title><body style="font-family:system-ui;background:#111;color:#eee;padding:40px">
        <h1>NullChat server is running ✅</h1><p>The web client has not been built. In development, open <a style="color:#9b8cff" href="http://localhost:5173">http://localhost:5173</a>.
        For production run <code>npm run build</code> and restart.</p></body>`);
      return;
    }
    const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
    const candidate = path.join(config.clientDist, rel);
    if (candidate.startsWith(config.clientDist + path.sep) && rel && rel !== 'index.html' && serveFile(req, res, candidate, {
      'Cache-Control': rel.startsWith('assets') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      'Content-Security-Policy': CSP,
    }, { compress: true })) return;
    // SPA fallback
    const invitePath = /^\/invite\/([A-Za-z0-9_-]{1,64})(?:\/[A-Za-z0-9_-]{1,64})?\/?$/.exec(pathname);
    if (invitePath && serveInvitePage(req, res, invitePath[1], pathname)) return;
    if (!serveIndex(req, res)) serveFile(req, res, indexFile, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP }, { compress: true });
    return;
  }
  const { status, body } = formatError(notFound());
  sendJson(res, status, body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[http] fatal', e);
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
  });
});
attachGateway(server);
try { purgeReports(); } catch (e) { console.error('[reports] could not clean up', e); }
try { removeStarterGifs(); } catch (e) { console.error('[gifs] could not clear the old starter GIFs', e); }
try { purgeGifFavorites(); } catch (e) { console.error('[gifs] could not clean up favorites', e); }

// ---- housekeeping ----
setInterval(() => {
  try {
    // Orphaned uploads (never attached to a message) older than a day.
    const orphans = all('SELECT id, stored_name FROM attachments WHERE message_id IS NULL AND created_at < ?', Date.now() - 24 * 3600 * 1000);
    for (const o of orphans) { removeUpload('attachments', o.stored_name); run('DELETE FROM attachments WHERE id = ?', o.id); }
    run('DELETE FROM email_tokens WHERE expires_at < ?', Date.now());
    run('DELETE FROM sessions WHERE last_used_at < ?', Date.now() - 90 * 24 * 3600 * 1000);
    run('DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at < ?', Date.now());
    purgeReports();
    purgeGifFavorites();
    sweepBotUsers();
    sweepWebhookUsers();
    pruneMemberLog();
    sweepTagBadges();
    sweepMemberAvatars();
  } catch (e) { console.error('[cleanup]', e); }
}, 60 * 60 * 1000).unref();

server.on('error', (e) => {
  console.error(`[server] could not start: ${e.message}`);
  if (process.send) process.send({ type: 'nullchat:error', message: e.message });
  if (!globalThis.__NULLCHAT_EMBEDDED__) process.exit(1);
  globalThis.__NULLCHAT_ON_ERROR__?.(e);
});
server.listen(config.port, config.host, () => {
  globalThis.__NULLCHAT_ON_LISTEN__?.(server.address().port);
  console.log(`\n  ⚡ NullChat server listening on http://localhost:${config.port}`);
  console.log(`     data directory: ${config.dataDir}`);
  if (!config.isProd) console.log('     development mode — open the web client at http://localhost:5173');
  if (!config.smtp.host) console.log('     no SMTP configured — password-reset emails are printed here');
  console.log('');
});

warmCompression(config.clientDist);
startBackups();
startIce();
startReminders();
startScheduler();
try { ensureLounge(); } catch (e) { console.error('[lounge]', e.message); }

// On a redeploy Fly sends SIGTERM: stop taking connections, fold the database's write-ahead log
// back into the main file and close it, so nothing is left half-written.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down NullChat...');
    server.close();
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { console.error('[shutdown] database:', e.message); }
    process.exit(0);
  });
}
