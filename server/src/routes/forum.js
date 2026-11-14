// Forum channels: start a post, and list the posts of a forum (filtered by tag, searched by title, sorted by activity or by newest).
// A post is a thread whose parent is the forum, so replies, mentions, reactions, pins, polls, files, slowmode, AutoMod,
// "locked" and "closed" all work on it exactly like they do in any other thread. What a forum adds is the title, the tags and the list.
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, enforceRateLimit, HttpError } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { channelAccess, getChannelRow, serializeChannel, serializeMessages } from '../models.js';
import { sendToChannel } from '../gateway.js';
import { sendMessageAs, runAutomod, MAX_CONTENT } from './messages.js';
import { checkAppliedTags, TITLE_MAX } from '../lib/forum.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';

const PAGE = 25;
const PREVIEW = 280;

function forumAccess(ctx) {
  const access = channelAccess(ctx.params.id, ctx.user.id);
  if (access.isDM || access.channel.type !== ChannelType.FORUM) throw bad('That is not a forum channel.', 'not_forum');
  return access;
}

/** The first line or two of a post, without the markup that would look like noise in a list. */
function previewOf(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1).trimEnd()}…` : t;
}

export default function register(r) {
  // ---- start a post ----
  r.post('/api/channels/:id/posts', async (ctx) => {
    const access = forumAccess(ctx);
    const { channel, perms, member } = access;
    if (!has(perms, P.CREATE_THREADS)) throw forbidden('You do not have permission to start posts here.');
    const body = z.object({
      title: z.string({ required_error: 'Give your post a title.' }).trim().min(1, 'Give your post a title.').max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`),
      content: z.string().max(MAX_CONTENT, `A post can be at most ${MAX_CONTENT} characters.`).default(''),
      tagIds: z.array(z.string().max(40)).max(20).default([]),
      attachmentIds: z.array(z.string()).max(10, 'You can attach at most 10 files.').default([]),
      nonce: z.string().max(64).optional(),
    }).parse(ctx.body || {});
    if (!body.content.trim() && !body.attachmentIds.length) throw bad('Write something for your post, or attach a file.', 'empty_post', { errors: { content: 'Write something for your post, or attach a file.' } });
    const tags = checkAppliedTags(channel, body.tagIds);
    runAutomod(access, ctx.user.id, body.title, !!ctx.user.bot);   // (the title is shown to everyone, so AutoMod reads it like a message)
    enforceRateLimit(`post:${ctx.user.id}`, 6, 10 * 60_000, 'You are starting posts too quickly. Wait a few minutes.');
    // Slowmode on a forum limits how often one person may start a post (moderators are exempt).
    if (channel.rate_limit > 0 && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS) && !has(perms, P.MANAGE_THREADS)) {
      const last = get('SELECT created_at FROM channels WHERE parent_id = ? AND type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1', channel.id, ChannelType.THREAD, ctx.user.id);
      if (last && Date.now() - last.created_at < channel.rate_limit * 1000) {
        const wait = Math.ceil((channel.rate_limit * 1000 - (Date.now() - last.created_at)) / 1000);
        throw new HttpError(429, `Slowmode is on. Wait ${wait}s before starting another post.`, 'slowmode', { retryAfter: wait });
      }
    }
    void member;

    const id = newId();
    run('INSERT INTO channels (id, guild_id, type, name, parent_id, owner_id, applied_tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, channel.guild_id, ChannelType.THREAD, body.title, channel.id, ctx.user.id, JSON.stringify(tags), Date.now());
    sendToChannel(channel, 'THREAD_CREATE', serializeChannel(getChannelRow(id), []));
    let msg;
    try {
      // The first message goes through the normal send path, so every check on a message (AutoMod, files, mentions, link previews) applies to it.
      msg = await sendMessageAs(ctx.user, id, { content: body.content, attachmentIds: body.attachmentIds, nonce: body.nonce });
    } catch (e) {
      run('DELETE FROM channels WHERE id = ?', id);   // nothing was posted: take the empty post away again
      sendToChannel(channel, 'THREAD_DELETE', { id, parentId: channel.id, guildId: channel.guild_id });
      throw e;
    }
    // The forum itself counts as "has something new" for everyone who can see it.
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', msg.id, channel.id);
    sendToChannel(channel, 'CHANNEL_UPDATE', serializeChannel(getChannelRow(channel.id)));
    return { ...serializeChannel(getChannelRow(id), []), firstMessage: msg };
  });

  // ---- the list of posts ----
  r.get('/api/channels/:id/posts', async (ctx) => {
    const { channel, member } = forumAccess(ctx);
    const q = z.object({
      sort: z.enum(['activity', 'new']).optional(),
      tag: z.string().max(40).optional(),
      closed: z.enum(['0', '1']).optional(),
      search: z.string().max(100).optional(),
      offset: z.coerce.number().int().min(0).max(5000).optional(),
    }).parse(ctx.query || {});
    const sort = q.sort || (channel.forum_sort ? 'new' : 'activity');
    const where = ['c.parent_id = ?', 'c.type = ?', 'c.archived = ?'];
    const args = [ctx.user.id, channel.id, ChannelType.THREAD, q.closed === '1' ? 1 : 0];
    if (q.tag) { where.push('c.applied_tags LIKE ?'); args.push(`%"${q.tag.replace(/[^0-9a-zA-Z_-]/g, '')}"%`); }
    const text = (q.search || '').trim();
    if (text) { where.push("c.name LIKE ? ESCAPE '\\'"); args.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
    // Pinned posts come first (the newest pin on top), whatever the sort is. Closed posts are never pinned.
    const order = `c.pinned_at IS NULL, c.pinned_at DESC, ${sort === 'new' ? 'c.created_at DESC, c.id DESC' : 'COALESCE(c.last_message_id, c.id) DESC'}`;
    const rows = all(`SELECT c.*, rs.last_read_id AS rs_last, rs.mention_count AS rs_mentions FROM channels c
      LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${PAGE + 1} OFFSET ?`, ...args, q.offset || 0);
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);

    // The first message of each post (its body), in one query.
    const firsts = new Map();
    if (page.length) {
      const ph = page.map(() => '?').join(',');
      const msgs = all(`SELECT * FROM messages WHERE id IN (SELECT MIN(id) FROM messages WHERE channel_id IN (${ph}) GROUP BY channel_id)`, ...page.map((p) => p.id));
      serializeMessages(msgs).forEach((m) => firsts.set(m.channelId, m));
    }
    const posts = page.map((p) => {
      const first = firsts.get(p.id);
      const image = (first?.attachments || []).find((a) => /^image\/(png|jpe?g|gif|webp)$/.test(a.contentType || ''));
      const lastRead = p.rs_last;
      // Posts from before someone joined are not "new" to them; posts since then are, until they open them.
      const unread = !!p.last_message_id && (lastRead ? p.last_message_id > lastRead : p.created_at > (member?.joinedAt || 0));
      return {
        ...serializeChannel(p, []),
        author: first?.author || null,
        preview: first ? { messageId: first.id, text: previewOf(first.content), image: image ? { url: image.url, description: image.description || null } : null, files: (first.attachments || []).length } : null,
        unread,
        mentionCount: p.rs_mentions || 0,
      };
    });
    return { posts, more, sort };
  });
}
