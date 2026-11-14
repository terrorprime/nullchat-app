import { get, run } from '../db.js';
import { sha256, randomToken, newId } from './security.js';
import { unauthorized } from './http.js';

export function createSession(userId, req) {
  const token = randomToken(32);
  const now = Date.now();
  run('INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), userId, sha256(token), String(req.headers['user-agent'] || '').slice(0, 300), req.ip || null, now, now);
  return token;
}

/** Bot tokens look like "nb_<random>". They are only ever shown once; the database keeps a hash. */
export const BOT_TOKEN_PREFIX = 'nb_';
export function newBotToken() { return BOT_TOKEN_PREFIX + randomToken(36); }

/** Resolve a bot from its token (with or without a leading "Bot "). Returns { user, bot } or null. */
export function botFromToken(raw) {
  const token = String(raw || '').replace(/^Bot\s+/i, '').trim();
  if (!token.startsWith(BOT_TOKEN_PREFIX) || token.length > 200) return null;
  const bot = get('SELECT * FROM bots WHERE token_hash = ?', sha256(token));
  if (!bot) return null;
  const user = get('SELECT * FROM users WHERE id = ?', bot.id);
  if (!user || user.banned_at) return null;
  if (!bot.last_seen_at || Date.now() - bot.last_seen_at > 60_000) run('UPDATE bots SET last_seen_at = ? WHERE id = ?', Date.now(), bot.id);
  return { user, bot };
}

/**
 * Resolve who is calling from the Authorization header:
 *   "Bearer <session token>"  — a person logged in
 *   "Bot <bot token>"         — a bot (see routes/bots.js for what bots may call)
 */
export function authenticate(req) {
  const h = req.headers.authorization || '';
  if (/^Bot\s/i.test(h)) {
    const found = botFromToken(h);
    return found ? { user: found.user, session: null, bot: found.bot } : null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const session = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(m[1].trim()));
  if (!session) return null;
  const user = get('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user || user.banned_at || user.bot) return null;
  // Touch the session at most once a minute.
  if (Date.now() - session.last_used_at > 60_000) run('UPDATE sessions SET last_used_at = ?, ip = ? WHERE id = ?', Date.now(), req.ip || null, session.id);
  return { user, session };
}

export function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized();
}
