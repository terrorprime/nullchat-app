// "Save for later" and reminders: which messages you saved, setting / clearing a reminder, and what happens
// when a reminder is due (a clickable toast, a sound, and a desktop notification when the app is in the background).
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';
import { toast, toastError } from './toast.js';
import { play } from './sounds.js';
import { getSetting } from './settings.js';
import { jumpToMessage, channelPath } from './actions.js';
import { navigate } from './router.jsx';

const keyed = (items) => Object.fromEntries(items.map((x) => [x.messageId, { channelId: x.channelId, savedAt: x.savedAt, remindAt: x.remindAt, reminded: !!x.reminded }]));

on('READY', () => {
  api.get('/users/@me/saved/ids').then((r) => store.set({ saved: keyed(r.items) })).catch(() => {});
});
on('SAVED_UPDATE', (d) => {
  const saved = { ...store.get().saved };
  if (d.saved === false) delete saved[d.messageId];
  else saved[d.messageId] = { channelId: d.channelId, savedAt: d.savedAt, remindAt: d.remindAt, reminded: !!d.reminded };
  store.set({ saved });
});

/** Open a message in context (switches channel first, then scrolls to it). */
export function goToMessage(channelId, messageId, guildId) {
  const ch = store.get().channels[channelId];
  if (ch) navigate(channelPath(ch));
  else if (guildId) navigate(`/channels/${guildId}/${channelId}`);
  setTimeout(() => jumpToMessage(channelId, messageId), 60);
}

on('REMINDER', (d) => {
  play('mention');
  const who = d.authorName ? `${d.authorName}: ` : '';
  const where = d.channelName ? ` (#${d.channelName})` : '';
  const text = d.preview || 'a saved message';
  toast(`⏰ Reminder${where} — ${who}${text}`, 'info', 25000, {
    onClick: () => goToMessage(d.channelId, d.messageId, d.guildId),
    actionLabel: 'Open',
    actions: [{ label: 'Snooze 10 min', onClick: () => snooze(d.channelId, d.messageId) }],
  });
  const focused = document.hasFocus() && document.visibilityState === 'visible';
  if (!focused && getSetting('notifications.desktop') && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('Reminder', { body: `${who}${text}`.slice(0, 200), icon: '/icon-192.png', tag: `reminder-${d.messageId}` });
      n.onclick = () => { window.focus(); goToMessage(d.channelId, d.messageId, d.guildId); n.close(); };
    } catch { /* some browsers need a service worker for notifications */ }
  }
});

async function snooze(channelId, messageId, minutes = 10) {
  if (await saveMessage({ id: messageId, channelId }, Date.now() + minutes * 60_000)) toast(`Snoozed. I’ll remind you again in ${minutes} minutes.`, 'success', 2500);
}

const path = (m) => `/channels/${m.channelId}/messages/${m.id}/save`;

export async function saveMessage(m, remindAt) {
  try {
    const body = remindAt === undefined ? {} : { remindAt };
    await api.put(path(m), body);
    return true;
  } catch (e) { toastError(e); return false; }
}
export async function unsaveMessage(m) {
  try { await api.del(path(m)); return true; } catch (e) { toastError(e); return false; }
}
export async function toggleSaved(m) {
  if (store.get().saved[m.id]) {
    if (await unsaveMessage(m)) toast('Removed from Saved', 'success', 1800);
  } else if (await saveMessage(m)) toast('Saved for later. Find it in your Inbox → Saved.', 'success', 2600);
}

// ---- reminder times ----------------------------------------------------------------------------------------------
const at9 = (d) => { d.setHours(9, 0, 0, 0); return d.getTime(); };
export function reminderPresets(now = new Date()) {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  return [
    { label: 'In 20 minutes', at: now.getTime() + 20 * 60_000 },
    { label: 'In 1 hour', at: now.getTime() + 60 * 60_000 },
    { label: 'In 3 hours', at: now.getTime() + 3 * 60 * 60_000 },
    { label: 'Tomorrow at 9:00 AM', at: at9(tomorrow) },
    { label: 'Next Monday at 9:00 AM', at: at9(monday) },
  ];
}

/** "in 3 hours", "in 2 days", "any moment now" */
export function timeUntil(ts, now = Date.now()) {
  const ms = ts - now;
  if (ms < 45_000) return 'any moment now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.round(ms / 3_600_000);
  if (hr < 36) return `in ${hr} hour${hr === 1 ? '' : 's'}`;
  const day = Math.round(ms / 86_400_000);
  return `in ${day} day${day === 1 ? '' : 's'}`;
}
