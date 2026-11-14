// Appeals: a suspended person can't log in, so they had no way to say "this was a mistake". Now the login screen offers a short
// form instead of a dead end, and the staff decide it in the Admin Panel or the Mod Panel.
//
//   - Only someone who has just proved they own the account (the right password) gets a short-lived ticket, so the form can't be used by strangers.
//   - One open appeal at a time per suspension, and after a "no" the person waits a week before trying again (a new suspension starts fresh).
//   - Approving restores the account (written to the log like any restore). Denying needs a short note, which the person reads on the same screen.
//   - A moderator decides appeals of ordinary accounts; an appeal from a moderator's own suspended account is for the admins.
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { config } from '../config.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId, verifyTicket } from '../lib/security.js';
import { APPEAL_COOLDOWN, APPEAL_MIN, APPEAL_MAX, NOTE_MAX, appealState, visibility, openAppeals } from '../lib/appeals.js';
import { isAdmin, isPlainMod, isDevJr, isStaff, staffRank, adminUserIds, modUserIds, logAdmin } from '../lib/admin.js';
import { sendToUsers } from '../gateway.js';
import { sendMail } from '../lib/mailer.js';
import { restoreAccount } from './admin.js';

const staffIds = () => [...new Set([...adminUserIds(), ...modUserIds()])];
const tellStaff = (data) => sendToUsers(staffIds(), 'APPEAL_UPDATE', data);

function shape(a, me) {
  const u = get('SELECT id, username, display_name, avatar, is_mod, is_devjr, banned_at, banned_reason, created_at FROM users WHERE id = ?', a.user_id);
  const before = get('SELECT COUNT(*) AS n FROM appeals WHERE user_id = ? AND id != ? AND created_at < ?', a.user_id, a.id, a.created_at).n;
  return {
    id: a.id, status: a.status, message: a.message, createdAt: a.created_at, decidedAt: a.decided_at || null, decidedBy: a.decided_by || null, note: a.note || null,
    suspensionReason: a.suspension_reason || null,
    user: u ? { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, isMod: isPlainMod(u), isDevJr: isDevJr(u), suspended: !!u.banned_at, suspendedAt: u.banned_at || null, joinedAt: u.created_at } : null,
    earlier: before,
    canDecide: a.status === 'open' && !!u && !!u.banned_at && (isAdmin(me) || staffRank(me) > staffRank(u)),
  };
}

function notify(user, subject, text) {
  if (!user?.email) return;
  sendMail({ to: user.email, subject, text }).catch((e) => console.log('[appeals] could not send the email:', e.message));
}

export default function register(r) {
  // ---- the person ----
  // They hold a ticket from the failed login. It only lets them see the state of the appeal and send one message.
  const fromTicket = (ticket) => {
    const t = verifyTicket(String(ticket || ''), config.secret);
    if (!t || t.t !== 'appeal') throw bad('This page timed out. Log in again to continue.', 'appeal_expired');
    const user = get('SELECT * FROM users WHERE id = ? AND bot = 0', t.uid);
    if (!user) throw bad('This page timed out. Log in again to continue.', 'appeal_expired');
    return user;
  };

  r.post('/api/auth/appeal/status', { auth: false }, async (ctx) => {
    enforceRateLimit(`appeal-status:${ctx.ip}`, 60, 10 * 60_000);
    const user = fromTicket(z.object({ ticket: z.string().max(2000) }).parse(ctx.body || {}).ticket);
    if (!user.banned_at) return { suspended: false };
    return { suspended: true, reason: user.banned_reason || null, appeal: appealState(user) };
  });

  r.post('/api/auth/appeal', { auth: false }, async (ctx) => {
    enforceRateLimit(`appeal:${ctx.ip}`, 6, 60 * 60_000, 'Too many appeals from this connection. Try again later.');
    const body = z.object({
      ticket: z.string().max(2000),
      message: z.string({ required_error: 'Tell us what happened.' }).trim().min(APPEAL_MIN, `Write at least ${APPEAL_MIN} characters so a person can understand.`).max(APPEAL_MAX, `Keep it under ${APPEAL_MAX} characters.`),
    }).parse(ctx.body || {});
    const user = fromTicket(body.ticket);
    if (!user.banned_at) throw bad('Your account is not suspended. You can log in.', 'not_suspended');
    enforceRateLimit(`appeal-user:${user.id}`, 4, 24 * 3600_000, 'You have sent a lot of appeals today. Wait for an answer.');
    const state = appealState(user);
    if (state.status === 'open') throw bad('You already have an appeal waiting. A moderator will look at it.', 'appeal_open');
    if (state.status === 'denied' && !state.canAppeal) {
      const days = Math.max(1, Math.ceil((state.retryAt - Date.now()) / 86400_000));
      throw bad(`Your last appeal was turned down. You can send another in ${days} day${days === 1 ? '' : 's'}.`, 'appeal_cooldown', { retryAt: state.retryAt });
    }
    const id = newId();
    run('INSERT INTO appeals (id, user_id, message, status, suspension_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, user.id, body.message.replace(/\r\n/g, '\n'), 'open', user.banned_reason || null, Date.now());
    tellStaff({ id, kind: 'new', username: user.username });
    return { ok: true, appeal: appealState(user) };
  });

  // ---- the staff ----
  const requireStaff = (ctx) => { if (!ctx.user || !isStaff(ctx.user)) throw forbidden('Only moderators can do that.'); return ctx.user; };

  r.get('/api/mod/appeals', async (ctx) => {
    const me = requireStaff(ctx);
    const v = visibility(me);
    const status = ctx.query.status === 'closed' ? 'closed' : 'open';
    const rows = all(`SELECT a.* FROM appeals a WHERE ${status === 'open' ? "a.status = 'open'" : "a.status != 'open'"}${v.sql}
      ORDER BY ${status === 'open' ? 'a.created_at ASC' : 'a.decided_at DESC'} LIMIT 100`, ...v.args);
    return { appeals: rows.map((a) => shape(a, me)), open: openAppeals(me) };
  });

  const decide = (ctx) => {
    const me = requireStaff(ctx);
    const a = get('SELECT * FROM appeals WHERE id = ?', ctx.params.id);
    if (!a) throw notFound('That appeal no longer exists.');
    const u = get('SELECT * FROM users WHERE id = ?', a.user_id);
    if (!isAdmin(me) && u && staffRank(u) >= staffRank(me)) throw forbidden(isDevJr(u) || staffRank(me) > 1 ? 'That account is staff at your level or above. Ask an admin.' : 'That account is a moderator. Ask an admin.');
    if (a.status !== 'open') throw bad(`This appeal was already ${a.status === 'approved' ? 'approved' : 'turned down'}${a.decided_by ? ` by ${a.decided_by}` : ''}.`, 'already_decided');
    if (!u) throw notFound('That account no longer exists.');
    return { me, a, u };
  };

  r.post('/api/mod/appeals/:id/approve', async (ctx) => {
    const { me, a, u } = decide(ctx);
    const { note } = z.object({ note: z.string().trim().max(NOTE_MAX).optional() }).parse(ctx.body || {});
    run("UPDATE appeals SET status = 'approved', decided_at = ?, decided_by = ?, note = ? WHERE id = ?", Date.now(), me.username, note || null, a.id);
    if (u.banned_at) restoreAccount(me, u);   // (also closes any other appeal still open for this person)
    logAdmin(me, 'appeal_approve', u.username, note || null);
    notify(u, 'Your NullChat account is active again', `Hi ${u.username},\n\nYour appeal was approved and your account is active again. You can log in now.${note ? `\n\nNote from the moderator: ${note}` : ''}\n\n${config.publicUrl}`);
    tellStaff({ id: a.id, kind: 'decided' });
    return shape(get('SELECT * FROM appeals WHERE id = ?', a.id), me);
  });

  r.post('/api/mod/appeals/:id/deny', async (ctx) => {
    const { me, a, u } = decide(ctx);
    const { note } = z.object({ note: z.string({ required_error: 'Say why, so the person knows what to expect.' }).trim().min(3, 'Say why, so the person knows what to expect.').max(NOTE_MAX) }).parse(ctx.body || {});
    run("UPDATE appeals SET status = 'denied', decided_at = ?, decided_by = ?, note = ? WHERE id = ?", Date.now(), me.username, note, a.id);
    logAdmin(me, 'appeal_deny', u.username, note);
    notify(u, 'About your NullChat appeal', `Hi ${u.username},\n\nYour appeal was reviewed and the suspension stays.\n\nNote from the moderator: ${note}\n\nYou can send another appeal in 7 days.`);
    tellStaff({ id: a.id, kind: 'decided' });
    return shape(get('SELECT * FROM appeals WHERE id = ?', a.id), me);
  });
}
