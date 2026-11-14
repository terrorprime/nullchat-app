// Notifications while the app is closed (Web Push). See lib/push.js for how it works.
import { z } from 'zod';
import { get } from '../db.js';
import { bad, enforceRateLimit } from '../lib/http.js';
import { getVapid, endpointAllowed, saveSubscription, removeSubscription, sendTest } from '../lib/push.js';
import { nativeSenders, saveNativeToken, removeNativeToken, nativeCount } from '../lib/nativePush.js';

const b64uLen = (s) => Buffer.from(String(s), 'base64url').length;

export default function register(r) {
  // The server's public key. The browser needs it to create a subscription that only this server can use.
  r.get('/api/push/key', async () => ({ publicKey: getVapid().publicKey }));

  r.post('/api/push/subscribe', async (ctx) => {
    enforceRateLimit(`push-sub:${ctx.user.id}`, 20, 60_000);
    const body = z.object({
      endpoint: z.string().url().max(1000),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
      preview: z.boolean().optional(),
      mentionsOnly: z.boolean().optional(),
    }).parse(ctx.body);
    if (!endpointAllowed(body.endpoint)) throw bad('That notification service isn\u2019t supported.');
    if (b64uLen(body.keys.p256dh) !== 65 || b64uLen(body.keys.auth) !== 16) throw bad('Those notification keys aren\u2019t valid.');
    saveSubscription(ctx.user.id, {
      endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth,
      preview: body.preview !== false, mentionsOnly: body.mentionsOnly !== false,
      userAgent: String(ctx.req.headers['user-agent'] || '').slice(0, 200),
    });
    return { ok: true };
  });

  r.post('/api/push/unsubscribe', async (ctx) => {
    const body = z.object({ endpoint: z.string().max(1000) }).parse(ctx.body);
    removeSubscription(ctx.user.id, body.endpoint);
    return { ok: true };
  });

  // "Send a test notification" button in Settings.
  r.post('/api/push/test', async (ctx) => {
    enforceRateLimit(`push-test:${ctx.user.id}`, 5, 60_000, 'Wait a moment before sending another test.');
    return sendTest(ctx.user.id);
  });

  // How many of my devices get notifications (shown in Settings).
  r.get('/api/push/devices', async (ctx) => ({ count: get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', ctx.user.id).n + nativeCount(ctx.user.id) }));

  // ---- the phone apps (docs/PHONE_APPS.md): they register a token from Firebase (Android) or Apple (iPhone) instead of a browser endpoint
  // Which kinds of phone this server can send to (the app asks before offering the switch).
  r.get('/api/push/native/status', async () => ({ senders: nativeSenders() }));

  r.post('/api/push/native', async (ctx) => {
    enforceRateLimit(`push-native:${ctx.user.id}`, 30, 60_000);
    const body = z.object({
      platform: z.enum(['android', 'ios']),
      token: z.string().min(20).max(1000),
      preview: z.boolean().optional(),
      mentionsOnly: z.boolean().optional(),
    }).parse(ctx.body);
    if (body.platform === 'ios' ? !/^[0-9a-fA-F]{32,400}$/.test(body.token) : !/^[A-Za-z0-9_:.\-]{20,1000}$/.test(body.token)) throw bad('That device token isn\u2019t valid.');
    if (!nativeSenders()[body.platform]) throw bad(`This server isn\u2019t set up to send notifications to ${body.platform === 'ios' ? 'iPhones' : 'Android phones'} yet.`);
    saveNativeToken(ctx.user.id, { platform: body.platform, token: body.token, preview: body.preview !== false, mentionsOnly: body.mentionsOnly !== false });
    return { ok: true };
  });

  r.post('/api/push/native/remove', async (ctx) => {
    const body = z.object({ token: z.string().max(1000) }).parse(ctx.body);
    removeNativeToken(ctx.user.id, body.token);
    return { ok: true };
  });
}
