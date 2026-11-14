// Application state + reducers for realtime gateway events.
import { createStore, useStoreOf } from './store.js';
import { ChannelType, computeChannelPermissions, computeBasePermissions, P, has, isTextLike, isVoiceLike } from '../../../shared/permissions.js';
import { toast } from './toast.js';

export const store = createStore({
  status: 'idle', // idle | connecting | ready | reconnecting
  me: null,
  settings: {},
  users: {},
  presences: {},
  guilds: {},          // id -> guild (without channels/members)
  guildChannels: {},   // guildId -> [channelIds]
  channels: {},        // id -> channel (guild channels, threads, DMs)
  members: {},         // guildId -> { userId -> member }
  privateChannelIds: [],
  relationships: {},   // userId -> { id, type, nickname, since }
  messages: {},        // channelId -> { list: [], hasMore, loading, loaded, hasNewer }
  readStates: {},      // channelId -> { lastReadId, mentionCount }
  typing: {},          // channelId -> { userId: ts }
  commands: {},        // guildId -> [{ id, botId, name, description, options }]  (slash commands from the bots in that server)
  voiceStates: {},     // userId -> state
  calls: {},           // channelId -> call
  guildSettings: {},   // guildId -> settings
  iceServers: [],
  features: {},
  saved: {},           // messageId -> { channelId, savedAt, remindAt, reminded }  ("Save for later")
  gifFavorites: null,  // the GIFs you starred, newest first (null until they are loaded)
  gifFavoritesFailed: false,
  scheduled: {},       // id -> { id, channelId, guildId, channelName, guildName, content, replyToId, silent, sendAt, error }  ("Send later")
  announcement: null,  // { id, text, level, createdAt, by } set by the site admin, or null
  announcementDismissed: '', // id of the announcement this person closed
  streaks: { dms: {}, guilds: {} },   // channel id / server id -> { count, best, lastDay, tz }  (days in a row: lib/streaks.js)
  music: {},           // voice channel id -> the room's music queue { tracks, playing, positionMs, locked, receivedAt }  (lib/music.js)
  sessionId: null,
});

export const useStore = (selector) => useStoreOf(store, selector);
export const getState = () => store.get();
export const setState = (p) => store.set(p);

// ---------- helpers ----------
const omit = (obj, key) => { const o = { ...obj }; delete o[key]; return o; };

function indexGuild(state, g) {
  const guilds = { ...state.guilds };
  const { channels: chs = [], threads = [], members: mem = [], ...core } = g;
  guilds[g.id] = core;
  const channels = { ...state.channels };
  // Remove channels of this guild that no longer exist / are no longer visible.
  for (const id of state.guildChannels[g.id] || []) delete channels[id];
  for (const c of Object.values(state.channels)) if (c.guildId === g.id && c.type === ChannelType.THREAD) delete channels[c.id];
  for (const c of chs) channels[c.id] = c;
  for (const t of threads) channels[t.id] = { ...(state.channels[t.id] || {}), ...t };
  const members = { ...state.members, [g.id]: Object.fromEntries(mem.map((m) => [m.userId, m])) };
  return { guilds, channels, members, guildChannels: { ...state.guildChannels, [g.id]: chs.map((c) => c.id) } };
}

function upsertMessage(list, msg) {
  const idx = list.findIndex((m) => m.id === msg.id || (msg.nonce && m.nonce === msg.nonce && m.pending));
  if (idx >= 0) { const copy = list.slice(); copy[idx] = { ...msg, pending: false, failed: false }; return copy; }
  // Insert keeping order by id.
  if (!list.length || list[list.length - 1].id <= msg.id || list[list.length - 1].pending) {
    const pendingStart = list.findIndex((m) => m.pending);
    if (pendingStart >= 0) return [...list.slice(0, pendingStart), msg, ...list.slice(pendingStart)];
    return [...list, msg];
  }
  const copy = [...list, msg];
  copy.sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return copy;
}

function patchMessage(state, channelId, id, fn) {
  const entry = state.messages[channelId];
  if (!entry) return null;
  const idx = entry.list.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const list = entry.list.slice();
  list[idx] = fn(list[idx]);
  return { messages: { ...state.messages, [channelId]: { ...entry, list } } };
}

/** After (re)connecting, every channel's messages are loaded again from scratch. Messages that failed to send are not on the server, so they
 *  are kept (and put back among the loaded ones when the channel is opened): what a person wrote must not disappear because the connection did. */
function keepUnsent(messages) {
  const out = {};
  for (const [id, e] of Object.entries(messages || {})) {
    const failed = (e.list || []).filter((m) => m.failed);
    if (failed.length) out[id] = { list: failed, hasMore: true, loaded: false, loading: false, hasNewer: false };
  }
  return out;
}

// ---------- gateway event reducer ----------
export function handleEvent(t, d) {
  const s = store.get();
  switch (t) {
    case 'READY': {
      let next = {
        status: 'ready',
        me: d.user,
        settings: d.settings || {},
        users: Object.fromEntries(d.users.map((u) => [u.id, u])),
        presences: Object.fromEntries(d.presences.map((p) => [p.userId, p])),
        relationships: Object.fromEntries(d.relationships.map((r) => [r.id, r])),
        readStates: Object.fromEntries(d.readStates.map((r) => [r.channelId, r])),
        voiceStates: Object.fromEntries(d.voiceStates.map((v) => [v.userId, v])),
        calls: Object.fromEntries(d.calls.map((c) => [c.channelId, c])),
        guildSettings: Object.fromEntries(d.guildSettings.map((g) => [g.guildId, g])),
        iceServers: d.iceServers,
        features: d.features,
        sessionId: d.sessionId,
        guilds: {}, guildChannels: {}, channels: {}, members: {},
        messages: keepUnsent(s.messages), typing: {},
        privateChannelIds: d.privateChannels.map((c) => c.id),
      };
      next.users[d.user.id] = d.user;
      for (const c of d.privateChannels) next.channels[c.id] = c;
      for (const g of d.guilds) next = { ...next, ...indexGuild(next, g) };
      store.set(next);
      break;
    }
    case 'USER_UPDATE': {
      const users = { ...s.users, [d.id]: { ...(s.users[d.id] || {}), ...d } };
      store.set(d.id === s.me?.id ? { users, me: { ...s.me, ...d } } : { users });
      break;
    }
    case 'TAG_UPDATE': {
      // A server changed (or removed) its tag: everyone on screen who wears it shows the new one at once.
      const fix = (u) => (u?.serverTag?.guildId === d.guildId ? { ...u, serverTag: d.tag ? { guildId: d.guildId, ...d.tag } : null } : u);
      const users = {};
      let changed = false;
      for (const [id, u] of Object.entries(s.users)) { const n = fix(u); if (n !== u) changed = true; users[id] = n; }
      const patch = changed ? { users } : {};
      if (s.me?.serverTag?.guildId === d.guildId) patch.me = fix(s.me);
      if (changed || patch.me) store.set(patch);
      break;
    }
    case 'USER_SETTINGS_UPDATE':
      store.set({ settings: d });
      break;
    case 'LEVEL_UP':
      toast(`You reached level ${d.level}!`, 'success');
      break;
    case 'PRESENCE_UPDATE':
      store.set({ presences: { ...s.presences, [d.userId]: d } });
      break;
    case 'RELATIONSHIP_ADD': {
      const { user, presence, ...rel } = d;
      const patch = { relationships: { ...s.relationships, [d.id]: rel } };
      if (user) patch.users = { ...s.users, [user.id]: user };
      if (presence) patch.presences = { ...s.presences, [presence.userId]: presence };
      store.set(patch);
      break;
    }
    case 'RELATIONSHIP_REMOVE':
      store.set({ relationships: omit(s.relationships, d.id) });
      break;
    case 'GUILD_SYNC': {
      const users = { ...s.users };
      store.set({ ...indexGuild(s, d), users });
      break;
    }
    case 'GUILD_DELETE': {
      const guilds = omit(s.guilds, d.id);
      const channels = { ...s.channels };
      for (const c of Object.values(channels)) if (c.guildId === d.id) delete channels[c.id];
      store.set({ guilds, channels, members: omit(s.members, d.id), guildChannels: omit(s.guildChannels, d.id), commands: omit(s.commands, d.id) });
      break;
    }
    case 'GUILD_MEMBER_ADD': {
      const members = { ...s.members, [d.guildId]: { ...(s.members[d.guildId] || {}), [d.member.userId]: d.member } };
      store.set({ members, users: { ...s.users, [d.user.id]: d.user } });
      break;
    }
    case 'GUILD_MEMBER_UPDATE': {
      if (!s.members[d.guildId]) break;
      store.set({ members: { ...s.members, [d.guildId]: { ...s.members[d.guildId], [d.member.userId]: d.member } } });
      break;
    }
    case 'GUILD_MEMBER_REMOVE': {
      if (!s.members[d.guildId]) break;
      store.set({ members: { ...s.members, [d.guildId]: omit(s.members[d.guildId], d.userId) } });
      break;
    }
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE': {
      const channels = { ...s.channels, [d.id]: d };
      const patch = { channels };
      if (!d.guildId && !s.privateChannelIds.includes(d.id)) patch.privateChannelIds = [d.id, ...s.privateChannelIds];
      store.set(patch);
      break;
    }
    case 'CHANNEL_DELETE':
      store.set({ channels: omit(s.channels, d.id), privateChannelIds: s.privateChannelIds.filter((x) => x !== d.id) });
      break;
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      store.set({ channels: { ...s.channels, [d.id]: { ...(s.channels[d.id] || {}), ...d } } });
      break;
    case 'THREAD_DELETE':
      store.set({ channels: omit(s.channels, d.id) });
      break;
    case 'MESSAGE_CREATE': {
      const ch = s.channels[d.channelId];
      const patch = {};
      // A private answer to a slash command (only this person gets it, nothing is stored): show it in the list, but it is not
      // "new" for unread counts and it doesn't count as the channel's latest message.
      if (d.ephemeral) {
        const entry = s.messages[d.channelId];
        const eph = {};
        if (entry?.loaded && !entry.hasNewer) eph.messages = { ...s.messages, [d.channelId]: { ...entry, list: upsertMessage(entry.list, d) } };
        if (s.typing[d.channelId]?.[d.author.id]) eph.typing = { ...s.typing, [d.channelId]: omit(s.typing[d.channelId], d.author.id) }; // the bot answered: it is no longer "typing"
        if (eph.messages || eph.typing) store.set(eph);
        break;
      }
      // (a quiet reply is not one of the channel's ordinary messages: it does not become the channel's latest message)
      if (ch && !d.quiet) patch.channels = { ...s.channels, [ch.id]: { ...ch, lastMessageId: d.id > (ch.lastMessageId || '') ? d.id : ch.lastMessageId } };
      const entry = s.messages[d.channelId];
      if (entry?.loaded && !entry.hasNewer) patch.messages = { ...s.messages, [d.channelId]: { ...entry, list: upsertMessage(entry.list, d) } };
      // (a webhook's author is left out: its name and picture can change from one message to the next, so they are read from each message)
      if (!d.author.webhook && (!s.users[d.author.id] || s.users[d.author.id] !== d.author)) patch.users = { ...s.users, [d.author.id]: { ...(s.users[d.author.id] || {}), ...d.author } };
      // Remove typing indicator for the author.
      if (s.typing[d.channelId]?.[d.author.id]) patch.typing = { ...s.typing, [d.channelId]: omit(s.typing[d.channelId], d.author.id) };
      // Unread bookkeeping
      if (d.author.id === s.me?.id) {
        if (!d.quiet) patch.readStates = { ...s.readStates, [d.channelId]: { channelId: d.channelId, lastReadId: d.id, mentionCount: 0 } };
      } else if (isMentioned(s, d) || (ch && !ch.guildId)) {
        const rs = s.readStates[d.channelId] || { channelId: d.channelId, lastReadId: null, mentionCount: 0 };
        patch.readStates = { ...s.readStates, [d.channelId]: { ...rs, mentionCount: rs.mentionCount + 1 } };
      }
      // Bump DM to top
      if (ch && !ch.guildId) patch.privateChannelIds = [ch.id, ...s.privateChannelIds.filter((x) => x !== ch.id)];
      store.set(patch);
      break;
    }
    case 'MESSAGE_UPDATE': {
      const entry = s.messages[d.channelId];
      if (!entry) break;
      // Update the message itself and any reply previews that quote it.
      const list = entry.list.map((m) => {
        if (m.id === d.id) return { ...m, ...d };
        if (m.replyTo?.id === d.id && m.replyTo.content !== d.content) return { ...m, replyTo: { ...m.replyTo, content: d.content.slice(0, 200) } };
        return m;
      });
      store.set({ messages: { ...s.messages, [d.channelId]: { ...entry, list } } });
      break;
    }
    case 'MESSAGE_DELETE': {
      const entry = s.messages[d.channelId];
      if (entry) {
        const list = entry.list.filter((m) => m.id !== d.id).map((m) => (m.replyTo?.id === d.id ? { ...m, replyTo: { id: d.id, deleted: true } } : m));
        store.set({ messages: { ...s.messages, [d.channelId]: { ...entry, list } } });
      }
      break;
    }
    case 'MESSAGE_DELETE_BULK': {
      const entry = s.messages[d.channelId];
      const ids = new Set(d.ids);
      if (entry) store.set({ messages: { ...s.messages, [d.channelId]: { ...entry, list: entry.list.filter((m) => !ids.has(m.id)) } } });
      break;
    }
    case 'MESSAGE_REACTIONS_UPDATE': {
      const p = patchMessage(s, d.channelId, d.messageId, (m) => ({ ...m, reactions: d.reactions }));
      if (p) store.set(p);
      break;
    }
    case 'TYPING_START': {
      if (d.userId === s.me?.id) break;
      store.set({ typing: { ...s.typing, [d.channelId]: { ...(s.typing[d.channelId] || {}), [d.userId]: Date.now() } } });
      break;
    }
    case 'STREAK_UPDATE': {   // a streak went up: a direct message's (channelId) or a server's (guildId)
      const st = s.streaks;
      store.set({ streaks: d.channelId ? { ...st, dms: { ...st.dms, [d.channelId]: d.streak } } : { ...st, guilds: { ...st.guilds, [d.guildId]: d.streak } } });
      if (streakListener) streakListener(d);
      break;
    }
    case 'VOICE_MUSIC': {     // the music queue of a voice channel changed (the whole queue arrives each time)
      const music = { ...s.music };
      if (d.tracks.length) music[d.channelId] = { ...d, receivedAt: Date.now() }; else delete music[d.channelId];
      store.set({ music });
      if (voiceMusicListener) voiceMusicListener(d);
      break;
    }
    case 'VOICE_MOOD':   // someone changed the room sound of a voice channel (the channel itself arrives as CHANNEL_UPDATE)
      if (voiceMoodListener) voiceMoodListener(d);
      break;
    case 'READ_STATE_UPDATE':
      store.set({ readStates: { ...s.readStates, [d.channelId]: d } });
      break;
    case 'GUILD_SETTINGS_UPDATE':
      store.set({ guildSettings: { ...s.guildSettings, [d.guildId]: d } });
      break;
    case 'VOICE_STATE_UPDATE': {
      const voiceStates = { ...s.voiceStates };
      if (!d.channelId) delete voiceStates[d.userId];
      else voiceStates[d.userId] = d;
      store.set({ voiceStates });
      break;
    }
    case 'CALL_UPDATE':
      store.set({ calls: { ...s.calls, [d.channelId]: d } });
      break;
    case 'CALL_DELETE':
      store.set({ calls: omit(s.calls, d.channelId) });
      break;
    default:
      break;
  }
}

let streakListener = null;
/** Who to tell when a streak goes up (the app shell: a note at the milestones). */
export function onStreak(fn) { streakListener = fn; }
let voiceMusicListener = null;
/** Who to tell when a room's music changes (the app shell: a note for the people in that room). */
export function onVoiceMusic(fn) { voiceMusicListener = fn; }
let voiceMoodListener = null;
/** Who to tell when a room sound changes (the app shell sets this: a note for the people in that room). */
export function onVoiceMood(fn) { voiceMoodListener = fn; }

// ---------- selectors / derived helpers ----------
export function isMentioned(s, msg) {
  const me = s.me?.id;
  if (!me || msg.author?.id === me) return false;
  if (msg.mentions?.includes(me)) return true;
  const ch = s.channels[msg.channelId];
  if (!ch) return false;
  if (!ch.guildId) return false;
  const gs = s.guildSettings[ch.guildId];
  if (msg.mentionEveryone && !gs?.suppressEveryone) return true;
  const member = s.members[ch.guildId]?.[me];
  if (member && msg.mentionRoles?.some((r) => member.roles.includes(r))) return true;
  return false;
}

/**
 * The name to show for the author of a message. A message sent through a webhook carries the name it was sent with (a different one every time,
 * if the sender likes), so it is read from the message; everyone else is looked up as usual (their nickname here, a friend's nickname, their name).
 */
export function authorName(s, author, guildId) {
  if (author?.webhook) return author.displayName || author.username || 'Webhook';
  return displayName(s, author?.id, guildId);
}
/** Do two messages come from the same sender? (A webhook can send as many names as it likes: a different name or picture is a different sender.) */
export function sameSender(a, b) {
  if (a.id !== b.id) return false;
  return !a.webhook || (a.displayName === b.displayName && a.avatar === b.avatar);
}

export function displayName(s, userId, guildId) {
  const u = s.users[userId];
  const rel = s.relationships[userId];
  if (guildId) {
    const m = s.members[guildId]?.[userId];
    if (m?.nick) return m.nick;
  }
  if (rel?.nickname) return rel.nickname;
  return u?.displayName || u?.username || 'Unknown User';
}

export function guildPermissions(s, guildId) {
  const g = s.guilds[guildId];
  const m = s.members[guildId]?.[s.me?.id];
  if (!g || !m) return 0;
  return computeBasePermissions(g, m);
}

export function channelPermissions(s, channelId) {
  let ch = s.channels[channelId];
  if (!ch) return 0;
  if (!ch.guildId) {
    return P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS |
      P.CONNECT | P.SPEAK | P.STREAM | P.USE_EXTERNAL_EMOJIS | P.MENTION_EVERYONE;
  }
  if (ch.type === ChannelType.THREAD && s.channels[ch.parentId]) ch = s.channels[ch.parentId];
  const g = s.guilds[ch.guildId];
  const m = s.members[ch.guildId]?.[s.me?.id];
  if (!g || !m) return 0;
  return computeChannelPermissions(g, m, ch);
}

export function can(s, channelId, flag) { return has(channelPermissions(s, channelId), flag); }

export function memberColor(s, guildId, userId) {
  const g = s.guilds[guildId];
  const m = s.members[guildId]?.[userId];
  if (!g || !m) return null;
  if (s.settings?.accessibility?.roleColors === 'off') return null;
  let best = null;
  for (const r of g.roles) if (r.color && m.roles.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best ? '#' + best.color.toString(16).padStart(6, '0') : null;
}

export function isChannelUnread(s, channelId) {
  const ch = s.channels[channelId];
  if (!ch?.lastMessageId) return false;
  const rs = s.readStates[channelId];
  if (!rs) return true;
  return !rs.lastReadId || ch.lastMessageId > rs.lastReadId;
}

export function isChannelMuted(s, ch) {
  if (!ch) return false;
  const gs = s.guildSettings[ch.guildId || '@me'];
  if (!gs) return false;
  if (gs.channelOverrides?.[ch.id]?.muted) return true;
  if (ch.parentId && gs.channelOverrides?.[ch.parentId]?.muted) return true;
  return false;
}

export function sortedGuildChannels(s, guildId) {
  const ids = s.guildChannels[guildId] || [];
  const chs = ids.map((id) => s.channels[id]).filter(Boolean);
  const byPos = (a, b) => isVoiceLike(a.type) - isVoiceLike(b.type) || a.position - b.position || (a.id < b.id ? -1 : 1);
  const cats = chs.filter((c) => c.type === ChannelType.CATEGORY).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const uncategorized = chs.filter((c) => c.type !== ChannelType.CATEGORY && (!c.parentId || !s.channels[c.parentId])).sort(byPos);
  return {
    uncategorized,
    categories: cats.map((cat) => ({ category: cat, channels: chs.filter((c) => c.parentId === cat.id && c.type !== ChannelType.CATEGORY).sort(byPos) })),
  };
}

export function firstTextChannel(s, guildId) {
  const { uncategorized, categories } = sortedGuildChannels(s, guildId);
  const all = [...uncategorized, ...categories.flatMap((c) => c.channels)];
  return all.find((c) => isTextLike(c.type)) || null;
}

export function guildHasUnread(s, guildId) {
  const gs = s.guildSettings[guildId];
  if (gs?.muted) return false;
  for (const id of s.guildChannels[guildId] || []) {
    const ch = s.channels[id];
    if ((isTextLike(ch?.type) || ch?.type === ChannelType.FORUM) && !isChannelMuted(s, ch) && isChannelUnread(s, id)) return true;
  }
  return false;
}

/** Unread @mentions and DMs across everything that isn't muted. */
export function unreadMentionTotal(s) {
  let count = 0;
  for (const [cid, rs] of Object.entries(s.readStates)) {
    if (!rs.mentionCount) continue;
    const ch = s.channels[cid];
    if (!ch) continue;
    if (ch.guildId && s.guildSettings[ch.guildId]?.muted) continue;
    count += rs.mentionCount;
  }
  return count;
}

export function guildMentionCount(s, guildId) {
  let n = 0;
  for (const id of s.guildChannels[guildId] || []) n += s.readStates[id]?.mentionCount || 0;
  for (const c of Object.values(s.channels)) if (c.type === ChannelType.THREAD && c.guildId === guildId) n += s.readStates[c.id]?.mentionCount || 0;
  return n;
}
