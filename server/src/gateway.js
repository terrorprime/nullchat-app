// Realtime gateway: WebSocket connections, presence, fan-out of events, voice signaling.
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { iceServersNow } from './lib/ice.js';
import { all, get, run, parseJSON } from './db.js';
import { sha256, newId } from './lib/security.js';
import { botFromToken, BOT_TOKEN_PREFIX } from './lib/auth.js';
import { rateLimit } from './lib/http.js';
import { clientIp } from './lib/ip.js';
import {
  privateUser, publicUser, activeCustomStatus, guildPayloadFor, userGuildIds, guildMemberIds,
  serializePrivateChannel, channelAccess, channelViewerIds, getChannelRow, isBlockedEitherWay, getMember,
  getGuildCore, serializeMessages,
} from './models.js';
import { clearWornTag } from './lib/servertag.js';
import { ChannelType, P, has, isVoiceLike, STAGE_MAX_SPEAKERS, STAGE_DEFAULT_LIMIT } from '../../shared/permissions.js';
import { createDiscordGateway } from './discordGateway.js';
import { sfuEnabled, mintJoinToken, removeParticipant } from './lib/sfu.js';
import { DISCORD_GATEWAY_PATH } from './lib/discord.js';

const conns = new Map();     // connId -> { ws, userId, sessionId, afk, connectedAt }
const userConns = new Map(); // userId -> Set<connId>
export const voiceStates = new Map(); // userId -> voice state
const calls = new Map();     // dm channelId -> { channelId, ringing: Set<userId>, startedAt, timer, messageId }

// ---- sending helpers ---------------------------------------------------------
function rawSend(conn, t, d) {
  if (conn.ws.readyState !== 1) return;
  if (conn.discord) { conn.discord.deliver(t, d); return; }   // a bot using the Discord-compatible gateway: discordGateway.js turns the event into Discord's
  conn.ws.send(JSON.stringify({ t, d }));
}
/** Sends to every open connection of a user. Returns how many connections it reached. (`frame`: the message already turned into text, when many people get the same one.) */
export function sendToUser(userId, t, d, exceptConnId, frame = null) {
  const set = userConns.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const cid of set) {
    if (cid === exceptConnId) continue;
    const c = conns.get(cid);
    if (!c || c.ws.readyState !== 1) continue;
    if (c.discord) { c.discord.deliver(t, d); n++; continue; }
    frame ??= JSON.stringify({ t, d });
    c.ws.send(frame);
    n++;
  }
  return n;
}
/** Send to only the newest connection of a user. A bot that has two copies running (a restart, say) gets each slash command once. */
export function sendToNewestConnection(userId, t, d) {
  const set = userConns.get(userId);
  if (!set) return false;
  for (const cid of [...set].reverse()) {
    const c = conns.get(cid);
    if (c && c.ws.readyState === 1) { rawSend(c, t, d); return true; }
  }
  return false;
}
/** The same message to many people: it is turned into text once, not once per person. */
export function sendToUsers(userIds, t, d) {
  let frame = null;
  for (const id of new Set(userIds)) {
    if (!userConns.has(id)) continue;
    frame ??= JSON.stringify({ t, d });
    sendToUser(id, t, d, undefined, frame);
  }
}
export function isOnline(userId) { return userConns.has(userId); }

// ---- connections made by other front doors (the Discord-compatible gateway) ----------------------------------------
let connCounter = 0;
export const newConnId = () => `c${++connCounter}`;
export function registerConn(conn) {
  conns.set(conn.id, conn);
  if (!userConns.has(conn.userId)) userConns.set(conn.userId, new Set());
  userConns.get(conn.userId).add(conn.id);
}
export function unregisterConn(conn) {
  conns.delete(conn.id);
  const set = userConns.get(conn.userId);
  if (set) { set.delete(conn.id); if (!set.size) userConns.delete(conn.userId); }
  if (!userConns.get(conn.userId)?.size) run('UPDATE users SET activity = NULL WHERE id = ? AND activity IS NOT NULL', conn.userId);
  broadcastPresence(conn.userId);
}
export function onlineUserIds() { return [...userConns.keys()]; }

export function sendToGuild(guildId, t, d) {
  sendToUsers(guildMemberIds(guildId).filter(isOnline), t, d);
}
/** Send to everyone who can view a channel (DM recipients or guild members with VIEW_CHANNEL). */
export function sendToChannel(channelRow, t, d, exceptUserId) {
  const ids = channelViewerIds(channelRow, (id) => isOnline(id) && id !== exceptUserId);   // (only the people who are connected need their permissions worked out)
  sendToUsers(ids, t, d);
}
/** Re-send the full guild (filtered per user) — used after structural / permission changes. */
export function syncGuild(guildId, onlyUserIds) {
  const ids = (onlyUserIds || guildMemberIds(guildId)).filter(isOnline);
  for (const uid of ids) {
    const payload = guildPayloadFor(guildId, uid);
    if (payload) sendToUser(uid, 'GUILD_SYNC', payload);
  }
}
export function disconnectSession(sessionId, reason = 'Session ended') {
  for (const c of conns.values()) {
    if (c.sessionId === sessionId) { rawSend(c, 'INVALID_SESSION', { reason }); c.ws.close(4004, reason); }
  }
}
/** How many different people are connected right now. */
export function connectedUserCount() {
  let n = 0;
  for (const set of userConns.values()) if (set.size) n++;
  return n;
}
export function disconnectUser(userId, reason = 'Logged out') {
  for (const cid of userConns.get(userId) || []) {
    const c = conns.get(cid);
    if (c) { rawSend(c, 'INVALID_SESSION', { reason }); c.ws.close(4004, reason); }
  }
}

// ---- presence ----------------------------------------------------------------
export function computePresence(userId, userRow = null) {   // (`userRow`: the person's row, when it has already been read)
  const set = userConns.get(userId);
  const row = userRow || get('SELECT status, custom_status, activity FROM users WHERE id = ?', userId);
  if (!row) return { userId, status: 'offline', customStatus: null };
  if (!set || set.size === 0 || row.status === 'invisible') return { userId, status: 'offline', customStatus: null };
  let status = row.status;
  if (status === 'online') {
    const allAfk = [...set].every((cid) => conns.get(cid)?.afk);
    if (allAfk) status = 'idle';
  }
  const mobile = [...set].some((cid) => conns.get(cid)?.mobile);
  return { userId, status, customStatus: activeCustomStatus(row), activity: parseJSON(row.activity, null), mobile };
}

/** Everyone who should see this user's presence / profile updates. */
export function audienceOf(userId) {
  const ids = new Set();
  for (const r of all('SELECT other_id FROM relationships WHERE user_id = ? AND type IN (1,3,4)', userId)) ids.add(r.other_id);
  for (const r of all('SELECT DISTINCT gm2.user_id FROM guild_members gm1 JOIN guild_members gm2 ON gm1.guild_id = gm2.guild_id WHERE gm1.user_id = ?', userId)) ids.add(r.user_id);
  for (const r of all('SELECT DISTINCT cr2.user_id FROM channel_recipients cr1 JOIN channel_recipients cr2 ON cr1.channel_id = cr2.channel_id WHERE cr1.user_id = ?', userId)) ids.add(r.user_id);
  ids.delete(userId);
  return [...ids].filter(isOnline);
}

const lastPresence = new Map();
export function broadcastPresence(userId, force = false) {
  const p = computePresence(userId);
  const key = JSON.stringify(p);
  if (!force && lastPresence.get(userId) === key) return;
  lastPresence.set(userId, key);
  sendToUsers(audienceOf(userId), 'PRESENCE_UPDATE', p);
  sendToUser(userId, 'PRESENCE_UPDATE', p);
}

export function broadcastUserUpdate(userId) {
  const row = get('SELECT * FROM users WHERE id = ?', userId);
  if (!row) return;
  sendToUser(userId, 'USER_UPDATE', privateUser(row));
  sendToUsers(audienceOf(userId), 'USER_UPDATE', publicUser(row));
}

// ---- READY payload -------------------------------------------------------------
function buildReady(userId, isBot = false) {
  const me = get('SELECT * FROM users WHERE id = ?', userId);
  const users = new Map();
  const rows = new Map();   // the same people as they are stored: their presence is worked out from these, without asking again
  const addRow = (u) => { if (!users.has(u.id)) { users.set(u.id, publicUser(u)); rows.set(u.id, u); } };
  const addUser = (id) => { if (!users.has(id)) { const u = get('SELECT * FROM users WHERE id = ?', id); if (u) addRow(u); } };

  const guilds = userGuildIds(userId).map((gid) => guildPayloadFor(gid, userId)).filter(Boolean);
  // everybody in each server in one question per server (a question per member made connecting cost grow with the square of the server's size)
  for (const g of guilds) for (const u of all('SELECT u.* FROM users u JOIN guild_members m ON m.user_id = u.id WHERE m.guild_id = ?', g.id)) addRow(u);

  const privateChannels = all(`SELECT c.* FROM channels c JOIN channel_recipients r ON r.channel_id = c.id
    WHERE r.user_id = ? AND (r.closed = 0 OR c.type = ${ChannelType.GROUP_DM})`, userId)
    .map((c) => serializePrivateChannel(c, userId));
  for (const c of privateChannels) c.recipients.forEach(addUser);

  const relationships = all('SELECT other_id, type, nickname, created_at FROM relationships WHERE user_id = ?', userId)
    .map((r) => { addUser(r.other_id); return { id: r.other_id, type: r.type, nickname: r.nickname, since: r.created_at }; });

  const presences = [...users.keys()].map((id) => computePresence(id, rows.get(id))).filter((p) => p.status !== 'offline');

  const visibleChannelIds = new Set([...guilds.flatMap((g) => g.channels.map((c) => c.id)), ...privateChannels.map((c) => c.id)]);
  const voice = [...voiceStates.values()].filter((v) => visibleChannelIds.has(v.channelId));
  voice.forEach((v) => addUser(v.userId));

  const readStates = all('SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = ?', userId)
    .map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id, mentionCount: r.mention_count }));

  const guildSettings = all('SELECT * FROM user_guild_settings WHERE user_id = ?', userId).map(serializeGuildSettings);

  const activeCalls = [...calls.values()].filter((c) => visibleChannelIds.has(c.channelId)).map(serializeCall);

  return {
    user: isBot ? publicUser(me) : privateUser(me),
    settings: isBot ? {} : parseJSON(me.settings, {}),
    guilds,
    privateChannels,
    relationships,
    users: [...users.values()],
    presences,
    voiceStates: voice,
    readStates,
    guildSettings,
    calls: activeCalls,
    iceServers: isBot ? [] : iceServersNow(),
    features: { giphy: !!config.giphyKey, linkPreviews: config.linkPreviews },
  };
}

export function serializeGuildSettings(r) {
  return { guildId: r.guild_id, muted: !!r.muted, notifications: r.notifications, suppressEveryone: !!r.suppress_everyone, channelOverrides: parseJSON(r.channel_overrides, {}) };
}

// ---- voice ---------------------------------------------------------------------
function voiceAudience(channelRow) {
  return channelViewerIds(channelRow, isOnline);
}

function broadcastVoiceState(state, channelRow) {
  sendToUsers(voiceAudience(channelRow), 'VOICE_STATE_UPDATE', state);
}

export function serializeCall(c) {
  return { channelId: c.channelId, ringing: [...c.ringing], startedAt: c.startedAt };
}

function broadcastCall(channelId) {
  const call = calls.get(channelId);
  const row = getChannelRow(channelId);
  if (!row) return;
  const ids = channelViewerIds(row, isOnline);
  if (call) sendToUsers(ids, 'CALL_UPDATE', serializeCall(call));
  else sendToUsers(ids, 'CALL_DELETE', { channelId });
}

export function leaveVoice(userId, { rejoining = null } = {}) {
  const state = voiceStates.get(userId);
  if (!state) return;
  voiceStates.delete(userId);
  // Big calls: tell the LiveKit server to drop them too, so a join token can't be used to keep listening after this. (Joining the same room
  // again needs no such order: LiveKit replaces the older connection of the same person by itself.)
  if (state.sfu && rejoining !== state.channelId) removeParticipant(state.channelId, userId);
  const row = getChannelRow(state.channelId);
  if (row) broadcastVoiceState({ ...state, channelId: null, previousChannelId: state.channelId }, row);
  else sendToUser(userId, 'VOICE_STATE_UPDATE', { ...state, channelId: null, previousChannelId: state.channelId });
  // End DM calls when nobody is left.
  const call = calls.get(state.channelId);
  if (call) {
    const remaining = [...voiceStates.values()].filter((v) => v.channelId === state.channelId);
    if (remaining.length === 0) {
      clearTimeout(call.timer);
      calls.delete(state.channelId);
      broadcastCall(state.channelId);
    }
  }
}

function joinVoice(conn, d) {
  const userId = conn.userId;
  const channelId = String(d?.channelId || '');
  let access;
  try { access = channelAccess(channelId, userId); } catch { return { error: 'Unknown channel.' }; }
  const { channel, perms, isDM } = access;
  if (!isDM && !isVoiceLike(channel.type)) return { error: 'That is not a voice channel.' };
  const isStage = !isDM && channel.type === ChannelType.STAGE;
  if (isDM && channel.type !== ChannelType.DM && channel.type !== ChannelType.GROUP_DM) return { error: 'Not a call channel.' };
  if (!has(perms, P.CONNECT)) return { error: 'You do not have permission to join this voice channel.' };
  // Big calls (LiveKit) are used in a server's voice channels when the site has them switched on. A page loaded before that was switched on
  // doesn't know how to join, and would end up in a call nobody can hear it in, so it is asked to reload instead.
  const bigCall = sfuEnabled() && !isDM && !isStage;
  if (bigCall && !d.sfu) return { error: 'Voice calls in this server were upgraded. Reload NullChat (Ctrl+R), then join again.' };
  if (isDM && channel.type === ChannelType.DM) {
    const other = all('SELECT user_id FROM channel_recipients WHERE channel_id = ? AND user_id != ?', channelId, userId)[0];
    if (other && isBlockedEitherWay(userId, other.user_id)) return { error: 'You cannot call this user.' };
  }
  const occupants = [...voiceStates.values()].filter((v) => v.channelId === channelId && v.userId !== userId);
  const limit = isStage ? (channel.user_limit || STAGE_DEFAULT_LIMIT) : channel.user_limit;   // (a stage is always capped: every speaker sends audio to every listener)
  if (!isDM && limit > 0 && occupants.length >= limit && !has(perms, P.MOVE_MEMBERS)) {
    return { error: isStage ? 'This stage is full.' : 'This voice channel is full.' };
  }
  if (voiceStates.has(userId)) leaveVoice(userId, { rejoining: channelId });
  const member = !isDM ? getMember(channel.guild_id, userId) : null;
  const prev = conn.lastServerVoice?.[channel.guild_id] || {};
  // On a stage everyone starts in the audience, except the people who run it (they can mute members), who start as speakers while there is room.
  const timedOut = !!(member?.timeoutUntil);
  const speakers = isStage ? occupants.filter((v) => !v.suppress).length : 0;
  const startsAsSpeaker = isStage && has(perms, P.MUTE_MEMBERS) && has(perms, P.SPEAK) && !timedOut && speakers < STAGE_MAX_SPEAKERS;
  const state = {
    userId,
    channelId,
    guildId: channel.guild_id || null,
    connId: conn.id,
    stage: isStage,
    handAt: null,                                         // when this listener asked to speak (stage only)
    selfMute: isStage || !!d.selfMute || !has(perms, P.SPEAK),   // (on a stage you start muted, so a new speaker is never live by accident)
    selfDeaf: !!d.selfDeaf,
    selfVideo: false,
    selfStream: false,
    cameraStreamId: null,
    screenStreamId: null,
    mute: !!prev.mute,
    deaf: !!prev.deaf,
    suppress: isStage ? !startsAsSpeaker : (!has(perms, P.SPEAK) || timedOut),
    joinedAt: Date.now(),
    ...(bigCall ? { sfu: true } : null),
  };
  voiceStates.set(userId, state);
  broadcastVoiceState(state, channel);

  if (isDM) {
    let call = calls.get(channelId);
    if (!call) {
      const others = all('SELECT user_id FROM channel_recipients WHERE channel_id = ? AND user_id != ?', channelId, userId).map((r) => r.user_id);
      call = { channelId, ringing: new Set(others), startedAt: Date.now(), timer: null };
      calls.set(channelId, call);
      call.timer = setTimeout(() => { const c = calls.get(channelId); if (c) { c.ringing.clear(); broadcastCall(channelId); } }, 45_000);
      // Post a "started a call" system message.
      const msgId = newId();
      run('INSERT INTO messages (id, channel_id, author_id, content, type, created_at) VALUES (?, ?, ?, ?, 3, ?)', msgId, channelId, userId, '', Date.now());
      run('UPDATE channels SET last_message_id = ? WHERE id = ?', msgId, channelId);
      run('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ?', channelId);
      const msg = serializeMessages([get('SELECT * FROM messages WHERE id = ?', msgId)])[0];
      sendToChannel(channel, 'MESSAGE_CREATE', msg);
    } else {
      call.ringing.delete(userId);
    }
    broadcastCall(channelId);
  }

  let sfu = null;
  if (bigCall) {
    const u = get('SELECT username, display_name FROM users WHERE id = ?', userId);
    sfu = {
      url: config.sfu.url,
      token: mintJoinToken({ userId, name: u?.display_name || u?.username || '', channelId, canSpeak: !state.suppress, canStream: has(perms, P.STREAM) }),
    };
  }

  return {
    ok: true,
    channelId,
    iceServers: iceServersNow(),
    participants: [...voiceStates.values()].filter((v) => v.channelId === channelId),
    ...(sfu ? { sfu } : null),
  };
}

function updateVoice(conn, d) {
  const state = voiceStates.get(conn.userId);
  if (!state || state.connId !== conn.id) return;
  const row = getChannelRow(state.channelId);
  if (!row) return;
  let perms = 0;
  try { perms = channelAccess(state.channelId, conn.userId).perms; } catch { leaveVoice(conn.userId); return; }
  if ('selfMute' in d) state.selfMute = !!d.selfMute;
  if ('selfDeaf' in d) state.selfDeaf = !!d.selfDeaf;
  const mayShow = has(perms, P.STREAM) && !(state.stage && state.suppress);   // (the audience of a stage doesn't show a camera or screen)
  if ('selfVideo' in d) state.selfVideo = !!d.selfVideo && mayShow;
  if ('selfStream' in d) state.selfStream = !!d.selfStream && mayShow;
  if ('cameraStreamId' in d) state.cameraStreamId = state.selfVideo ? String(d.cameraStreamId || '').slice(0, 100) || null : null;
  if ('screenStreamId' in d) state.screenStreamId = state.selfStream ? String(d.screenStreamId || '').slice(0, 100) || null : null;
  broadcastVoiceState(state, row);
}

/**
 * Stage channels: a few people speak, everyone else listens.
 *   { action: 'hand', raised }        a listener asks to speak (or takes the request back)
 *   { action: 'speak', userId }       let a listener speak (people who can mute members; or you, if you are one)
 *   { action: 'audience', userId }    move a speaker back to the audience (yourself, or anyone if you can mute members)
 *   { action: 'end' }                 end the stage: everyone is disconnected (people who can mute members)
 */
function stageAction(conn, d) {
  const me = voiceStates.get(conn.userId);
  if (!me || me.connId !== conn.id) return { error: 'You are not on a stage.' };
  const row = getChannelRow(me.channelId);
  if (!row || row.type !== ChannelType.STAGE) return { error: 'This is not a stage.' };
  let perms;
  try { perms = channelAccess(me.channelId, conn.userId).perms; } catch { leaveVoice(conn.userId); return { error: 'You can no longer see this stage.' }; }
  const mod = has(perms, P.MUTE_MEMBERS);
  const inStage = () => [...voiceStates.values()].filter((v) => v.channelId === me.channelId);
  const targetOf = () => {
    const id = String(d.userId || conn.userId);
    const t = voiceStates.get(id);
    return t && t.channelId === me.channelId ? t : null;
  };
  switch (d.action) {
    case 'hand': {
      if (!me.suppress) return { error: 'You are already a speaker.' };
      if (!has(perms, P.SPEAK)) return { error: 'You are not allowed to speak in this stage.' };
      me.handAt = d.raised === false ? null : (me.handAt || Date.now());
      broadcastVoiceState(me, row);
      return { ok: true };
    }
    case 'speak': {
      const t = targetOf();
      if (!t) return { error: 'That person is not on the stage.' };
      if (t.userId !== conn.userId && !mod) return { error: 'Only the people who run the stage can invite someone to speak.' };
      if (t.userId === conn.userId && !mod) return { error: 'Raise your hand and a moderator can let you speak.' };
      if (!t.suppress) return { ok: true };
      if (inStage().filter((v) => !v.suppress).length >= STAGE_MAX_SPEAKERS) return { error: `A stage can have ${STAGE_MAX_SPEAKERS} speakers at a time. Move someone back to the audience first.` };
      let tperms = 0;
      try { tperms = channelAccess(me.channelId, t.userId).perms; } catch { return { error: 'That person can no longer see this stage.' }; }
      const tm = row.guild_id ? getMember(row.guild_id, t.userId) : null;
      if (!has(tperms, P.SPEAK) || tm?.timeoutUntil) return { error: 'That person is not allowed to speak here.' };
      t.suppress = false; t.handAt = null; t.selfMute = true;   // (they start muted and unmute themselves)
      broadcastVoiceState(t, row);
      return { ok: true };
    }
    case 'audience': {
      const t = targetOf();
      if (!t) return { error: 'That person is not on the stage.' };
      if (t.userId !== conn.userId && !mod) return { error: 'Only the people who run the stage can move someone to the audience.' };
      if (t.suppress) return { ok: true };
      t.suppress = true; t.handAt = null;
      t.selfVideo = false; t.selfStream = false; t.cameraStreamId = null; t.screenStreamId = null;
      broadcastVoiceState(t, row);
      return { ok: true };
    }
    case 'end': {
      if (!mod) return { error: 'Only the people who run the stage can end it.' };
      for (const v of inStage()) {
        const c = conns.get(v.connId);
        leaveVoice(v.userId);
        if (c) rawSend(c, 'VOICE_FORCE_DISCONNECT', { reason: 'The stage was ended.' });
      }
      return { ok: true };
    }
    default:
      return { error: 'Unknown stage action.' };
  }
}

/** Moderator voice actions (server mute/deafen, move, disconnect). */
export function moderateVoice(targetId, { mute, deaf, channelId, disconnect }, guildId) {
  const state = voiceStates.get(targetId);
  if (!state || state.guildId !== guildId) return false;
  if (disconnect) {
    const conn = conns.get(state.connId);
    leaveVoice(targetId);
    if (conn) rawSend(conn, 'VOICE_FORCE_DISCONNECT', { reason: 'You were disconnected by a moderator.' });
    return true;
  }
  if (channelId && channelId !== state.channelId) {
    const conn = conns.get(state.connId);
    if (conn) rawSend(conn, 'VOICE_FORCE_MOVE', { channelId });
    return true;
  }
  if (mute !== undefined) state.mute = !!mute;
  if (deaf !== undefined) state.deaf = !!deaf;
  const conn = conns.get(state.connId);
  if (conn) { conn.lastServerVoice = conn.lastServerVoice || {}; conn.lastServerVoice[guildId] = { mute: state.mute, deaf: state.deaf }; }
  broadcastVoiceState(state, getChannelRow(state.channelId));
  return true;
}

/** Called when a user's permissions may have changed (e.g. kicked) — drop them from voice if needed. */
export function revalidateVoice(userId) {
  const state = voiceStates.get(userId);
  if (!state) return;
  try {
    const { perms } = channelAccess(state.channelId, userId);
    if (!has(perms, P.CONNECT)) throw new Error();
  } catch {
    const conn = conns.get(state.connId);
    leaveVoice(userId);
    if (conn) rawSend(conn, 'VOICE_FORCE_DISCONNECT', { reason: 'You no longer have access to that voice channel.' });
  }
}

export function endCallsForChannel(channelId) {
  for (const v of [...voiceStates.values()]) if (v.channelId === channelId) {
    const conn = conns.get(v.connId);
    leaveVoice(v.userId);
    if (conn) rawSend(conn, 'VOICE_FORCE_DISCONNECT', { reason: 'The channel was removed.' });
  }
}

// ---- op handlers -----------------------------------------------------------------
function handleOp(conn, msg) {
  const { op, d, nonce } = msg;
  const reply = (data) => { if (nonce) rawSend(conn, 'REPLY', { nonce, ...data }); };
  if (conn.bot && op !== 'heartbeat' && op !== 'typing') return; // bots don't join voice or calls; their status is set over the REST API
  switch (op) {
    case 'heartbeat':
      rawSend(conn, 'HEARTBEAT_ACK', {});
      break;
    case 'presence': {
      conn.afk = !!d?.afk;
      broadcastPresence(conn.userId);
      break;
    }
    case 'typing': {
      if (rateLimit(`typing:${conn.userId}`, 15, 10_000)) return;
      try {
        const { channel, perms } = channelAccess(String(d?.channelId || ''), conn.userId);
        const isThread = channel.type === ChannelType.THREAD;
        if (!has(perms, isThread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES)) return;
        const member = channel.guild_id ? getMember(channel.guild_id, conn.userId) : null;
        sendToChannel(channel, 'TYPING_START', { channelId: channel.id, userId: conn.userId, guildId: channel.guild_id, member, at: Date.now() }, conn.userId);
      } catch { /* ignore */ }
      break;
    }
    case 'voice_join':
      reply(joinVoice(conn, d || {}));
      break;
    case 'voice_leave': {
      const st = voiceStates.get(conn.userId);
      if (st && (st.connId === conn.id || d?.force)) leaveVoice(conn.userId);
      reply({ ok: true });
      break;
    }
    case 'voice_state':
      updateVoice(conn, d || {});
      break;
    case 'voice_stage':
      reply(stageAction(conn, d || {}));
      break;
    case 'voice_signal': {
      const me = voiceStates.get(conn.userId);
      const target = voiceStates.get(String(d?.to || ''));
      if (!me || !target || me.channelId !== target.channelId || me.connId !== conn.id) return;
      const tc = conns.get(target.connId);
      if (tc) rawSend(tc, 'VOICE_SIGNAL', { from: conn.userId, data: d.data });
      break;
    }
    case 'call_decline': {
      const call = calls.get(String(d?.channelId || ''));
      if (call && call.ringing.delete(conn.userId)) broadcastCall(call.channelId);
      break;
    }
    case 'call_ring': {
      // Re-ring recipients who are not in the call.
      const call = calls.get(String(d?.channelId || ''));
      const st = voiceStates.get(conn.userId);
      if (!call || !st || st.channelId !== call.channelId) return;
      const inCall = new Set([...voiceStates.values()].filter((v) => v.channelId === call.channelId).map((v) => v.userId));
      // Only people who are in this conversation can be rung (the list a caller sends is a request, not a fact: anything else in it is ignored).
      const members = new Set(all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', call.channelId).map((r) => r.user_id));
      const asked = Array.isArray(d?.userIds) && d.userIds.length ? d.userIds.slice(0, 50).map(String).filter((id) => members.has(id)) : [...members];
      for (const t of asked) if (!inCall.has(t) && t !== conn.userId) call.ringing.add(t);
      clearTimeout(call.timer);
      call.timer = setTimeout(() => { const c = calls.get(call.channelId); if (c) { c.ringing.clear(); broadcastCall(call.channelId); } }, 45_000);
      broadcastCall(call.channelId);
      break;
    }
    default:
      break;
  }
}

// ---- connection lifecycle ------------------------------------------------------------

export function attachGateway(server) {
  // "Playing X" only means something while the desktop app that reported it is connected. If the server stopped without people
  // disconnecting cleanly, nobody is connected now, so any activity still stored is left over.
  try { run('UPDATE users SET activity = NULL WHERE activity IS NOT NULL'); } catch { /* an older database without the column */ }
  // Two front doors share the one HTTP server: /gateway (NullChat's own) and /discord-gateway (what Discord libraries speak, see discordGateway.js).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const discord = createDiscordGateway();
  server.on('upgrade', (req, socket, head) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/gateway') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else if (pathname === DISCORD_GATEWAY_PATH) discord.handleUpgrade(req, socket, head);
    else { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); }
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    if (rateLimit(`ws:${ip}`, 30, 60_000)) { ws.close(4008, 'Rate limited'); return; }
    const conn = { id: newConnId(), ws, userId: null, sessionId: null, afk: false, alive: true, mobile: false };
    // (generous on purpose: when hundreds of people reconnect together after a restart the server needs a while to get to everybody, and a person
    // who identified at once must not be dropped just for waiting their turn. An idle connection that never identifies still goes, and each address can only open a few a minute.)
    const identifyTimer = setTimeout(() => { if (!conn.userId) ws.close(4003, 'Not authenticated'); }, 30_000);

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (!conn.userId) {
        if (msg.op !== 'identify') return;
        const token = String(msg.d?.token || '');
        // Two kinds of login: a person's session token, or a bot's token ("nb_…", with or without a leading "Bot ").
        let userId = null, sessionId = null, isBot = false;
        if (token.replace(/^Bot\s+/i, '').startsWith(BOT_TOKEN_PREFIX)) {
          const found = botFromToken(token);
          if (found) { userId = found.user.id; isBot = true; }
        } else {
          const session = token && get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
          if (session) { userId = session.user_id; sessionId = session.id; }
        }
        if (!userId) { rawSend(conn, 'INVALID_SESSION', { reason: 'Invalid token' }); ws.close(4004, 'Invalid token'); return; }
        clearTimeout(identifyTimer);
        conn.userId = userId;
        conn.sessionId = sessionId;
        conn.bot = isBot;
        conn.mobile = !!msg.d?.mobile;
        conns.set(conn.id, conn);
        if (!userConns.has(conn.userId)) userConns.set(conn.userId, new Set());
        userConns.get(conn.userId).add(conn.id);
        if (sessionId) run('UPDATE sessions SET last_used_at = ? WHERE id = ?', Date.now(), sessionId);
        rawSend(conn, 'READY', { ...buildReady(conn.userId, isBot), sessionId, connId: conn.id, ...(isBot ? { bot: true } : {}) });
        broadcastPresence(conn.userId);
        return;
      }
      // Call set-up messages (an offer, an answer and a dozen or more network candidates for each person you connect to, again whenever a camera or
      // screen share starts) get their own, much larger allowance: with 120 shared with everything else, a big call on a computer with many network
      // adapters could silently lose some of them, and the people whose messages were lost would never connect.
      const signalling = msg.op === 'voice_signal';
      if (rateLimit(signalling ? `wssig:${conn.id}` : `wsmsg:${conn.id}`, signalling ? 600 : 120, 10_000)) return;
      try { handleOp(conn, msg); } catch (e) { console.error('[gateway] op error', e); }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimer);
      conns.delete(conn.id);
      if (!conn.userId) return;
      const set = userConns.get(conn.userId);
      if (set) { set.delete(conn.id); if (!set.size) userConns.delete(conn.userId); }
      // The desktop app that said "Playing X" is gone (closed, crashed, lost its connection). Without this the line would come
      // back the next time this person signs in, even from a browser that can't see what they're running.
      if (!userConns.get(conn.userId)?.size) run('UPDATE users SET activity = NULL WHERE id = ? AND activity IS NOT NULL', conn.userId);
      const vs = voiceStates.get(conn.userId);
      if (vs && vs.connId === conn.id) leaveVoice(conn.userId);
      broadcastPresence(conn.userId);
    });
    ws.on('error', () => {});
  });

  const interval = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));
  return wss;
}

/** Called when a member is removed from a guild (kick/ban/leave). */
export function onMemberRemoved(guildId, userId) {
  sendToUser(userId, 'GUILD_DELETE', { id: guildId });
  if (clearWornTag(guildId, userId)) broadcastUserUpdate(userId);   // a tag is only worn by someone who is still in that server
  const st = voiceStates.get(userId);
  if (st && st.guildId === guildId) {
    const conn = conns.get(st.connId);
    leaveVoice(userId);
    if (conn) rawSend(conn, 'VOICE_FORCE_DISCONNECT', { reason: 'You are no longer in that server.' });
  }
}

export { getGuildCore };

/** Re-check voice access for everyone connected to voice in a guild (after permission changes). */
export function revalidateGuildVoice(guildId) {
  for (const v of [...voiceStates.values()]) if (v.guildId === guildId) revalidateVoice(v.userId);
}
