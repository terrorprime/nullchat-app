// Mod Panel API: what site staff below the admin can do (see lib/admin.js for the levels).
//   a mod    - handles every report on this NullChat (direct messages, things a server's owner wrote, messages in any server), finds ordinary accounts
//              by name, suspends or restores them (with a reason, and not too many an hour), and reads the log of what mods did.
//              Cannot see anyone's email or addresses, reset passwords, delete accounts or servers, change site settings, read messages
//              (except the one that was reported), or touch an admin, a Dev Jr or another mod.
//   a Dev Jr - all of that, and also: sees emails and finds people by email, makes one-time password reset links, reads the site's numbers
//              (messages, servers, uploads, database size) and the log of what mods and Dev Jrs did. Acts on mods and ordinary accounts only.
//              Still cannot see sign-in addresses, delete accounts or servers, make backups, change site settings or hand out roles.
// Admins may call these too; they have the Admin Panel for the same things and more.
import { z } from 'zod';
import fs from 'node:fs';
import { get, all, DB_PATH, DB_INFO } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { config } from '../config.js';
import { isAdmin, isDevJr, isPlainMod, isStaff, staffRank, notStaffSql, recentStaffLog, logAdmin } from '../lib/admin.js';
import { issueEmailToken } from './auth.js';
import { connectedUserCount, isOnline } from '../gateway.js';
import { suspendAccount, restoreAccount } from './admin.js';
import { openSiteReports, siteReportsAbout } from './reports.js';
import { openAppeals } from '../lib/appeals.js';

function requireStaff(ctx) {
  if (!ctx.user || !isStaff(ctx.user)) throw forbidden('Only moderators can do that.');
  return ctx.user;
}

/** A Dev Jr, or the admin: the things a mod does not get (emails, password reset links, the site's numbers). */
const isSenior = (u) => staffRank(u) >= 2;
function requireSenior(ctx) {
  const me = requireStaff(ctx);
  if (!isSenior(me)) throw forbidden('Only a Dev Jr or the site admin can do that.');
  return me;
}

/** The account an action is aimed at: never yourself, never an admin, and never someone of your own rank or above (a mod acts on ordinary accounts, a Dev Jr also on mods). */
function target(ctx, actor) {
  const t = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
  if (!t || t.bot) throw notFound('Unknown user.');
  if (t.id === actor.id) throw bad('You can’t do that to your own account.', 'self');
  if (isAdmin(t)) throw forbidden('That account is a site admin. Mods can’t act on admins.');
  if (!isAdmin(actor) && staffRank(t) >= staffRank(actor)) throw forbidden(isDevJr(t) ? 'That account is a Dev Jr. Ask an admin.' : 'That account is a moderator. Ask an admin.');
  return t;
}

const like = (q) => `%${String(q || '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const page = (v, d, max) => Math.min(max, Math.max(0, Number.parseInt(v, 10) || d));

/** An account as staff below the admin see it: no addresses, and an email only for a Dev Jr (and the admin). */
function userRow(u, me) {
  return {
    id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, createdAt: u.created_at,
    ...(isSenior(me) ? { email: u.email } : {}),
    lastActive: u.last_active || null, banned: !!u.banned_at, bannedAt: u.banned_at || null, bannedReason: u.banned_reason || null,
    isAdmin: isAdmin(u), isDevJr: isDevJr(u), isMod: isPlainMod(u), online: isOnline(u.id),
  };
}

export default function register(r) {
  r.get('/api/mod/overview', async (ctx) => {
    const me = requireStaff(ctx);
    const n = (sql, ...a) => get(sql, ...a)?.n ?? 0;
    return {
      openReports: openSiteReports(me),
      openAppeals: openAppeals(me),
      suspended: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND banned_at IS NOT NULL'),
      users: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0'),
      newToday: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND created_at > ?', Date.now() - 24 * 3600 * 1000),
      online: connectedUserCount(),
      // the site's numbers: for a Dev Jr (and the admin), not for a mod
      ...(isSenior(me) ? (() => {
        let dbBytes = 0; try { dbBytes = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
        return {
          guilds: n('SELECT COUNT(*) AS n FROM guilds'),
          channels: n('SELECT COUNT(*) AS n FROM channels WHERE guild_id IS NOT NULL'),
          messages: n('SELECT COUNT(*) AS n FROM messages'),
          uploadBytes: n('SELECT COALESCE(SUM(size), 0) AS n FROM attachments'),
          dbBytes,
          runtime: { node: process.versions.node, dbDriver: DB_INFO.driver, sqlite: DB_INFO.sqlite },
        };
      })() : {}),
    };
  });

  // Find accounts by name. (A mod can't look people up by email; a Dev Jr can.)
  r.get('/api/mod/users', async (ctx) => {
    const me = requireStaff(ctx);
    const q = String(ctx.query.q || '').trim().slice(0, 100);
    const limit = page(ctx.query.limit, 50, 100) || 50;
    const offset = page(ctx.query.offset, 0, 1_000_000);
    const args = [q, like(q), like(q)];
    let where = `u.bot = 0 AND (? = '' OR u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'`;
    if (isSenior(me)) { where += ` OR u.email LIKE ? ESCAPE '\\'`; args.push(like(q)); }
    where += ')';
    if (ctx.query.filter === 'banned') where += ' AND u.banned_at IS NOT NULL';
    if (ctx.query.filter === 'reported') {
      where += " AND EXISTS (SELECT 1 FROM reports rp WHERE rp.status = 'open' AND rp.reported_user_id = u.id)";
      if (!isAdmin(me)) { const hide = notStaffSql('u.id', me); where += hide.sql; args.push(...hide.args); }
    }
    const rows = all(`SELECT u.*, (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_active
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const total = get(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, ...args).n;
    return { users: rows.map((u) => userRow(u, me)), total };
  });

  r.get('/api/mod/users/:id', async (ctx) => {
    const me = requireStaff(ctx);
    const u = get('SELECT u.*, (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_active FROM users u WHERE u.id = ? AND u.bot = 0', ctx.params.id);
    if (!u) throw notFound('Unknown user.');
    const canAct = u.id !== me.id && !isAdmin(u) && (isAdmin(me) || staffRank(u) < staffRank(me));
    return {
      ...userRow(u, me),
      messages: get('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?', u.id).n,
      servers: get('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?', u.id).n,
      reports: staffRank(u) >= staffRank(me) && !isAdmin(me) ? null : siteReportsAbout(u.id),   // (what is said about someone of your own rank or above is for the level over you)
      canAct,
      canReset: canAct && isSenior(me),
    };
  });

  // Suspend: logged out everywhere, cannot log in. Reversible. The reason is shown to the person and kept in the log, so a mod has to give one.
  r.post('/api/mod/users/:id/ban', async (ctx) => {
    const me = requireStaff(ctx);
    const t = target(ctx, me);
    const schema = isAdmin(me) ? z.string().trim().max(200).optional() : z.string({ required_error: 'Say why. The person will see it, and admins can read it in the log.' }).trim().min(3, 'Say why. The person will see it, and admins can read it in the log.').max(200);
    const { reason } = z.object({ reason: schema }).parse(ctx.body || {});
    if (!isAdmin(me)) enforceRateLimit(`modban:${me.id}`, isSenior(me) ? 60 : 20, 60 * 60_000, 'You have suspended a lot of accounts this hour. If more are needed, ask an admin.');
    suspendAccount(me, t, reason);
    return { ok: true };
  });

  r.post('/api/mod/users/:id/unban', async (ctx) => {
    const me = requireStaff(ctx);
    const t = target(ctx, me);
    restoreAccount(me, t);
    return { ok: true };
  });

  // A one-time link a Dev Jr passes to the person themselves, for when they are locked out and the email never arrives. The same link the "forgot password"
  // email carries: valid for an hour, replaces any earlier reset link, and when it is used the person is signed out everywhere. Two-factor, if they have it,
  // still applies. Only for accounts ranked below the one asking, and written to the log with the name.
  r.post('/api/mod/users/:id/reset-link', async (ctx) => {
    const me = requireSenior(ctx);
    enforceRateLimit(`devjrreset:${me.id}`, 20, 60 * 60_000, 'You have made a lot of reset links this hour. If more are needed, ask an admin.');
    const t = target(ctx, me);
    const ttl = 60 * 60 * 1000;
    const token = issueEmailToken(t.id, 'reset', ttl);
    logAdmin(me, 'reset_link', t.username);
    return { url: `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`, expiresAt: Date.now() + ttl, username: t.username };
  });

  // What staff below the admin have done, newest first (the admins' own actions are not here). A mod sees what mods did; a Dev Jr what mods and Dev Jrs did.
  r.get('/api/mod/log', async (ctx) => {
    const me = requireStaff(ctx);
    const roles = isSenior(me) ? ['mod', 'devjr'] : ['mod'];
    return { entries: recentStaffLog(roles, page(ctx.query.limit, 100, 500) || 100).map((e) => ({ id: e.id, by: e.admin_name, role: e.role, action: e.action, target: e.target, detail: e.detail, createdAt: e.created_at })) };
  });
}
