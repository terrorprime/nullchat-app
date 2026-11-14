import { z } from 'zod';
import { get, all, run, tx, parseJSON } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { hashPassword, verifyPassword, newId } from '../lib/security.js';
import { isAdmin } from '../lib/admin.js';
import { receiveImage, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import { privateUser, publicUser, relationshipType, isBlockedEitherWay, serializePrivateChannel, getUserRow, voiceSoundsOf, profileSongOf } from '../models.js';
import {
  broadcastUserUpdate, broadcastPresence, sendToUser, sendToUsers, disconnectUser, disconnectSession, computePresence, serializeGuildSettings,
  leaveVoice, onMemberRemoved, sendToGuild,
} from '../gateway.js';
import { usernameSchema, passwordSchema } from './auth.js';
import { ChannelType } from '../../../shared/permissions.js';
import { logMember } from '../lib/raid.js';
import { sanitizeActivity } from '../../../shared/levels.js';
import {
  NAME_FONT_IDS, NAME_EFFECT_IDS, PRISM_COLORS, DECORATION_IDS, ADMIN_DECORATION_ID, IMAGE_DECORATION_DEFAULT_SCALE, PROFILE_EFFECT_IDS,
  sanitizeProfileTheme, sanitizeNameStyle, sanitizeDecoration, sanitizeProfileEffect,
} from '../../../shared/perks.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like #7c6cff');

/** The uploaded-image decoration a user row currently has (or null). */
const imageDecorationOf = (row) => { const d = sanitizeDecoration(row?.avatar_decoration); return d && typeof d === 'object' && d.kind === 'image' ? d : null; };
const removeDecorationFile = (d) => { if (d) removeUpload('decorations', storedNameFromUrl(d.url)); };

function requirePassword(user, password) {
  return verifyPassword(String(password || ''), user.password_hash).then((ok) => {
    if (!ok) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
  });
}

/** Can `fromId` start a DM / friend request with `toId` based on the recipient's privacy settings? */
function privacyAllows(fromId, toId, kind) {
  const target = getUserRow(toId);
  const s = parseJSON(target?.settings, {});
  const privacy = s.privacy || {};
  const friends = relationshipType(toId, fromId) === 1;
  const mutualGuild = !!get('SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?', fromId, toId);
  if (kind === 'dm') {
    if (friends) return true;
    if (privacy.allowDMsFromServerMembers === false) return false;
    return mutualGuild;
  }
  // friend request
  const fr = privacy.friendRequests || { everyone: true, mutualFriends: true, mutualServers: true };
  if (fr.everyone !== false) return true;
  if (fr.mutualServers !== false && mutualGuild) return true;
  if (fr.mutualFriends !== false) {
    const mf = get('SELECT 1 FROM relationships a JOIN relationships b ON a.other_id = b.other_id WHERE a.user_id = ? AND b.user_id = ? AND a.type = 1 AND b.type = 1', fromId, toId);
    if (mf) return true;
  }
  return false;
}
export { privacyAllows };

function relPayload(userId, otherId) {
  const r = get('SELECT * FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId);
  return r ? { id: otherId, type: r.type, nickname: r.nickname, since: r.created_at, user: publicUser(getUserRow(otherId)), presence: computePresence(otherId) } : null;
}
function setRel(userId, otherId, type) {
  run(`INSERT INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, other_id) DO UPDATE SET type = excluded.type, created_at = excluded.created_at`, userId, otherId, type, Date.now());
}
function delRel(userId, otherId) {
  run('DELETE FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId);
}
function emitRel(userId, otherId) {
  const p = relPayload(userId, otherId);
  if (p) sendToUser(userId, 'RELATIONSHIP_ADD', p);
  else sendToUser(userId, 'RELATIONSHIP_REMOVE', { id: otherId });
}

/** Delete an account: files, sessions, memberships. Messages stay and show as "Deleted User". */
export function purgeUser(user) {
  const uid = user.id;
  const guildIds = all('SELECT guild_id FROM guild_members WHERE user_id = ?', uid).map((g) => g.guild_id);
  leaveVoice(uid);
  disconnectUser(uid, 'Account deleted');
  removeUpload('avatars', storedNameFromUrl(user.avatar));
  removeUpload('banners', storedNameFromUrl(user.banner));
  removeDecorationFile(imageDecorationOf(user));
  for (const url of Object.values(voiceSoundsOf(user))) removeUpload('voicesounds', storedNameFromUrl(url));
  removeUpload('profilesongs', storedNameFromUrl(profileSongOf(user)?.url));
  run('DELETE FROM users WHERE id = ?', uid);
  for (const gid of guildIds) sendToGuild(gid, 'GUILD_MEMBER_REMOVE', { guildId: gid, userId: uid });
}

export default function register(r) {
  r.get('/api/users/@me', async (ctx) => ({ ...privateUser(ctx.user), settings: parseJSON(ctx.user.settings, {}) }));

  r.patch('/api/users/@me', async (ctx) => {
    const body = z.object({
      displayName: z.string().trim().max(32).nullable().optional(),
      bio: z.string().max(190).optional(),
      pronouns: z.string().trim().max(40).optional(),
      accentColor: hexColor.nullable().optional(),
      profileTheme: z.object({ primary: hexColor, secondary: hexColor }).nullable().optional(),
      nameStyle: z.object({
        font: z.enum(NAME_FONT_IDS),
        effect: z.enum(NAME_EFFECT_IDS),
        colors: z.array(hexColor).max(PRISM_COLORS),
      }).nullable().optional(),
      profileEffect: z.enum(PROFILE_EFFECT_IDS).nullable().optional(),
      // a ready-made id, the admin's crest, or a custom design (checked for real just below)
      avatarDecoration: z.union([z.enum([...DECORATION_IDS, ADMIN_DECORATION_ID]), z.object({ kind: z.literal('custom') }).passthrough(), z.object({ kind: z.literal('image') }).passthrough()]).nullable().optional(),
      avatar: z.null().optional(),
      banner: z.null().optional(),
    }).parse(ctx.body);
    const u = ctx.user;
    const sets = []; const vals = [];
    if (body.displayName !== undefined) { sets.push('display_name = ?'); vals.push(body.displayName || null); }
    if (body.bio !== undefined) { sets.push('bio = ?'); vals.push(body.bio); }
    if (body.pronouns !== undefined) { sets.push('pronouns = ?'); vals.push(body.pronouns); }
    if (body.accentColor !== undefined) { sets.push('accent_color = ?'); vals.push(body.accentColor); }
    if (body.profileTheme !== undefined) {
      const t = sanitizeProfileTheme(body.profileTheme);
      sets.push('profile_theme = ?'); vals.push(t ? JSON.stringify(t) : null);
    }
    if (body.nameStyle !== undefined) {
      const n = sanitizeNameStyle(body.nameStyle);
      sets.push('name_style = ?'); vals.push(n ? JSON.stringify(n) : null);
    }
    if (body.profileEffect !== undefined) { sets.push('profile_effect = ?'); vals.push(sanitizeProfileEffect(body.profileEffect)); }
    if (body.avatarDecoration !== undefined) {
      const raw = body.avatarDecoration;
      const d = raw === null ? null : sanitizeDecoration(raw);
      if (raw !== null && d === null) throw bad('That decoration isn’t valid.');
      if (d === ADMIN_DECORATION_ID && !isAdmin(u)) throw forbidden('The Admin Crest is only for the site admin.');
      // An uploaded picture can only be the one this user already uploaded (the PATCH just changes its size).
      const had = imageDecorationOf(u);
      if (d && typeof d === 'object' && d.kind === 'image' && (!had || had.url !== d.url)) throw bad('Upload your image first, then adjust its size.');
      // Picking anything else (or nothing) retires the uploaded file.
      if (had && !(d && typeof d === 'object' && d.kind === 'image')) removeDecorationFile(had);
      // The admin wears the crest unless they choose otherwise, so "none" has to be remembered as ''.
      sets.push('avatar_decoration = ?');
      vals.push(d === null ? (isAdmin(u) ? '' : null) : typeof d === 'string' ? d : JSON.stringify(d));
    }
    if (body.avatar === null) { removeUpload('avatars', storedNameFromUrl(u.avatar)); sets.push('avatar = NULL'); }
    if (body.banner === null) { removeUpload('banners', storedNameFromUrl(u.banner)); sets.push('banner = NULL'); }
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, u.id);
    broadcastUserUpdate(u.id);
    return privateUser(getUserRow(u.id));
  });

  r.put('/api/users/@me/avatar', { raw: true }, async (ctx) => {
    enforceRateLimit(`avatar:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const img = await receiveImage(ctx.req, 'avatars', 10 * 1024 * 1024);
    removeUpload('avatars', storedNameFromUrl(ctx.user.avatar));
    run('UPDATE users SET avatar = ? WHERE id = ?', `/uploads/avatars/${img.storedName}`, ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });
  // Your own avatar decoration: a transparent PNG, GIF or WebP that is drawn around your avatar.
  r.put('/api/users/@me/decoration', { raw: true }, async (ctx) => {
    enforceRateLimit(`decoration:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const img = await receiveImage(ctx.req, 'decorations', 3 * 1024 * 1024);
    if (img.contentType === 'image/jpeg') {
      removeUpload('decorations', img.storedName);
      throw bad('A decoration needs a transparent background, so please use a PNG, GIF or WebP image.');
    }
    removeDecorationFile(imageDecorationOf(ctx.user));
    const d = { kind: 'image', url: `/uploads/decorations/${img.storedName}`, scale: IMAGE_DECORATION_DEFAULT_SCALE, x: 0, y: 0 };
    run('UPDATE users SET avatar_decoration = ? WHERE id = ?', JSON.stringify(d), ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });
  r.put('/api/users/@me/banner', { raw: true }, async (ctx) => {
    enforceRateLimit(`banner:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const img = await receiveImage(ctx.req, 'banners', 15 * 1024 * 1024);
    removeUpload('banners', storedNameFromUrl(ctx.user.banner));
    run('UPDATE users SET banner = ? WHERE id = ?', `/uploads/banners/${img.storedName}`, ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });

  // Username / email / password changes require the current password.
  r.patch('/api/users/@me/account', async (ctx) => {
    const body = z.object({
      password: z.string().min(1, 'is required'),
      username: usernameSchema.optional(),
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      newPassword: passwordSchema.optional(),
    }).parse(ctx.body);
    await requirePassword(ctx.user, body.password);
    const u = ctx.user;
    if (body.username && body.username !== u.username) {
      enforceRateLimit(`rename:${u.id}`, 2, 3600 * 1000, 'You are changing your username too often. Try again later.');
      if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', body.username, u.id)) throw bad('That username is taken.', 'username_taken', { errors: { username: 'Username is unavailable.' } });
      run('UPDATE users SET username = ? WHERE id = ?', body.username, u.id);
    }
    if (body.email && body.email !== u.email) {
      if (get('SELECT 1 FROM users WHERE email = ? AND id != ?', body.email, u.id)) throw bad('That email is already in use.', 'email_taken', { errors: { email: 'Email is already registered.' } });
      run('UPDATE users SET email = ? WHERE id = ?', body.email, u.id);
    }
    if (body.newPassword) {
      const hash = await hashPassword(body.newPassword);
      run('UPDATE users SET password_hash = ? WHERE id = ?', hash, u.id);
      // Log out every other device.
      const others = all('SELECT id FROM sessions WHERE user_id = ? AND id != ?', u.id, ctx.session.id);
      run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, ctx.session.id);
      others.forEach((s) => disconnectSession(s.id, 'Password changed'));
    }
    broadcastUserUpdate(u.id);
    return privateUser(getUserRow(u.id));
  });

  r.delete('/api/users/@me', async (ctx) => {
    const { password } = z.object({ password: z.string().min(1) }).parse(ctx.body);
    await requirePassword(ctx.user, password);
    const owned = all('SELECT id, name FROM guilds WHERE owner_id = ?', ctx.user.id);
    if (owned.length) throw bad(`You own ${owned.length} server(s) (${owned.map((g) => g.name).join(', ')}). Transfer ownership or delete them first.`, 'owns_guilds');
    purgeUser(ctx.user);
    return { ok: true };
  });

  // Synced client settings (appearance, accessibility, notifications, privacy, keybinds, ...).
  r.patch('/api/users/@me/settings', async (ctx) => {
    const patch = z.record(z.any()).parse(ctx.body);
    const current = parseJSON(ctx.user.settings, {});
    const merged = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object') merged[k] = { ...current[k], ...v };
      else merged[k] = v;
    }
    const json = JSON.stringify(merged);
    if (json.length > 64 * 1024) throw bad('Settings are too large.');
    run('UPDATE users SET settings = ? WHERE id = ?', json, ctx.user.id);
    sendToUser(ctx.user.id, 'USER_SETTINGS_UPDATE', merged);
    if (patch.privacy) broadcastUserUpdate(ctx.user.id); // level visibility is part of the public profile
    return merged;
  });

  r.patch('/api/users/@me/presence', async (ctx) => {
    const body = z.object({
      status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
      customStatus: z.object({
        text: z.string().max(128).optional().nullable(),
        emoji: z.string().max(64).optional().nullable(),
        expiresAt: z.number().int().positive().optional().nullable(),
      }).nullable().optional(),
      // "Playing X" (set by the desktop app when it spots a game, or cleared with null)
      activity: z.object({ name: z.string().max(64), since: z.number().optional() }).nullable().optional(),
    }).parse(ctx.body);
    if (body.activity !== undefined) {
      const act = sanitizeActivity(body.activity);
      const share = parseJSON(ctx.user.settings, {}).privacy?.shareActivity !== false;
      run('UPDATE users SET activity = ? WHERE id = ?', act && share ? JSON.stringify(act) : null, ctx.user.id);
    }
    if (body.status) run('UPDATE users SET status = ? WHERE id = ?', body.status, ctx.user.id);
    if (body.customStatus !== undefined) {
      const cs = body.customStatus && (body.customStatus.text || body.customStatus.emoji) ? body.customStatus : null;
      run('UPDATE users SET custom_status = ? WHERE id = ?', cs ? JSON.stringify(cs) : null, ctx.user.id);
    }
    broadcastUserUpdate(ctx.user.id);
    broadcastPresence(ctx.user.id, true);
    return privateUser(getUserRow(ctx.user.id));
  });

  r.post('/api/users/@me/onboarded', async (ctx) => {
    run('UPDATE users SET onboarded = 1 WHERE id = ?', ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return { ok: true };
  });

  r.get('/api/users/search', async (ctx) => {
    enforceRateLimit(`usersearch:${ctx.user.id}`, 30, 60_000);
    const q = String(ctx.query.q || '').trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return [];
    const like = q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    const rows = all(`SELECT * FROM users WHERE (username LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\') AND id != ? AND bot = 0 ORDER BY length(username) LIMIT 20`, like, like, ctx.user.id);
    return rows.filter((u) => !isBlockedEitherWay(ctx.user.id, u.id) || relationshipType(ctx.user.id, u.id) === 2)
      .map((u) => ({ ...publicUser(u), relationship: relationshipType(ctx.user.id, u.id) }));
  });

  r.get('/api/users/:id/profile', async (ctx) => {
    const u = getUserRow(ctx.params.id);
    if (!u) throw notFound('Unknown user.');
    const me = ctx.user.id;
    const mutualGuilds = all('SELECT a.guild_id, b.nick FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?', me, u.id)
      .map((g) => ({ id: g.guild_id, nick: g.nick }));
    const mutualFriends = all('SELECT a.other_id FROM relationships a JOIN relationships b ON a.other_id = b.other_id WHERE a.user_id = ? AND b.user_id = ? AND a.type = 1 AND b.type = 1', me, u.id)
      .map((r) => publicUser(getUserRow(r.other_id)));
    return {
      user: publicUser(u),
      presence: computePresence(u.id),
      mutualGuilds: u.id === me ? [] : mutualGuilds,
      mutualFriends: u.id === me ? [] : mutualFriends,
      relationship: relationshipType(me, u.id),
      note: parseJSON(ctx.user.settings, {}).notes?.[u.id] || '',
    };
  });

  // ---- relationships (friends / blocks) ----
  r.get('/api/users/@me/relationships', async (ctx) =>
    all('SELECT other_id FROM relationships WHERE user_id = ?', ctx.user.id).map((r) => relPayload(ctx.user.id, r.other_id)));

  r.post('/api/users/@me/relationships', async (ctx) => {
    const { username } = z.object({ username: z.string().trim().min(1).max(40) }).parse(ctx.body);
    const target = get('SELECT * FROM users WHERE username = ?', username.toLowerCase().replace(/^@/, ''));
    if (!target) throw bad('Hm, didn’t work. Double check that the username is correct.', 'unknown_user');
    return sendFriendRequest(ctx, target.id);
  });

  async function sendFriendRequest(ctx, targetId) {
    const me = ctx.user.id;
    if (targetId === me) throw bad('You can’t add yourself as a friend.');
    if (getUserRow(targetId)?.bot) throw bad('Bots can’t be added as friends.', 'bot');
    enforceRateLimit(`friendreq:${me}`, 20, 10 * 60 * 1000);
    const mine = relationshipType(me, targetId);
    const theirs = relationshipType(targetId, me);
    if (mine === 1) throw bad('You’re already friends with that user!', 'already_friends');
    if (mine === 2) throw bad('You have blocked this user. Unblock them first.', 'blocked');
    if (theirs === 2) throw bad('Hm, didn’t work. Double check that the username is correct.', 'unknown_user');
    if (mine === 3) {
      // Accept their incoming request.
      tx(() => { setRel(me, targetId, 1); setRel(targetId, me, 1); });
    } else {
      if (!privacyAllows(me, targetId, 'friend')) throw bad('This user is not accepting friend requests from you.', 'privacy');
      tx(() => { setRel(me, targetId, 4); setRel(targetId, me, 3); });
    }
    emitRel(me, targetId); emitRel(targetId, me);
    broadcastPresence(me, true); broadcastPresence(targetId, true);
    return relPayload(me, targetId);
  }

  r.put('/api/users/@me/relationships/:id', async (ctx) => {
    const { type } = z.object({ type: z.union([z.literal(1), z.literal(2)]).default(1) }).parse(ctx.body || {});
    const targetId = ctx.params.id;
    if (!getUserRow(targetId)) throw notFound('Unknown user.');
    if (type === 1) return sendFriendRequest(ctx, targetId);
    // Block: remove any friendship / requests, keep their block of us if any.
    const me = ctx.user.id;
    if (targetId === me) throw bad('You can’t block yourself.');
    tx(() => {
      setRel(me, targetId, 2);
      if (relationshipType(targetId, me) !== 2) delRel(targetId, me);
    });
    emitRel(me, targetId); emitRel(targetId, me);
    return relPayload(me, targetId);
  });

  r.delete('/api/users/@me/relationships/:id', async (ctx) => {
    const me = ctx.user.id; const other = ctx.params.id;
    const mine = relationshipType(me, other);
    tx(() => {
      delRel(me, other);
      // Removing a friend / request removes it on both sides; unblocking only removes our side.
      if (mine !== 2 && relationshipType(other, me) !== 2) delRel(other, me);
    });
    emitRel(me, other); emitRel(other, me);
    return { ok: true };
  });

  r.patch('/api/users/@me/notes/:id', async (ctx) => {
    const { note } = z.object({ note: z.string().max(256) }).parse(ctx.body);
    const s = parseJSON(ctx.user.settings, {});
    s.notes = { ...(s.notes || {}), [ctx.params.id]: note };
    if (!note) delete s.notes[ctx.params.id];
    run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), ctx.user.id);
    sendToUser(ctx.user.id, 'USER_SETTINGS_UPDATE', s);
    return { ok: true };
  });

  // ---- DMs and group DMs ----
  r.post('/api/users/@me/channels', async (ctx) => {
    const body = z.object({ recipientId: z.string().optional(), recipients: z.array(z.string()).max(9).optional(), name: z.string().max(100).optional() }).parse(ctx.body);
    const me = ctx.user.id;
    if (body.recipientId) {
      const other = body.recipientId;
      if (other === me) throw bad('You can’t message yourself.');
      const otherRow = getUserRow(other);
      if (!otherRow) throw notFound('Unknown user.');
      if (otherRow.bot) throw bad('Bots can’t receive direct messages. Use their slash commands in a server.', 'bot');
      const existing = get(`SELECT c.* FROM channels c
        JOIN channel_recipients a ON a.channel_id = c.id AND a.user_id = ?
        JOIN channel_recipients b ON b.channel_id = c.id AND b.user_id = ?
        WHERE c.type = ${ChannelType.DM}`, me, other);
      if (existing) {
        run('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ? AND user_id = ?', existing.id, me);
        const payload = serializePrivateChannel(existing, me);
        sendToUser(me, 'CHANNEL_CREATE', payload);
        return payload;
      }
      if (isBlockedEitherWay(me, other)) throw forbidden('You can’t message this user.');
      if (!privacyAllows(me, other, 'dm')) throw forbidden('This user only accepts direct messages from friends.');
      const id = newId();
      tx(() => {
        run('INSERT INTO channels (id, type, created_at) VALUES (?, ?, ?)', id, ChannelType.DM, Date.now());
        run('INSERT INTO channel_recipients (channel_id, user_id, closed) VALUES (?, ?, 0), (?, ?, 1)', id, me, id, other);
      });
      const row = get('SELECT * FROM channels WHERE id = ?', id);
      const payload = serializePrivateChannel(row, me);
      sendToUser(me, 'CHANNEL_CREATE', payload);
      return payload;
    }
    // Group DM — only with friends.
    const recips = [...new Set((body.recipients || []).filter((x) => x !== me))];
    for (const id of recips) {
      if (relationshipType(me, id) !== 1) throw bad('You can only add friends to a group DM.');
    }
    const id = newId();
    tx(() => {
      run('INSERT INTO channels (id, type, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)', id, ChannelType.GROUP_DM, body.name || null, me, Date.now());
      for (const u of [me, ...recips]) run('INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)', id, u);
    });
    const row = get('SELECT * FROM channels WHERE id = ?', id);
    for (const u of [me, ...recips]) sendToUser(u, 'CHANNEL_CREATE', serializePrivateChannel(row, u));
    return serializePrivateChannel(row, me);
  });

  r.get('/api/users/@me/channels', async (ctx) =>
    all(`SELECT c.* FROM channels c JOIN channel_recipients r ON r.channel_id = c.id WHERE r.user_id = ? AND (r.closed = 0 OR c.type = ${ChannelType.GROUP_DM})`, ctx.user.id)
      .map((c) => serializePrivateChannel(c, ctx.user.id)));

  // ---- leave guild ----
  r.delete('/api/users/@me/guilds/:id', async (ctx) => {
    const g = get('SELECT * FROM guilds WHERE id = ?', ctx.params.id);
    if (!g || !get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', g.id, ctx.user.id)) throw notFound('Unknown server.');
    if (g.owner_id === ctx.user.id) throw bad('You own this server. Transfer ownership or delete it instead.', 'owner_cannot_leave');
    run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', g.id, ctx.user.id);
    logMember(g.id, 'leave');
    run('DELETE FROM user_guild_settings WHERE guild_id = ? AND user_id = ?', g.id, ctx.user.id);
    onMemberRemoved(g.id, ctx.user.id);
    sendToGuild(g.id, 'GUILD_MEMBER_REMOVE', { guildId: g.id, userId: ctx.user.id });
    return { ok: true };
  });

  // ---- per-guild notification settings ----
  r.patch('/api/users/@me/guilds/:id/settings', async (ctx) => {
    const gid = ctx.params.id;
    if (gid !== '@me' && !get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', gid, ctx.user.id)) throw notFound('Unknown server.');
    const body = z.object({
      muted: z.boolean().optional(),
      notifications: z.number().int().min(0).max(2).optional(),
      suppressEveryone: z.boolean().optional(),
      channelOverrides: z.record(z.object({ muted: z.boolean().optional(), notifications: z.number().int().min(-1).max(2).optional() })).optional(),
    }).parse(ctx.body);
    const cur = get('SELECT * FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', ctx.user.id, gid) ||
      { muted: 0, notifications: 0, suppress_everyone: 0, channel_overrides: '{}' };
    const overrides = { ...parseJSON(cur.channel_overrides, {}) };
    for (const [cid, v] of Object.entries(body.channelOverrides || {})) overrides[cid] = { ...(overrides[cid] || {}), ...v };
    run(`INSERT INTO user_guild_settings (user_id, guild_id, muted, notifications, suppress_everyone, channel_overrides) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET muted = excluded.muted, notifications = excluded.notifications,
      suppress_everyone = excluded.suppress_everyone, channel_overrides = excluded.channel_overrides`,
      ctx.user.id, gid, body.muted ?? !!cur.muted ? 1 : 0, body.notifications ?? cur.notifications, (body.suppressEveryone ?? !!cur.suppress_everyone) ? 1 : 0, JSON.stringify(overrides));
    const row = get('SELECT * FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', ctx.user.id, gid);
    const payload = serializeGuildSettings(row);
    sendToUser(ctx.user.id, 'GUILD_SETTINGS_UPDATE', payload);
    return payload;
  });

  void sendToUsers;
}
