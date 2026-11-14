// A server's moderation file on a member: warnings and moderator notes.
//   Warnings  - a moderator (Timeout Members) warns a member with a reason. The member is told at once (or the next time they open
//               NullChat) and has to press "I understand". The history stays, also after the member leaves. A server can choose to
//               time a member out automatically when they reach a number of warnings within 30 days (AutoMod → Warnings).
//   Notes     - short notes about a member that only this server's moderators can read and add to. The member never sees them.
// "Moderator" here: anyone who may time out, kick or ban members, or manage the server.
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { guildAccess, getMember, publicUser, getUserRow, requirePerm } from '../models.js';
import { sendToUser, sendToGuild, syncGuild, revalidateVoice } from '../gateway.js';
import { audit } from '../services.js';
import { pushNotice } from '../lib/push.js';
import { P, has, highestRolePosition, computeBasePermissions } from '../../../shared/permissions.js';

export const WARN_WINDOW_MS = 30 * 24 * 3600 * 1000;   // warnings count toward the automatic timeout for 30 days
const MAX_NOTES = 100;                                  // per member, per server

const isModerator = (perms) => has(perms, P.MODERATE_MEMBERS) || has(perms, P.KICK_MEMBERS) || has(perms, P.BAN_MEMBERS) || has(perms, P.MANAGE_GUILD);
function requireModerator(perms) { if (!isModerator(perms)) throw forbidden('Only this server’s moderators can see that.'); }

const recentCount = (guildId, userId) => get('SELECT COUNT(*) AS n FROM member_warnings WHERE guild_id = ? AND user_id = ? AND created_at > ?', guildId, userId, Date.now() - WARN_WINDOW_MS).n;

const warningRow = (w) => ({ id: w.id, userId: w.user_id, moderatorId: w.moderator_id || null, reason: w.reason, createdAt: w.created_at, seen: !!w.seen_at });
const noteRow = (n) => ({ id: n.id, userId: n.user_id, authorId: n.author_id || null, text: n.text, createdAt: n.created_at });

/** What the warned member is shown: the server, the reason and where they stand. Never who warned them. */
function mine(w) {
  const g = get('SELECT name, icon, automod FROM guilds WHERE id = ?', w.guild_id);
  let am = {}; try { am = JSON.parse(g?.automod || '{}') || {}; } catch { /* ignore */ }
  const member = get('SELECT timeout_until FROM guild_members WHERE guild_id = ? AND user_id = ?', w.guild_id, w.user_id);
  return {
    id: w.id, guildId: w.guild_id, guildName: g?.name || 'a server', guildIcon: g?.icon || null, reason: w.reason, createdAt: w.created_at, seen: !!w.seen_at,
    count: recentCount(w.guild_id, w.user_id), limit: am.warnLimit || 0,
    timeoutUntil: member?.timeout_until > Date.now() ? member.timeout_until : null,
  };
}

export default function register(r) {
  // The whole file on one person, for moderators. Works for someone who has left too (their history is the point).
  r.get('/api/guilds/:id/members/:userId/modfile', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requireModerator(perms);
    const u = getUserRow(ctx.params.userId);
    if (!u) throw notFound('Unknown user.');
    const warnings = all('SELECT * FROM member_warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 200', guild.id, u.id);
    const notes = all('SELECT * FROM member_notes WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', guild.id, u.id, MAX_NOTES);
    const ids = new Set([u.id]);
    warnings.forEach((w) => w.moderator_id && ids.add(w.moderator_id));
    notes.forEach((n) => n.author_id && ids.add(n.author_id));
    const target = getMember(guild.id, u.id);
    const outranked = !!target && actor.userId !== guild.ownerId && highestRolePosition(guild, target) >= highestRolePosition(guild, actor);
    return {
      warnings: warnings.map(warningRow), notes: notes.map(noteRow),
      users: [...ids].map((id) => publicUser(getUserRow(id))).filter(Boolean),
      inServer: !!target,
      recent: recentCount(guild.id, u.id), limit: guild.automod?.warnLimit || 0, timeout: guild.automod?.warnTimeout || 3600,
      canWarn: has(perms, P.MODERATE_MEMBERS) && !!target && !u.bot && u.id !== ctx.user.id && u.id !== guild.ownerId && !outranked,
      canManage: has(perms, P.MANAGE_GUILD),
    };
  });

  // Warn a member. They are told, it is written in the audit log, and it may time them out (see WARN_WINDOW_MS above).
  r.post('/api/guilds/:id/members/:userId/warnings', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MODERATE_MEMBERS);
    const { reason } = z.object({ reason: z.string({ required_error: 'Say what the warning is for. The member will read it.' }).trim().min(1, 'Say what the warning is for. The member will read it.').max(512) }).parse(ctx.body || {});
    const targetId = ctx.params.userId;
    if (targetId === ctx.user.id) throw bad('You can’t warn yourself.');
    if (targetId === guild.ownerId) throw forbidden('You can’t do that to the server owner.');
    const target = getMember(guild.id, targetId);
    if (!target) throw notFound('That person is not in this server any more.');
    if (getUserRow(targetId)?.bot) throw bad('Bots can’t be warned.');
    if (actor.userId !== guild.ownerId && highestRolePosition(guild, target) >= highestRolePosition(guild, actor)) throw forbidden('That member has a role equal to or higher than yours.');
    enforceRateLimit(`warn:${guild.id}:${ctx.user.id}`, 30, 10 * 60_000, 'You have given a lot of warnings in a few minutes. Wait a little.');

    const id = newId();
    run('INSERT INTO member_warnings (id, guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, guild.id, targetId, ctx.user.id, reason, Date.now());
    audit(guild.id, ctx.user.id, 'MEMBER_WARN', { targetId, targetType: 'user', reason });

    // Enough warnings in 30 days: an automatic timeout, if the server asked for one. Never for an administrator, and never shortening a longer timeout.
    const count = recentCount(guild.id, targetId);
    const limit = guild.automod?.warnLimit || 0;
    let timeoutUntil = null;
    if (limit && count >= limit && !has(computeBasePermissions(guild, target), P.ADMINISTRATOR)) {
      const until = Date.now() + (guild.automod?.warnTimeout || 3600) * 1000;
      const now = get('SELECT timeout_until FROM guild_members WHERE guild_id = ? AND user_id = ?', guild.id, targetId)?.timeout_until || 0;
      if (until > now) {
        run('UPDATE guild_members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?', until, guild.id, targetId);
        audit(guild.id, null, 'MEMBER_TIMEOUT', { targetId, targetType: 'user', reason: `AutoMod: reached ${count} warnings`, changes: { timeoutUntil: until } });
        sendToGuild(guild.id, 'GUILD_MEMBER_UPDATE', { guildId: guild.id, member: getMember(guild.id, targetId) });
        syncGuild(guild.id, [targetId]); revalidateVoice(targetId);
        timeoutUntil = until;
      }
    }
    const row = get('SELECT * FROM member_warnings WHERE id = ?', id);
    sendToUser(targetId, 'WARNING_CREATE', mine(row));
    pushNotice([targetId], { title: `Warning in ${guild.name}`, body: 'A moderator gave you a warning. Open NullChat to read it.', url: `/channels/${guild.id}`, tag: `warning-${guild.id}` });
    return { warning: warningRow(row), recent: count, limit, timeoutUntil };
  });

  // Take a warning back (it no longer counts). Whoever gave it, or someone who manages the server.
  r.delete('/api/guilds/:id/warnings/:warningId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MODERATE_MEMBERS);
    const w = get('SELECT * FROM member_warnings WHERE id = ? AND guild_id = ?', ctx.params.warningId, guild.id);
    if (!w) throw notFound('That warning is already gone.');
    if (w.moderator_id !== ctx.user.id && !has(perms, P.MANAGE_GUILD)) throw forbidden('Only the moderator who gave this warning, or someone who manages the server, can remove it.');
    run('DELETE FROM member_warnings WHERE id = ?', w.id);
    audit(guild.id, ctx.user.id, 'MEMBER_WARN_REMOVE', { targetId: w.user_id, targetType: 'user', reason: w.reason });
    sendToUser(w.user_id, 'WARNING_DELETE', { id: w.id });
    return { ok: true, recent: recentCount(guild.id, w.user_id) };
  });

  // ---- notes ----
  r.post('/api/guilds/:id/members/:userId/notes', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requireModerator(perms);
    const { text } = z.object({ text: z.string().trim().min(1, 'Write the note first.').max(1000) }).parse(ctx.body || {});
    const u = getUserRow(ctx.params.userId);
    if (!u) throw notFound('Unknown user.');
    if (get('SELECT COUNT(*) AS n FROM member_notes WHERE guild_id = ? AND user_id = ?', guild.id, u.id).n >= MAX_NOTES) throw bad(`A member can have at most ${MAX_NOTES} notes. Delete an old one first.`);
    const id = newId();
    run('INSERT INTO member_notes (id, guild_id, user_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, guild.id, u.id, ctx.user.id, text, Date.now());
    audit(guild.id, ctx.user.id, 'MEMBER_NOTE', { targetId: u.id, targetType: 'user' });   // (that a note was written, not what it says)
    return noteRow(get('SELECT * FROM member_notes WHERE id = ?', id));
  });

  r.delete('/api/guilds/:id/notes/:noteId', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requireModerator(perms);
    const n = get('SELECT * FROM member_notes WHERE id = ? AND guild_id = ?', ctx.params.noteId, guild.id);
    if (!n) throw notFound('That note is already gone.');
    if (n.author_id !== ctx.user.id && !has(perms, P.MANAGE_GUILD)) throw forbidden('Only whoever wrote this note, or someone who manages the server, can delete it.');
    run('DELETE FROM member_notes WHERE id = ?', n.id);
    return { ok: true };
  });

  // ---- the warned member's side ----
  // Warnings I haven't read yet (the app shows them when it opens), or with ?all=1 every warning I still have.
  r.get('/api/users/@me/warnings', async (ctx) => {
    const rows = ctx.query.all
      ? all('SELECT * FROM member_warnings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', ctx.user.id)
      : all('SELECT * FROM member_warnings WHERE user_id = ? AND seen_at IS NULL ORDER BY created_at LIMIT 20', ctx.user.id);
    return { warnings: rows.map(mine) };
  });

  r.post('/api/users/@me/warnings/seen', async (ctx) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(50) }).parse(ctx.body || {});
    for (const id of ids) run('UPDATE member_warnings SET seen_at = ? WHERE id = ? AND user_id = ? AND seen_at IS NULL', Date.now(), id, ctx.user.id);
    sendToUser(ctx.user.id, 'WARNING_SEEN', { ids });   // (my other devices close theirs)
    return { ok: true };
  });
}
