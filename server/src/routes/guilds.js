import { z } from 'zod';
import { get, all, run, tx } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId, randomCode, verifyPassword } from '../lib/security.js';
import { receiveImage, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import {
  guildAccess, guildPayloadFor, getGuildCore, getMember, publicUser, getUserRow, serializeRole, serializeEmoji, serializeSticker,
  channelAccess, getChannelRow, serializeChannel, requirePerm, guildMemberIds,
} from '../models.js';
import {
  syncGuild, sendToGuild, sendToUser, onMemberRemoved, moderateVoice, revalidateVoice, voiceStates, endCallsForChannel,
  sendToChannel, isOnline, computePresence, sendToUsers, onlineUserIds,
} from '../gateway.js';
import { audit, addMemberToGuild } from '../services.js';
import { isBotId, uninstallBot } from '../lib/bots.js';
import { logMember } from '../lib/raid.js';
import { removeBadgeFile, forget as forgetTag } from '../lib/servertag.js';
import { RAID_MIN, RAID_MAX, pauseState } from '../lib/pause.js';
import {
  P, has, ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, ChannelType, highestRolePosition, computeBasePermissions, isVoiceLike,
} from '../../../shared/permissions.js';
import { normalizeSource } from '../../../shared/community.js';

const MAX_STICKERS = 50;   // per server

const TEMPLATES = {
  default: { categories: [['Text Channels', [['general', 0]]], ['Voice Channels', [['General', 2]]]] },
  gaming: { categories: [['Information', [['welcome', 0], ['announcements', 0]]], ['Text Channels', [['general', 0], ['clips-and-highlights', 0], ['looking-for-group', 0]]], ['Voice Channels', [['Lobby', 2], ['Gaming', 2]]]] },
  friends: { categories: [['Text Channels', [['general', 0], ['games', 0], ['music', 0]]], ['Voice Channels', [['Lounge', 2], ['Stream Room', 2]]]] },
  study: { categories: [['Information', [['welcome-and-rules', 0], ['notes-resources', 0]]], ['Text Channels', [['general', 0], ['homework-help', 0], ['session-planning', 0]]], ['Voice Channels', [['Lounge', 2], ['Study Room 1', 2], ['Study Room 2', 2]]]] },
  // The lounge every new account is added to (see lib/lounge.js).
  lounge: { categories: [['Start Here', [['welcome', 0], ['introductions', 0]]], ['Hang Out', [['general', 0], ['off-topic', 0]]], ['Voice', [['Hangout', 2]]]] },
  community: { categories: [['Information', [['welcome', 0], ['rules', 0], ['announcements', 0]]], ['Community', [['general', 0], ['introductions', 0], ['off-topic', 0], ['memes', 0]]], ['Voice Channels', [['Hangout', 2], ['Events', 2]]]] },
};

/**
 * Creates a server with its roles and channels from a template, owned by (and containing) `ownerId`. Returns its id.
 * Used by the "Create Server" button and for the lounge. `systemChannelName` picks where "X just joined" messages go.
 */
export function createGuildRecord(ownerId, name, template = 'default', { systemChannelName = null } = {}) {
  const count = get('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?', ownerId).n;
  if (count >= 200) throw bad('You can be in at most 200 servers.');
  const gid = newId();
  const now = Date.now();
  let systemChannel = null;
  tx(() => {
    run('INSERT INTO guilds (id, name, owner_id, created_at, automod) VALUES (?, ?, ?, ?, ?)', gid, name, ownerId, now, JSON.stringify({ spamFilter: true, mentionLimit: 20 }));
    run('INSERT INTO roles (id, guild_id, name, permissions, position) VALUES (?, ?, ?, ?, 0)', gid, gid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
    run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', gid, ownerId, now);
    let pos = 0;
    for (const [catName, chans] of TEMPLATES[template].categories) {
      const catId = newId();
      run('INSERT INTO channels (id, guild_id, type, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', catId, gid, ChannelType.CATEGORY, catName, pos++, now);
      let cpos = 0;
      for (const [chName, type] of chans) {
        const cid = newId();
        run('INSERT INTO channels (id, guild_id, type, name, position, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', cid, gid, type, chName, cpos++, catId, now);
        if (type === 0 && (systemChannelName ? chName === systemChannelName : !systemChannel && (chName === 'general' || chName === 'welcome'))) systemChannel = cid;
      }
    }
    if (systemChannel) run('UPDATE guilds SET system_channel_id = ? WHERE id = ?', systemChannel, gid);
    run("INSERT INTO guild_member_log (guild_id, kind, at) VALUES (?, 'start', ?), (?, 'join', ?)", gid, now, gid, now);   // (tracked from the day it is made)
  });
  return gid;
}

export function normalizeChannelName(name, type) {
  const n = String(name || '').trim();
  if (type === ChannelType.TEXT || type === ChannelType.ANNOUNCEMENT || type === ChannelType.FORUM) return n.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').slice(0, 100);
  return n.slice(0, 100);
}

function assertCanActOn(guild, actor, targetId) {
  if (targetId === guild.ownerId) throw forbidden('You can’t do that to the server owner.');
  const target = getMember(guild.id, targetId);
  if (!target) throw notFound('Unknown member.');
  if (actor.userId !== guild.ownerId && highestRolePosition(guild, target) >= highestRolePosition(guild, actor)) {
    throw forbidden('That member has a role equal to or higher than yours.');
  }
  return target;
}

/** Remove a member from a server (used by Kick and by the bulk tool). The caller has already checked who may do it. */
export function kickMember(guild, actorId, targetId, reason, changes = null) {
  run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', guild.id, targetId);
  logMember(guild.id, 'leave');
  audit(guild.id, actorId, 'MEMBER_KICK', { targetId, targetType: 'user', reason, changes });
  onMemberRemoved(guild.id, targetId);
  sendToGuild(guild.id, 'GUILD_MEMBER_REMOVE', { guildId: guild.id, userId: targetId });
}

/** Ban a person (a member or not), optionally deleting the last days of their messages here. The caller has already checked who may do it. */
export function banMember(guild, actorId, targetId, { reason, deleteMessageSeconds = 0 } = {}, changes = null) {
  run('INSERT OR REPLACE INTO bans (guild_id, user_id, reason, moderator_id, created_at) VALUES (?, ?, ?, ?, ?)', guild.id, targetId, reason || null, actorId, Date.now());
  const wasMember = !!getMember(guild.id, targetId);
  run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', guild.id, targetId);
  if (wasMember) logMember(guild.id, 'leave');
  if (deleteMessageSeconds > 0) {
    const since = Date.now() - deleteMessageSeconds * 1000;
    const msgs = all(`SELECT m.id, m.channel_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ? AND m.author_id = ? AND m.created_at >= ?`, guild.id, targetId, since);
    const byChannel = new Map();
    for (const m of msgs) { if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []); byChannel.get(m.channel_id).push(m.id); }
    for (const [cid, ids] of byChannel) {
      tx(() => ids.forEach((id) => run('DELETE FROM messages WHERE id = ?', id)));
      const ch = getChannelRow(cid);
      if (ch) sendToChannel(ch, 'MESSAGE_DELETE_BULK', { channelId: cid, ids });
    }
  }
  audit(guild.id, actorId, 'MEMBER_BAN_ADD', { targetId, targetType: 'user', reason, changes });
  if (wasMember) {
    onMemberRemoved(guild.id, targetId);
    sendToGuild(guild.id, 'GUILD_MEMBER_REMOVE', { guildId: guild.id, userId: targetId });
  }
}

/** Whether `actor` may act on `targetId` (not the owner, and a lower top role). Returns a short reason when not, or null when fine. */
export function whyNotActOn(guild, actor, targetId) {
  if (targetId === guild.ownerId) return 'That is the server owner.';
  const target = getMember(guild.id, targetId);
  if (!target) return 'Not in this server.';
  if (actor.userId !== guild.ownerId && highestRolePosition(guild, target) >= highestRolePosition(guild, actor)) return 'Has a role equal to or higher than yours.';
  return null;
}

const automodSchema = z.object({
  blockedWords: z.array(z.string().trim().min(1).max(60)).max(200).optional(),
  blockInvites: z.boolean().optional(),
  blockLinks: z.boolean().optional(),
  mentionLimit: z.number().int().min(0).max(50).optional(),
  timeoutOnMentionSpam: z.boolean().optional(),
  mentionTimeout: z.number().int().min(60).max(28 * 24 * 3600).optional(),   // ...for this many seconds (10 minutes when not set)
  spamFilter: z.boolean().optional(),
  warnLimit: z.number().int().min(0).max(10).optional(),                    // time a member out when they have this many warnings in 30 days (0 = never); see routes/modfile.js
  warnTimeout: z.number().int().min(60).max(28 * 24 * 3600).optional(),     // ...for this many seconds
  exemptRoles: z.array(z.string()).max(50).optional(),
}).strict();

/** Delete a server completely (messages, files, everything) and tell its members. Used by the owner and by site admins. */
export function purgeGuild(guild) {
  const members = guildMemberIds(guild.id);
  for (const v of [...voiceStates.values()]) if (v.guildId === guild.id) endCallsForChannel(v.channelId);
  const atts = all('SELECT a.stored_name FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ?', guild.id);
  const emojis = all('SELECT stored_name FROM emojis WHERE guild_id = ?', guild.id);
  const stickers = all('SELECT stored_name FROM stickers WHERE guild_id = ?', guild.id);
  const wearers = all('SELECT id FROM users WHERE tag_guild_id = ?', guild.id).map((u) => u.id);
  const tagBadge = get('SELECT tag_badge FROM guilds WHERE id = ?', guild.id)?.tag_badge;
  run('UPDATE users SET tag_guild_id = NULL WHERE tag_guild_id = ?', guild.id);
  run('DELETE FROM reports WHERE guild_id = ?', guild.id); // reports hold copies of messages: they go with the server, right away
  run('DELETE FROM guilds WHERE id = ?', guild.id);
  run('DELETE FROM streaks WHERE key = ?', `g:${guild.id}`);
  atts.forEach((a) => removeUpload('attachments', a.stored_name));
  emojis.forEach((e) => removeUpload('emojis', e.stored_name));
  stickers.forEach((x) => removeUpload('stickers', x.stored_name));
  removeUpload('icons', storedNameFromUrl(guild.icon));
  removeUpload('banners', storedNameFromUrl(guild.banner));
  removeBadgeFile(tagBadge);
  forgetTag(guild.id);
  if (wearers.length) sendToUsers(onlineUserIds(), 'TAG_UPDATE', { guildId: guild.id, tag: null });
  for (const uid of members) sendToUser(uid, 'GUILD_DELETE', { id: guild.id });
}

export default function register(r) {
  // ---- create / read / update / delete ----
  r.post('/api/guilds', async (ctx) => {
    enforceRateLimit(`guildcreate:${ctx.user.id}`, 10, 3600 * 1000, 'You are creating servers too quickly.');
    const body = z.object({ name: z.string().trim().min(2).max(100), template: z.enum(Object.keys(TEMPLATES).filter((k) => k !== 'lounge')).default('default') }).parse(ctx.body);
    const gid = createGuildRecord(ctx.user.id, body.name, body.template);
    const payload = guildPayloadFor(gid, ctx.user.id);
    sendToUser(ctx.user.id, 'GUILD_SYNC', payload);
    return payload;
  });

  r.get('/api/guilds/:id', async (ctx) => {
    guildAccess(ctx.params.id, ctx.user.id);
    return guildPayloadFor(ctx.params.id, ctx.user.id);
  });

  r.patch('/api/guilds/:id', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const body = z.object({
      name: z.string().trim().min(2).max(100).optional(),
      description: z.string().max(300).optional(),
      discoverable: z.boolean().optional(),
      verificationLevel: z.number().int().min(0).max(3).optional(),
      systemChannelId: z.string().nullable().optional(),
      automod: automodSchema.optional(),
      icon: z.null().optional(),
      banner: z.null().optional(),
    }).parse(ctx.body);
    const sets = []; const vals = []; const changes = {};
    const set = (col, val, key) => { sets.push(`${col} = ?`); vals.push(val); changes[key] = val; };
    if (body.name !== undefined) set('name', body.name, 'name');
    if (body.description !== undefined) set('description', body.description, 'description');
    if (body.discoverable !== undefined) set('discoverable', body.discoverable ? 1 : 0, 'discoverable');
    if (body.verificationLevel !== undefined) set('verification_level', body.verificationLevel, 'verificationLevel');
    if (body.systemChannelId !== undefined) {
      if (body.systemChannelId) {
        const ch = getChannelRow(body.systemChannelId);
        if (!ch || ch.guild_id !== guild.id || ch.type !== ChannelType.TEXT) throw bad('System channel must be a text channel in this server.');
      }
      set('system_channel_id', body.systemChannelId, 'systemChannelId');
    }
    if (body.automod) set('automod', JSON.stringify({ ...guild.automod, ...body.automod }), 'automod');
    if (body.icon === null) { removeUpload('icons', storedNameFromUrl(guild.icon)); sets.push('icon = NULL'); changes.icon = null; }
    if (body.banner === null) { removeUpload('banners', storedNameFromUrl(guild.banner)); sets.push('banner = NULL'); changes.banner = null; }
    if (sets.length) {
      run(`UPDATE guilds SET ${sets.join(', ')} WHERE id = ?`, ...vals, guild.id);
      audit(guild.id, ctx.user.id, 'GUILD_UPDATE', { targetId: guild.id, targetType: 'guild', changes });
      syncGuild(guild.id);
    }
    return guildPayloadFor(guild.id, ctx.user.id);
  });

  // Raid protection: stop new people joining, by hand or automatically when lots join at once (see lib/raid.js).
  r.patch('/api/guilds/:id/safety', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const body = z.object({
      invitesPaused: z.boolean().optional(),
      raidGuard: z.boolean().optional(),
      raidThreshold: z.number().int().min(RAID_MIN, `Pick a number from ${RAID_MIN} to ${RAID_MAX}.`).max(RAID_MAX, `Pick a number from ${RAID_MIN} to ${RAID_MAX}.`).optional(),
      liftRaid: z.literal(true).optional(),   // end an automatic pause now
    }).parse(ctx.body || {});
    const row = get('SELECT * FROM guilds WHERE id = ?', guild.id);   // (the raw row: `guild` above has its own, camel-cased shape)
    const sets = []; const vals = []; const changes = {};
    const set = (col, val, key, shown = val) => { sets.push(`${col} = ?`); vals.push(val); changes[key] = shown; };
    if (body.invitesPaused !== undefined && body.invitesPaused !== !!row.invites_paused) set('invites_paused', body.invitesPaused ? 1 : 0, 'invitesPaused', body.invitesPaused);
    if (body.raidGuard !== undefined && body.raidGuard !== !!row.raid_guard) set('raid_guard', body.raidGuard ? 1 : 0, 'raidGuard', body.raidGuard);
    if (body.raidThreshold !== undefined && body.raidThreshold !== row.raid_threshold) set('raid_threshold', body.raidThreshold, 'raidThreshold');
    if (body.liftRaid && row.raid_until > Date.now()) set('raid_until', 0, 'raidLifted', true);
    if (sets.length) {
      run(`UPDATE guilds SET ${sets.join(', ')} WHERE id = ?`, ...vals, guild.id);
      if (changes.raidLifted || changes.raidGuard || changes.raidThreshold !== undefined) logMember(guild.id, 'reset');   // the guard counts afresh from now
      audit(guild.id, ctx.user.id, 'GUILD_SAFETY', { targetId: guild.id, targetType: 'guild', changes });
      syncGuild(guild.id);
    }
    return guildPayloadFor(guild.id, ctx.user.id);
  });

  for (const kind of ['icon', 'banner']) {
    r.put(`/api/guilds/:id/${kind}`, { raw: true }, async (ctx) => {
      const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
      requirePerm(perms, P.MANAGE_GUILD);
      const dir = kind === 'icon' ? 'icons' : 'banners';
      const img = await receiveImage(ctx.req, dir, 10 * 1024 * 1024);
      removeUpload(dir, storedNameFromUrl(guild[kind]));
      run(`UPDATE guilds SET ${kind} = ? WHERE id = ?`, `/uploads/${dir}/${img.storedName}`, guild.id);
      audit(guild.id, ctx.user.id, 'GUILD_UPDATE', { targetId: guild.id, targetType: 'guild', changes: { [kind]: 'updated' } });
      syncGuild(guild.id);
      return guildPayloadFor(guild.id, ctx.user.id);
    });
  }

  r.delete('/api/guilds/:id', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    if (guild.ownerId !== ctx.user.id) throw forbidden('Only the server owner can delete the server.');
    const { confirmName } = z.object({ confirmName: z.string() }).parse(ctx.body);
    if (confirmName.trim() !== guild.name) throw bad('You didn’t enter the server name correctly.', 'name_mismatch', { errors: { confirmName: 'Server name does not match.' } });
    purgeGuild(guild);
    return { ok: true };
  });

  r.post('/api/guilds/:id/transfer', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    if (guild.ownerId !== ctx.user.id) throw forbidden('Only the owner can transfer ownership.');
    const body = z.object({ userId: z.string(), password: z.string() }).parse(ctx.body);
    if (!(await verifyPassword(body.password, ctx.user.password_hash))) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
    if (!getMember(guild.id, body.userId)) throw notFound('Unknown member.');
    if (getUserRow(body.userId)?.bot) throw bad('A bot can’t own a server.');
    run('UPDATE guilds SET owner_id = ? WHERE id = ?', body.userId, guild.id);
    audit(guild.id, ctx.user.id, 'GUILD_OWNER_TRANSFER', { targetId: body.userId, targetType: 'user' });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ---- members ----
  r.get('/api/guilds/:id/members', async (ctx) => {
    guildAccess(ctx.params.id, ctx.user.id);
    return guildPayloadFor(ctx.params.id, ctx.user.id).members;
  });

  r.patch('/api/guilds/:id/members/:userId', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    const targetId = ctx.params.userId === '@me' ? ctx.user.id : ctx.params.userId;
    const body = z.object({
      nick: z.string().trim().max(32).nullable().optional(),
      roles: z.array(z.string()).max(100).optional(),
      timeoutUntil: z.number().int().nullable().optional(),
      mute: z.boolean().optional(),
      deaf: z.boolean().optional(),
      channelId: z.string().optional(),
      disconnect: z.boolean().optional(),
      reason: z.string().max(512).optional(),
    }).parse(ctx.body);
    const self = targetId === ctx.user.id;
    let target = getMember(guild.id, targetId);
    if (!target) throw notFound('Unknown member.');
    let permsChanged = false;

    if (body.nick !== undefined) {
      if (self) requirePerm(perms, P.CHANGE_NICKNAME, 'You can’t change your nickname here.');
      else { requirePerm(perms, P.MANAGE_NICKNAMES); assertCanActOn(guild, actor, targetId); }
      run('UPDATE guild_members SET nick = ? WHERE guild_id = ? AND user_id = ?', body.nick || null, guild.id, targetId);
      if (!self) audit(guild.id, ctx.user.id, 'MEMBER_UPDATE', { targetId, targetType: 'user', changes: { nick: body.nick || null }, reason: body.reason });
    }
    if (body.roles !== undefined) {
      requirePerm(perms, P.MANAGE_ROLES);
      if (!self) assertCanActOn(guild, actor, targetId);
      const myTop = highestRolePosition(guild, actor);
      const roleMap = new Map(guild.roles.map((x) => [x.id, x]));
      const desired = [...new Set(body.roles.filter((id) => id !== guild.id && roleMap.has(id)))];
      const current = new Set(target.roles);
      const added = desired.filter((id) => !current.has(id));
      const removed = target.roles.filter((id) => !desired.includes(id));
      for (const id of [...added, ...removed]) {
        if (roleMap.get(id).position >= myTop) throw forbidden(`You can’t assign or remove the role "${roleMap.get(id).name}" because it is not below your highest role.`);
      }
      tx(() => {
        for (const id of added) run('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', guild.id, targetId, id);
        for (const id of removed) run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?', guild.id, targetId, id);
      });
      if (added.length || removed.length) {
        permsChanged = true;
        audit(guild.id, ctx.user.id, 'MEMBER_ROLE_UPDATE', { targetId, targetType: 'user', changes: { added: added.map((id) => roleMap.get(id).name), removed: removed.map((id) => roleMap.get(id).name) }, reason: body.reason });
      }
    }
    if (body.timeoutUntil !== undefined) {
      requirePerm(perms, P.MODERATE_MEMBERS);
      if (self) throw bad('You can’t time yourself out.');
      assertCanActOn(guild, actor, targetId);
      const targetPerms = computeBasePermissions(guild, target);
      if (has(targetPerms, P.ADMINISTRATOR)) throw forbidden('Administrators can’t be timed out.');
      let until = body.timeoutUntil;
      if (until && until <= Date.now()) until = null;
      if (until && until > Date.now() + 28 * 24 * 3600 * 1000) throw bad('Timeouts can last at most 28 days.');
      run('UPDATE guild_members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?', until, guild.id, targetId);
      audit(guild.id, ctx.user.id, until ? 'MEMBER_TIMEOUT' : 'MEMBER_TIMEOUT_REMOVE', { targetId, targetType: 'user', changes: { timeoutUntil: until }, reason: body.reason });
      permsChanged = true;
    }
    if (body.mute !== undefined || body.deaf !== undefined) {
      if (body.mute !== undefined) requirePerm(perms, P.MUTE_MEMBERS);
      if (body.deaf !== undefined) requirePerm(perms, P.DEAFEN_MEMBERS);
      if (!moderateVoice(targetId, { mute: body.mute, deaf: body.deaf }, guild.id)) throw bad('That member is not connected to voice.');
      audit(guild.id, ctx.user.id, 'MEMBER_VOICE_UPDATE', { targetId, targetType: 'user', changes: { mute: body.mute, deaf: body.deaf }, reason: body.reason });
    }
    if (body.channelId || body.disconnect) {
      requirePerm(perms, P.MOVE_MEMBERS);
      if (body.channelId) {
        const ch = getChannelRow(body.channelId);
        if (!ch || ch.guild_id !== guild.id || !isVoiceLike(ch.type)) throw bad('Target must be a voice channel in this server.');
      }
      if (!moderateVoice(targetId, { channelId: body.channelId, disconnect: body.disconnect }, guild.id)) throw bad('That member is not connected to voice.');
      audit(guild.id, ctx.user.id, body.disconnect ? 'MEMBER_DISCONNECT' : 'MEMBER_MOVE', { targetId, targetType: 'user', changes: body.channelId ? { channelId: body.channelId } : null });
    }
    target = getMember(guild.id, targetId);
    sendToGuild(guild.id, 'GUILD_MEMBER_UPDATE', { guildId: guild.id, member: target });
    if (permsChanged) { syncGuild(guild.id, [targetId]); revalidateVoice(targetId); }
    return target;
  });

  // Kick
  r.delete('/api/guilds/:id/members/:userId', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.KICK_MEMBERS);
    const targetId = ctx.params.userId;
    if (targetId === ctx.user.id) throw bad('Use “Leave Server” to leave.');
    assertCanActOn(guild, actor, targetId);
    const reason = z.object({ reason: z.string().max(512).optional() }).parse(ctx.body || {}).reason;
    // Kicking a bot takes it out of this server (its role here goes too); the app itself and its other servers are not touched.
    if (isBotId(targetId)) { uninstallBot(targetId, guild.id); audit(guild.id, ctx.user.id, 'BOT_REMOVE', { targetId, targetType: 'user' }); return { ok: true }; }
    kickMember(guild, ctx.user.id, targetId, reason);
    return { ok: true };
  });

  // ---- bans ----
  r.get('/api/guilds/:id/bans', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.BAN_MEMBERS);
    return all('SELECT * FROM bans WHERE guild_id = ? ORDER BY created_at DESC', ctx.params.id)
      .map((b) => ({ user: publicUser(getUserRow(b.user_id)), reason: b.reason, moderatorId: b.moderator_id, createdAt: b.created_at }))
      .filter((b) => b.user);
  });

  r.put('/api/guilds/:id/bans/:userId', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.BAN_MEMBERS);
    const targetId = ctx.params.userId;
    if (targetId === ctx.user.id) throw bad('You can’t ban yourself.');
    if (!getUserRow(targetId)) throw notFound('Unknown user.');
    if (getMember(guild.id, targetId)) assertCanActOn(guild, actor, targetId);
    if (isBotId(targetId)) { uninstallBot(targetId, guild.id); audit(guild.id, ctx.user.id, 'BOT_REMOVE', { targetId, targetType: 'user' }); return { ok: true }; }
    const body = z.object({ reason: z.string().max(512).optional(), deleteMessageSeconds: z.number().int().min(0).max(7 * 86400).default(0) }).parse(ctx.body || {});
    banMember(guild, ctx.user.id, targetId, body);
    return { ok: true };
  });

  r.delete('/api/guilds/:id/bans/:userId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.BAN_MEMBERS);
    const res = run('DELETE FROM bans WHERE guild_id = ? AND user_id = ?', guild.id, ctx.params.userId);
    if (!res.changes) throw notFound('That user is not banned.');
    audit(guild.id, ctx.user.id, 'MEMBER_BAN_REMOVE', { targetId: ctx.params.userId, targetType: 'user' });
    return { ok: true };
  });

  // ---- roles ----
  const roleBody = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    permissions: z.number().int().min(0).max(ALL_PERMISSIONS).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  });

  function checkGrantable(guild, actor, perms, newPerms) {
    if (guild.ownerId === actor.userId || has(perms, P.ADMINISTRATOR)) return;
    if ((newPerms & ~perms) !== 0) throw forbidden('You can’t grant permissions you don’t have.');
  }

  r.post('/api/guilds/:id/roles', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_ROLES);
    const body = roleBody.parse(ctx.body || {});
    if (guild.roles.length >= 250) throw bad('This server has the maximum number of roles.');
    const permsVal = body.permissions ?? (guild.roles.find((x) => x.id === guild.id)?.permissions || 0);
    checkGrantable(guild, actor, perms, permsVal);
    const id = newId();
    // New roles go just above @everyone; shift others up.
    tx(() => {
      run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', guild.id);
      run('INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        id, guild.id, body.name || 'new role', body.color || 0, permsVal, body.hoist ? 1 : 0, body.mentionable ? 1 : 0);
    });
    audit(guild.id, ctx.user.id, 'ROLE_CREATE', { targetId: id, targetType: 'role', changes: { name: body.name || 'new role' } });
    syncGuild(guild.id);
    return serializeRole(get('SELECT * FROM roles WHERE id = ?', id));
  });

  r.patch('/api/guilds/:id/roles/:roleId', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_ROLES);
    const role = guild.roles.find((x) => x.id === ctx.params.roleId);
    if (!role) throw notFound('Unknown role.');
    if (actor.userId !== guild.ownerId && role.position >= highestRolePosition(guild, actor) && role.id !== guild.id) throw forbidden('You can only edit roles below your highest role.');
    const body = roleBody.parse(ctx.body || {});
    if (body.permissions !== undefined) checkGrantable(guild, actor, perms, body.permissions & ~role.permissions);
    if (role.id === guild.id && body.name) delete body.name;
    const sets = []; const vals = [];
    for (const [k, col] of [['name', 'name'], ['color', 'color'], ['permissions', 'permissions']]) if (body[k] !== undefined) { sets.push(`${col} = ?`); vals.push(body[k]); }
    if (body.hoist !== undefined) { sets.push('hoist = ?'); vals.push(body.hoist ? 1 : 0); }
    if (body.mentionable !== undefined) { sets.push('mentionable = ?'); vals.push(body.mentionable ? 1 : 0); }
    if (sets.length) {
      run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...vals, role.id);
      audit(guild.id, ctx.user.id, 'ROLE_UPDATE', { targetId: role.id, targetType: 'role', changes: { ...body, name: body.name ?? role.name } });
      syncGuild(guild.id);
      if (body.permissions !== undefined) for (const uid of guildMemberIds(guild.id)) revalidateVoice(uid);
    }
    return serializeRole(get('SELECT * FROM roles WHERE id = ?', role.id));
  });

  r.patch('/api/guilds/:id/roles', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_ROLES);
    const order = z.array(z.string()).parse(ctx.body?.order); // highest first, excluding @everyone
    const myTop = highestRolePosition(guild, actor);
    const roles = guild.roles.filter((x) => x.id !== guild.id);
    if (order.length !== roles.length || new Set(order).size !== order.length || !roles.every((x) => order.includes(x.id))) throw bad('Role order must include every role.');
    // Unless you own the server, the roles at and above your own highest role must stay where they are, in the same order, at the
    // top: the first roles of the new order have to be exactly those, and everything else may be shuffled below them.
    if (actor.userId !== guild.ownerId) {
      const fixed = roles.filter((x) => x.position >= myTop).sort((p, q) => q.position - p.position).map((x) => x.id);
      if (!fixed.every((id, i) => order[i] === id)) throw forbidden('You can only reorder roles below your highest role.');
    }
    const n = order.length;
    tx(() => { order.forEach((id, i) => run('UPDATE roles SET position = ? WHERE id = ?', n - i, id)); });
    audit(guild.id, ctx.user.id, 'ROLE_REORDER', { targetType: 'role' });
    syncGuild(guild.id);
    return getGuildCore(guild.id).roles;
  });

  r.delete('/api/guilds/:id/roles/:roleId', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_ROLES);
    const role = guild.roles.find((x) => x.id === ctx.params.roleId);
    if (!role || role.id === guild.id) throw notFound('Unknown role.');
    if (actor.userId !== guild.ownerId && role.position >= highestRolePosition(guild, actor)) throw forbidden('You can only delete roles below your highest role.');
    tx(() => {
      run('DELETE FROM roles WHERE id = ?', role.id);
      run('DELETE FROM channel_overwrites WHERE target_id = ?', role.id);
      run('UPDATE roles SET position = position - 1 WHERE guild_id = ? AND position > ?', guild.id, role.position);
    });
    audit(guild.id, ctx.user.id, 'ROLE_DELETE', { targetId: role.id, targetType: 'role', changes: { name: role.name } });
    syncGuild(guild.id);
    for (const uid of guildMemberIds(guild.id)) revalidateVoice(uid);
    return { ok: true };
  });

  // ---- channels ----
  r.post('/api/guilds/:id/channels', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_CHANNELS);
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      type: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(5), z.literal(13), z.literal(15)]),
      parentId: z.string().nullable().optional(),
      topic: z.string().max(1024).optional(),
      private: z.boolean().optional(),
      allowedRoles: z.array(z.string()).optional(),
    }).parse(ctx.body);
    const name = normalizeChannelName(body.name, body.type);
    if (!name) throw bad('Channel name is invalid.', 'bad_name', { errors: { name: 'Please enter a valid name.' } });
    if (get('SELECT COUNT(*) AS n FROM channels WHERE guild_id = ?', guild.id).n >= 500) throw bad('This server has the maximum number of channels.');
    let parent = null;
    if (body.parentId && body.type !== ChannelType.CATEGORY) {
      parent = getChannelRow(body.parentId);
      if (!parent || parent.guild_id !== guild.id || parent.type !== ChannelType.CATEGORY) throw bad('Unknown category.');
    }
    const id = newId();
    const pos = (get('SELECT MAX(position) AS p FROM channels WHERE guild_id = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)', guild.id, parent?.id ?? null, parent?.id ?? null).p ?? -1) + 1;
    tx(() => {
      run('INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, guild.id, body.type, name, body.topic || '', pos, parent?.id || null, Date.now());
      if (parent) {
        for (const o of all('SELECT * FROM channel_overwrites WHERE channel_id = ?', parent.id)) {
          run('INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, ?, ?, ?)', id, o.target_id, o.target_type, o.allow, o.deny);
        }
      }
      if (body.private) {
        run(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 0, 0, ?)
             ON CONFLICT(channel_id, target_id) DO UPDATE SET deny = deny | excluded.deny, allow = allow & ~excluded.deny`, id, guild.id, P.VIEW_CHANNEL);
        run(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 1, ?, 0)
             ON CONFLICT(channel_id, target_id) DO UPDATE SET allow = allow | excluded.allow`, id, ctx.user.id, P.VIEW_CHANNEL);
        for (const rid of body.allowedRoles || []) {
          if (!guild.roles.some((x) => x.id === rid)) continue;
          run(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 0, ?, 0)
               ON CONFLICT(channel_id, target_id) DO UPDATE SET allow = allow | excluded.allow`, id, rid, P.VIEW_CHANNEL);
        }
      }
    });
    audit(guild.id, ctx.user.id, 'CHANNEL_CREATE', { targetId: id, targetType: 'channel', changes: { name, type: body.type } });
    syncGuild(guild.id);
    return serializeChannel(getChannelRow(id));
  });

  r.patch('/api/guilds/:id/channels', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_CHANNELS);
    const list = z.array(z.object({ id: z.string(), position: z.number().int().min(0), parentId: z.string().nullable().optional() })).max(500).parse(ctx.body);
    tx(() => {
      for (const item of list) {
        const ch = getChannelRow(item.id);
        if (!ch || ch.guild_id !== guild.id || ch.type === ChannelType.THREAD) continue;
        if (item.parentId !== undefined && ch.type !== ChannelType.CATEGORY) {
          if (item.parentId) {
            const p = getChannelRow(item.parentId);
            if (!p || p.guild_id !== guild.id || p.type !== ChannelType.CATEGORY) throw bad('Unknown category.');
          }
          run('UPDATE channels SET position = ?, parent_id = ? WHERE id = ?', item.position, item.parentId, ch.id);
        } else {
          run('UPDATE channels SET position = ? WHERE id = ?', item.position, ch.id);
        }
      }
    });
    audit(guild.id, ctx.user.id, 'CHANNEL_REORDER', { targetType: 'channel' });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ---- invites ----
  r.get('/api/guilds/:id/invites', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    return all('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC', ctx.params.id).map(serializeInvite);
  });

  r.post('/api/channels/:id/invites', async (ctx) => {
    const { channel, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM) throw bad('You can’t create invites for direct messages.');
    requirePerm(perms, P.CREATE_INVITE);
    const paused = pauseState(get('SELECT * FROM guilds WHERE id = ?', channel.guild_id));
    if (paused.paused) throw bad(paused.kind === 'raid' ? 'New members are paused for a few minutes because a lot of people joined at once. Try again soon, or resume joining in Server Settings → Safety Setup.' : 'New members are paused for this server, so there is no point making an invite. Resume joining in Server Settings → Safety Setup first.', 'invites_paused');
    enforceRateLimit(`invite:${ctx.user.id}`, 20, 10 * 60 * 1000);
    const body = z.object({
      maxAge: z.number().int().min(0).max(30 * 86400).default(7 * 86400),
      maxUses: z.number().int().min(0).max(1000).default(0),
      unique: z.boolean().default(false),
    }).parse(ctx.body || {});
    if (!body.unique) {
      const existing = get(`SELECT * FROM invites WHERE guild_id = ? AND channel_id = ? AND inviter_id = ? AND max_uses = ? AND code NOT IN (SELECT vanity_code FROM guilds WHERE vanity_code IS NOT NULL) AND
        ((expires_at IS NULL AND ? = 0) OR (expires_at IS NOT NULL AND ? > 0 AND expires_at > ?)) ORDER BY created_at DESC`,
      channel.guild_id, channel.id, ctx.user.id, body.maxUses, body.maxAge, body.maxAge, Date.now() + (body.maxAge * 1000) / 2);
      if (existing) return serializeInvite(existing);
    }
    let code;
    do { code = randomCode(8); } while (get('SELECT 1 FROM invites WHERE code = ?', code));
    run('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      code, channel.guild_id, channel.id, ctx.user.id, body.maxUses, body.maxAge ? Date.now() + body.maxAge * 1000 : null, Date.now());
    audit(channel.guild_id, ctx.user.id, 'INVITE_CREATE', { targetId: code, targetType: 'invite', changes: { maxAge: body.maxAge, maxUses: body.maxUses } });
    return serializeInvite(get('SELECT * FROM invites WHERE code = ?', code));
  });

  r.get('/api/invites/:code', { auth: false }, async (ctx) => {
    enforceRateLimit(`invitelookup:${ctx.ip}`, 60, 60_000);
    const preview = invitePreview(ctx.params.code);
    if (!preview) throw notFound('This invite is invalid or has expired.');
    return preview;
  });

  r.post('/api/invites/:code', async (ctx) => {
    enforceRateLimit(`join:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const inv = findInvite(ctx.params.code);
    if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw notFound('This invite is invalid or has expired.');
    const source = normalizeSource(ctx.body?.source) || null;   // (a label on the link; anything unusable is simply ignored, it must never stop someone joining)
    const { alreadyMember } = addMemberToGuild(inv.guild_id, ctx.user.id, { source });
    if (!alreadyMember) run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
    return { guildId: inv.guild_id, channelId: inv.channel_id, alreadyMember };
  });

  r.delete('/api/invites/:code', async (ctx) => {
    const inv = findInvite(ctx.params.code);
    if (!inv) throw notFound('Unknown invite.');
    const { perms } = guildAccess(inv.guild_id, ctx.user.id);
    if (inv.inviter_id !== ctx.user.id) requirePerm(perms, P.MANAGE_GUILD);
    run('DELETE FROM invites WHERE code = ?', inv.code);
    run('UPDATE guilds SET vanity_code = NULL WHERE id = ? AND vanity_code = ?', inv.guild_id, inv.code);   // (revoking the server's own link frees its name)
    audit(inv.guild_id, ctx.user.id, 'INVITE_DELETE', { targetId: inv.code, targetType: 'invite' });
    return { ok: true };
  });

  // ---- audit log ----
  r.get('/api/guilds/:id/audit-logs', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.VIEW_AUDIT_LOG);
    const where = ['guild_id = ?']; const vals = [ctx.params.id];
    if (ctx.query.before) { where.push('id < ?'); vals.push(String(ctx.query.before)); }
    if (ctx.query.userId) { where.push('user_id = ?'); vals.push(String(ctx.query.userId)); }
    if (ctx.query.action) { where.push('action = ?'); vals.push(String(ctx.query.action)); }
    const rows = all(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`, ...vals);
    const userIds = new Set();
    rows.forEach((x) => { if (x.user_id) userIds.add(x.user_id); if (x.target_type === 'user' && x.target_id) userIds.add(x.target_id); });
    return {
      entries: rows.map((x) => ({ id: x.id, userId: x.user_id, action: x.action, targetId: x.target_id, targetType: x.target_type, changes: x.changes ? JSON.parse(x.changes) : null, reason: x.reason, createdAt: x.created_at })),
      users: [...userIds].map((id) => publicUser(getUserRow(id))).filter(Boolean),
    };
  });

  // ---- emojis ----
  r.post('/api/guilds/:id/emojis', { raw: true }, async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const name = String(ctx.query.name || '').trim();
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) { ctx.req.resume(); throw bad('Emoji names must be 2-32 characters of letters, numbers and underscores.'); }
    if (get('SELECT COUNT(*) AS n FROM emojis WHERE guild_id = ?', guild.id).n >= 100) { ctx.req.resume(); throw bad('This server has the maximum number of emojis (100).'); }
    const img = await receiveImage(ctx.req, 'emojis', 512 * 1024);
    const id = newId();
    run('INSERT INTO emojis (id, guild_id, name, stored_name, animated, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, guild.id, name, img.storedName, img.animated ? 1 : 0, ctx.user.id, Date.now());
    audit(guild.id, ctx.user.id, 'EMOJI_CREATE', { targetId: id, targetType: 'emoji', changes: { name } });
    syncGuild(guild.id);
    return serializeEmoji(get('SELECT * FROM emojis WHERE id = ?', id));
  });
  r.patch('/api/guilds/:id/emojis/:emojiId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const { name } = z.object({ name: z.string().regex(/^[a-zA-Z0-9_]{2,32}$/, 'must be 2-32 letters, numbers or underscores') }).parse(ctx.body);
    const res = run('UPDATE emojis SET name = ? WHERE id = ? AND guild_id = ?', name, ctx.params.emojiId, guild.id);
    if (!res.changes) throw notFound('Unknown emoji.');
    audit(guild.id, ctx.user.id, 'EMOJI_UPDATE', { targetId: ctx.params.emojiId, targetType: 'emoji', changes: { name } });
    syncGuild(guild.id);
    return { ok: true };
  });
  r.delete('/api/guilds/:id/emojis/:emojiId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const e = get('SELECT * FROM emojis WHERE id = ? AND guild_id = ?', ctx.params.emojiId, guild.id);
    if (!e) throw notFound('Unknown emoji.');
    run('DELETE FROM emojis WHERE id = ?', e.id);
    removeUpload('emojis', e.stored_name);
    audit(guild.id, ctx.user.id, 'EMOJI_DELETE', { targetId: e.id, targetType: 'emoji', changes: { name: e.name } });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ---- stickers ----
  // A sticker is a picture of the server's own (up to 512 KB; PNG, GIF or WebP so it can have a see-through background) that members send as a message.
  // It uses the emoji permission, and anyone who is in the server can use it in any other server or chat they are in.
  const STICKER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _\-'!?.]{1,29}$/u;
  r.post('/api/guilds/:id/stickers', { raw: true }, async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const name = String(ctx.query.name || '').trim();
    const tag = String(ctx.query.tag || '').trim().slice(0, 40);
    if (!STICKER_NAME.test(name)) { ctx.req.resume(); throw bad('A sticker’s name must be 2-30 characters: letters, numbers, spaces and a few marks.'); }
    if (get('SELECT COUNT(*) AS n FROM stickers WHERE guild_id = ?', guild.id).n >= MAX_STICKERS) { ctx.req.resume(); throw bad(`This server has the maximum number of stickers (${MAX_STICKERS}).`); }
    const img = await receiveImage(ctx.req, 'stickers', 512 * 1024);
    if (img.contentType === 'image/jpeg') { removeUpload('stickers', img.storedName); throw bad('Stickers need a see-through background, so please use a PNG, GIF or WebP picture.'); }
    const id = newId();
    run('INSERT INTO stickers (id, guild_id, name, tag, stored_name, animated, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, guild.id, name, tag, img.storedName, img.animated ? 1 : 0, ctx.user.id, Date.now());
    audit(guild.id, ctx.user.id, 'STICKER_CREATE', { targetId: id, targetType: 'sticker', changes: { name } });
    syncGuild(guild.id);
    return serializeSticker(get('SELECT * FROM stickers WHERE id = ?', id));
  });
  r.patch('/api/guilds/:id/stickers/:stickerId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const body = z.object({ name: z.string().trim().regex(STICKER_NAME, 'must be 2-30 characters: letters, numbers, spaces and a few marks').optional(), tag: z.string().trim().max(40).optional() }).parse(ctx.body);
    const x = get('SELECT * FROM stickers WHERE id = ? AND guild_id = ?', ctx.params.stickerId, guild.id);
    if (!x) throw notFound('Unknown sticker.');
    run('UPDATE stickers SET name = ?, tag = ? WHERE id = ?', body.name ?? x.name, body.tag ?? x.tag, x.id);
    audit(guild.id, ctx.user.id, 'STICKER_UPDATE', { targetId: x.id, targetType: 'sticker', changes: { name: body.name ?? x.name } });
    syncGuild(guild.id);
    return serializeSticker(get('SELECT * FROM stickers WHERE id = ?', x.id));
  });
  r.delete('/api/guilds/:id/stickers/:stickerId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_EMOJIS);
    const x = get('SELECT * FROM stickers WHERE id = ? AND guild_id = ?', ctx.params.stickerId, guild.id);
    if (!x) throw notFound('Unknown sticker.');
    run('DELETE FROM stickers WHERE id = ?', x.id);
    removeUpload('stickers', x.stored_name);
    audit(guild.id, ctx.user.id, 'STICKER_DELETE', { targetId: x.id, targetType: 'sticker', changes: { name: x.name } });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ---- discovery ----
  r.get('/api/discovery', async (ctx) => {
    const q = String(ctx.query.q || '').trim().toLowerCase();
    const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    const rows = all(`SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS member_count FROM guilds g
      WHERE g.discoverable = 1 AND (? = '' OR lower(g.name) LIKE ? ESCAPE '\\' OR lower(g.description) LIKE ? ESCAPE '\\')
      ORDER BY member_count DESC, g.created_at DESC LIMIT 60`, q, like, like);
    return rows.map((g) => ({
      id: g.id, name: g.name, icon: g.icon, banner: g.banner, description: g.description,
      memberCount: g.member_count,
      onlineCount: guildMemberIds(g.id).filter((id) => isOnline(id) && computePresence(id).status !== 'offline').length,
      joined: !!get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', g.id, ctx.user.id),
    }));
  });
  r.post('/api/discovery/:id/join', async (ctx) => {
    enforceRateLimit(`join:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const g = get('SELECT * FROM guilds WHERE id = ? AND discoverable = 1', ctx.params.id);
    if (!g) throw notFound('That server is not open to the public.');
    addMemberToGuild(g.id, ctx.user.id, { source: 'discovery' });
    return { guildId: g.id, channelId: g.system_channel_id };
  });
}

export function serializeInvite(inv) {
  const inviter = inv.inviter_id ? publicUser(getUserRow(inv.inviter_id)) : null;
  const ch = inv.channel_id ? getChannelRow(inv.channel_id) : null;
  return {
    code: inv.code, guildId: inv.guild_id, channelId: inv.channel_id, channelName: ch?.name || null,
    inviter, maxUses: inv.max_uses, uses: inv.uses, expiresAt: inv.expires_at, createdAt: inv.created_at,
    vanity: !!get('SELECT 1 AS x FROM guilds WHERE id = ? AND vanity_code = ?', inv.guild_id, inv.code),
  };
}

/** Find an invite by its code. A server's own link (/invite/pixelclub) works whatever the capital letters; the random codes are exact. */
/** What an invite link shows (the invite page, the card in chat and the preview other sites make): the server, who invited, how many people
 *  are in it. `null` when the invite is invalid, expired or used up. Nothing here needs a login. */
export function invitePreview(code) {
  const inv = findInvite(code);
  if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses)) return null;
  const g = get('SELECT * FROM guilds WHERE id = ?', inv.guild_id);
  if (!g) return null;
  const members = guildMemberIds(g.id);
  const ch = inv.channel_id ? getChannelRow(inv.channel_id) : null;
  return {
    code: inv.code,
    guild: { id: g.id, name: g.name, icon: g.icon, banner: g.banner, description: g.description, createdAt: g.created_at },
    channel: ch ? { id: ch.id, name: ch.name, type: ch.type } : null,
    inviter: inv.inviter_id ? publicUser(getUserRow(inv.inviter_id)) : null,
    memberCount: members.length,
    onlineCount: members.filter((id) => isOnline(id) && computePresence(id).status !== 'offline').length,
    expiresAt: inv.expires_at,
    paused: pauseState(g).paused,   // (the invite page says so, instead of letting someone press Join and get an error)
  };
}

export function findInvite(code) {
  const c = String(code || '');
  return get('SELECT * FROM invites WHERE code = ?', c)
    || get('SELECT i.* FROM invites i JOIN guilds g ON g.vanity_code = i.code WHERE i.code = ?', c.toLowerCase());
}
