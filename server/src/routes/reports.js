// Reporting a message, and handling reports.
//   - A message in a server is reported to that server's moderators (everyone who can manage messages there) AND to the site admin and
//     site mods, so the Mod Panel shows every report on this NullChat.
//   - A message in a DM or group DM, or one written by the server's owner (nobody else could act on that), goes to the site admin and mods only.
// One report has one status: whoever handles it (a server moderator or site staff) handles it for everybody.
// A report keeps a snapshot of the message (text and file names, not the files), so it still makes sense after the message is
// edited or deleted. The person who is reported is never told, and never sees reports about themselves.
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { channelAccess, guildAccess, getGuildCore, getGuildMembers, publicUser, userGuildIds } from '../models.js';
import { sendToUsers } from '../gateway.js';
import { audit } from '../services.js';
import { isAdmin, isStaff, staffRank, rankOfId, logAdmin, adminUserIds, modUserIds, notStaffSql } from '../lib/admin.js';
import { pushNotice } from '../lib/push.js';
import { P, has, computeBasePermissions } from '../../../shared/permissions.js';
import { REPORT_REASONS, REPORT_REASON_LABELS } from '../../../shared/reports.js';
import { openAppeals } from '../lib/appeals.js';

const KEEP_CLOSED_DAYS = 90;
const PAGE = 25;

/** Everyone who can handle reports for a server: members who can manage messages. */
function moderatorIds(guildId) {
  const guild = getGuildCore(guildId);
  if (!guild) return [];
  return getGuildMembers(guildId).filter((m) => has(computeBasePermissions(guild, m), P.MANAGE_MESSAGES)).map((m) => m.userId);
}

/** The site admin, and the mods and Dev Jrs ranked above the person the report is about: a mod does not judge an admin, a Dev Jr or another mod,
 *  and a Dev Jr does not judge an admin or another Dev Jr. */
function siteStaffIds(reportedUserId) {
  return [...adminUserIds(), ...modUserIds(rankOfId(reportedUserId) + 1)];
}

/** Who is told about / can see a report (never the person who wrote the reported message): site staff for every report, plus a server's moderators for that server's. */
function handlersOf(rep) {
  const ids = [...siteStaffIds(rep.reported_user_id), ...(rep.target === 'guild' && rep.guild_id ? moderatorIds(rep.guild_id) : [])];
  return [...new Set(ids)].filter((id) => id !== rep.reported_user_id);
}

/** What the site list holds for this person: every report on this NullChat, and (for a mod or a Dev Jr) none about someone of their own rank or above. */
function siteScope(user) {
  const hide = isAdmin(user) ? { sql: '', args: [] } : notStaffSql('reported_user_id', user);
  return { where: `1 = 1${hide.sql}`, args: hide.args };
}

/** How many site reports are waiting for this person. */
export function openSiteReports(user) {
  const { where, args } = siteScope(user);
  return get(`SELECT COUNT(*) AS n FROM reports WHERE ${where} AND status = 'open' AND (reported_user_id IS NULL OR reported_user_id != ?)`, ...args, user.id).n;
}

/** How many reports there are about one account (open, and all together). */
export function siteReportsAbout(userId) {
  const row = get("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'open'), 0) AS open FROM reports WHERE reported_user_id = ?", userId);
  return { open: row.open, total: row.total };
}

/** Can this person handle the report as one of the server's moderators? */
function isServerModFor(rep, user) {
  if (rep.target !== 'guild' || !rep.guild_id) return false;
  try { return has(guildAccess(rep.guild_id, user.id).perms, P.MANAGE_MESSAGES); } catch { return false; }
}

function canHandle(rep, user) {
  if (rep.reported_user_id && rep.reported_user_id === user.id) return false;
  if (isAdmin(user) || (isStaff(user) && staffRank(user) > rankOfId(rep.reported_user_id))) return true;   // site staff can handle every report about someone ranked below them
  return isServerModFor(rep, user);
}

function shape(rep, { withExists = false } = {}) {
  const user = (id) => { const u = id ? get('SELECT * FROM users WHERE id = ?', id) : null; return u ? publicUser(u) : null; };
  const snapshot = JSON.parse(rep.snapshot);
  return {
    id: rep.id, target: rep.target, guildId: rep.guild_id, channelId: rep.channel_id, messageId: rep.message_id,
    reason: rep.reason, reasonLabel: REPORT_REASON_LABELS[rep.reason] || rep.reason, details: rep.details,
    status: rep.status, createdAt: rep.created_at, resolvedAt: rep.resolved_at, note: rep.note,
    resolvedBy: rep.resolved_by ? (() => { const u = get('SELECT username, display_name FROM users WHERE id = ?', rep.resolved_by); return u ? (u.display_name || u.username) : null; })() : null,
    reporter: user(rep.reporter_id), reported: user(rep.reported_user_id) || (snapshot.author ? { id: null, username: snapshot.author.username, displayName: snapshot.author.name, avatar: null } : null),
    snapshot,
    messageExists: withExists ? !!get('SELECT 1 FROM messages WHERE id = ?', rep.message_id) : undefined,
  };
}

function list(ctx, where, args) {
  const status = ctx.query.status === 'closed' ? "status != 'open'" : "status = 'open'";
  const before = ctx.query.before ? ' AND id < ?' : '';
  const rows = all(`SELECT * FROM reports WHERE ${where} AND ${status} AND (reported_user_id IS NULL OR reported_user_id != ?)${before} ORDER BY id DESC LIMIT ${PAGE + 1}`,
    ...args, ctx.user.id, ...(ctx.query.before ? [String(ctx.query.before)] : []));
  return { items: rows.slice(0, PAGE).map((r) => shape(r, { withExists: true })), more: rows.length > PAGE };
}

/** Old handled reports are deleted, and so are reports for servers that no longer exist (they hold copies of messages). */
export function purgeReports() {
  run("DELETE FROM reports WHERE status != 'open' AND resolved_at IS NOT NULL AND resolved_at < ?", Date.now() - KEEP_CLOSED_DAYS * 24 * 3600 * 1000);
  run("DELETE FROM reports WHERE target = 'guild' AND guild_id IS NULL");
}

export default function register(r) {
  // ---- report a message ----
  r.post('/api/channels/:id/messages/:messageId/report', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!has(access.perms, P.READ_MESSAGE_HISTORY)) throw notFound('Unknown message.');
    const body = z.object({
      reason: z.enum(REPORT_REASONS.map((x) => x.value)),
      details: z.string().max(500).default(''),
    }).parse(ctx.body);
    const details = body.details.replace(/\r\n/g, '\n').trim();
    if (body.reason === 'other' && !details) throw bad('Tell the moderators what is wrong.');
    const msg = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!msg) throw notFound('Unknown message.');
    if (msg.type !== 0 && msg.type !== 19) throw bad('System messages can’t be reported.');
    if (msg.author_id === ctx.user.id) throw bad('You can’t report your own message.');
    if (get('SELECT 1 FROM reports WHERE reporter_id = ? AND message_id = ?', ctx.user.id, msg.id)) throw bad('You already reported this message.', 'already_reported');
    enforceRateLimit(`report:${ctx.user.id}`, 10, 3_600_000, 'You have sent a lot of reports. Try again in a while.');

    const guildId = access.isDM ? null : access.channel.guild_id;
    const target = guildId && access.guild.ownerId !== msg.author_id ? 'guild' : 'site';
    const author = msg.author_id ? get('SELECT username, display_name FROM users WHERE id = ?', msg.author_id) : null;
    const files = all('SELECT filename, content_type, size FROM attachments WHERE message_id = ?', msg.id);
    let fwd = null; try { fwd = msg.forward ? JSON.parse(msg.forward) : null; } catch { /* unreadable: ignore */ }
    const snapshot = {
      content: msg.content.slice(0, 2000),
      attachments: files.map((f) => ({ filename: f.filename, contentType: f.content_type, size: f.size })),
      forwarded: fwd ? { author: fwd.author?.name || null, content: String(fwd.content || '').slice(0, 1000) } : undefined,
      embeds: JSON.parse(msg.embeds || '[]').length,
      author: author ? { name: author.display_name || author.username, username: author.username } : { name: 'Deleted User', username: null },
      createdAt: msg.created_at, editedAt: msg.edited_at,
      channelName: access.channel.name || null, guildName: access.guild?.name || null,
    };
    const id = newId();
    run('INSERT INTO reports (id, guild_id, channel_id, message_id, reporter_id, reported_user_id, target, reason, details, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, guildId, access.channel.id, msg.id, ctx.user.id, msg.author_id || null, target, body.reason, details, JSON.stringify(snapshot), Date.now());

    // Site staff are told for every report and read it in the Mod / Admin Panel; a server's moderators (who aren't site staff) read theirs in Server Settings.
    const notMe = (ids) => ids.filter((uid) => uid !== ctx.user.id);
    const staff = notMe(siteStaffIds(msg.author_id).filter((uid) => uid !== msg.author_id));
    const serverMods = target === 'guild' ? notMe(handlersOf({ target, guild_id: guildId, reported_user_id: msg.author_id })).filter((uid) => !staff.includes(uid)) : [];
    const where = guildId ? access.guild.name : 'this NullChat';
    sendToUsers(staff, 'REPORT_CREATE', { id, target: 'site', guildId, guildName: access.guild?.name || null });
    sendToUsers(serverMods, 'REPORT_CREATE', { id, target, guildId, guildName: access.guild?.name || null });
    pushNotice(staff, { title: 'New report', body: `A message was reported in ${where}.`, url: '/channels/@me', tag: 'reports-site' });
    pushNotice(serverMods, { title: 'New report', body: `A message was reported in ${where}.`, url: `/channels/${guildId}/${access.channel.id}`, tag: `reports-${guildId}` });
    return { ok: true };
  });

  // ---- the lists ----
  r.get('/api/guilds/:id/reports', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    if (!has(perms, P.MANAGE_MESSAGES)) throw forbidden('You need the Manage Messages permission to see reports.');
    return list(ctx, "target = 'guild' AND guild_id = ?", [guild.id]);
  });
  r.get('/api/admin/reports', async (ctx) => {
    if (!isStaff(ctx.user)) throw forbidden('Only the site admin or a moderator can do that.');
    const { where, args } = siteScope(ctx.user);
    return list(ctx, where, args);
  });

  // How many open reports are waiting for this person (the badges).
  r.get('/api/reports/summary', async (ctx) => {
    const out = { guilds: {}, site: null };
    const mine = userGuildIds(ctx.user.id);
    if (mine.length) {
      const ph = mine.map(() => '?').join(',');
      const rows = all(`SELECT guild_id, COUNT(*) AS n FROM reports WHERE target = 'guild' AND status = 'open' AND guild_id IN (${ph}) AND (reported_user_id IS NULL OR reported_user_id != ?) GROUP BY guild_id`, ...mine, ctx.user.id);
      for (const row of rows) {
        try { if (has(guildAccess(row.guild_id, ctx.user.id).perms, P.MANAGE_MESSAGES)) out.guilds[row.guild_id] = row.n; } catch { /* left the server */ }
      }
    }
    if (isStaff(ctx.user)) {
      out.site = openSiteReports(ctx.user); out.appeals = openAppeals(ctx.user);
      // Someone who is site staff and also moderates a server sees that server's reports in both lists; a total counts them once.
      const gids = Object.keys(out.guilds);
      const { where, args } = siteScope(ctx.user);
      out.overlap = gids.length
        ? get(`SELECT COUNT(*) AS n FROM reports WHERE ${where} AND target = 'guild' AND status = 'open' AND guild_id IN (${gids.map(() => '?').join(',')}) AND (reported_user_id IS NULL OR reported_user_id != ?)`, ...args, ...gids, ctx.user.id).n
        : 0;
    }
    return out;
  });

  // ---- handling ----
  r.post('/api/reports/:id/status', async (ctx) => {
    const body = z.object({ status: z.enum(['resolved', 'dismissed', 'open']), note: z.string().max(300).optional() }).parse(ctx.body);
    const rep = get('SELECT * FROM reports WHERE id = ?', ctx.params.id);
    if (!rep || !canHandle(rep, ctx.user)) throw notFound('That report no longer exists.');
    const note = (body.note || '').trim() || null;
    if (body.status === 'open') run("UPDATE reports SET status = 'open', resolved_by = NULL, resolved_at = NULL, note = NULL WHERE id = ?", rep.id);
    else run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, note = ? WHERE id = ?', body.status, ctx.user.id, Date.now(), note, rep.id);
    const action = { resolved: 'REPORT_RESOLVE', dismissed: 'REPORT_DISMISS', open: 'REPORT_REOPEN' }[body.status];
    // A server moderator's action goes in that server's audit log; site staff acting from the Mod / Admin Panel go in the site's activity log.
    if (isServerModFor(rep, ctx.user)) audit(rep.guild_id, ctx.user.id, action, { targetId: rep.reported_user_id, targetType: 'user', changes: { reason: rep.reason }, reason: note });
    else {
      const guildName = rep.target === 'guild' ? (JSON.parse(rep.snapshot).guildName || null) : null;
      logAdmin(ctx.user, { resolved: 'report_resolve', dismissed: 'report_dismiss', open: 'report_reopen' }[body.status], rep.reported_user_id ? (get('SELECT username FROM users WHERE id = ?', rep.reported_user_id)?.username || null) : null, `${REPORT_REASON_LABELS[rep.reason] || rep.reason}${guildName ? ` (in ${guildName})` : ''}${note ? ` — ${note}` : ''}`);
    }
    sendToUsers(handlersOf(rep), 'REPORT_UPDATE', { id: rep.id, target: rep.target, guildId: rep.guild_id });
    return shape(get('SELECT * FROM reports WHERE id = ?', rep.id), { withExists: true });
  });
}
