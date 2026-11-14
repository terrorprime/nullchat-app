// Site admin panel API: look at every account and server on this installation and remove people.
// Only site admins can use these (see lib/admin.js for who that is). Message contents are NOT exposed here.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, DB_PATH, DB_INFO } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit, serveFile } from '../lib/http.js';
import { randomToken, verifyPassword } from '../lib/security.js';
import { config } from '../config.js';
import { backupNow, listBackups, BACKUP_DIR, BACKUP_NAME } from '../lib/backup.js';
import { isAdmin, isPlainMod, isDevJr, logAdmin, recentAdminLog, forgetAdminCache } from '../lib/admin.js';
import { getGuildCore } from '../models.js';
import { disconnectUser, leaveVoice, connectedUserCount, isOnline, sendToUsers, sendToUser, onlineUserIds, broadcastUserUpdate, syncGuild } from '../gateway.js';
import { loungeInfo, loungeGuild, createLounge, setAutoJoin } from '../lib/lounge.js';
import { LEVELS, MAX_ANNOUNCEMENT, getAnnouncement, setAnnouncement, clearAnnouncement, registrationOpen, registrationSource, setRegistrationOverride } from '../lib/site.js';
import { purgeUser } from './users.js';
import { issueEmailToken } from './auth.js';
import { purgeGuild } from './guilds.js';
import { removeServerTag } from './servertags.js';
import { tagFromRow } from '../lib/servertag.js';
import { audit } from '../services.js';
import { sfuStatus } from '../lib/sfu.js';
import { nativeSummary } from '../lib/nativePush.js';
import { getBot, deleteBot, installCount } from '../lib/bots.js';

function requireAdmin(ctx) {
  if (!ctx.user || !isAdmin(ctx.user)) throw forbidden('Only the site admin can do that.');
  return ctx.user;
}

/** The account an action is aimed at. Admins cannot act on themselves or on other admins. */
function target(ctx, admin) {
  const t = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
  if (!t || t.bot) throw notFound('Unknown user.');
  if (t.id === admin.id) throw bad('You can’t do that to your own account.', 'self');
  if (isAdmin(t)) throw bad('That account is a site admin. Remove them from ADMIN_USERS first.', 'target_admin');
  return t;
}

// One-time download links for backups (a normal browser download can't send the login header, so the page asks
// for a link that works once, for one minute).
const downloadTickets = new Map(); // token -> { name, adminId, expires }
const backupInfo = () => ({ enabled: config.backups.enabled, everyHours: config.backups.everyHours, keep: config.backups.keep, files: listBackups() });

const like = (q) => `%${String(q || '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const page = (v, d, max) => Math.min(max, Math.max(0, Number.parseInt(v, 10) || d));

function userRow(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name, email: u.email, avatar: u.avatar, createdAt: u.created_at,
    lastActive: u.last_active || null, guilds: u.guilds ?? 0, banned: !!u.banned_at, bannedAt: u.banned_at || null, bannedReason: u.banned_reason || null,
    isAdmin: isAdmin(u), isMod: isPlainMod(u), isDevJr: isDevJr(u), online: isOnline(u.id),
  };
}

/** Suspend an account: logged out everywhere and cannot log in. Reversible. Their messages stay. Used by the Admin Panel and the Mod Panel. */
export function suspendAccount(actor, t, reason) {
  run('UPDATE users SET banned_at = ?, banned_reason = ? WHERE id = ?', Date.now(), reason || null, t.id);
  run('DELETE FROM sessions WHERE user_id = ?', t.id);
  leaveVoice(t.id);
  disconnectUser(t.id, 'Account suspended');
  logAdmin(actor, 'suspend_user', t.username, reason);
}
export function restoreAccount(actor, t) {
  run('UPDATE users SET banned_at = NULL, banned_reason = NULL WHERE id = ?', t.id);
  // an appeal still waiting is answered by this: the person is back
  run("UPDATE appeals SET status = 'approved', decided_at = ?, decided_by = ? WHERE user_id = ? AND status = 'open'", Date.now(), actor.username, t.id);
  logAdmin(actor, 'restore_user', t.username);
}

export default function register(r) {
  r.get('/api/admin/overview', async (ctx) => {
    requireAdmin(ctx);
    const n = (sql, ...a) => get(sql, ...a)?.n ?? 0;
    let dbBytes = 0; try { dbBytes = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
    return {
      users: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0'),
      newToday: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND created_at > ?', Date.now() - 24 * 3600 * 1000),
      banned: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND banned_at IS NOT NULL'),
      mods: n('SELECT COUNT(*) AS n FROM users WHERE is_mod = 1 AND is_devjr = 0'),
      devjrs: n('SELECT COUNT(*) AS n FROM users WHERE is_devjr = 1'),
      openAppeals: n("SELECT COUNT(*) AS n FROM appeals WHERE status = 'open'"),
      online: connectedUserCount(),
      guilds: n('SELECT COUNT(*) AS n FROM guilds'),
      channels: n('SELECT COUNT(*) AS n FROM channels WHERE guild_id IS NOT NULL'),
      messages: n('SELECT COUNT(*) AS n FROM messages'),
      uploadBytes: n('SELECT COALESCE(SUM(size), 0) AS n FROM attachments'),
      dbBytes,
      runtime: { node: process.versions.node, dbDriver: DB_INFO.driver, sqlite: DB_INFO.sqlite },
      bigCalls: sfuStatus(),
      phoneApps: nativeSummary(),
    };
  });

  r.get('/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    const q = String(ctx.query.q || '').trim().slice(0, 100);
    const onlyBanned = ctx.query.filter === 'banned';
    const onlyMods = ctx.query.filter === 'mods';
    const onlyDevJr = ctx.query.filter === 'devjr';
    const limit = page(ctx.query.limit, 50, 100) || 50;
    const offset = page(ctx.query.offset, 0, 1_000_000);
    const where = `u.bot = 0 AND (? = '' OR u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')${onlyBanned ? ' AND u.banned_at IS NOT NULL' : ''}${onlyMods ? ' AND u.is_mod = 1 AND u.is_devjr = 0' : ''}${onlyDevJr ? ' AND u.is_devjr = 1' : ''}`;
    const args = [q, like(q), like(q), like(q)];
    const rows = all(`SELECT u.*, (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_active,
        (SELECT COUNT(*) FROM guild_members gm WHERE gm.user_id = u.id) AS guilds
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const total = get(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, ...args).n;
    return { users: rows.map(userRow), total };
  });

  r.get('/api/admin/users/:id', async (ctx) => {
    requireAdmin(ctx);
    const u = get(`SELECT u.*, (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_active,
        (SELECT COUNT(*) FROM guild_members gm WHERE gm.user_id = u.id) AS guilds FROM users u WHERE u.id = ? AND u.bot = 0`, ctx.params.id);
    if (!u) throw notFound('Unknown user.');
    return {
      ...userRow(u),
      messages: get('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?', u.id).n,
      servers: all('SELECT g.id, g.name, g.owner_id FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id WHERE gm.user_id = ? ORDER BY g.name', u.id)
        .map((g) => ({ id: g.id, name: g.name, owner: g.owner_id === u.id })),
      sessions: all('SELECT ip, user_agent, last_used_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 5', u.id)
        .map((s) => ({ ip: s.ip, userAgent: s.user_agent, lastUsed: s.last_used_at })),
    };
  });

  // Suspend: logged out everywhere, cannot log in. Reversible with /unban. Their messages stay.
  r.post('/api/admin/users/:id/ban', async (ctx) => {
    const admin = requireAdmin(ctx);
    const t = target(ctx, admin);
    const { reason } = z.object({ reason: z.string().trim().max(200).optional() }).parse(ctx.body || {});
    suspendAccount(admin, t, reason);
    return { ok: true };
  });

  r.post('/api/admin/users/:id/unban', async (ctx) => {
    const admin = requireAdmin(ctx);
    const t = target(ctx, admin);
    restoreAccount(admin, t);
    return { ok: true };
  });

  // Make someone a site moderator, or take it back. Only an admin can; the person is told at once and their screen updates
  // without reloading. Admins are not "made" mods (they already can do everything), and a suspended account is not promoted.
  r.put('/api/admin/users/:id/mod', async (ctx) => {
    const admin = requireAdmin(ctx);
    const { mod } = z.object({ mod: z.boolean() }).parse(ctx.body || {});
    enforceRateLimit(`modrole:${admin.id}`, 60, 60 * 60_000, 'You have changed a lot of moderators. Try again in a while.');
    const t = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!t) throw notFound('Unknown user.');
    if (t.id === admin.id || isAdmin(t)) throw bad('Site admins can already do everything a mod can.', 'target_admin');
    if (mod && t.banned_at) throw bad('Restore this account before making them a mod.', 'banned');
    if (mod && t.is_devjr) throw bad('They are a Dev Jr, which is above a mod. Remove Dev Jr first if you want them to be a mod instead.', 'is_devjr');
    if (!!t.is_mod === mod) return { ok: true, isMod: mod };
    run('UPDATE users SET is_mod = ? WHERE id = ?', mod ? 1 : 0, t.id);
    logAdmin(admin, mod ? 'mod_add' : 'mod_remove', t.username);
    broadcastUserUpdate(t.id);
    sendToUser(t.id, 'MOD_UPDATE', { isMod: mod, isDevJr: false });
    return { ok: true, isMod: mod };
  });

  // Make someone a Dev Jr (a level between mod and admin), or take it back. Only an admin can; the person is told at once and their screen updates without
  // reloading. A Dev Jr has every power of a mod, so making someone one replaces "mod"; taking it back makes them an ordinary member again.
  r.put('/api/admin/users/:id/devjr', async (ctx) => {
    const admin = requireAdmin(ctx);
    const { devjr } = z.object({ devjr: z.boolean() }).parse(ctx.body || {});
    enforceRateLimit(`modrole:${admin.id}`, 60, 60 * 60_000, 'You have changed a lot of staff roles. Try again in a while.');
    const t = get('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!t || t.bot) throw notFound('Unknown user.');
    if (t.id === admin.id || isAdmin(t)) throw bad('Site admins can already do everything a Dev Jr can.', 'target_admin');
    if (devjr && t.banned_at) throw bad('Restore this account before making them a Dev Jr.', 'banned');
    if (!!t.is_devjr === devjr) return { ok: true, isDevJr: devjr };
    run('UPDATE users SET is_devjr = ?, is_mod = 0 WHERE id = ?', devjr ? 1 : 0, t.id);
    logAdmin(admin, devjr ? 'devjr_add' : 'devjr_remove', t.username);
    broadcastUserUpdate(t.id);
    sendToUser(t.id, 'MOD_UPDATE', { isMod: false, isDevJr: devjr, ...(devjr ? {} : { removed: 'devjr' }) });
    return { ok: true, isDevJr: devjr };
  });

  // A one-time link the admin passes to the person themselves, for when they are locked out and no email is set up
  // (or the email never arrives). It is the same link the "forgot password" email carries: valid for an hour, replaces
  // any earlier reset link, and when it is used the person is signed out everywhere. Two-factor, if they have it, still applies.
  r.post('/api/admin/users/:id/reset-link', async (ctx) => {
    const admin = requireAdmin(ctx);
    enforceRateLimit(`adminreset:${admin.id}`, 20, 60 * 60 * 1000);
    const t = target(ctx, admin);
    const ttl = 60 * 60 * 1000;
    const token = issueEmailToken(t.id, 'reset', ttl);
    logAdmin(admin, 'reset_link', t.username);
    return { url: `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`, expiresAt: Date.now() + ttl, username: t.username };
  });

  // Permanent. Their messages stay and show as "Deleted User".
  r.delete('/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const t = target(ctx, admin);
    const body = z.object({ confirmUsername: z.string(), deleteServers: z.boolean().optional() }).parse(ctx.body || {});
    if (body.confirmUsername.trim() !== t.username) throw bad('Type their username exactly to confirm.', 'name_mismatch');
    const owned = all('SELECT id, name FROM guilds WHERE owner_id = ?', t.id);
    if (owned.length && !body.deleteServers) {
      throw bad(`They own ${owned.length} server(s): ${owned.map((g) => g.name).join(', ')}. Tick “also delete their servers”, or delete those servers first.`, 'owns_guilds');
    }
    for (const g of owned) {
      const core = getGuildCore(g.id);
      if (core) { purgeGuild(core); logAdmin(admin, 'delete_server', g.name, `owned by ${t.username}`); }
    }
    purgeUser(t);
    forgetAdminCache();
    logAdmin(admin, 'delete_user', t.username, t.email);
    return { ok: true };
  });

  r.get('/api/admin/guilds', async (ctx) => {
    requireAdmin(ctx);
    const q = String(ctx.query.q || '').trim().slice(0, 100);
    const rows = all(`SELECT g.id, g.name, g.icon, g.owner_id, g.created_at, g.tag, g.tag_badge, g.tag_color, u.username AS owner_name,
        (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS members,
        (SELECT COUNT(*) FROM channels c WHERE c.guild_id = g.id) AS channels
      FROM guilds g LEFT JOIN users u ON u.id = g.owner_id
      WHERE (? = '' OR g.name LIKE ? ESCAPE '\\') ORDER BY g.created_at DESC LIMIT 200`, q, like(q));
    return { guilds: rows.map((g) => ({ id: g.id, name: g.name, icon: g.icon, ownerId: g.owner_id, ownerName: g.owner_name, members: g.members, channels: g.channels, createdAt: g.created_at, tag: tagFromRow(g) })) };
  });

  r.delete('/api/admin/guilds/:id/tag', async (ctx) => {
    const admin = requireAdmin(ctx);
    const g = getGuildCore(ctx.params.id);
    if (!g) throw notFound('Unknown server.');
    if (!g.tag) return { ok: true };
    const text = g.tag.text;
    removeServerTag(g.id);
    audit(g.id, admin.id, 'GUILD_TAG', { targetId: g.id, targetType: 'guild', changes: { tag: null, byAdmin: true } });
    logAdmin(admin, 'remove_server_tag', `${g.name} (${text})`);
    syncGuild(g.id);
    return { ok: true };
  });

  r.delete('/api/admin/guilds/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const g = getGuildCore(ctx.params.id);
    if (!g) throw notFound('Unknown server.');
    const { confirmName } = z.object({ confirmName: z.string() }).parse(ctx.body || {});
    if (confirmName.trim() !== g.name) throw bad('Type the server name exactly to confirm.', 'name_mismatch');
    purgeGuild(g);
    logAdmin(admin, 'delete_server', g.name);
    return { ok: true };
  });

  // ---- apps (bots) that other people can add: the App Directory ----
  // Every app that is listed or has a link, and the ones staff hid. Hiding takes it out of the directory and stops new servers adding it
  // (the servers that already have it keep it; their managers can remove it). Deleting removes it everywhere.
  const appRow = (b) => ({
    id: b.id, name: b.name, username: b.username, avatar: b.avatar, description: b.description, visibility: b.visibility, hidden: !!b.hidden,
    ownerId: b.owner_id, ownerName: b.owner_name || null, installs: b.installs, createdAt: b.created_at, online: isOnline(b.id),
  });
  r.get('/api/admin/apps', async (ctx) => {
    requireAdmin(ctx);
    const q = String(ctx.query.q || '').trim().slice(0, 100);
    const rows = all(`SELECT b.*, u.display_name AS name, u.username, u.avatar, o.username AS owner_name,
        (SELECT COUNT(*) FROM bot_installs i WHERE i.bot_id = b.id) AS installs
      FROM bots b JOIN users u ON u.id = b.id LEFT JOIN users o ON o.id = b.owner_id
      WHERE (b.visibility != 'private' OR b.hidden = 1) AND (? = '' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR o.username LIKE ? ESCAPE '\\')
      ORDER BY b.hidden DESC, installs DESC, b.created_at DESC LIMIT 200`, q, like(q), like(q), like(q));
    return { apps: rows.map(appRow) };
  });

  r.put('/api/admin/apps/:botId/hidden', async (ctx) => {
    const admin = requireAdmin(ctx);
    const bot = getBot(ctx.params.botId);
    if (!bot) throw notFound('Unknown app.');
    const { hidden } = z.object({ hidden: z.boolean() }).parse(ctx.body || {});
    run('UPDATE bots SET hidden = ? WHERE id = ?', hidden ? 1 : 0, bot.id);
    const u = get('SELECT display_name FROM users WHERE id = ?', bot.id);
    logAdmin(admin, hidden ? 'hide_app' : 'show_app', u?.display_name || bot.id);
    return { ok: true, hidden };
  });

  r.delete('/api/admin/apps/:botId', async (ctx) => {
    const admin = requireAdmin(ctx);
    const bot = getBot(ctx.params.botId);
    if (!bot) throw notFound('Unknown app.');
    const u = get('SELECT display_name FROM users WHERE id = ?', bot.id);
    const n = installCount(bot.id);
    deleteBot(bot.id);
    logAdmin(admin, 'delete_app', u?.display_name || bot.id, `in ${n} server${n === 1 ? '' : 's'}`);
    return { ok: true };
  });

  // ---- database backups ----
  r.get('/api/admin/backups', async (ctx) => {
    requireAdmin(ctx);
    return backupInfo();
  });

  // Make a fresh backup right now (the copy is consistent even while people are chatting).
  r.post('/api/admin/backups', async (ctx) => {
    const admin = requireAdmin(ctx);
    enforceRateLimit(`backup:${admin.id}`, 5, 10 * 60_000, 'You can make a few backups every ten minutes. Try again shortly.');
    const file = await backupNow();
    logAdmin(admin, 'backup_create', path.basename(file));
    return backupInfo();
  });

  // Ask for a download link. It contains everything (including private messages), so the admin's password is needed.
  r.post('/api/admin/backups/:name/ticket', async (ctx) => {
    const admin = requireAdmin(ctx);
    const { password } = z.object({ password: z.string().max(200) }).parse(ctx.body || {});
    enforceRateLimit(`backup-ticket:${admin.id}`, 5, 10 * 60_000, 'Too many attempts. Wait a few minutes and try again.');
    if (!(await verifyPassword(password, admin.password_hash))) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
    const name = ctx.params.name;
    if (!BACKUP_NAME.test(name) || !listBackups().some((b) => b.name === name)) throw notFound('That backup no longer exists.');
    const now = Date.now();
    for (const [k, v] of downloadTickets) if (v.expires < now) downloadTickets.delete(k);
    const token = randomToken(24);
    downloadTickets.set(token, { name, adminId: admin.id, expires: now + 60_000 });
    logAdmin(admin, 'backup_download', name);
    return { url: `/api/admin/backups/download?ticket=${token}` };
  });

  r.get('/api/admin/backups/download', { auth: false, raw: true }, async (ctx) => {
    const t = downloadTickets.get(String(ctx.query.ticket || ''));
    downloadTickets.delete(String(ctx.query.ticket || ''));
    if (!t || t.expires < Date.now()) throw forbidden('This download link has expired. Go back to the Admin panel and start the download again.');
    const file = path.join(BACKUP_DIR, t.name);
    const ok = serveFile(ctx.req, ctx.res, file, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${t.name}"`,
      'Cache-Control': 'no-store',
    });
    if (!ok) throw notFound('That backup no longer exists.');
  });

  // ---- site settings: announcement banner + sign-ups ----
  const siteInfo = () => ({
    announcement: getAnnouncement(),
    registration: { open: registrationOpen(), source: registrationSource(), configDefault: config.registrationOpen },
    maxAnnouncement: MAX_ANNOUNCEMENT,
    lounge: loungeInfo(),
  });
  const pushAnnouncement = () => sendToUsers(onlineUserIds(), 'ANNOUNCEMENT_UPDATE', { announcement: getAnnouncement() });
  r.get('/api/admin/site', async (ctx) => {
    requireAdmin(ctx);
    return siteInfo();
  });
  // A banner at the top of the app for everyone (e.g. "Maintenance tonight at 10 PM"). Saving again replaces it.
  r.put('/api/admin/site/announcement', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = z.object({ text: z.string().trim().min(1, 'Write the announcement first.').max(MAX_ANNOUNCEMENT, `Keep it under ${MAX_ANNOUNCEMENT} characters.`), level: z.enum(LEVELS).default('info') }).parse(ctx.body || {});
    enforceRateLimit(`announce:${admin.id}`, 20, 10 * 60_000);
    setAnnouncement(body, admin.username);
    logAdmin(admin, 'announcement_set', body.level, body.text);
    pushAnnouncement();
    return siteInfo();
  });
  r.delete('/api/admin/site/announcement', async (ctx) => {
    const admin = requireAdmin(ctx);
    if (getAnnouncement()) { clearAnnouncement(); logAdmin(admin, 'announcement_clear'); pushAnnouncement(); }
    return siteInfo();
  });
  // Open or close sign-ups without redeploying. open: null goes back to the REGISTRATION_OPEN setting.
  r.put('/api/admin/site/registration', async (ctx) => {
    const admin = requireAdmin(ctx);
    const { open } = z.object({ open: z.boolean().nullable() }).parse(ctx.body || {});
    setRegistrationOverride(open);
    logAdmin(admin, 'registration_set', open === null ? 'default' : open ? 'open' : 'closed');
    return siteInfo();
  });

  // The Nullspace lounge: every new account is added to it. autoJoin switches that on or off.
  r.put('/api/admin/site/lounge', async (ctx) => {
    const admin = requireAdmin(ctx);
    const { autoJoin } = z.object({ autoJoin: z.boolean() }).parse(ctx.body || {});
    setAutoJoin(autoJoin);
    logAdmin(admin, 'lounge_set', autoJoin ? 'on' : 'off');
    return siteInfo();
  });
  // Makes a new lounge (if it was deleted, or was never made because the switch was off). Does nothing if there is one.
  r.post('/api/admin/site/lounge/create', async (ctx) => {
    const admin = requireAdmin(ctx);
    enforceRateLimit(`lounge:${admin.id}`, 5, 60 * 60_000);
    if (!loungeGuild()) {
      createLounge(admin);
      setAutoJoin(true);
      logAdmin(admin, 'lounge_create');
    }
    return siteInfo();
  });

  r.get('/api/admin/log', async (ctx) => {
    requireAdmin(ctx);
    return { entries: recentAdminLog(page(ctx.query.limit, 100, 500) || 100).map((e) => ({ id: e.id, admin: e.admin_name, role: e.role || 'admin', action: e.action, target: e.target, detail: e.detail, createdAt: e.created_at })) };
  });
}
