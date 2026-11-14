// Notifications while NullChat is closed, using Web Push: RFC 8030 (delivery), RFC 8291 (message encryption) and
// RFC 8292 (VAPID, which proves to the browser's push service that the message comes from this server).
// Written with node:crypto only, so there is nothing extra to install.
//
// How it works: a phone (or browser) that turned notifications on gave us an "endpoint" URL at its browser
// vendor's push service (Google, Mozilla, Apple or Microsoft) plus two keys. We encrypt each notification with
// those keys, so the push service only sees scrambled bytes, and POST it to the endpoint. The device wakes up
// the NullChat service worker (client/public/sw.js), which shows the notification.
import crypto from 'node:crypto';
import { get, all, run, parseJSON } from '../db.js';
import { config } from '../config.js';
import { newId } from './security.js';
import { channelViewerIds, isBlockedEitherWay } from '../models.js';
import { deliverNative, nativeDevices, nativeUserIds, nativeEveryMessageUserIds, hasNativeTokens } from './nativePush.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// ---------------------------------------------------------------- server identity (VAPID)
let vapid = null;
/** The server's push identity: created once and kept in the database, so it survives restarts and deploys. */
export function getVapid() {
  if (vapid) return vapid;
  const row = get("SELECT value FROM _meta WHERE key = 'vapid'");
  let jwk = row ? parseJSON(row.value, null) : null;
  if (!jwk?.d || !jwk?.x || !jwk?.y) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    run("INSERT INTO _meta(key, value) VALUES ('vapid', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(jwk));
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  vapid = { publicKey, privateKey };
  return vapid;
}

const vapidSubject = () => (config.publicUrl.startsWith('https://') ? config.publicUrl : 'mailto:admin@nullchat.invalid');

function vapidAuthorization(endpoint) {
  const { publicKey, privateKey } = getVapid();
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapidSubject() }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// ---------------------------------------------------------------- RFC 8291 "aes128gcm" encryption
/** Encrypt `payload` (Buffer) for one subscription. Returns the request body. */
export function encryptPayload(payload, p256dh, authSecretB64) {
  const uaPublic = fromB64u(p256dh); // the device's public key (65 bytes)
  const authSecret = fromB64u(authSecretB64); // the device's 16-byte secret
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // a fresh key just for this message
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]); // 0x02 = last (only) record
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---------------------------------------------------------------- which endpoints we will talk to
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
/** Only the browser vendors' push services (https). Stops anyone from using the server to call arbitrary addresses. */
export function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (config.pushAnyEndpoint) return /^https?:$/.test(u.protocol);
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

// ---------------------------------------------------------------- sending
/** POST one encrypted message. Resolves to the push service's HTTP status. Redirects are refused on purpose. */
export async function sendPush(sub, payloadObj, { ttl = 86400, urgency = 'high' } = {}) {
  const body = encryptPayload(Buffer.from(JSON.stringify(payloadObj)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency, Authorization: vapidAuthorization(sub.endpoint) },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  res.body?.cancel?.().catch(() => {});
  return res.status;
}

/** Send and keep the table tidy: forget devices that unsubscribed, and ones that keep failing. Resolves 'ok' | 'gone' | 'failed'. */
async function deliver(sub, payload, opts) {
  if (sub.platform) return deliverNative(sub, payload, opts); // a phone app (Android / iPhone): lib/nativePush.js
  try {
    const status = await sendPush(sub, payload, opts);
    if (status === 404 || status === 410) { run('DELETE FROM push_subscriptions WHERE id = ?', sub.id); return 'gone'; }
    if (status >= 200 && status < 300) { run('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?', Date.now(), sub.id); return 'ok'; }
    throw new Error(`push service answered ${status}`);
  } catch {
    const failures = (sub.failures || 0) + 1;
    if (failures >= 8) run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
    else run('UPDATE push_subscriptions SET failures = ? WHERE id = ?', failures, sub.id);
    return 'failed';
  }
}

/** Run async jobs a few at a time, so one @everyone in a big server doesn't open hundreds of connections at once. */
async function pool(jobs, size = 8) {
  const results = [];
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); } };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  return results;
}

export function saveSubscription(userId, { endpoint, p256dh, auth, preview = true, mentionsOnly = true, userAgent = null }) {
  const now = Date.now();
  const existing = get('SELECT id FROM push_subscriptions WHERE endpoint = ?', endpoint);
  if (existing) {
    // Same device, maybe a different account now (log out / log in): the notifications follow the account that is logged in.
    run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, preview = ?, mentions_only = ?, user_agent = ?, failures = 0 WHERE id = ?',
      userId, p256dh, auth, preview ? 1 : 0, mentionsOnly ? 1 : 0, userAgent, existing.id);
  } else {
    run('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, preview, mentions_only, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), userId, endpoint, p256dh, auth, preview ? 1 : 0, mentionsOnly ? 1 : 0, userAgent, now);
    // A person rarely has more than a few devices; keep the newest 10.
    for (const old of all('SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10', userId)) run('DELETE FROM push_subscriptions WHERE id = ?', old.id);
  }
}
export function removeSubscription(userId, endpoint) {
  run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint);
}
export const hasSubscriptions = (userId) => !!get('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', userId) || hasNativeTokens(userId);

/** Every device of one person that should hear about this: browsers and phone apps. `mentioned` false leaves out devices set to "only DMs, mentions and replies". */
const devicesOf = (uid, mentioned = true) => [
  ...all('SELECT * FROM push_subscriptions WHERE user_id = ? AND (mentions_only = 0 OR ? = 1)', uid, mentioned ? 1 : 0),
  ...nativeDevices(uid, mentioned),
];

/** Send a test notification to every device of one account. */
export async function sendTest(userId) {
  const subs = devicesOf(userId);
  const results = await pool(subs.map((s) => () => deliver(s, { title: 'NullChat', body: 'Notifications are working.', url: '/channels/@me', tag: 'nullchat-test', test: true }, { ttl: 300 })));
  return { devices: subs.length, sent: results.filter((r) => r === 'ok').length };
}

// ---------------------------------------------------------------- new message -> notification
/**
 * The number on the app's icon: unread @mentions and DMs (not counting muted servers) plus friend requests waiting. The same
 * count the open app works out for itself (client/src/lib/notify.js), so the icon agrees while the app is closed.
 */
export function unreadBadgeCount(userId) {
  const mentions = get(`SELECT COALESCE(SUM(rs.mention_count), 0) AS n FROM read_states rs
                        JOIN channels c ON c.id = rs.channel_id
                        LEFT JOIN user_guild_settings g ON g.user_id = rs.user_id AND g.guild_id = c.guild_id
                        WHERE rs.user_id = ? AND rs.mention_count > 0 AND COALESCE(g.muted, 0) = 0`, userId)?.n || 0;
  const requests = get('SELECT COUNT(*) AS n FROM relationships WHERE user_id = ? AND type = 3', userId)?.n || 0;
  return Math.min(9999, mentions + requests);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Message text as it should read in a notification: mentions, emoji, spoilers and markdown tidied up. */
export function previewText(content, attachmentCount = 0, stickerCount = 0) {
  let t = String(content || '')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?(\d+)>/g, (_m, id) => {
      const u = get('SELECT username, display_name FROM users WHERE id = ?', id);
      return `@${u?.display_name || u?.username || 'user'}`;
    })
    .replace(/<#(\d+)>/g, (_m, id) => `#${get('SELECT name FROM channels WHERE id = ?', id)?.name || 'channel'}`)
    .replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t && stickerCount) t = 'Sent a sticker';
  if (!t && attachmentCount) t = attachmentCount > 1 ? `Sent ${attachmentCount} attachments` : 'Sent an attachment';
  return clip(t, 160);
}

/** Where tapping a notification for this channel goes. Threads open inside their parent channel. */
function channelUrl(channel) {
  if (!channel.guild_id) return `/channels/@me/${channel.id}`;
  if (channel.type === 11 && channel.parent_id) return `/channels/${channel.guild_id}/${channel.parent_id}?thread=${channel.id}`;
  return `/channels/${channel.guild_id}/${channel.id}`;
}

/**
 * Close friends (the starred ones, kept in the person's settings) may get through Do Not Disturb when the person turned that on:
 * a direct message from one, or a mention by one. They have to still be friends. The open app has the same rule (client/src/lib/closeFriends.js).
 */
function closeFriendMayNotify(uid, authorId, isDM, mentioned) {
  if (!authorId || !(isDM || mentioned)) return false;
  const s = parseJSON(get('SELECT settings FROM users WHERE id = ?', uid)?.settings, {});
  if (!s?.notifications?.closeFriendsBreakDnd || !Array.isArray(s.closeFriends) || !s.closeFriends.includes(authorId)) return false;
  return get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', uid, authorId)?.type === 1;
}

/**
 * Should this person get a notification for this message? Mirrors the rules the open app uses (client/src/lib/notify.js),
 * so the same messages that would pop up in the app pop up on the phone: Do Not Disturb silences everything; a muted server
 * or channel silences everything except real @mentions; a server set to "mentions only" / "nothing" is respected.
 */
function wantsNotification(uid, channel, isDM, mentioned, authorId = null) {
  if (get('SELECT status FROM users WHERE id = ?', uid)?.status === 'dnd' && !closeFriendMayNotify(uid, authorId, isDM, mentioned)) return false;
  const gs = get('SELECT muted, notifications, channel_overrides FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', uid, isDM ? '@me' : channel.guild_id);
  if (!gs) return true;
  const overrides = parseJSON(gs.channel_overrides, {});
  const override = overrides[channel.id] || (channel.parent_id ? overrides[channel.parent_id] : null);
  if (isDM) return !override?.muted;
  let level = gs.notifications ?? 0;
  if (typeof override?.notifications === 'number' && override.notifications >= 0) level = override.notifications;
  if (override?.muted && !mentioned) return false;
  if (gs.muted && !mentioned) return false;
  if (level === 2) return false;
  if (level === 1 && !mentioned) return false;
  return true;
}

/**
 * Tell people about a new message that nobody has to be looking at. `notified` is who the message pinged (everyone in a
 * DM; the people mentioned or replied to in a server) and `onlyEveryone` the ones pinged only by @everyone / @here.
 * Devices set to "only DMs, mentions and replies" (the default) get just those; devices set to "every message" also get
 * the rest of the channels they would see notifications for. Fire-and-forget: never slows down or breaks sending.
 */
//   only: when given, nobody outside this set is notified (a quiet reply is for the people picked, see routes/quiet.js)
export function pushForMessage({ channel, isDM, msg, authorId, notified = [], onlyEveryone = new Set(), only = null }) {
  (async () => {
    try {
      // Only people with a registered device can be notified, so start from them (most servers have few or none).
      const subscribed = new Set([...all('SELECT DISTINCT user_id FROM push_subscriptions').map((r) => r.user_id), ...nativeUserIds()]);
      if (!subscribed.size) return;
      const everyMessage = new Set([...all('SELECT DISTINCT user_id FROM push_subscriptions WHERE mentions_only = 0').map((r) => r.user_id), ...nativeEveryMessageUserIds()]);
      const pinged = new Set(notified);
      const candidates = new Set([...subscribed].filter((uid) => pinged.has(uid) || everyMessage.has(uid)));
      candidates.delete(authorId);
      if (only) for (const uid of [...candidates]) if (!only.has(uid)) candidates.delete(uid);
      if (!candidates.size) return;
      // Who can see this channel (a DM's recipients, or the server members allowed to view it)? Only worked out when needed.
      const viewers = new Set(channelViewerIds(channel));
      for (const uid of [...candidates]) if (!viewers.has(uid) || (!pinged.has(uid) && isBlockedEitherWay(uid, authorId))) candidates.delete(uid);
      if (!candidates.size) return;

      const author = get('SELECT username, display_name, avatar FROM users WHERE id = ?', authorId);
      const guild = isDM ? null : get('SELECT name FROM guilds WHERE id = ?', channel.guild_id);
      const text = !msg.content && msg.forward ? 'Forwarded a message' : previewText(msg.content, msg.attachments?.length || 0, msg.stickers?.length || 0);
      const url = channelUrl(channel);
      const icon = typeof author?.avatar === 'string' && author.avatar.startsWith('/uploads/') ? author.avatar : undefined;
      const jobs = [];
      for (const uid of candidates) {
        let mentioned = pinged.has(uid);
        if (mentioned && !isDM && onlyEveryone.has(uid) && get('SELECT suppress_everyone FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', uid, channel.guild_id)?.suppress_everyone) mentioned = false;
        if (!wantsNotification(uid, channel, isDM, mentioned, authorId)) continue;
        const subs = devicesOf(uid, mentioned);
        if (!subs.length) continue;
        const unread = unreadBadgeCount(uid);
        const nick = isDM ? null : get('SELECT nick FROM guild_members WHERE guild_id = ? AND user_id = ?', channel.guild_id, authorId)?.nick;
        const authorName = nick || author?.display_name || author?.username || 'Someone';
        const title = isDM ? (channel.name ? `${authorName} (${channel.name})` : authorName) : `${authorName} (#${channel.name}${guild ? `, ${guild.name}` : ''})`;
        for (const sub of subs) {
          const body = sub.preview ? text : (!isDM && mentioned ? 'You were mentioned' : 'New message');
          // (`stack`: the phone shows "…(+2 more)" when this chat already has an unread notification; `unread`: the number for the app icon)
          jobs.push(() => deliver(sub, { title, body, url, icon, tag: channel.id, channelId: channel.id, messageId: msg.id, ts: Date.now(), stack: true, unread }));
        }
      }
      if (jobs.length) await pool(jobs);
    } catch (e) { console.error('[push]', e.message); }
  })();
}

/**
 * A short notice for some people (for example "a message was reported"). It never carries message text. Goes to every device
 * of each person, whatever they chose for "only DMs and mentions", but not to people in Do Not Disturb. Fire-and-forget.
 */
export function pushNotice(userIds, { title, body, url = '/channels/@me', tag }) {
  (async () => {
    try {
      const jobs = [];
      for (const uid of new Set(userIds)) {
        if (get('SELECT status FROM users WHERE id = ?', uid)?.status === 'dnd') continue;
        for (const sub of devicesOf(uid)) jobs.push(() => deliver(sub, { title, body: sub.preview ? body : 'Open NullChat to see it', url, tag, ts: Date.now() }));
      }
      if (jobs.length) await pool(jobs);
    } catch (e) { console.error('[push]', e.message); }
  })();
}

/**
 * A saved-message reminder came due. Resolves to how many devices were told. Reminders ignore Do Not Disturb and
 * "mentions only" because the person asked for this one themselves.
 */
export async function pushReminder(userId, { messageId, channelId, channelName, authorName, preview }) {
  try {
    const subs = devicesOf(userId);
    if (!subs.length) return 0;
    const where = channelName ? ` in #${channelName}` : '';
    const ch = get('SELECT id, guild_id, type, parent_id FROM channels WHERE id = ?', channelId);
    const url = ch ? channelUrl(ch) : '/channels/@me';
    const results = await pool(subs.map((sub) => () => deliver(sub, {
      title: `Reminder${where}`,
      body: sub.preview ? (authorName ? `${authorName}: ${preview || 'a message you saved'}` : preview || 'A message you saved') : 'A message you saved is due',
      url, tag: `reminder-${messageId}`, channelId, messageId, ts: Date.now(),
    })));
    return results.filter((r) => r === 'ok').length;
  } catch (e) { console.error('[push]', e.message); return 0; }
}
