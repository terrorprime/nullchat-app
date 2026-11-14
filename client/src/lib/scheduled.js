// Scheduled ("send later") messages: the list of what is waiting, creating / changing / cancelling them, and what happens
// when one cannot be sent (a toast that opens the Scheduled tab of the Inbox so you can fix or retry it).
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';
import { toast, toastError } from './toast.js';
import { timeUntil } from './saved.js';

export const MAX_SCHEDULED = 25;
const keyed = (items) => Object.fromEntries(items.map((x) => [x.id, x]));

on('READY', () => {
  api.get('/users/@me/scheduled').then((r) => store.set({ scheduled: keyed(r.items) })).catch(() => {});
});

on('SCHEDULED_UPDATE', (d) => {
  const cur = store.get().scheduled;
  const next = { ...cur };
  if (d.removed) {
    delete next[d.id];
    // Sent while you're looking at something else? Say so (it shows up in the channel itself otherwise).
    if (d.sent && cur[d.id] && !location.pathname.includes(cur[d.id].channelId)) {
      const where = cur[d.id].channelName ? ` to #${cur[d.id].channelName}` : '';
      toast(`Your scheduled message was sent${where}.`, 'success', 3500);
    }
  } else if (d.item) {
    next[d.item.id] = d.item;
    if (d.failed) {
      const where = d.item.channelName ? ` in #${d.item.channelName}` : '';
      toast(`Couldn’t send your scheduled message${where}: ${d.item.error || 'something went wrong'}`, 'error', 15000, {
        actionLabel: 'Review',
        onClick: () => openScheduledTab(),
      });
    }
  }
  store.set({ scheduled: next });
});

export function openScheduledTab() {
  import('../components/Inbox.jsx').then((m) => m.openInboxModal('scheduled'));
}

/** Pending items, soonest first. Failed ones come first so they get noticed. */
export function sortedScheduled(map) {
  return Object.values(map).sort((a, b) => (!!b.error - !!a.error) || a.sendAt - b.sendAt);
}
export const pendingCount = (map) => Object.values(map).filter((x) => !x.error).length;

export async function scheduleMessage(channelId, content, sendAt, { replyTo = null, silent = false } = {}) {
  try {
    const item = await api.post(`/channels/${channelId}/scheduled`, { content, sendAt, replyTo, silent });
    store.set({ scheduled: { ...store.get().scheduled, [item.id]: item } });
    return item;
  } catch (e) { toastError(e); return null; }
}
async function update(id, body) {
  try {
    const item = await api.patch(`/users/@me/scheduled/${id}`, body);
    store.set({ scheduled: { ...store.get().scheduled, [item.id]: item } });
    return item;
  } catch (e) { toastError(e); return null; }
}
export const rescheduleMessage = (id, sendAt) => update(id, { sendAt });
export const editScheduledText = (id, content) => update(id, { content });
/** A failed message: try it again in about a minute. */
export const retryScheduled = (id) => update(id, {});
export async function cancelScheduled(id) {
  try {
    await api.del(`/users/@me/scheduled/${id}`);
    const next = { ...store.get().scheduled }; delete next[id];
    store.set({ scheduled: next });
    return true;
  } catch (e) { toastError(e); return false; }
}
export async function sendScheduledNow(id) {
  try {
    await api.post(`/users/@me/scheduled/${id}/send-now`, {});
    const next = { ...store.get().scheduled }; delete next[id];
    store.set({ scheduled: next });
    return true;
  } catch (e) { toastError(e); return false; }
}

// ---- times -------------------------------------------------------------------------------------------------------
const at = (d, h, m = 0) => { d.setHours(h, m, 0, 0); return d.getTime(); };
export function schedulePresets(now = new Date()) {
  const list = [{ label: 'In 1 hour', at: now.getTime() + 60 * 60_000 }];
  if (now.getHours() < 17) list.push({ label: 'This evening at 6:00 PM', at: at(new Date(now), 18) });
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  list.push({ label: 'Tomorrow at 9:00 AM', at: at(tomorrow, 9) });
  const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  if (monday.toDateString() !== tomorrow.toDateString()) list.push({ label: 'Monday at 9:00 AM', at: at(monday, 9) });
  return list;
}

/** "in 3 hours · Fri, Nov 6, 9:00 AM" */
export const shortWhen = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const describeTime = (ts) => `${timeUntil(ts)} · ${shortWhen(ts)}`;
