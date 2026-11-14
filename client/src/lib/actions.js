// Higher-level actions shared by components.
import { api, uploadFile, setToken } from './api.js';
import { forgetAccount } from './accounts.js';
import { store, isChannelUnread, handleEvent } from './state.js';
import { navigate } from './router.jsx';
import { toast, toastError } from './toast.js';
import { disconnect } from './gateway.js';
import { leaveVoice } from './voice.js';
import { uiStore } from './ui.js';
import { clearStoredDrafts } from './drafts.js';
import { detachPush } from './push.js';

const PAGE = 50;

function setEntry(channelId, patch) {
  const s = store.get();
  const cur = s.messages[channelId] || { list: [], hasMore: true, loaded: false, loading: false, hasNewer: false };
  store.set({ messages: { ...s.messages, [channelId]: { ...cur, ...patch } } });
}

export async function loadMessages(channelId, { before, force } = {}) {
  const s = store.get();
  const entry = s.messages[channelId];
  if (entry?.loading) return;
  if (!before && entry?.loaded && !force && !entry.hasNewer) return;
  setEntry(channelId, { loading: true });
  try {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (before) q.set('before', before);
    const rows = await api.get(`/channels/${channelId}/messages?${q}`);
    const list = rows.slice().reverse();
    const cur = store.get().messages[channelId];
    if (before && cur) {
      const ids = new Set(cur.list.map((m) => m.id));
      setEntry(channelId, { list: [...list.filter((m) => !ids.has(m.id)), ...cur.list], hasMore: rows.length === PAGE, loading: false });
    } else {
      const pendingList = (cur?.list || []).filter((m) => m.pending);
      setEntry(channelId, { list: [...list, ...pendingList], hasMore: rows.length === PAGE, loaded: true, loading: false, hasNewer: false, focusId: null });
    }
  } catch (e) {
    setEntry(channelId, { loading: false, loaded: true, error: e.message });
  }
}

/** Load messages around a specific message (for jumping to replies, search results, pins). */
export async function jumpToMessage(channelId, messageId) {
  const entry = store.get().messages[channelId];
  if (entry?.list.some((m) => m.id === messageId)) {
    setEntry(channelId, { focusId: messageId, focusAt: Date.now() });
    return;
  }
  setEntry(channelId, { loading: true });
  try {
    const rows = await api.get(`/channels/${channelId}/messages?around=${messageId}&limit=50`);
    const ch = store.get().channels[channelId];
    const list = rows.slice().reverse();
    const hasNewer = !!(ch?.lastMessageId && list.length && list[list.length - 1].id < ch.lastMessageId);
    setEntry(channelId, { list, hasMore: true, loaded: true, loading: false, hasNewer, focusId: messageId, focusAt: Date.now() });
  } catch (e) {
    setEntry(channelId, { loading: false });
    toastError(e);
  }
}

export async function loadNewer(channelId) {
  const entry = store.get().messages[channelId];
  if (!entry?.hasNewer || entry.loading || !entry.list.length) return;
  setEntry(channelId, { loading: true });
  try {
    const last = entry.list[entry.list.length - 1].id;
    const rows = await api.get(`/channels/${channelId}/messages?after=${last}&limit=50`);
    const list = rows.slice().reverse();
    const cur = store.get().messages[channelId];
    const ids = new Set(cur.list.map((m) => m.id));
    setEntry(channelId, { list: [...cur.list, ...list.filter((m) => !ids.has(m.id))], hasNewer: rows.length === 50, loading: false });
  } catch { setEntry(channelId, { loading: false }); }
}

let nonceSeq = 0;
/** `gif`: an uploaded GIF. It is sent by id and shows straight away, without the link being fetched. */
//   quietTo: the people who may see it (a quiet reply, components/Quiet.jsx): text only, sent to its own endpoint.
export async function sendMessage(channelId, content, { replyTo = null, files = [], silent = false, gif = null, sticker = null, quietTo = null } = {}) {
  const s = store.get();
  const nonce = `${Date.now()}${++nonceSeq}`;
  const pending = {
    id: `pending-${nonce}`,
    nonce,
    pending: true,
    channelId,
    author: s.users[s.me.id] || s.me,
    content,
    createdAt: Date.now(),
    attachments: files.map((f, i) => ({ id: `p${i}`, filename: f.name, size: f.size, contentType: f.type, url: null, progress: 0 })),
    embeds: gif ? [{ type: 'image', url: gif.url, image: { url: gif.url }, alt: gif.name }] : [], reactions: [], mentions: [],
    stickers: sticker ? [{ id: sticker.id, name: sticker.name, url: sticker.url, animated: sticker.animated, guildId: sticker.guildId }] : [],
    replyTo: replyTo ? { id: replyTo.id, author: replyTo.author, content: replyTo.content } : null,
    type: replyTo ? 19 : 0,
    // Everything needed to send it again if it fails: "Retry" must bring the reply, the files, the silent mark and the GIF along, not only the words.
    retry: { replyTo, files, silent, gif, sticker, quietTo },
    ...(quietTo ? { quiet: { viewers: quietTo.map((id) => s.users[id]).filter(Boolean) } } : {}),
  };
  const entry = store.get().messages[channelId];
  const shown = !!(entry?.loaded && !entry.hasNewer);   // (the person can see it sending)
  if (shown) setEntry(channelId, { list: [...entry.list, pending] });
  const updatePending = (fn) => {
    const e = store.get().messages[channelId];
    if (!e) return;
    setEntry(channelId, { list: e.list.map((m) => (m.nonce === nonce && m.pending ? fn(m) : m)) });
  };
  // It did not go. The list can have been rebuilt while it was on its way (the connection came back and everything was loaded again): the
  // message must still show up as "failed to send", with Retry, never just disappear.
  const markFailed = (error) => {
    const e = store.get().messages[channelId];
    if (e?.list.some((m) => m.nonce === nonce && m.pending)) updatePending((m) => ({ ...m, failed: true, error }));
    else if (shown) setEntry(channelId, { list: [...(e?.list || []), { ...pending, failed: true, error }] });
  };
  try {
    const attachmentIds = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const res = await uploadFile(`/attachments?filename=${encodeURIComponent(f.name)}&spoiler=${f.spoiler ? 'true' : 'false'}${f.description?.trim() ? `&description=${encodeURIComponent(f.description.trim().slice(0, 1000))}` : ''}`, f.file || f, (p) => {
        updatePending((m) => ({ ...m, attachments: m.attachments.map((a, j) => (j === i ? { ...a, progress: p } : a)) }));
      });
      attachmentIds.push(res.id);
    }
    const sent = quietTo
      ? await api.post(`/channels/${channelId}/quiet-replies`, { content, replyTo: replyTo.id, viewers: quietTo, nonce })
      : await api.post(`/channels/${channelId}/messages`, { content, replyTo: replyTo?.id || null, attachmentIds, nonce, silent, gifId: gif?.id, stickerIds: sticker ? [sticker.id] : [], mentionReplied: replyTo?.mention !== false });
    // The answer is the message itself: show it as sent now. (The live event for it does the same later and changes nothing; it is the only
    // way it arrives if the connection was down or coming back at that moment.)
    if (sent?.id) handleEvent('MESSAGE_CREATE', sent);
  } catch (e) {
    markFailed(e.message);
    toast(e.message, 'error', 6000);
  }
}

export function removeFailedMessage(channelId, nonce) {
  const e = store.get().messages[channelId];
  if (e) setEntry(channelId, { list: e.list.filter((m) => m.nonce !== nonce) });
}

const ackTimers = new Map();
/** channel id -> the read mark it had just before it was last marked read here, and when. */
export const recentAcks = new Map();
export function ackChannel(channelId, force = false) {
  const s = store.get();
  const ch = s.channels[channelId];
  if (!ch) return;
  const rs = s.readStates[channelId];
  if (!force && !isChannelUnread(s, channelId) && !rs?.mentionCount) return;
  recentAcks.set(channelId, { lastReadId: rs?.lastReadId || null, at: Date.now() });   // (the catch-up card needs to know what was unread a moment ago: lib/catchup.js)
  // Optimistic local update
  store.set({ readStates: { ...s.readStates, [channelId]: { channelId, lastReadId: ch.lastMessageId, mentionCount: 0 } } });
  clearTimeout(ackTimers.get(channelId));
  ackTimers.set(channelId, setTimeout(() => {
    api.post(`/channels/${channelId}/ack`, { messageId: store.get().channels[channelId]?.lastMessageId || null }).catch(() => {});
  }, 300));
}

export async function markUnread(channelId, messageId) {
  // The channel counts as read up to the message before this one. The server knows which message that is even when it isn't loaded here
  // (and how many of the messages from there on mention you), so its answer is the one kept; what is loaded just makes it show at once.
  const apply = (lastReadId, mentionCount) => {
    const s = store.get();
    store.set({ readStates: { ...s.readStates, [channelId]: { channelId, lastReadId, mentionCount } } });
    window.dispatchEvent(new CustomEvent('nullchat:marked-unread', { detail: { channelId, lastReadId } }));
  };
  const entry = store.get().messages[channelId];
  const idx = entry?.list.findIndex((m) => m.id === messageId) ?? -1;
  if (idx > 0) apply(entry.list[idx - 1].id, store.get().readStates[channelId]?.mentionCount || 0);
  try {
    const r = await api.post(`/channels/${channelId}/unread`, { messageId });
    apply(r.lastReadId, r.mentionCount);
    return true;
  } catch (e) { toastError(e); return false; }
}

export async function ackGuild(guildId) {
  const s = store.get();
  const readStates = { ...s.readStates };
  for (const id of s.guildChannels[guildId] || []) {
    const ch = s.channels[id];
    if (ch?.lastMessageId) readStates[id] = { channelId: id, lastReadId: ch.lastMessageId, mentionCount: 0 };
  }
  store.set({ readStates });
  await api.post(`/guilds/${guildId}/ack`).catch(() => {});
}

export async function openDM(userId) {
  try {
    const ch = await api.post('/users/@me/channels', { recipientId: userId });
    navigate(`/channels/@me/${ch.id}`);
    return ch;
  } catch (e) { toastError(e); return null; }
}

export async function logout() {
  const myId = store.get().me?.id; // (read before anything below clears it)
  try { await leaveVoice({ silent: true }); } catch { /* ignore */ }
  try { await detachPush(); } catch { /* ignore */ } // (needs the session, so before logging out) this phone stops getting this account's notifications
  try { await api.post('/auth/logout'); } catch { /* ignore */ }
  disconnect();
  setToken(null);
  forgetAccount(myId);   // (if it was one of the accounts kept for switching)
  clearStoredDrafts(myId);
  uiStore.set({ drafts: {}, replyTo: {} }); // the next person to log in on this page must not see these
  store.set({ status: 'idle', me: null, guilds: {}, channels: {}, messages: {}, users: {}, saved: {}, gifFavorites: null, gifFavoritesFailed: false });
  navigate('/login', { replace: true });
}

export async function setStatus(status) {
  try { await api.patch('/users/@me/presence', { status }); } catch (e) { toastError(e); }
}

export async function toggleReaction(channelId, message, emoji) {
  const myId = store.get().me.id;
  const existing = message.reactions?.find((r) => r.emoji === emoji);
  const mine = existing?.users.includes(myId);
  try {
    if (mine) await api.del(`/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`);
    else await api.put(`/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`);
  } catch (e) { toastError(e); }
}

export function channelPath(ch) {
  if (!ch) return '/channels/@me';
  if (!ch.guildId) return `/channels/@me/${ch.id}`;
  if (ch.type === 11) return `/channels/${ch.guildId}/${ch.parentId}?thread=${ch.id}`;
  return `/channels/${ch.guildId}/${ch.id}`;
}
