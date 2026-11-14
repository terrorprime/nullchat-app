// Quiet replies: a reply in a server channel (or group chat) that only the people the sender picks can see.
//
// They are kept in their own table, never in `messages`. Everything that reads messages (search, pins, saved messages, forwarding,
// the inbox, exports, insights, bots, push to "every message" devices, moderators' tools) therefore cannot show one to somebody
// it was not meant for: there is nothing in those places to filter. A quiet reply reaches people in exactly two ways, both in this
// file: the live event (sent to the author and the chosen people only) and the channel's message list (merged in per reader).
//
// As private as a direct message: server moderators do not see them. They are text only, cannot be pinned, reacted to, forwarded
// or turned into a thread, and the author can delete them.
import { z } from 'zod';
import { get, all, run, tx, db } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { channelAccess, channelViewerIds, publicUser, isBlockedEitherWay, DELETED_USER } from '../models.js';
import { sendToUsers } from '../gateway.js';
import { pushForMessage } from '../lib/push.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';

export const MAX_QUIET_VIEWERS = 10;
export const MAX_QUIET_CONTENT = 2000;

db.exec(`
  CREATE TABLE IF NOT EXISTS quiet_replies (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reply_to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quiet_channel ON quiet_replies(channel_id, id);
  CREATE TABLE IF NOT EXISTS quiet_viewers (
    quiet_id TEXT NOT NULL REFERENCES quiet_replies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (quiet_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_quiet_viewers_user ON quiet_viewers(user_id);
`);

const VISIBLE = '(q.author_id = ? OR EXISTS (SELECT 1 FROM quiet_viewers v WHERE v.quiet_id = q.id AND v.user_id = ?))';

/** The quiet reply with this id, if this person wrote it or was picked to see it. */
function visibleQuiet(id, channelId, userId) {
  return get(`SELECT q.* FROM quiet_replies q WHERE q.id = ? AND q.channel_id = ? AND ${VISIBLE}`, id, channelId, userId, userId) || null;
}

/** Quiet replies in the shape of messages (so the message list shows them), each with the people who can see it. */
export function serializeQuiet(rows) {
  if (!rows.length) return [];
  const ph = rows.map(() => '?').join(',');
  const viewerRows = all(`SELECT quiet_id, user_id FROM quiet_viewers WHERE quiet_id IN (${ph})`, ...rows.map((r) => r.id));
  const refIds = [...new Set(rows.map((r) => r.reply_to_id))];
  const rph = refIds.map(() => '?').join(',');
  const refs = new Map();
  for (const m of all(`SELECT id, author_id, content, forward IS NOT NULL AS forwarded, (stickers IS NOT NULL AND stickers != '[]') AS sticker FROM messages WHERE id IN (${rph})`, ...refIds)) refs.set(m.id, m);
  for (const m of all(`SELECT id, author_id, content FROM quiet_replies WHERE id IN (${rph})`, ...refIds)) refs.set(m.id, { ...m, quiet: true });
  const userIds = new Set([...rows.map((r) => r.author_id), ...viewerRows.map((v) => v.user_id), ...[...refs.values()].map((m) => m.author_id).filter(Boolean)]);
  const users = new Map();
  if (userIds.size) for (const u of all(`SELECT * FROM users WHERE id IN (${[...userIds].map(() => '?').join(',')})`, ...userIds)) users.set(u.id, publicUser(u));
  return rows.map((r) => {
    const viewerIds = viewerRows.filter((v) => v.quiet_id === r.id).map((v) => v.user_id);
    const ref = refs.get(r.reply_to_id);
    return {
      id: r.id, channelId: r.channel_id, author: users.get(r.author_id) || DELETED_USER, content: r.content, type: 19,
      createdAt: r.created_at, editedAt: null, pinned: false,
      mentions: viewerIds, mentionRoles: [], mentionEveryone: false,     // (the chosen people are pinged, nobody else)
      embeds: [], components: [], forward: null, crosspost: null, published: false, attachments: [], poll: null, stickers: [], interaction: null, reactions: [], thread: null,
      replyTo: ref
        ? { id: ref.id, author: users.get(ref.author_id) || DELETED_USER, content: ref.content.slice(0, 200), ...(ref.forwarded ? { forwarded: true } : {}), ...(ref.sticker ? { sticker: true } : {}), ...(ref.quiet ? { quiet: true } : {}) }
        : { id: r.reply_to_id, deleted: true },
      quiet: { viewers: viewerIds.map((id) => users.get(id)).filter(Boolean) },
    };
  });
}

/**
 * One page of a channel's messages with this reader's quiet replies put in where they belong.
 * `page` is the already serialized page of ordinary messages, newest first; `full` says whether that page reached its limit (so
 * more ordinary messages may exist beyond its far end). The result is again newest first and never longer than `limit`, so the
 * client's "is there more?" test (a page that is exactly full) keeps working: what is cut off comes back with the next page.
 */
function mergeDesc(page, userId, channelId, limit, { below = null, full }) {
  const where = [`q.channel_id = ?`, VISIBLE];
  const vals = [channelId, userId, userId];
  if (below) { where.push('q.id < ?'); vals.push(String(below)); }
  if (full && page.length) { where.push('q.id > ?'); vals.push(page[page.length - 1].id); }
  const rows = all(`SELECT q.* FROM quiet_replies q WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT ?`, ...vals, limit);
  if (!rows.length) return page;
  return [...page, ...serializeQuiet(rows)].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}
function mergeAsc(pageAsc, userId, channelId, limit, { above, full }) {
  const where = [`q.channel_id = ?`, VISIBLE, 'q.id > ?'];
  const vals = [channelId, userId, userId, String(above)];
  if (full && pageAsc.length) { where.push('q.id < ?'); vals.push(pageAsc[pageAsc.length - 1].id); }
  const rows = all(`SELECT q.* FROM quiet_replies q WHERE ${where.join(' AND ')} ORDER BY q.id ASC LIMIT ?`, ...vals, limit);
  if (!rows.length) return pageAsc;
  return [...pageAsc, ...serializeQuiet(rows)].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/** Used by the message list route. `older` / `newer` are serialized ordinary messages (older: newest first; newer: oldest first). */
export const quietMerge = {
  latest: (page, userId, channelId, limit) => mergeDesc(page, userId, channelId, limit, { full: page.length >= limit }),
  before: (page, userId, channelId, limit, before) => mergeDesc(page, userId, channelId, limit, { below: before, full: page.length >= limit }),
  after: (pageAsc, userId, channelId, limit, after) => mergeAsc(pageAsc, userId, channelId, limit, { above: after, full: pageAsc.length >= limit }),
};

/**
 * Marking a channel read up to its latest message also covers the quiet replies this person can see that came after it (they
 * are not ordinary messages, so the channel's "latest message" does not know them). Returns the read mark to store.
 */
export function readMarkWithQuiet(userId, channel, lastId) {
  if (lastId && channel.last_message_id && lastId < channel.last_message_id) return lastId;   // (reading up to an older message: leave it)
  const q = get(`SELECT MAX(q.id) AS id FROM quiet_replies q WHERE q.channel_id = ? AND ${VISIBLE}`, channel.id, userId, userId)?.id;
  return q && (!lastId || q > lastId) ? q : lastId;
}

/** How many quiet replies are waiting for this person in each of these channels, newer than what they have read (for the catch-up card). */
export function quietWaiting(userId, channelId, afterId) {
  return all(`SELECT q.* FROM quiet_replies q JOIN quiet_viewers v ON v.quiet_id = q.id AND v.user_id = ? WHERE q.channel_id = ? AND q.id > ? ORDER BY q.id DESC LIMIT 20`, userId, channelId, afterId || '');
}

const sendSchema = z.object({
  content: z.string().max(MAX_QUIET_CONTENT + 200).default(''),
  replyTo: z.string().min(1).max(40),
  viewers: z.array(z.string().regex(/^\d{1,25}$/)).max(MAX_QUIET_VIEWERS + 5).default([]),
  nonce: z.string().max(40).optional(),
});

export default function register(r, { runAutomod, checkVerification }) {
  r.post('/api/channels/:id/quiet-replies', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { channel, perms } = access;
    const body = sendSchema.parse(ctx.body || {});
    if (ctx.user.bot) throw forbidden('Bots can’t send quiet replies.');
    if (channel.type === ChannelType.DM) throw bad('A direct message is already private. Quiet replies are for servers and group chats.');
    if (![ChannelType.TEXT, ChannelType.ANNOUNCEMENT, ChannelType.THREAD, ChannelType.GROUP_DM].includes(channel.type)) throw bad('Quiet replies can’t be used in this kind of channel.');
    const content = body.content.trim();
    if (!content) throw bad('Your message is empty.');
    if (content.length > MAX_QUIET_CONTENT) throw bad(`A quiet reply can be at most ${MAX_QUIET_CONTENT} characters.`);
    if (!has(perms, P.READ_MESSAGE_HISTORY)) throw forbidden('You can’t reply here.');
    if (!has(perms, channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES)) throw forbidden('You do not have permission to send messages in this channel.');
    if (channel.type === ChannelType.THREAD && channel.locked && !has(perms, P.MANAGE_THREADS)) throw forbidden('This thread is locked.');
    enforceRateLimit(`msg:${ctx.user.id}`, 8, 5_000, 'You are sending messages too quickly. Slow down!');
    if (!access.isDM) { checkVerification(access, ctx.user); runAutomod(access, ctx.user.id, content, false); }

    // What it answers: an ordinary message here, or a quiet reply this person can see.
    const plain = get('SELECT id, author_id FROM messages WHERE id = ? AND channel_id = ?', body.replyTo, channel.id);
    const quietRef = plain ? null : visibleQuiet(body.replyTo, channel.id, ctx.user.id);
    if (!plain && !quietRef) throw bad('You can only reply to messages in the same channel.');

    // Who may see it. Nobody picked: the author of the message being answered.
    let viewers = [...new Set(body.viewers)].filter((id) => id !== ctx.user.id);
    if (!viewers.length) { const a = (plain || quietRef).author_id; if (a && a !== ctx.user.id) viewers = [a]; }
    if (!viewers.length) throw bad('Pick at least one person who can see this reply.');
    if (viewers.length > MAX_QUIET_VIEWERS) throw bad(`A quiet reply can be shown to at most ${MAX_QUIET_VIEWERS} people.`);
    const canView = new Set(channelViewerIds(channel, (id) => viewers.includes(id)));
    for (const id of viewers) {
      const u = get('SELECT id, bot FROM users WHERE id = ?', id);
      if (!u || !canView.has(id)) throw bad('One of the people you picked can’t see this channel.');
      if (u.bot) throw bad('Bots can’t be shown a quiet reply.');
      if (isBlockedEitherWay(ctx.user.id, id)) throw forbidden('Your quiet reply could not be delivered to one of the people you picked.');
    }
    // Answering a quiet reply: only people who can already see that one, so nobody gets an answer to something hidden from them.
    if (quietRef) {
      const allowed = new Set([quietRef.author_id, ...all('SELECT user_id FROM quiet_viewers WHERE quiet_id = ?', quietRef.id).map((v) => v.user_id)]);
      if (viewers.some((id) => !allowed.has(id))) throw bad('A reply to a quiet reply can only be shown to the people who can see that reply.');
    }

    const id = newId();
    tx(() => {
      run('INSERT INTO quiet_replies (id, channel_id, author_id, reply_to_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, channel.id, ctx.user.id, (plain || quietRef).id, content, Date.now());
      for (const v of viewers) {
        run('INSERT INTO quiet_viewers (quiet_id, user_id) VALUES (?, ?)', id, v);
        run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, NULL, 1)
             ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`, v, channel.id);
      }
    });
    const msg = { ...serializeQuiet([get('SELECT * FROM quiet_replies WHERE id = ?', id)])[0], guildId: channel.guild_id || null, nonce: body.nonce };
    sendToUsers([ctx.user.id, ...viewers], 'MESSAGE_CREATE', msg);
    pushForMessage({ channel, isDM: access.isDM, msg, authorId: ctx.user.id, notified: viewers, only: new Set(viewers) });
    return msg;
  });

  // The author takes it back. It disappears for everyone who could see it.
  r.delete('/api/channels/:id/quiet-replies/:quietId', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const row = visibleQuiet(ctx.params.quietId, access.channel.id, ctx.user.id);
    if (!row) throw notFound('Unknown message.');
    if (row.author_id !== ctx.user.id) throw forbidden('Only the person who wrote a quiet reply can delete it.');
    const viewers = all('SELECT user_id FROM quiet_viewers WHERE quiet_id = ?', row.id).map((v) => v.user_id);
    run('DELETE FROM quiet_replies WHERE id = ?', row.id);
    sendToUsers([row.author_id, ...viewers], 'MESSAGE_DELETE', { id: row.id, channelId: row.channel_id, guildId: access.channel.guild_id || null });
    return { ok: true };
  });
}
