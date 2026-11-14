// The rules of appeals (see routes/appeals.js): who may file, how long the form stays open, who may decide which appeal.
import { get } from '../db.js';
import { config } from '../config.js';
import { signTicket } from './security.js';
import { isAdmin, notStaffSql } from './admin.js';

export const APPEAL_TTL = 30 * 60 * 1000;           // how long the form stays open after a login attempt
export const APPEAL_COOLDOWN = 7 * 24 * 3600 * 1000; // after a "no"
export const APPEAL_MIN = 10, APPEAL_MAX = 1000, NOTE_MAX = 300;

export const appealTicketFor = (user) => signTicket({ uid: user.id, t: 'appeal' }, config.secret, APPEAL_TTL);

/** Where this person stands: can they file one, is one waiting, was the last one turned down? Only appeals filed since the current suspension count. */
export function appealState(user) {
  const last = get('SELECT * FROM appeals WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1', user.id, user.banned_at || 0);
  if (!last) return { status: 'none', canAppeal: true };
  if (last.status === 'open') return { status: 'open', canAppeal: false, message: last.message, filedAt: last.created_at };
  if (last.status === 'denied') {
    const retryAt = (last.decided_at || last.created_at) + APPEAL_COOLDOWN;
    return { status: 'denied', canAppeal: Date.now() >= retryAt, message: last.message, filedAt: last.created_at, decidedAt: last.decided_at, note: last.note || null, retryAt };
  }
  return { status: 'none', canAppeal: true };   // (an approved one means the person is no longer suspended; a later suspension is a new case)
}

/** Appeals this staff member may decide: staff leave the appeals of anyone of their own rank or above to the level over them (a mod: all staff; a Dev Jr: admins and Dev Jrs). */
export function visibility(me) {
  if (isAdmin(me)) return { sql: '', args: [] };
  return notStaffSql('a.user_id', me);
}

export function openAppeals(me) {
  const v = visibility(me);
  return get(`SELECT COUNT(*) AS n FROM appeals a WHERE a.status = 'open'${v.sql}`, ...v.args).n;
}

