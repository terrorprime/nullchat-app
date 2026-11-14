import { z } from 'zod';
import { get, run, all, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, bad, unauthorized, enforceRateLimit } from '../lib/http.js';
import {
  hashPassword, verifyPassword, newId, randomToken, sha256, generateTotpSecret, verifyTotp, signTicket, verifyTicket, randomCode,
} from '../lib/security.js';
import { createSession } from '../lib/auth.js';
import { appealState, appealTicketFor } from '../lib/appeals.js';
import { registrationOpen } from '../lib/site.js';
import { joinLounge } from '../lib/lounge.js';
import { sendPasswordResetEmail } from '../lib/mailer.js';
import { privateUser } from '../models.js';
import { disconnectSession, disconnectUser, broadcastUserUpdate } from '../gateway.js';

export const usernameSchema = z.string().trim().toLowerCase()
  .min(2, 'must be at least 2 characters').max(32, 'must be at most 32 characters')
  .regex(/^[a-z0-9_.]+$/, 'can only contain letters, numbers, underscores and periods')
  .refine((u) => !/\.\./.test(u), 'cannot contain two periods in a row')
  .refine((u) => !['everyone', 'here', 'nullchat', 'admin', 'system'].includes(u), 'is reserved');
export const passwordSchema = z.string().min(8, 'must be at least 8 characters').max(128, 'must be at most 128 characters');
const emailSchema = z.string().trim().toLowerCase().email('must be a valid email address').max(254);

export function issueEmailToken(userId, type, ttlMs, data = null) {
  const token = randomToken(32);
  run('DELETE FROM email_tokens WHERE user_id = ? AND type = ?', userId, type);
  run('INSERT INTO email_tokens (token_hash, user_id, type, data, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(token), userId, type, data, Date.now() + ttlMs);
  return token;
}
function consumeEmailToken(token, type) {
  const row = get('SELECT * FROM email_tokens WHERE token_hash = ? AND type = ?', sha256(String(token || '')), type);
  if (!row || row.expires_at < Date.now()) return null;
  run('DELETE FROM email_tokens WHERE token_hash = ?', row.token_hash);
  return row;
}

// (the person has just proved they own the account, so the answer also carries what they need to appeal: a short-lived ticket and where an appeal stands)
function suspended(user) {
  return new HttpError(403, `This account has been suspended.${user.banned_reason ? ` Reason: ${user.banned_reason}` : ''}`, 'account_suspended', {
    reason: user.banned_reason || null, appeal: appealState(user), appealTicket: appealTicketFor(user),
  });
}

export default function register(r) {
  r.post('/api/auth/register', { auth: false }, async (ctx) => {
    enforceRateLimit(`register:${ctx.ip}`, 5, 60 * 60 * 1000, 'Too many accounts created from this network. Try again later.');
    if (!registrationOpen()) throw new HttpError(403, 'Registration is currently closed.', 'registration_closed');
    const body = z.object({
      email: emailSchema,
      username: usernameSchema,
      password: passwordSchema,
      displayName: z.string().trim().max(32).optional().nullable(),
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a valid date').optional(),
    }).parse(ctx.body);
    if (body.dateOfBirth) {
      const dob = new Date(body.dateOfBirth);
      const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (!(age >= 13)) throw bad('You must be at least 13 years old to use NullChat.', 'too_young', { errors: { dateOfBirth: 'You must be at least 13 years old.' } });
    }
    if (get('SELECT 1 FROM users WHERE email = ?', body.email)) throw bad('That email is already registered.', 'email_taken', { errors: { email: 'Email is already registered.' } });
    if (get('SELECT 1 FROM users WHERE username = ?', body.username)) throw bad('That username is taken.', 'username_taken', { errors: { username: 'Username is unavailable. Try another.' } });
    const hash = await hashPassword(body.password);
    const id = newId();
    // No email verification: new accounts are usable straight away.
    run(`INSERT INTO users (id, email, username, display_name, password_hash, email_verified, created_at, settings) VALUES (?, ?, ?, ?, ?, 1, ?, '{}')`,
      id, body.email, body.username, body.displayName || null, hash, Date.now());
    const user = get('SELECT * FROM users WHERE id = ?', id);
    const token = createSession(id, ctx.req);
    // New accounts are added to the Nullspace lounge so there is someone to talk to (the admin can turn that off).
    const lounge = joinLounge(id);
    return { token, user: privateUser(user), ...(lounge ? { lounge } : {}) };
  });

  r.post('/api/auth/login', { auth: false }, async (ctx) => {
    enforceRateLimit(`login:${ctx.ip}`, 10, 5 * 60 * 1000, 'Too many login attempts. Wait a few minutes and try again.');
    const body = z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }).parse(ctx.body);
    // Bot accounts have no password and can never log in (they use their token).
    const found = get('SELECT * FROM users WHERE email = ? OR username = ?', body.login.toLowerCase(), body.login.toLowerCase());
    const user = found && !found.bot ? found : null;
    const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyPassword(body.password, 'scrypt$AAAA$AAAA').catch(() => false);
    if (!user || !ok) throw bad('Login or password is invalid.', 'invalid_login', { errors: { login: 'Login or password is invalid.', password: 'Login or password is invalid.' } });
    if (user.banned_at) throw suspended(user);
    if (user.mfa_enabled) {
      return { mfa: true, ticket: signTicket({ uid: user.id, t: 'mfa' }, config.secret, 5 * 60 * 1000) };
    }
    return { token: createSession(user.id, ctx.req), user: privateUser(user) };
  });

  r.post('/api/auth/mfa', { auth: false }, async (ctx) => {
    enforceRateLimit(`mfa:${ctx.ip}`, 10, 5 * 60 * 1000);
    const body = z.object({ ticket: z.string(), code: z.string().trim().min(6).max(20) }).parse(ctx.body);
    const t = verifyTicket(body.ticket, config.secret);
    if (!t || t.t !== 'mfa') throw unauthorized('Your login session expired. Please log in again.');
    const user = get('SELECT * FROM users WHERE id = ?', t.uid);
    if (!user || !user.mfa_enabled) throw unauthorized();
    if (user.banned_at) throw suspended(user);
    let ok = verifyTotp(user.mfa_secret, body.code);
    if (!ok) {
      const codes = JSON.parse(user.mfa_backup_codes || '[]');
      const h = sha256(body.code.replace(/[\s-]/g, '').toLowerCase());
      const idx = codes.indexOf(h);
      if (idx >= 0) { codes.splice(idx, 1); run('UPDATE users SET mfa_backup_codes = ? WHERE id = ?', JSON.stringify(codes), user.id); ok = true; }
    }
    if (!ok) throw bad('Invalid two-factor code.', 'invalid_code', { errors: { code: 'Invalid two-factor code.' } });
    return { token: createSession(user.id, ctx.req), user: privateUser(user) };
  });

  r.post('/api/auth/logout', async (ctx) => {
    run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
    disconnectSession(ctx.session.id, 'Logged out');
    return { ok: true };
  });

  r.post('/api/auth/forgot-password', { auth: false }, async (ctx) => {
    enforceRateLimit(`forgot:${ctx.ip}`, 5, 15 * 60 * 1000);
    const { email } = z.object({ email: emailSchema }).parse(ctx.body);
    const user = get('SELECT * FROM users WHERE email = ?', email);
    if (user && !user.bot) {
      const token = issueEmailToken(user.id, 'reset', 3600 * 1000);
      sendPasswordResetEmail(user, token).catch((e) => console.error('[mail] reset email failed:', e.message));
    }
    // Always succeed so the endpoint can't be used to discover accounts.
    return { ok: true };
  });

  r.post('/api/auth/reset-password', { auth: false }, async (ctx) => {
    enforceRateLimit(`reset:${ctx.ip}`, 10, 15 * 60 * 1000);
    const body = z.object({ token: z.string().min(10), password: passwordSchema }).parse(ctx.body);
    const row = consumeEmailToken(body.token, 'reset');
    if (!row || get('SELECT bot FROM users WHERE id = ?', row.user_id)?.bot) throw bad('This reset link is invalid or has expired. Request a new one.', 'invalid_token');
    const hash = await hashPassword(body.password);
    tx(() => {
      run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', hash, row.user_id);
      run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    disconnectUser(row.user_id, 'Password changed');
    return { ok: true };
  });

  // ---- sessions / devices ----
  r.get('/api/auth/sessions', async (ctx) => {
    return all('SELECT id, user_agent, ip, created_at, last_used_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC', ctx.user.id)
      .map((s) => ({ id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastUsedAt: s.last_used_at, current: s.id === ctx.session.id }));
  });
  r.delete('/api/auth/sessions/:id', async (ctx) => {
    const s = get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    if (!s) throw bad('Unknown session.');
    run('DELETE FROM sessions WHERE id = ?', s.id);
    disconnectSession(s.id, 'Session revoked');
    return { ok: true };
  });
  r.post('/api/auth/sessions/logout-others', async (ctx) => {
    const others = all('SELECT id FROM sessions WHERE user_id = ? AND id != ?', ctx.user.id, ctx.session.id);
    run('DELETE FROM sessions WHERE user_id = ? AND id != ?', ctx.user.id, ctx.session.id);
    others.forEach((s) => disconnectSession(s.id, 'Session revoked'));
    return { ok: true, count: others.length };
  });

  // ---- two-factor authentication ----
  r.post('/api/auth/mfa/setup', async (ctx) => {
    if (ctx.user.mfa_enabled) throw bad('Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    run('UPDATE users SET mfa_secret = ? WHERE id = ?', secret, ctx.user.id);
    const label = encodeURIComponent(`NullChat:${ctx.user.username}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=NullChat&algorithm=SHA1&digits=6&period=30` };
  });
  r.post('/api/auth/mfa/enable', async (ctx) => {
    const body = z.object({ code: z.string().trim(), password: z.string().min(1) }).parse(ctx.body);
    if (!(await verifyPassword(body.password, ctx.user.password_hash))) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
    const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!u.mfa_secret) throw bad('Start setup first.');
    if (!verifyTotp(u.mfa_secret, body.code)) throw bad('That code is not valid. Check your authenticator app’s clock and try again.', 'invalid_code', { errors: { code: 'Invalid code.' } });
    const backupCodes = Array.from({ length: 10 }, () => randomCode(8).toLowerCase());
    run('UPDATE users SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ?', JSON.stringify(backupCodes.map((c) => sha256(c))), ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return { ok: true, backupCodes };
  });
  r.post('/api/auth/mfa/disable', async (ctx) => {
    const body = z.object({ code: z.string().trim(), password: z.string().min(1) }).parse(ctx.body);
    if (!(await verifyPassword(body.password, ctx.user.password_hash))) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
    if (!verifyTotp(ctx.user.mfa_secret, body.code)) throw bad('Invalid two-factor code.', 'invalid_code', { errors: { code: 'Invalid code.' } });
    run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?', ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return { ok: true };
  });
}
