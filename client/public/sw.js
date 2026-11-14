// NullChat service worker: makes the web app installable, loads the app shell instantly and shows
// notifications when a message arrives while NullChat is closed (Web Push, see server/src/lib/push.js).
// API calls, the realtime gateway and uploads always go to the network.
const CACHE = 'nullchat-shell-v4';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/(api|gateway|uploads|emojis|downloads)\b/.test(url.pathname)) return;

  // Built assets have hashed names (and fonts never change): cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // Pages: network-first, fall back to the cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/')));
  }
});

// ---------------------------------------------------------------- background notifications (Web Push)
const isWebKit = () => /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android|Edg\/|OPR\//.test(navigator.userAgent);
/** A promise's result, or `fallback` if it fails or takes longer than `ms` (a push has to show its notification promptly). */
const within = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
const safePath = (u) => (typeof u === 'string' && /^\/(?!\/)/.test(u) ? u : '/channels/@me');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON: show the generic notification below */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // You are looking at NullChat right now, so the app already shows the message. (Safari insists that every
    // push shows something, or it takes the permission away, so there we always show it.)
    if (!data.test && !isWebKit() && wins.some((c) => c.focused || c.visibilityState === 'visible')) return;
    const tag = String(data.tag || 'nullchat');
    let body = String(data.body || 'You have a new message.').slice(0, 280);
    // A chat that already has an unread notification shows the newest message and how many came since, instead of quietly replacing it.
    let count = 1;
    if (data.stack) {
      const open = await within(self.registration.getNotifications({ tag }), 1500, []);   // (no list in time: show it as a single one)
      count = open.reduce((n, x) => Math.max(n, (x.data && x.data.count) || 1), 0) + 1;
      if (count > 1) body = `${body} (+${count - 1} more)`;
    }
    await self.registration.showNotification(String(data.title || 'NullChat').slice(0, 120), {
      body,
      icon: typeof data.icon === 'string' && /^\/uploads\/[\w./-]+$/.test(data.icon) ? data.icon : '/icon-192.png',
      badge: '/badge-96.png',
      tag,
      renotify: true, // each new message in a chat should alert again, not just replace the old one quietly
      timestamp: Number(data.ts) || Date.now(),
      data: { url: safePath(data.url), count },
    });
    // The number on the app's icon, kept right while the app is closed (the open app keeps it right by itself). After the notification
    // is up, and never waited on for long: a phone without icon badges must not hold the notification back.
    const nav = self.navigator;
    if (typeof data.unread === 'number' && nav && typeof nav.setAppBadge === 'function') {
      await within(data.unread > 0 ? nav.setAppBadge(data.unread) : nav.clearAppBadge(), 2000, null);
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      try { await win.focus(); } catch { /* may not be allowed: still tell the page */ }
      win.postMessage({ type: 'nullchat-open', url: path }); // the app switches to that chat without reloading
      return;
    }
    await self.clients.openWindow(path);
  })());
});
