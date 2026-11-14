// Scheduled ("send later") messages. Text messages (optionally a reply) that are sent automatically at a time you pick.
// They go through exactly the same checks as a normal message at the moment they are sent, so if you lose permission in
// the meantime the message is not sent and you are told why. They are private to you until they are sent.
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { channelAccess, getUserRow } from '../models.js';
import { sendToUser } from '../gateway.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';
import { sendMessageAs, MAX_CONTENT } from './messages.js';

export const MAX_PENDING = 25;
const MIN_LEAD_MS = 5_000;
const MAX_LEAD_MS = 30 * 24 * 3600 * 1000;

const shape = (r) => {
  const ch = get('SELECT c.name, c.type, c.guild_id, g.name AS guild_name FROM channels c LEFT JOIN guilds g ON g.id = c.guild_id WHERE c.id = ?', r.channel_id);
  return {
    id: r.id, channelId: r.channel_id, guildId: ch?.guild_id || null, channelName: ch?.name || null, guildName: ch?.guild_name || null,
    content: r.content, replyToId: r.reply_to_id || null, silent: !!r.silent, sendAt: r.send_at, createdAt: r.created_at, error: r.error || null,
  };
};
const emit = (userId, payload) => sendToUser(userId, 'SCHEDULED_UPDATE', payload);

function checkTime(sendAt) {
  const now = Date.now();
  if (sendAt < now + MIN_LEAD_MS) throw bad('Pick a time in the future.');
  if (sendAt > now + MAX_LEAD_MS) throw bad('You can schedule up to 30 days ahead.');
}
const cleanContent = (c) => {
  const content = String(c || '').replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
  if (!content) throw bad('Write a message to schedule.');
  if (content.length > MAX_CONTENT) throw bad(`Messages can be at most ${MAX_CONTENT} characters.`);
  return content;
};
const own = (ctx) => {
  const row = get('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!row) throw notFound('That scheduled message no longer exists.');
  return row;
};

export default function register(r) {
  r.post('/api/channels/:id/scheduled', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { channel, perms } = access;
    if (channel.type === ChannelType.CATEGORY) throw bad('You can’t send messages here.');
    if (channel.type === ChannelType.FORUM) throw bad('This is a forum. Start a post instead.', 'forum_channel');
    if (!has(perms, channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES)) throw forbidden('You do not have permission to send messages in this channel.');
    const body = z.object({ content: z.string(), sendAt: z.number().int(), replyTo: z.string().nullable().optional(), silent: z.boolean().optional() }).parse(ctx.body);
    const content = cleanContent(body.content);
    checkTime(body.sendAt);
    enforceRateLimit(`sched:${ctx.user.id}`, 20, 60_000);
    if (get('SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ? AND error IS NULL', ctx.user.id).n >= MAX_PENDING) {
      throw bad(`You can have up to ${MAX_PENDING} scheduled messages at once. Send or cancel a few first.`, 'scheduled_full');
    }
    let replyTo = null;
    if (body.replyTo) {
      replyTo = get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', body.replyTo, channel.id)?.id;
      if (!replyTo) throw bad('The message you are replying to no longer exists.');
    }
    const id = newId();
    run('INSERT INTO scheduled_messages (id, user_id, channel_id, content, reply_to_id, silent, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, ctx.user.id, channel.id, content, replyTo, body.silent ? 1 : 0, body.sendAt, Date.now());
    const item = shape(get('SELECT * FROM scheduled_messages WHERE id = ?', id));
    emit(ctx.user.id, { item });
    return item;
  });

  r.get('/api/users/@me/scheduled', async (ctx) => ({
    items: all('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at', ctx.user.id).map(shape).filter((i) => {
      // Hide items whose channel you can no longer see (they come back if you rejoin; they will not be sent meanwhile).
      try { channelAccess(i.channelId, ctx.user.id); return true; } catch { return false; }
    }),
    limit: MAX_PENDING,
  }));

  // Change the time and/or the text. Rescheduling a failed message tries it again.
  r.patch('/api/users/@me/scheduled/:id', async (ctx) => {
    const row = own(ctx);
    const body = z.object({ sendAt: z.number().int().optional(), content: z.string().optional() }).parse(ctx.body || {});
    const content = body.content !== undefined ? cleanContent(body.content) : row.content;
    const sendAt = body.sendAt !== undefined ? body.sendAt : (row.error ? Date.now() + 60_000 : row.send_at);
    if (body.sendAt !== undefined) checkTime(sendAt);
    run('UPDATE scheduled_messages SET content = ?, send_at = ?, error = NULL WHERE id = ?', content, sendAt, row.id);
    const item = shape(get('SELECT * FROM scheduled_messages WHERE id = ?', row.id));
    emit(ctx.user.id, { item });
    return item;
  });

  r.delete('/api/users/@me/scheduled/:id', async (ctx) => {
    const row = own(ctx);
    run('DELETE FROM scheduled_messages WHERE id = ?', row.id);
    emit(ctx.user.id, { id: row.id, removed: true });
    return { ok: true };
  });

  // Send it right now instead of waiting. If it can't be sent, you get the reason here.
  r.post('/api/users/@me/scheduled/:id/send-now', async (ctx) => {
    const row = own(ctx);
    const res = await deliver(row, { manual: true });
    if (!res.ok) throw bad(res.error);
    return { ok: true };
  });
}

// ---- the scheduler ----------------------------------------------------------------------------------------------
/** Sends one scheduled message. Returns { ok } or { ok: false, error, retry? } (retry: hit a limit, will be tried again). */
async function deliver(row, { manual = false } = {}) {
  const user = getUserRow(row.user_id);
  if (!user || user.banned_at) { run('DELETE FROM scheduled_messages WHERE id = ?', row.id); return { ok: false, error: 'This account can’t send messages.' }; }
  try {
    await sendMessageAs(user, row.channel_id, { content: row.content, replyTo: row.reply_to_id || null, silent: !!row.silent, attachmentIds: [] });
    run('DELETE FROM scheduled_messages WHERE id = ?', row.id);
    emit(row.user_id, { id: row.id, removed: true, sent: true });
    return { ok: true };
  } catch (e) {
    // Sending too fast (the global send-speed limit, or this channel's slowmode): keep the message due and try again once the
    // wait is over. Nothing else of yours in that place jumps ahead of it, so the order you scheduled things in is kept.
    if (e.status === 429 && !manual && (e.code === 'rate_limited' || e.code === 'slowmode')) {
      const key = e.code === 'slowmode' ? `c:${row.user_id}:${row.channel_id}` : `u:${row.user_id}`;
      blockedUntil.set(key, Date.now() + Math.max(2, e.extra?.retryAfter || 5) * 1000);
      return { ok: false, error: e.message, retry: true };
    }
    const msg = String(e.message || 'It could not be sent.').slice(0, 300);
    if (!manual || e.status !== 429) {
      run('UPDATE scheduled_messages SET error = ? WHERE id = ?', msg, row.id);
      emit(row.user_id, { item: shape(get('SELECT * FROM scheduled_messages WHERE id = ?', row.id)), failed: true });
    }
    return { ok: false, error: msg };
  }
}

const blockedUntil = new Map(); // "u:<user>" / "c:<user>:<channel>" -> don't try again before this time
let busy = false;
export async function deliverDueScheduled(now = Date.now()) {
  if (busy) return 0;
  busy = true;
  let sent = 0;
  try {
    // Failed items nobody looked at for a week are tidied away.
    run('DELETE FROM scheduled_messages WHERE error IS NOT NULL AND send_at < ?', now - 7 * 24 * 3600 * 1000);
    for (const [k, until] of blockedUntil) if (until <= now) blockedUntil.delete(k);
    for (const row of all('SELECT * FROM scheduled_messages WHERE error IS NULL AND send_at <= ? ORDER BY send_at, id LIMIT 50', now)) {
      if (blockedUntil.has(`u:${row.user_id}`) || blockedUntil.has(`c:${row.user_id}:${row.channel_id}`)) continue;
      if ((await deliver(row)).ok) sent++;
    }
  } finally { busy = false; }
  return sent;
}

export function startScheduler() {
  setInterval(() => { deliverDueScheduled().catch((e) => console.error('[scheduled]', e.message)); }, 5_000).unref();
}
