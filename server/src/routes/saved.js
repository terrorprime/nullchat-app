// "Save for later": bookmark any message you can see, optionally with a reminder. Saved items are private to
// you and follow you across devices. When a reminder is due you get a REMINDER event (a toast in the app).
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { channelAccess, serializeMessages } from '../models.js';
import { sendToUser } from '../gateway.js';
import { pushReminder, hasSubscriptions } from '../lib/push.js';
import { P, has } from '../../../shared/permissions.js';

export const MAX_SAVED = 200;
const MAX_REMIND_MS = 365 * 24 * 3600 * 1000;

function visibleMessage(channelId, messageId, userId) {
  const access = channelAccess(channelId, userId);
  if (!has(access.perms, P.READ_MESSAGE_HISTORY)) throw forbidden();
  const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', messageId, access.channel.id);
  if (!row) throw notFound('Unknown message.');
  return { access, row };
}

const remindAtSchema = z.number().int().nullable().optional();
const checkRemindAt = (v) => {
  if (v == null) return null;
  const now = Date.now();
  if (v < now + 5_000) throw bad('Pick a reminder time in the future.');
  if (v > now + MAX_REMIND_MS) throw bad('Reminders can be at most a year away.');
  return v;
};

const shape = (s, extra = {}) => ({ messageId: s.message_id, channelId: s.channel_id, savedAt: s.saved_at, remindAt: s.remind_at && !s.reminded_at ? s.remind_at : null, reminded: !!s.reminded_at, ...extra });

export default function register(r) {
  // Everything you saved that you can still see. Items from places you've left are hidden (they come back if you rejoin).
  r.get('/api/users/@me/saved', async (ctx) => {
    const rows = all('SELECT * FROM saved_messages WHERE user_id = ? ORDER BY saved_at DESC', ctx.user.id);
    const items = [];
    const messageRows = [];
    for (const s of rows) {
      let access;
      try { access = channelAccess(s.channel_id, ctx.user.id); } catch { continue; }
      if (!has(access.perms, P.READ_MESSAGE_HISTORY)) continue;
      const m = get('SELECT * FROM messages WHERE id = ?', s.message_id);
      if (!m) continue;
      messageRows.push(m);
      items.push({ s, guildId: access.channel.guild_id || null });
    }
    const messages = new Map(serializeMessages(messageRows).map((m) => [m.id, m]));
    return { items: items.map(({ s, guildId }) => shape(s, { guildId, message: messages.get(s.message_id) })), limit: MAX_SAVED };
  });

  // Just the ids (cheap): used to show which messages are saved when the app starts.
  r.get('/api/users/@me/saved/ids', async (ctx) => ({
    items: all('SELECT message_id, channel_id, saved_at, remind_at, reminded_at FROM saved_messages WHERE user_id = ?', ctx.user.id).map((s) => shape(s)),
  }));

  r.put('/api/channels/:id/messages/:messageId/save', async (ctx) => {
    const { row } = visibleMessage(ctx.params.id, ctx.params.messageId, ctx.user.id);
    const body = z.object({ remindAt: remindAtSchema }).parse(ctx.body || {});
    const remindAt = checkRemindAt(body.remindAt);
    enforceRateLimit(`save:${ctx.user.id}`, 60, 60_000);
    const existing = get('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, row.id);
    if (!existing) {
      const n = get('SELECT COUNT(*) AS n FROM saved_messages WHERE user_id = ?', ctx.user.id).n;
      if (n >= MAX_SAVED) throw bad(`You can save up to ${MAX_SAVED} messages. Remove a few from Saved first.`, 'saved_full');
      run('INSERT INTO saved_messages (user_id, message_id, channel_id, saved_at, remind_at) VALUES (?, ?, ?, ?, ?)', ctx.user.id, row.id, row.channel_id, Date.now(), remindAt);
    } else if (body.remindAt !== undefined) {
      // Re-saving with a new time (or null) changes / clears the reminder.
      run('UPDATE saved_messages SET remind_at = ?, reminded_at = NULL WHERE user_id = ? AND message_id = ?', remindAt, ctx.user.id, row.id);
    }
    const s = get('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, row.id);
    const out = shape(s);
    sendToUser(ctx.user.id, 'SAVED_UPDATE', { ...out, saved: true });
    return out;
  });

  r.delete('/api/channels/:id/messages/:messageId/save', async (ctx) => {
    run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ? AND channel_id = ?', ctx.user.id, ctx.params.messageId, ctx.params.id);
    sendToUser(ctx.user.id, 'SAVED_UPDATE', { messageId: ctx.params.messageId, channelId: ctx.params.id, saved: false, remindAt: null });
    return { ok: true };
  });
}

// ---- reminders -----------------------------------------------------------------------------------------------
// Checked every few seconds. A reminder is delivered to the person's open apps; if they're offline it waits and
// is delivered as soon as they connect. A reminder for something that was deleted or is no longer visible is dropped.
function previewOf(m) {
  const text = String(m.content || '').replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 140) || (m.forward ? 'Forwarded message' : m.attachments?.length ? `[${m.attachments[0].filename || 'attachment'}]` : '');
}

// Reminders being pushed right now (a push can take a few seconds, and this runs every 10 seconds).
const pushing = new Set();

/**
 * Returns how many reminders reached an open app. A reminder for someone who isn't connected but has notifications
 * turned on for a phone or browser is sent there instead, and counts as delivered once the push service accepts it.
 */
export function deliverDueReminders(now = Date.now()) {
  const due = all('SELECT * FROM saved_messages WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT 200', now);
  let delivered = 0;
  const markDone = (s) => run('UPDATE saved_messages SET reminded_at = ? WHERE user_id = ? AND message_id = ?', now, s.user_id, s.message_id);
  for (const s of due) {
    let access;
    try { access = channelAccess(s.channel_id, s.user_id); } catch { access = null; }
    const row = access && has(access.perms, P.READ_MESSAGE_HISTORY) ? get('SELECT * FROM messages WHERE id = ?', s.message_id) : null;
    if (!row) { markDone(s); continue; }
    const m = serializeMessages([row])[0];
    const info = {
      messageId: s.message_id, channelId: s.channel_id, guildId: access.channel.guild_id || null,
      channelName: access.channel.name || null, authorId: m.author?.id || null, authorName: m.author?.displayName || m.author?.username || null,
      preview: previewOf(m), remindAt: s.remind_at,
    };
    const sent = sendToUser(s.user_id, 'REMINDER', info);
    if (sent > 0) {
      markDone(s); delivered++;
      pushReminder(s.user_id, info); // the person may have the app open on a laptop and be holding their phone
    } else if (hasSubscriptions(s.user_id)) {
      const key = `${s.user_id}:${s.message_id}`;
      if (pushing.has(key)) continue;
      pushing.add(key);
      pushReminder(s.user_id, info)
        .then((n) => { if (n > 0) markDone(s); }) // if no device took it, it stays due and is tried again (or shown when they connect)
        .finally(() => pushing.delete(key));
    }
  }
  return delivered;
}

export function startReminders() {
  setInterval(() => { try { deliverDueReminders(); } catch (e) { console.error('[reminders]', e.message); } }, 10_000).unref();
}
