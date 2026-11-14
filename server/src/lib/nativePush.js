// Notifications for the NullChat phone apps (docs/PHONE_APPS.md), sent through the phone makers' own services:
//   Android -> Firebase Cloud Messaging ("FCM", HTTP v1 API)       needs FCM_SERVICE_ACCOUNT
//   iPhone  -> Apple Push Notification service ("APNs", HTTP/2)    needs APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
// Written with node:crypto, fetch and node:http2 only, so nothing extra is installed. (The browser notifications in lib/push.js
// are separate: a browser or an installed web app registers an endpoint; a phone app registers a device token.)
//
// Unlike a browser, a phone app can't decrypt anything for us, so these messages are readable by Google / Apple on their way.
// That is the same as every chat app's notifications on a phone. "Show message text" off keeps the text out of them entirely.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { get, all, run } from '../db.js';
import { config } from '../config.js';
import { newId } from './security.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export const nativeSenders = () => ({ android: !!config.fcm, ios: !!config.apns });
export const nativeEnabled = () => !!(config.fcm || config.apns);

// Web addresses, kept in one place. (The three environment names are only for automated tests; they are not documented because
// a real server never sets them.)
const FCM_TOKEN_URL = () => process.env.FCM_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const FCM_SEND_URL = (project) => (process.env.FCM_SEND_URL || 'https://fcm.googleapis.com/v1/projects/{project}/messages:send').replace('{project}', encodeURIComponent(project));
const APNS_ORIGIN = () => process.env.APNS_URL || (config.apns?.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');

// One warning a minute at most for each kind of problem, and never with a key in it.
const lastWarn = new Map();
function warnOften(kind, text) {
  if (Date.now() - (lastWarn.get(kind) || 0) < 60_000) return;
  lastWarn.set(kind, Date.now());
  console.warn(`[native-push] ${text}`);
}

// ---------------------------------------------------------------- the table
// (native_push_tokens: one row per phone that turned notifications on; it is created in db.js)

export function saveNativeToken(userId, { platform, token, preview = true, mentionsOnly = true }) {
  const existing = get('SELECT id FROM native_push_tokens WHERE token = ?', token);
  if (existing) {
    // The same phone, maybe another account now (log out / log in): notifications follow the account that is logged in.
    run('UPDATE native_push_tokens SET user_id = ?, platform = ?, preview = ?, mentions_only = ?, failures = 0 WHERE id = ?', userId, platform, preview ? 1 : 0, mentionsOnly ? 1 : 0, existing.id);
  } else {
    run('INSERT INTO native_push_tokens (id, user_id, platform, token, preview, mentions_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), userId, platform, token, preview ? 1 : 0, mentionsOnly ? 1 : 0, Date.now());
    // A person rarely has more than a few phones; keep the newest 10.
    for (const old of all('SELECT id FROM native_push_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10', userId)) run('DELETE FROM native_push_tokens WHERE id = ?', old.id);
  }
}
export const removeNativeToken = (userId, token) => run('DELETE FROM native_push_tokens WHERE user_id = ? AND token = ?', userId, token);
export const hasNativeTokens = (userId) => !!get('SELECT 1 FROM native_push_tokens WHERE user_id = ? LIMIT 1', userId);
export const nativeCount = (userId) => get('SELECT COUNT(*) AS n FROM native_push_tokens WHERE user_id = ?', userId).n;
/** The phones of one person that should hear about something: all of them, or (`mentionedOnly`) just the ones set to "every message" plus, when `mentioned`, the rest. */
export function nativeDevices(userId, mentioned = true) {
  return all('SELECT * FROM native_push_tokens WHERE user_id = ? AND (mentions_only = 0 OR ? = 1)', userId, mentioned ? 1 : 0);
}
export const nativeUserIds = () => all('SELECT DISTINCT user_id FROM native_push_tokens').map((r) => r.user_id);
export const nativeEveryMessageUserIds = () => all('SELECT DISTINCT user_id FROM native_push_tokens WHERE mentions_only = 0').map((r) => r.user_id);
/** For the Admin Panel: how many phones, per kind. */
export const nativeSummary = () => ({
  ...nativeSenders(), // { android: true | false, ios: true | false }: can this server send to that kind of phone
  androidDevices: get("SELECT COUNT(*) AS n FROM native_push_tokens WHERE platform = 'android'").n,
  iosDevices: get("SELECT COUNT(*) AS n FROM native_push_tokens WHERE platform = 'ios'").n,
});

// ---------------------------------------------------------------- Android: Firebase Cloud Messaging (HTTP v1)
let fcmAccess = null; // { token, expires }
async function fcmAccessToken() {
  if (fcmAccess && fcmAccess.expires - 60_000 > Date.now()) return fcmAccess.token;
  const { clientEmail, privateKey } = config.fcm;
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = FCM_TOKEN_URL();
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUrl, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), privateKey);
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64u(sig)}` }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    const e = new Error(`Google refused the Firebase key (HTTP ${res.status}${j?.error ? `, ${String(j.error).slice(0, 60)}` : ''})`);
    e.config = true;
    throw e;
  }
  fcmAccess = { token: j.access_token, expires: Date.now() + Math.max(120, Number(j.expires_in) || 3600) * 1000 };
  return fcmAccess.token;
}

const strings = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));

async function sendFcm(row, { title, body, data, tag, badge }, ttl) {
  let access;
  try { access = await fcmAccessToken(); } catch (e) { if (e.config) { warnOften('fcm-config', e.message); return 'config'; } throw e; }
  const message = {
    token: row.token,
    notification: { title, body },
    data: strings(data),
    android: {
      priority: 'HIGH',
      ttl: `${ttl}s`,
      notification: { channel_id: 'messages', ...(tag ? { tag } : null), ...(badge > 0 ? { notification_count: badge } : null) },
    },
  };
  const res = await fetch(FCM_SEND_URL(config.fcm.projectId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) { res.body?.cancel?.().catch(() => {}); return 'ok'; }
  const j = await res.json().catch(() => null);
  const code = (j?.error?.details || []).map((d) => d.errorCode).find(Boolean) || j?.error?.status || '';
  if (res.status === 404 || code === 'UNREGISTERED') return 'gone'; // the app was uninstalled or the token replaced
  if (res.status === 400 && /registration token/i.test(j?.error?.message || '')) return 'gone';
  if (res.status === 401 || res.status === 403 || code === 'SENDER_ID_MISMATCH' || code === 'THIRD_PARTY_AUTH_ERROR') {
    // (the server's own key or project is wrong; that says nothing about this phone, so keep it)
    if (res.status === 401) fcmAccess = null;
    warnOften('fcm-config', `Firebase refused to send (HTTP ${res.status}${code ? `, ${code}` : ''}). Check FCM_SERVICE_ACCOUNT and that the Firebase project is the one the app was built with.`);
    return 'config';
  }
  throw new Error(`Firebase answered ${res.status} ${code}`);
}

// ---------------------------------------------------------------- iPhone: Apple Push Notification service (HTTP/2)
let apnsJwt = null; // { value, issued }
function apnsProviderToken() {
  // Apple wants a token that is neither older than an hour nor re-made more often than every 20 minutes.
  if (apnsJwt && Date.now() - apnsJwt.issued < 45 * 60_000) return apnsJwt.value;
  const { key, keyId, teamId } = config.apns;
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64u(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  apnsJwt = { value: `${head}.${claims}.${b64u(sig)}`, issued: Date.now() };
  return apnsJwt.value;
}

let apnsSession = null;
function apnsConnection(origin) {
  if (apnsSession && apnsSession.origin === origin && !apnsSession.session.closed && !apnsSession.session.destroyed) return apnsSession.session;
  const session = http2.connect(origin);
  const forget = () => { if (apnsSession?.session === session) apnsSession = null; };
  session.on('error', forget);
  session.on('close', forget);
  session.on('goaway', forget);
  session.unref(); // an idle connection never keeps the server from stopping
  apnsSession = { origin, session };
  return session;
}

function apnsRequest(origin, path, headers, body) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = apnsConnection(origin).request({ ':method': 'POST', ':path': path, ...headers });
    } catch (e) { reject(e); return; }
    const chunks = [];
    let status = 0;
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new Error('Apple did not answer in time')); }, 10_000);
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { clearTimeout(timer); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

async function sendApns(row, { title, body, data, tag, badge }, ttl) {
  const { bundleId } = config.apns;
  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: 'default', ...(badge >= 0 ? { badge } : null), ...(tag ? { 'thread-id': tag } : null) },
    ...strings(data),
  });
  const headers = {
    authorization: `bearer ${apnsProviderToken()}`,
    'apns-topic': bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl),
    'content-type': 'application/json',
    ...(tag && Buffer.byteLength(tag) <= 64 ? { 'apns-collapse-id': tag } : null), // a newer message in the same chat replaces the older notification
  };
  const origin = APNS_ORIGIN();
  const path = `/3/device/${encodeURIComponent(row.token)}`;
  let res;
  try { res = await apnsRequest(origin, path, headers, payload); } catch (e) { apnsSession = null; res = await apnsRequest(origin, path, headers, payload); } // (one retry on a dropped connection)
  if (res.status === 200) return 'ok';
  const reason = (() => { try { return JSON.parse(res.body).reason || ''; } catch { return ''; } })();
  if (res.status === 410 || reason === 'Unregistered') return 'gone';
  if (res.status === 403 || reason === 'InvalidProviderToken' || reason === 'ExpiredProviderToken' || reason === 'BadTopic' || reason === 'MissingTopic') {
    apnsJwt = null;
    warnOften('apns-config', `Apple refused to send (${reason || `HTTP ${res.status}`}). Check APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID.`);
    return 'config';
  }
  // (BadDeviceToken is usually a development-signed build talking to the live service, or the other way round: see APNS_SANDBOX.)
  throw new Error(`Apple answered ${res.status} ${reason}`);
}

// ---------------------------------------------------------------- one message to one phone
/**
 * Send what lib/push.js built for a browser (title, body, url, tag, channelId, messageId, unread) to a phone app.
 * Resolves 'ok' | 'gone' | 'failed' | 'config' and keeps the table tidy: a phone that unregistered is forgotten, one that keeps failing is dropped,
 * and a problem with the server's own keys (config) never costs anyone their registration.
 */
export async function deliverNative(row, payload, { ttl = 86400 } = {}) {
  const msg = {
    title: payload.title || 'NullChat',
    body: payload.body || '',
    data: { url: payload.url || '/channels/@me', channelId: payload.channelId, messageId: payload.messageId, tag: payload.tag },
    tag: payload.tag,
    badge: typeof payload.unread === 'number' ? payload.unread : -1,
  };
  try {
    let result;
    if (row.platform === 'android') result = config.fcm ? await sendFcm(row, msg, ttl) : 'config';
    else if (row.platform === 'ios') result = config.apns ? await sendApns(row, msg, ttl) : 'config';
    else result = 'gone';
    if (result === 'gone') { run('DELETE FROM native_push_tokens WHERE id = ?', row.id); return 'gone'; }
    if (result === 'ok') { run('UPDATE native_push_tokens SET last_success_at = ?, failures = 0 WHERE id = ?', Date.now(), row.id); return 'ok'; }
    return result; // 'config'
  } catch (e) {
    const failures = (row.failures || 0) + 1;
    if (failures >= 8) run('DELETE FROM native_push_tokens WHERE id = ?', row.id);
    else run('UPDATE native_push_tokens SET failures = ? WHERE id = ?', failures, row.id);
    warnOften(`${row.platform}-net`, `could not reach the ${row.platform === 'ios' ? 'Apple' : 'Firebase'} push service: ${String(e.message || e).slice(0, 120)}`);
    return 'failed';
  }
}
