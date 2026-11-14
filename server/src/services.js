import { get, run, tx } from './db.js';
import { levelFor, XP_COOLDOWN_MS, XP_MIN, XP_MAX } from '../../shared/levels.js';
import { newId } from './lib/security.js';
import { forbidden, bad } from './lib/http.js';
import { serializeMessages, getMember, publicUser, getUserRow, guildPayloadFor } from './models.js';
import { sendToChannel, sendToUser, sendToGuild, broadcastPresence, broadcastUserUpdate } from './gateway.js';
import { assertMayJoin, noteJoin, logMember } from './lib/raid.js';

export function audit(guildId, userId, action, { targetId = null, targetType = null, changes = null, reason = null } = {}) {
  run('INSERT INTO audit_logs (id, guild_id, user_id, action, target_id, target_type, changes, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), guildId, userId, action, targetId, targetType, changes ? JSON.stringify(changes) : null, reason ? String(reason).slice(0, 512) : null, Date.now());
}

/** Insert a system message (join, pin, thread created, call...) and broadcast it. */
export function createSystemMessage(channelRow, authorId, type, content = '', extra = {}) {
  const id = newId();
  run('INSERT INTO messages (id, channel_id, author_id, content, type, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, channelRow.id, authorId, content, type, extra.replyToId || null, Date.now());
  run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, channelRow.id);
  const msg = serializeMessages([get('SELECT * FROM messages WHERE id = ?', id)])[0];
  sendToChannel(channelRow, 'MESSAGE_CREATE', { ...msg, guildId: channelRow.guild_id || null });
  return msg;
}

/** `source` is the "joined from" label of the invite link (or 'discovery'); it is only counted, never kept against the person. `skipGuard` is for the Nullspace lounge, which new accounts are added to when they sign up: a paused server must not break signing up. */
export function addMemberToGuild(guildId, userId, { skipGuard = false, source = null } = {}) {
  const guild = get('SELECT * FROM guilds WHERE id = ?', guildId);
  if (!guild) throw bad('Unknown server.');
  if (get('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?', guildId, userId)) throw forbidden('You are banned from this server.');
  if (get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId)) return { alreadyMember: true };
  if (!skipGuard) assertMayJoin(guild);   // (paused by hand, or paused by raid protection)
  const count = get('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?', userId).n;
  if (count >= 200) throw bad('You can be in at most 200 servers.');
  tx(() => {
    run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guildId, userId, Date.now());
  });
  logMember(guildId, 'join', Date.now(), source);
  const member = getMember(guildId, userId);
  const user = publicUser(getUserRow(userId));
  sendToGuild(guildId, 'GUILD_MEMBER_ADD', { guildId, member, user });
  sendToUser(userId, 'GUILD_SYNC', guildPayloadFor(guildId, userId));
  broadcastPresence(userId, true);
  if (guild.system_channel_id) {
    const ch = get('SELECT * FROM channels WHERE id = ?', guild.system_channel_id);
    if (ch) createSystemMessage(ch, userId, 7);
  }
  if (!skipGuard) noteJoin(guild);   // (too many joins in a minute pauses new members)
  return { alreadyMember: false };
}

/**
 * Give a user xp for chatting in a server. One award per user per server every 30 seconds, so
 * spamming doesn't level you up. Also feeds the account-wide level shown on profiles.
 */
export function awardXp(guildId, userId) {
  const now = Date.now();
  const row = get('SELECT last_award FROM guild_xp WHERE guild_id = ? AND user_id = ?', guildId, userId);
  if (row && now - row.last_award < XP_COOLDOWN_MS) {
    run('UPDATE guild_xp SET messages = messages + 1 WHERE guild_id = ? AND user_id = ?', guildId, userId);
    return null;
  }
  const gain = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const before = get('SELECT xp FROM users WHERE id = ?', userId)?.xp || 0;
  tx(() => {
    run(`INSERT INTO guild_xp (guild_id, user_id, xp, messages, last_award) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, messages = messages + 1, last_award = excluded.last_award`, guildId, userId, gain, now);
    run('UPDATE users SET xp = xp + ? WHERE id = ?', gain, userId);
  });
  const after = before + gain;
  if (levelFor(after) > levelFor(before)) {
    sendToUser(userId, 'LEVEL_UP', { guildId, level: levelFor(after), xp: after });
    broadcastUserUpdate(userId);
  }
  return { gain, xp: after };
}
