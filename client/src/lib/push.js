// Notifications on your phone (or any browser) while NullChat is closed — "Web Push".
// The browser hands us a private address at its maker's push service (Google / Apple / Mozilla / Microsoft);
// we give that address to our own server, and the server posts encrypted messages to it. The service worker
// (public/sw.js) wakes up and shows them. Needs HTTPS, which Fly.io gives you.
import { api } from './api.js';
import { installEnv, isStandalone, desktop } from './install.js';
import { navigate } from './router.jsx';
import { inNativeApp, nativePlatform, nativePlugin } from './native.js';

const ON_KEY = 'nullchat.push'; // '1' = this device should receive background notifications
const PREVIEW_KEY = 'nullchat.push.preview'; // '0' = hide message text (just "New message")
const ALL_KEY = 'nullchat.push.all'; // '1' = every message, not just DMs, mentions and replies
const TOKEN_KEY = 'nullchat.push.token'; // the phone app's notification address (from Google on Android, Apple on iPhone)

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

/** { ok, reason } — reason is 'desktop' | 'ios-install' | 'unsupported' | 'dev' when not ok. */
export function pushSupport() {
  // Inside the NullChat phone app notifications go through the phone itself, not the web view (see "the phone app" below).
  if (inNativeApp()) return nativePlugin('PushNotifications') ? { ok: true, native: true } : { ok: false, reason: 'unsupported' };
  if (desktop) return { ok: false, reason: 'desktop' }; // the desktop app has its own notifications
  const env = installEnv();
  const hasApis = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // iPhone / iPad only allow web push for apps added to the Home Screen (iOS 16.4+).
  if (env.ios && !isStandalone()) return { ok: false, reason: 'ios-install' };
  if (!hasApis) return { ok: false, reason: 'unsupported' };
  if (env.inApp) return { ok: false, reason: 'unsupported' };
  if (!import.meta.env?.PROD) return { ok: false, reason: 'dev' }; // the service worker only exists in production builds
  return { ok: true };
}

export const previewEnabled = () => read(PREVIEW_KEY) !== '0';
export const everyMessageEnabled = () => read(ALL_KEY) === '1';
export const pushWanted = () => read(ON_KEY) === '1';

function keyBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

async function registration() {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('NullChat is still starting up. Try again in a moment.')), 8000)),
  ]);
  return reg;
}

/** Make sure this browser is subscribed with the server's key, and tell the server about it (safe to repeat). */
async function subscribeAndRegister(reg) {
  const { publicKey } = await api.get('/push/key');
  const wanted = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, wanted)) { await sub.unsubscribe().catch(() => {}); sub = null; } // the server's identity changed
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
  const json = sub.toJSON();
  await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys, preview: previewEnabled(), mentionsOnly: !everyMessageEnabled() });
  return sub;
}

// ---- the phone app (Android and iPhone) ---------------------------------------------------------------------------------
// The phone's web view has no web push, so the app does it the way every phone app does: it asks the phone for a notification
// address (a "token", from Google on Android and Apple on iPhone), we give it to our server, and the server sends the notifications
// through Google or Apple (server/src/lib/nativePush.js). The pieces on the phone are Capacitor's Push Notifications feature.
const platformName = () => (nativePlatform() === 'ios' ? 'iPhones' : 'Android phones');
let nativeBound = false;
let nativeOfferOk = false; // set once we know this phone could be offered notifications (server set up, not blocked)
const tokenWaiters = [];

/** Tell the server this phone's address (safe to repeat). */
const tellServerAboutPhone = (token) => api.post('/push/native', { platform: nativePlatform(), token, preview: previewEnabled(), mentionsOnly: !everyMessageEnabled() });

/** Listen once for what the phone tells us: a new address, a failure to get one, and a tap on a notification. */
function bindNativeEvents(PN) {
  if (nativeBound) return;
  nativeBound = true;
  PN.addListener('registration', (t) => {
    const token = t?.value;
    if (!token) return;
    write(TOKEN_KEY, token);
    for (const w of tokenWaiters.splice(0)) { clearTimeout(w.timer); w.resolve(token); }
    if (pushWanted()) tellServerAboutPhone(token).catch(() => {}); // the phone changed its address: keep the server up to date
  });
  PN.addListener('registrationError', (e) => {
    for (const w of tokenWaiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`Your phone wouldn’t give NullChat a notification address${e?.error ? ` (${String(e.error).slice(0, 120)})` : ''}. Check your connection and try again.`)); }
  });
  // Tapping a notification opens that chat (also when the tap is what started the app: the phone keeps the tap until we listen).
  PN.addListener('pushNotificationActionPerformed', (a) => {
    const url = a?.notification?.data?.url;
    if (typeof url === 'string' && /^\/(?!\/)/.test(url)) navigate(url); // (a path on this site only)
  });
}

const waitForToken = (ms = 20000) => new Promise((resolve, reject) => {
  const w = { resolve, reject, timer: setTimeout(() => { tokenWaiters.splice(tokenWaiters.indexOf(w), 1); reject(new Error('Your phone didn’t answer in time. Check your connection and try again.')); }, ms) };
  tokenWaiters.push(w);
});

const nativeSenderReady = async () => {
  try { return !!(await api.get('/push/native/status')).senders?.[nativePlatform()]; } catch { return false; }
};
const nativePermission = async (PN) => {
  try { const r = (await PN.checkPermissions()).receive; return r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'default'; } catch { return 'default'; }
};

async function enableNativePush() {
  const PN = nativePlugin('PushNotifications');
  if (!PN) throw new Error('This copy of the app was built without notifications. Update the app.');
  if (!(await nativeSenderReady())) throw new Error(`This server isn’t set up to send notifications to ${platformName()} yet. Whoever runs it needs to follow docs/PHONE_APPS.md.`);
  bindNativeEvents(PN);
  let perm = await nativePermission(PN);
  if (perm !== 'granted') {
    try { perm = (await PN.requestPermissions()).receive === 'granted' ? 'granted' : 'denied'; } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for NullChat in your phone’s settings, then try again.');
  if (nativePlatform() === 'android') await PN.createChannel({ id: 'messages', name: 'Messages', description: 'Direct messages, @mentions and replies', importance: 4, visibility: 0, vibration: true }).catch(() => {});
  const got = waitForToken();
  got.catch(() => {});
  await PN.register();
  const token = await got;
  await tellServerAboutPhone(token);
  write(ON_KEY, '1');
}

async function disableNativePush() {
  write(ON_KEY, null);
  const token = read(TOKEN_KEY);
  if (token) await api.post('/push/native/remove', { token }, { noAuthRedirect: true }).catch(() => {});
  try { await nativePlugin('PushNotifications')?.unregister(); } catch { /* nothing to undo */ }
  write(TOKEN_KEY, null);
}

/** After login / app start: bind the phone's events, work out whether to offer notifications, and re-attach this phone to the account. */
async function syncNativePush() {
  const PN = nativePlugin('PushNotifications');
  if (!PN) return;
  bindNativeEvents(PN);
  const [perm, ready] = await Promise.all([nativePermission(PN), nativeSenderReady()]);
  nativeOfferOk = ready && perm !== 'denied';
  window.dispatchEvent(new Event('nullchat-push-offer'));
  if (!pushWanted()) return;
  if (perm !== 'granted') { write(ON_KEY, null); return; } // the person switched them off in the phone’s settings
  if (!ready) return;
  try { await PN.register(); } catch { /* try again next start */ } // (the phone answers with its address: bindNativeEvents passes it on)
}

/** Turn background notifications on for this device. Must be called from a click (browsers ask for permission). */
export async function enablePush() {
  if (inNativeApp()) return enableNativePush();
  const sup = pushSupport();
  if (!sup.ok) throw new Error('This device can’t receive background notifications yet.');
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Allow them for NullChat in your phone or browser settings, then try again.' : 'Notifications were not allowed.');
  const reg = await registration();
  await subscribeAndRegister(reg);
  write(ON_KEY, '1');
}

/** Turn them off: forget this device on the server and in the browser. */
export async function disablePush() {
  if (inNativeApp()) return disableNativePush();
  write(ON_KEY, null);
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint }, { noAuthRedirect: true }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* nothing to undo */ }
}

/** Log out: stop this account's notifications on this device, but remember that the device wants them for the next login. */
export async function detachPush() {
  if (inNativeApp()) {
    const token = read(TOKEN_KEY);
    if (pushWanted() && token) await api.post('/push/native/remove', { token }, { noAuthRedirect: true }).catch(() => {});
    return;
  }
  if (!pushWanted() || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.post('/push/unsubscribe', { endpoint: sub.endpoint }, { noAuthRedirect: true });
  } catch { /* offline: the server forgets a dead endpoint by itself */ }
}

/** After login / app start: re-attach this device to the logged-in account (browsers sometimes rotate the address). */
export async function syncPush() {
  if (inNativeApp()) return syncNativePush();
  if (!pushWanted()) return;
  const sup = pushSupport();
  if (!sup.ok) return;
  if (Notification.permission !== 'granted') { write(ON_KEY, null); return; } // the person revoked it in browser settings
  try { await subscribeAndRegister(await registration()); } catch { /* try again next start */ }
}

/** The "preview" switch: show the message text in notifications, or only "New message". */
export async function setPreview(on) {
  write(PREVIEW_KEY, on ? '1' : '0');
  if (pushWanted()) await syncPush();
}

/** The "every message" switch: also notify for all messages in the servers and channels you haven't muted (default: DMs, @mentions and replies only). */
export async function setEveryMessage(on) {
  write(ALL_KEY, on ? '1' : '0');
  if (pushWanted()) await syncPush();
}

/** { devices, sent } — sends a real notification through the whole chain. */
export const sendTestPush = () => api.post('/push/test');

/** Tapping a notification while the app is open: the service worker asks the page to open that chat. */
export function listenForNotificationTaps() {
  if (inNativeApp()) { const PN = nativePlugin('PushNotifications'); if (PN) bindNativeEvents(PN); return; }
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'nullchat-open' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) navigate(e.data.url);
  });
}

/** Current state for the settings screen. */
export async function pushStatus() {
  const support = pushSupport();
  if (support.native) {
    const PN = nativePlugin('PushNotifications');
    const [permission, serverReady] = await Promise.all([nativePermission(PN), nativeSenderReady()]);
    return { support, native: true, serverReady, permission, subscribed: pushWanted() && permission === 'granted' && serverReady, preview: previewEnabled(), everyMessage: everyMessageEnabled() };
  }
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  let subscribed = false;
  if (support.ok && pushWanted()) {
    try { subscribed = !!(await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()); } catch { /* ignore */ }
  }
  return { support, native: inNativeApp(), permission, subscribed: subscribed && permission === 'granted', preview: previewEnabled(), everyMessage: everyMessageEnabled() };
}

// ---- offering them on phones --------------------------------------------------------------------------------------------
// Turning this on lives in Settings, where hardly anyone looks, so a phone that could receive them is asked once (a slim bar,
// "Turn on"). "Not now" asks again in two weeks. iPhones that haven't added NullChat to the Home Screen can't receive them yet:
// they see the install bar instead, which says why.
const PROMPT_KEY = 'nullchat.pushPromptHidden';
const promptHidden = () => Date.now() - Number(read(PROMPT_KEY) || 0) < 14 * 24 * 3600 * 1000;
export const hidePushPrompt = () => write(PROMPT_KEY, String(Date.now()));
/** Should this phone or tablet be asked to turn on closed-app notifications right now? */
export function shouldOfferPush() {
  if (inNativeApp()) return nativeOfferOk && !pushWanted() && !promptHidden();
  if (desktop || !installEnv().mobile) return false;
  if (!pushSupport().ok) return false;
  if (!('Notification' in window) || Notification.permission === 'denied') return false;
  return !pushWanted() && !promptHidden();
}

/** The person has read this chat (or is looking at it): take its notifications out of the notification shade. */
export async function closeNotificationsFor(channelId) {
  if (channelId && inNativeApp()) {
    try {
      const PN = nativePlugin('PushNotifications');
      const { notifications = [] } = (await PN?.getDeliveredNotifications()) || {};
      const mine = notifications.filter((n) => n.tag === channelId || n.data?.channelId === channelId);
      if (mine.length) await PN.removeDeliveredNotifications({ notifications: mine });
    } catch { /* nothing to close */ }
    return;
  }
  if (!channelId || !('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    for (const n of (await reg?.getNotifications({ tag: channelId })) || []) n.close();
  } catch { /* nothing to close */ }
}
