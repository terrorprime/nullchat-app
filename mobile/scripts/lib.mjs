// Shared by the build scripts: reads mobile/nullchat-app.json (plus a few environment overrides) and checks it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOBILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(MOBILE_DIR, '..');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Where the server address comes from, first one that is set wins: NULLCHAT_SERVER_URL (the GitHub variable the desktop build uses too),
 *  "serverUrl" in mobile/nullchat-app.json, the desktop app's address, the PUBLIC_URL in fly.toml. */
function findServerUrl(cfg, env) {
  if ((env.NULLCHAT_SERVER_URL || '').trim()) return env.NULLCHAT_SERVER_URL.trim();
  if ((cfg.serverUrl || '').trim()) return cfg.serverUrl.trim();
  try {
    const d = readJson(join(ROOT, 'desktop', 'app-config.json'));
    if ((d.serverUrl || '').trim()) return d.serverUrl.trim();
  } catch { /* not there: fine */ }
  try {
    const m = /PUBLIC_URL\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, 'fly.toml'), 'utf8'));
    if (m) return m[1].trim();
  } catch { /* not there: fine */ }
  return '';
}

/** Returns the checked settings, or throws an Error whose message says what to fix (the scripts print it without a stack trace). */
export function loadAppConfig(env = process.env, file = join(MOBILE_DIR, 'nullchat-app.json')) {
  const cfg = existsSync(file) ? readJson(file) : {};
  const out = {
    appName: String(cfg.appName ?? 'NullChat').trim(),
    appId: String(cfg.appId ?? 'chat.nullchat.app').trim(),
    versionName: String(env.NULLCHAT_VERSION_NAME || cfg.versionName || '1.0.0').trim(),
    versionCode: Number(env.NULLCHAT_VERSION_CODE || (cfg.versionCode ?? 1)),
  };
  const fail = (msg) => { throw new Error(msg); };

  if (!out.appName || out.appName.length > 30 || /[\u0000-\u001f<>&"'\\]/.test(out.appName)) {
    fail('"appName" in mobile/nullchat-app.json must be 1-30 characters and can\'t contain < > & " \' or a backslash.');
  }
  // Letters and digits in dot-separated parts, each starting with a letter: valid for both Google Play and the App Store.
  if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(out.appId) || out.appId.length > 100) {
    fail('"appId" in mobile/nullchat-app.json must look like chat.example.nullchat: two or more parts separated by dots, letters and digits only, each part starting with a letter.');
  }
  if (!/^\d+(\.\d+){0,2}$/.test(out.versionName)) fail('"versionName" must be numbers like 1.0.0 (the App Store only accepts numbers and dots).');
  if (!Number.isInteger(out.versionCode) || out.versionCode < 1 || out.versionCode > 2000000000) fail('"versionCode" must be a whole number of at least 1. Raise it every time you publish an update.');

  const raw = findServerUrl(cfg, env);
  if (!raw) fail('No server address. Set "serverUrl" in mobile/nullchat-app.json (for example https://nullchat.fly.dev) or the NULLCHAT_SERVER_URL variable.');
  let u;
  try { u = new URL(raw); } catch { fail(`"${raw}" isn't a web address. It should look like https://nullchat.fly.dev`); }
  if (u.protocol !== 'https:') fail(`The server address must start with https:// (got "${raw}"). Voice, camera and notifications don't work on plain http.`);
  if (u.username || u.password) fail('The server address can\'t contain a username or password.');
  out.serverUrl = `https://${u.host}${u.pathname.replace(/\/+$/, '')}`; // no trailing slash, no query or fragment
  out.host = u.hostname;
  return out;
}

export function buildCapacitorConfig(app) {
  return {
    appId: app.appId,
    appName: app.appName,
    webDir: 'www',
    // The app is NullChat's own website in a native shell, so it is always the latest version your server runs: updating the server updates the apps.
    // (Capacitor's docs call server.url a development feature, see docs/PHONE_APPS.md for what that means for the App Store.)
    server: {
      url: app.serverUrl,
      allowNavigation: [app.host],
      errorPath: 'index.html', // shown instead of a blank screen when the server can't be reached
    },
    backgroundColor: '#040405',
    android: {
      allowMixedContent: false,
      webContentsDebuggingEnabled: false,
    },
    ios: {
      contentInset: 'never', // the website handles the notch and home bar itself (it already does as an installed web app)
      backgroundColor: '#040405',
    },
  };
}

export function writeProjectFiles(app, dir = MOBILE_DIR) {
  writeFileSync(join(dir, 'capacitor.config.json'), JSON.stringify(buildCapacitorConfig(app), null, 2) + '\n');
  mkdirSync(join(dir, 'www'), { recursive: true });
  // www/index.html reads the address from here, so the "Try again" button goes to your server.
  writeFileSync(join(dir, 'www', 'nullchat-server.js'), `window.NULLCHAT_SERVER = ${JSON.stringify(app.serverUrl)};\n`);
}

// ---- helpers for the two patch scripts -------------------------------------------------------------------------------------------

/** True when this file was started directly (node scripts/x.mjs) rather than imported by a test. */
export function isMain(metaUrl) {
  try { return resolve(process.argv[1] || '') === fileURLToPath(metaUrl); } catch { return false; }
}

/** Replace text that must be there; if Capacitor changes its template so the text moves, say so instead of silently doing nothing. */
export function mustReplace(text, pattern, replacement, what) {
  if (!(pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern))) {
    throw new Error(`Couldn't find ${what} in the project Capacitor generated, so it can't be set up automatically. Capacitor may have changed its template: see docs/PHONE_APPS.md, "If a build step fails".`);
  }
  return text.replace(pattern, replacement);
}

/** Copy every file under `from` into `to`, keeping the folder layout; returns how many were copied. */
export function copyTree(from, to) {
  let n = 0;
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) { mkdirSync(dst, { recursive: true }); n += copyTree(src, dst); }
    else { mkdirSync(to, { recursive: true }); copyFileSync(src, dst); n++; }
  }
  return n;
}

export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Run a patch script: print what it did, or the problem in plain words. */
export function runCli(fn) {
  try {
    const app = loadAppConfig();
    const notes = fn(app);
    for (const n of notes) console.log('  ' + n);
  } catch (e) {
    console.error('\n' + e.message + '\n');
    process.exit(1);
  }
}
