// Site-wide staff. Server owners moderate their own server; on top of that there are three levels for the whole installation:
//   admin  = sees and runs everything (see isAdmin below; chosen in ADMIN_USERS, never changed from inside the app)
//   Dev Jr = a level between, handed out and taken back by the admin (users.is_devjr): everything a mod can do, and also sees emails, finds people by
//            email, makes password reset links and reads the site's numbers. Cannot touch admins or other Dev Jrs, and cannot delete accounts or
//            servers, make backups or change site settings.
//   mod    = a lower level the admin hands out and takes back in the Admin Panel (users.is_mod): handles the reports nobody else
//            could, and suspends or restores ordinary accounts. Cannot touch admins, Dev Jrs or other mods, and sees no emails or addresses.
// Staff only ever act on people ranked below them (see staffRank).
import { get, run, all } from '../db.js';
import { config } from '../config.js';
import { newId } from './security.js';

let oldestCache = { id: null, at: 0 };
function oldestUserId() {
  if (Date.now() - oldestCache.at > 30_000) {
    oldestCache = { id: get('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1')?.id || null, at: Date.now() };
  }
  return oldestCache.id;
}
export function forgetAdminCache() { oldestCache = { id: null, at: 0 }; }

/** Is this users-table row a site admin? ADMIN_USERS wins; without it the oldest account is the admin. */
export function isAdmin(u) {
  if (!u) return false;
  if (config.adminUsers.length) return config.adminUsers.includes(String(u.username).toLowerCase()) || config.adminUsers.includes(String(u.email).toLowerCase());
  return oldestUserId() === u.id;
}

/** The ids of every site admin (the accounts in ADMIN_USERS, or the oldest account when that is empty). */
export function adminUserIds() {
  if (config.adminUsers.length) {
    const ph = config.adminUsers.map(() => '?').join(',');
    return all(`SELECT id FROM users WHERE lower(username) IN (${ph}) OR lower(email) IN (${ph})`, ...config.adminUsers, ...config.adminUsers).map((r) => r.id);
  }
  const id = oldestUserId();
  return id ? [id] : [];
}

/** Is this a Dev Jr? An admin is never counted as one. */
export function isDevJr(u) {
  return !!u && !!u.is_devjr && !isAdmin(u);
}

/** Does this person have a mod's powers? A Dev Jr has every one of them (and more), so permission checks ask this. An admin is never counted as a mod. */
export function isMod(u) {
  return !!u && (!!u.is_mod || !!u.is_devjr) && !isAdmin(u);
}

/** Exactly a mod (not a Dev Jr, not an admin): what the labels and the Admin Panel's "Make mod" button need. */
export function isPlainMod(u) {
  return !!u && !!u.is_mod && !u.is_devjr && !isAdmin(u);
}

/** Admin or anyone below with the powers of a mod. */
export const isStaff = (u) => isAdmin(u) || isMod(u);

/** 3 admin, 2 Dev Jr, 1 mod, 0 everyone else. Staff only act on people ranked below them (an admin acts on nobody who is an admin). */
export function staffRank(u) {
  if (!u) return 0;
  return isAdmin(u) ? 3 : isDevJr(u) ? 2 : isMod(u) ? 1 : 0;
}
export const rankOfId = (userId) => (userId ? staffRank(get('SELECT * FROM users WHERE id = ?', userId)) : 0);
export const rankName = (rank) => ['member', 'moderator', 'Dev Jr', 'site admin'][rank] || 'member';

/** The ids of every site moderator and Dev Jr (not counting admins, and not accounts that are suspended) whose rank is at least `minRank` (1 = mods and Dev Jrs, 2 = Dev Jrs only). */
export function modUserIds(minRank = 1) {
  const admins = new Set(adminUserIds());
  return all('SELECT * FROM users WHERE (is_mod = 1 OR is_devjr = 1) AND banned_at IS NULL')
    .filter((u) => !admins.has(u.id) && staffRank(u) >= minRank).map((u) => u.id);
}

/** Everyone staff of at least this rank (admins included, suspended or not). */
export function staffIdsAtLeast(minRank) {
  const ids = new Set(all('SELECT * FROM users WHERE is_mod = 1 OR is_devjr = 1').filter((u) => staffRank(u) >= minRank).map((u) => u.id));
  if (minRank <= 3) for (const id of adminUserIds()) ids.add(id);
  return [...ids];
}

/** Everyone a mod must leave alone: admins, Dev Jrs and other mods. */
export function staffUserIds() {
  return staffIdsAtLeast(1);
}

/** An SQL piece that hides what the person must not see: everyone of their own rank or above (a mod: all staff; a Dev Jr: admins and Dev Jrs).
 *  ` AND (<column> IS NULL OR <column> NOT IN (...))`. Empty when there is nobody to hide. */
export function notStaffSql(column, actor = null) {
  const ids = staffIdsAtLeast(Math.max(1, actor ? staffRank(actor) : 1));
  return ids.length ? { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${ids.map(() => '?').join(',')}))`, args: ids } : { sql: '', args: [] };
}

export function logAdmin(adminRow, action, target = null, detail = null) {
  const role = isAdmin(adminRow) ? 'admin' : isDevJr(adminRow) ? 'devjr' : 'mod';
  run('INSERT INTO admin_log (id, admin_id, admin_name, action, target, detail, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), adminRow.id, adminRow.username, action, target, detail ? String(detail).slice(0, 500) : null, Date.now(), role);
  console.log(`[${role}] ${adminRow.username} ${action} ${target || ''}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
}

const clampLimit = (limit) => Math.min(500, Math.max(1, limit));
export const recentAdminLog = (limit = 100) => all('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT ?', clampLimit(limit));
/** What the given levels did (admins' actions are not in here unless asked for): ['mod'] for mods, ['mod', 'devjr'] for a Dev Jr. */
export const recentStaffLog = (roles, limit = 100) => all(`SELECT * FROM admin_log WHERE role IN (${roles.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`, ...roles, clampLimit(limit));
export const recentModLog = (limit = 100) => recentStaffLog(['mod'], limit);
