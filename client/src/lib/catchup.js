// The catch-up card ("while you were gone"): when it is shown, and the data behind it (server/src/routes/catchup.js).
import { store, guildHasUnread } from './state.js';
import { createStore } from './store.js';
import { api } from './api.js';
import { recentAcks } from './actions.js';
import { getSetting } from './settings.js';
import { toastError } from './toast.js';

export const catchUpStore = createStore({ card: null });   // { guildId, data, manual }

const COOLDOWN = 3 * 3600_000;   // after the card was shown for a server, it is not shown again by itself for this long
const KEY = 'nullchat.catchup';
const shownAt = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const remember = (guildId) => { try { const m = shownAt(); m[guildId] = Date.now(); localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private window */ } };

/** What the channels of this server looked like before this app opened one of them a moment ago (see actions.js ackChannel). */
function seenParam(guildId) {
  const s = store.get();
  const parts = [];
  for (const [cid, v] of recentAcks) {
    if (Date.now() - v.at > 8000 || s.channels[cid]?.guildId !== guildId) continue;
    parts.push(`${cid}:${v.lastReadId || '0'}`);
  }
  return parts.length ? `?seen=${parts.slice(0, 20).join(',')}` : '';
}

let seq = 0;
async function load(guildId, manual) {
  const mine = ++seq;
  const data = await api.get(`/guilds/${guildId}/catchup${seenParam(guildId)}`);
  if (mine !== seq) return null;   // (another server was opened meanwhile)
  return data;
}

/** Coming into a server: show the card when there is a real backlog, the person wants it, and it was not just shown. */
export async function maybeCatchUp(guildId) {
  if (getSetting('chat.catchUp') === false) return;
  const cur = catchUpStore.get().card;
  if (cur && cur.guildId !== guildId && !cur.manual) catchUpStore.set({ card: null });   // the card belongs to the server it was made for
  if (cur?.guildId === guildId) return;
  if (Date.now() - (shownAt()[guildId] || 0) < COOLDOWN) return;
  const s = store.get();
  const acked = [...recentAcks].some(([cid, v]) => Date.now() - v.at < 8000 && s.channels[cid]?.guildId === guildId);
  const mentions = (s.guildChannels[guildId] || []).some((id) => (s.readStates[id]?.mentionCount || 0) > 0);
  if (!acked && !mentions && !guildHasUnread(s, guildId)) return;   // nothing new: no need to ask
  try {
    const data = await load(guildId, false);
    if (!data || !data.worth) return;
    if (location.pathname.split('/')[2] !== guildId) return;   // (the person already went somewhere else)
    remember(guildId);
    catchUpStore.set({ card: { guildId, data, manual: false } });
  } catch { /* the card is a nicety: never an error in someone's face */ }
}

/** From the server's menu: always opens, also when there is nothing new. */
export async function openCatchUp(guildId) {
  try {
    const data = await load(guildId, true);
    if (!data) return;
    remember(guildId);
    catchUpStore.set({ card: { guildId, data, manual: true } });
  } catch (e) { toastError(e); }
}

export function closeCatchUp() { catchUpStore.set({ card: null }); }
