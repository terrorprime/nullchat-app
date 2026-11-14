// The site admin's announcement bar: loaded when the app starts, refreshed when it reconnects or comes back into view,
// and pushed live when the admin posts or removes one. Closing it is remembered per announcement.
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';

const KEY = 'nullchat.announcement.dismissed';
const read = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
store.set({ announcementDismissed: read() });

export function loadAnnouncement() {
  api.get('/announcement').then((r) => store.set({ announcement: r.announcement || null })).catch(() => {});
}
loadAnnouncement();
on('READY', loadAnnouncement);
on('ANNOUNCEMENT_UPDATE', (d) => store.set({ announcement: d.announcement || null }));
// Someone who left a tab open all day still gets the news when they come back to it (and logged-out pages have no live connection).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadAnnouncement(); });

export function dismissAnnouncement(id) {
  try { localStorage.setItem(KEY, id); } catch { /* private mode: it just comes back after a reload */ }
  store.set({ announcementDismissed: id });
}
