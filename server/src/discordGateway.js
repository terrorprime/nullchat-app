// A Discord-compatible gateway for bots: the numeric-opcode WebSocket protocol Discord libraries speak (HELLO, IDENTIFY, READY, GUILD_CREATE,
// heartbeats, dispatch events with sequence numbers), served at /discord-gateway.
//
// It is a second front door to the same realtime system, not a second system: a connection here is registered like any other bot connection, so
// NullChat's own events reach it through gateway.js, and translate() below turns each one into the Discord event bots expect (or drops it).
// What is covered and what is not: docs/DISCORD_BOTS.md.
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { all, run } from './db.js';
import { config } from './config.js';
import { rateLimit } from './lib/http.js';
import { clientIp } from './lib/ip.js';
import { botFromToken } from './lib/auth.js';
import { newId } from './lib/security.js';
import { guildPayloadFor, userGuildIds, getUserRow, publicUser, getChannelRow, getMember } from './models.js';
import { registerConn, unregisterConn, newConnId, broadcastPresence, broadcastUserUpdate } from './gateway.js';
import {
  DISCORD_VERSION, DISCORD_GATEWAY_PATH, toUser, userById, toMember, toRole, toChannel, toEmoji, toGuild, toGuildCreate, toMessage, toEmojiRef,
  toInteraction, originOfRequest, iso,
} from './lib/discord.js';

const HEARTBEAT_MS = 41_250;

// ---- intents: which events a bot asked for ---------------------------------------------------------------------------------------------------
const I = { GUILDS: 1 << 0, GUILD_MEMBERS: 1 << 1, GUILD_EXPRESSIONS: 1 << 3, GUILD_PRESENCES: 1 << 8, GUILD_MESSAGES: 1 << 9, GUILD_MESSAGE_REACTIONS: 1 << 10, GUILD_MESSAGE_TYPING: 1 << 11 };
const EVENT_INTENT = {
  CHANNEL_CREATE: I.GUILDS, CHANNEL_UPDATE: I.GUILDS, CHANNEL_DELETE: I.GUILDS, CHANNEL_PINS_UPDATE: I.GUILDS, GUILD_UPDATE: I.GUILDS, GUILD_DELETE: I.GUILDS,
  GUILD_ROLE_CREATE: I.GUILDS, GUILD_ROLE_UPDATE: I.GUILDS, GUILD_ROLE_DELETE: I.GUILDS,
  GUILD_MEMBER_ADD: I.GUILD_MEMBERS, GUILD_MEMBER_UPDATE: I.GUILD_MEMBERS, GUILD_MEMBER_REMOVE: I.GUILD_MEMBERS,
  GUILD_EMOJIS_UPDATE: I.GUILD_EXPRESSIONS, PRESENCE_UPDATE: I.GUILD_PRESENCES,
  MESSAGE_CREATE: I.GUILD_MESSAGES, MESSAGE_UPDATE: I.GUILD_MESSAGES, MESSAGE_DELETE: I.GUILD_MESSAGES, MESSAGE_DELETE_BULK: I.GUILD_MESSAGES,
  MESSAGE_REACTION_ADD: I.GUILD_MESSAGE_REACTIONS, MESSAGE_REACTION_REMOVE: I.GUILD_MESSAGE_REACTIONS, MESSAGE_REACTION_REMOVE_ALL: I.GUILD_MESSAGE_REACTIONS,
  TYPING_START: I.GUILD_MESSAGE_TYPING,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const guildOfChannel = (id) => getChannelRow(id)?.guild_id || null;

// ---- NullChat event → Discord events -----------------------------------------------------------------------------------------------------------
/** What a server's structure looked like the last time this connection was told, so a change can be told as Discord's separate events. */
function snapshotOf(payload) {
  return {
    guild: toGuild({ ...payload, roles: [], emojis: [] }),
    roles: new Map((payload.roles || []).map((r) => [r.id, toRole(r)])),
    channels: new Map((payload.channels || []).map((c) => [c.id, toChannel(c)])),
    emojis: (payload.emojis || []).map(toEmoji),
  };
}

/** NullChat sends the whole (filtered) server again after structural changes; Discord sends one event per change. */
function diffGuild(dc, payload, me) {
  const before = dc.guilds.get(payload.id);
  const now = snapshotOf(payload);
  dc.guilds.set(payload.id, now);
  if (!before) return [['GUILD_CREATE', toGuildCreate(payload, me)]];   // (the bot was just added to this server: tell it everything, as Discord does)
  const out = [];
  if (!same(before.guild, now.guild)) out.push(['GUILD_UPDATE', { ...toGuild(payload) }]);
  for (const [id, role] of now.roles) {
    if (!before.roles.has(id)) out.push(['GUILD_ROLE_CREATE', { guild_id: payload.id, role }]);
    else if (!same(before.roles.get(id), role)) out.push(['GUILD_ROLE_UPDATE', { guild_id: payload.id, role }]);
  }
  for (const id of before.roles.keys()) if (!now.roles.has(id)) out.push(['GUILD_ROLE_DELETE', { guild_id: payload.id, role_id: id }]);
  for (const [id, ch] of now.channels) {
    if (!before.channels.has(id)) out.push(['CHANNEL_CREATE', ch]);
    else if (!same(before.channels.get(id), ch)) out.push(['CHANNEL_UPDATE', ch]);
  }
  for (const [id, ch] of before.channels) if (!now.channels.has(id)) out.push(['CHANNEL_DELETE', ch]);
  if (!same(before.emojis, now.emojis)) out.push(['GUILD_EMOJIS_UPDATE', { guild_id: payload.id, emojis: now.emojis }]);
  return out;
}

function translate(conn, t, d) {
  const dc = conn.discord;
  const me = conn.userId;
  const origin = dc.origin;
  switch (t) {
    case 'MESSAGE_CREATE':
    case 'MESSAGE_UPDATE': {
      if (d.ephemeral) return [];   // (a private reply to a command is for that person only)
      const guildId = d.guildId ?? guildOfChannel(d.channelId);
      if (!guildId) return [];      // (bots have no direct messages here)
      return [[t, toMessage(d, { viewerId: me, origin, guildId, withMember: true })]];
    }
    case 'MESSAGE_DELETE': {
      const guildId = d.guildId ?? guildOfChannel(d.channelId);
      return guildId ? [[t, { id: d.id, channel_id: d.channelId, guild_id: guildId }]] : [];
    }
    case 'MESSAGE_DELETE_BULK': {
      const guildId = guildOfChannel(d.channelId);
      return guildId ? [[t, { ids: d.ids, channel_id: d.channelId, guild_id: guildId }]] : [];
    }
    case 'MESSAGE_REACTIONS_UPDATE': {
      const delta = d.delta;
      const guildId = d.guildId ?? guildOfChannel(d.channelId);
      if (!delta || !guildId) return [];
      const base = { channel_id: d.channelId, message_id: d.messageId, guild_id: guildId };
      if (delta.type === 'clear') return [['MESSAGE_REACTION_REMOVE_ALL', base]];
      const ev = { ...base, user_id: delta.userId, emoji: toEmojiRef(delta.emoji), burst: false, type: 0 };
      if (delta.type === 'add') {
        const mem = getMember(guildId, delta.userId);
        return [['MESSAGE_REACTION_ADD', { ...ev, ...(mem ? { member: toMember(mem, userById(delta.userId)) } : {}) }]];
      }
      return [['MESSAGE_REACTION_REMOVE', ev]];
    }
    case 'GUILD_MEMBER_ADD': {
      if (!dc.guilds.has(d.guildId)) return [];   // (a server the bot has just been added to: its GUILD_CREATE, with every member, follows)
      const user = d.user ? toUser(d.user) : userById(d.member?.userId);
      return user && d.member ? [[t, { guild_id: d.guildId, ...toMember(d.member, user) }]] : [];
    }
    case 'GUILD_MEMBER_REMOVE': {
      if (d.userId === me) return [];   // (the bot itself being removed is announced as GUILD_DELETE)
      const user = userById(d.userId);
      return user ? [[t, { guild_id: d.guildId, user }]] : [];
    }
    case 'GUILD_MEMBER_UPDATE': {
      const user = userById(d.member?.userId);
      return user ? [[t, { guild_id: d.guildId, ...toMember(d.member, user) }]] : [];
    }
    case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': {
      if (!d.guildId) return [];
      const ch = toChannel(d);
      const snap = dc.guilds.get(d.guildId);
      if (snap) snap.channels.set(ch.id, ch);   // (so the GUILD_SYNC that usually follows does not tell it again)
      return [[t, ch]];
    }
    case 'CHANNEL_PINS_UPDATE': {
      const guildId = guildOfChannel(d.channelId);
      return guildId ? [[t, { channel_id: d.channelId, guild_id: guildId, last_pin_timestamp: iso(Date.now()) }]] : [];
    }
    case 'GUILD_SYNC': return d?.id ? diffGuild(dc, d, me) : [];
    case 'GUILD_DELETE': { dc.guilds.delete(d.id); return [[t, { id: d.id }]]; }
    case 'TYPING_START': {
      if (!d.guildId || d.userId === me) return [];
      const mem = d.member || getMember(d.guildId, d.userId);
      return [[t, { channel_id: d.channelId, guild_id: d.guildId, user_id: d.userId, timestamp: Math.floor((d.at || Date.now()) / 1000), ...(mem ? { member: toMember(mem, userById(d.userId)) } : {}) }]];
    }
    case 'PRESENCE_UPDATE': {
      const shared = userGuildIds(d.userId).filter((g) => dc.guilds.has(g));   // (Discord tells a presence once for every server the two have in common)
      if (!shared.length) return [];
      const activities = [];
      if (d.customStatus?.text) activities.push({ name: 'Custom Status', type: 4, state: d.customStatus.text, created_at: Date.now() });
      if (d.activity?.name) activities.push({ name: d.activity.name, type: 0, created_at: d.activity.since || Date.now() });
      const status = ['online', 'idle', 'dnd'].includes(d.status) ? d.status : 'offline';
      return shared.map((guildId) => [t, { user: { id: d.userId }, guild_id: guildId, status, activities, client_status: status === 'offline' ? {} : { [d.mobile ? 'mobile' : 'desktop']: status } }]);
    }
    case 'INTERACTION_CREATE': return [['INTERACTION_CREATE', toInteraction(d, me, origin)]];
    default: return [];
  }
}

// ---- the server ----------------------------------------------------------------------------------------------------------------------------------
export function createDiscordGateway() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    if (rateLimit(`dws:${ip}`, 30, 60_000)) { ws.close(4008, 'Rate limited'); return; }
    const params = new URL(req.url, 'http://x').searchParams;
    if (params.get('encoding') && params.get('encoding') !== 'json') { ws.close(4000, 'Only encoding=json is supported.'); return; }
    const compress = params.get('compress');
    if (compress && compress !== 'zlib-stream') { ws.close(4000, 'Only compress=zlib-stream is supported (or leave compression off).'); return; }

    const origin = originOfRequest(req, config.publicUrl);
    const conn = {
      id: newConnId(), ws, userId: null, sessionId: null, afk: false, alive: true, mobile: false, bot: true,
      discord: { seq: 0, intents: 0, origin, sessionId: newId(), guilds: new Map(), ready: false, lastBeat: Date.now(), deliver: null },
    };
    const dc = conn.discord;
    // compress=zlib-stream: one deflate stream for the whole connection, flushed after every message (that is what clients expect)
    let deflate = null, packed = [];
    if (compress) {
      deflate = zlib.createDeflate();
      deflate.on('data', (c) => packed.push(c));
      deflate.on('error', () => {});
    }
    const emit = (text) => {
      if (!deflate) { ws.send(text); return; }
      deflate.write(text);
      deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => { const out = Buffer.concat(packed); packed = []; if (ws.readyState === 1) ws.send(out); });
    };
    const send = (op, d, t) => {
      if (ws.readyState !== 1) return;
      emit(JSON.stringify(op === 0 ? { op, d, s: ++dc.seq, t } : { op, d }));
    };
    const dispatch = (name, payload) => {
      const bit = EVENT_INTENT[name];
      if (bit && !(dc.intents & bit)) return;
      send(0, payload, name);
    };
    dc.deliver = (t, d) => {
      if (!dc.ready) return;
      let events;
      try { events = translate(conn, t, d); } catch (e) { console.error('[discord gateway] could not translate', t, e); return; }
      for (const [name, payload] of events) dispatch(name, payload);
    };

    send(10, { heartbeat_interval: HEARTBEAT_MS });
    const identifyTimer = setTimeout(() => { if (!conn.userId) ws.close(4003, 'Not authenticated.'); }, 30_000);
    const beatTimer = setInterval(() => { if (conn.userId && Date.now() - dc.lastBeat > HEARTBEAT_MS * 2) ws.close(4009, 'Session timed out.'); }, 15_000);
    beatTimer.unref?.();

    const identify = (d) => {
      if (conn.userId) { ws.close(4005, 'Already authenticated.'); return; }
      if (!d || typeof d.intents !== 'number' || d.intents < 0 || !Number.isInteger(d.intents)) { ws.close(4013, 'Invalid intent(s).'); return; }
      const found = botFromToken(String(d.token || ''));
      if (!found) { ws.close(4004, 'Authentication failed.'); return; }
      clearTimeout(identifyTimer);
      dc.intents = d.intents;
      conn.userId = found.user.id;
      conn.mobile = false;
      const guildIds = userGuildIds(conn.userId);
      registerConn(conn);
      applyPresence(conn, d.presence);
      const url = origin.replace(/^http/, 'ws') + DISCORD_GATEWAY_PATH;
      dc.ready = true;
      send(0, {
        v: DISCORD_VERSION, user: { ...toUser(publicUser(found.user)), verified: true, mfa_enabled: false, flags: 0 }, guilds: guildIds.map((id) => ({ id, unavailable: true })),
        session_id: dc.sessionId, resume_gateway_url: url, application: { id: conn.userId, flags: 0 }, shard: [0, 1],
      }, 'READY');
      for (const gid of guildIds) {
        const payload = guildPayloadFor(gid, conn.userId);
        if (!payload) continue;
        dc.guilds.set(gid, snapshotOf(payload));
        send(0, toGuildCreate(payload, conn.userId), 'GUILD_CREATE');
      }
      broadcastPresence(conn.userId, true);
    };

    const requestMembers = (d) => {
      const gid = String(d?.guild_id || '');
      if (!conn.userId || !gid || !userGuildIds(conn.userId).includes(gid)) return;
      const rows = all('SELECT u.* FROM users u JOIN guild_members m ON m.user_id = u.id WHERE m.guild_id = ?', gid);
      const wanted = Array.isArray(d.user_ids) ? new Set(d.user_ids.map(String)) : null;
      const query = String(d.query || '').toLowerCase();
      let list = rows.filter((u) => (wanted ? wanted.has(u.id) : u.username.toLowerCase().startsWith(query)));
      if (Number(d.limit) > 0) list = list.slice(0, Number(d.limit));
      const members = list.map((u) => { const m = getMember(gid, u.id); return m && toMember(m, toUser(publicUser(u))); }).filter(Boolean);
      const notFound = wanted ? [...wanted].filter((id) => !list.some((u) => u.id === id)) : undefined;
      const chunks = Math.max(1, Math.ceil(members.length / 1000));
      for (let i = 0; i < chunks; i++) {
        send(0, { guild_id: gid, members: members.slice(i * 1000, (i + 1) * 1000), chunk_index: i, chunk_count: chunks, ...(notFound ? { not_found: notFound } : {}), ...(d.nonce ? { nonce: d.nonce } : {}) }, 'GUILD_MEMBERS_CHUNK');
      }
    };

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { ws.close(4002, 'Decode error.'); return; }
      if (!msg || typeof msg !== 'object') { ws.close(4002, 'Decode error.'); return; }
      if (rateLimit(`dwsmsg:${conn.id}`, 120, 60_000)) { ws.close(4008, 'Rate limited.'); return; }
      switch (msg.op) {
        case 1: dc.lastBeat = Date.now(); send(11); break;                                // HEARTBEAT → HEARTBEAT_ACK
        case 2: identify(msg.d); break;
        case 3: if (conn.userId) applyPresence(conn, msg.d); break;                        // PRESENCE_UPDATE
        case 6: send(9, false); break;                                                      // RESUME: nothing is kept, so start again
        case 8: requestMembers(msg.d); break;                                              // REQUEST_GUILD_MEMBERS
        default: if (!conn.userId) ws.close(4003, 'Not authenticated.'); break;           // (VOICE_STATE_UPDATE and the rest are ignored)
      }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimer);
      clearInterval(beatTimer);
      deflate?.destroy();
      if (conn.userId) unregisterConn(conn);
    });
    ws.on('error', () => {});
  });

  return {
    wss,
    handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); },
  };
}

/** A bot's "status" and "activity" (what Discord libraries send as presence): shown like anyone's in the member list. */
function applyPresence(conn, p) {
  if (!p || typeof p !== 'object') return;
  const status = p.status === 'offline' ? 'invisible' : p.status;
  if (['online', 'idle', 'dnd', 'invisible'].includes(status)) run('UPDATE users SET status = ? WHERE id = ?', status, conn.userId);
  if (Array.isArray(p.activities)) {
    const custom = p.activities.find((a) => a?.type === 4);
    const playing = p.activities.find((a) => a && a.type !== 4 && typeof a.name === 'string');
    const text = String(custom?.state || custom?.name || '').slice(0, 128);
    run('UPDATE users SET custom_status = ?, activity = ? WHERE id = ?', text ? JSON.stringify({ text }) : null, playing ? JSON.stringify({ name: String(playing.name).slice(0, 64), since: Date.now() }) : null, conn.userId);
  }
  const row = getUserRow(conn.userId);
  if (row) { broadcastUserUpdate(conn.userId); broadcastPresence(conn.userId, true); }
}

