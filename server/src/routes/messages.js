import { z } from 'zod';
import { get, all, run, tx, parseJSON } from '../db.js';
import { HttpError, bad, forbidden, notFound, enforceRateLimit, rateLimit } from '../lib/http.js';
import { newId, idToTimestamp } from '../lib/security.js';
import { removeUpload, duplicateUpload } from '../lib/uploads.js';
import { unfurlAll, extractUrls } from '../lib/unfurl.js';
import { config } from '../config.js';
import {
  channelAccess, serializeMessages, getChannelRow, serializeChannel, serializePrivateChannel, isBlockedEitherWay, relationshipType,
  getMember, guildAccess, getGuildCore, getGuildChannels, channelViewerIds, getUserRow, webhookAccess,
} from '../models.js';
import { sendToChannel, sendToUser, sendToUsers, isOnline } from '../gateway.js';
import { audit, createSystemMessage, awardXp } from '../services.js';
import { noteMessageForStreaks } from './streaks.js';
import { privacyAllows } from './users.js';
import { gifUrlOf } from './gifs.js';
import { pushForMessage } from '../lib/push.js';
import { quietMerge, readMarkWithQuiet } from './quiet.js';
import { embedsSchema, cleanEmbeds, isRich } from '../lib/embeds.js';
import { cleanComponents } from '../lib/components.js';
import { pollInputSchema, cleanPoll, insertPoll, getPoll, pollEnded, setVotes } from '../lib/polls.js';
import { P, has, ChannelType, computeChannelPermissions, isTextLike } from '../../../shared/permissions.js';

export const MAX_CONTENT = 4000;

/** The address people use to reach this server, for the link of an uploaded GIF. */
function originOf(ctx) {
  const h = ctx.req?.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.\-:[\]]{1,255}$/i.test(host)) return config.publicUrl;
  const proto = String(h['x-forwarded-proto'] || (ctx.req?.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

// The send handler, reachable from other server code (the scheduler sends scheduled messages through exactly the same
// checks as a normal send: permissions, blocks, slowmode, AutoMod, mentions, link previews).
let sendHandlerRef = null;
//   extra (server-side only, never from a request): { interaction, allowEmpty, webhook: { name, avatar } } (a webhook's message: the sender is not a member, see webhookAccess)
export async function sendMessageAs(user, channelId, body, extra = {}) {
  if (!sendHandlerRef) throw new Error('messages routes are not registered yet');
  return sendHandlerRef({ user, params: { id: channelId }, body, query: {}, ip: null, extra });
}
let editHandlerRef = null;
/** Edit a message as its author (used to finish a slash-command answer that was first sent as "thinking…"). */
export async function editMessageAs(user, channelId, messageId, body, extra = {}) {
  if (!editHandlerRef) throw new Error('messages routes are not registered yet');
  return editHandlerRef({ user, params: { id: channelId, messageId }, body, query: {}, ip: null, extra });
}
let deleteHandlerRef = null;
/** Delete a message as its author (taking back a slash-command answer). */
export async function deleteMessageAs(user, channelId, messageId, extra = {}) {
  if (!deleteHandlerRef) throw new Error('messages routes are not registered yet');
  return deleteHandlerRef({ user, params: { id: channelId, messageId }, body: {}, query: {}, ip: null, extra });
}
const recentContent = new Map(); // userId -> [{content, at}] for duplicate-spam detection

/** What the caller may do in this channel: a webhook (not a member, see models.js) or a member / bot as usual. */
const accessOf = (ctx) => (ctx.extra?.webhook ? webhookAccess(ctx.params.id) : channelAccess(ctx.params.id, ctx.user.id));

function threadPermFlag(channel) {
  return channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
}

/** Parse mentions from message content, respecting permissions. */
function parseMentions(content, access) {
  const userIds = [...new Set([...content.matchAll(/<@!?(\d{19})>/g)].map((m) => m[1]))].slice(0, 100);
  let roleIds = [...new Set([...content.matchAll(/<@&(\d{19})>/g)].map((m) => m[1]))];
  const everyone = /@(everyone|here)\b/.test(content.replace(/```[\s\S]*?```|`[^`]*`/g, ''));
  let validUsers = userIds;
  if (access.isDM) {
    const recips = new Set(all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', access.channel.id).map((r) => r.user_id));
    validUsers = userIds.filter((id) => recips.has(id));
    roleIds = [];
  } else {
    validUsers = userIds.filter((id) => get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', access.channel.guild_id, id));
    const canAll = has(access.perms, P.MENTION_EVERYONE);
    roleIds = roleIds.filter((id) => { const role = access.guild.roles.find((x) => x.id === id); return role && (role.mentionable || canAll); });
  }
  return { users: validUsers, roles: roleIds, everyone: everyone && !access.isDM && has(access.perms, P.MENTION_EVERYONE) };
}

/** Throws if this server's AutoMod would block the text (used for messages, and for the titles of threads and forum posts). */
export function runAutomod(access, userId, content, isBot = false) {
  if (access.isDM || isBot) return; // bots are added by the server's managers, so AutoMod leaves them alone
  const { guild, perms, member } = access;
  if (has(perms, P.MANAGE_GUILD) || has(perms, P.ADMINISTRATOR)) return;
  const am = guild.automod || {};
  if ((am.exemptRoles || []).some((rid) => member.roles.includes(rid))) return;
  const block = (reason, extra) => {
    audit(guild.id, null, 'AUTOMOD_BLOCK_MESSAGE', { targetId: userId, targetType: 'user', reason, changes: { channelId: access.channel.id, content: content.slice(0, 200), ...extra } });
    throw new HttpError(400, `Your message was blocked by this server’s AutoMod: ${reason}`, 'automod_blocked');
  };
  const lower = content.toLowerCase();
  for (const word of am.blockedWords || []) {
    const w = word.toLowerCase();
    const re = w.includes('*') ? new RegExp(w.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i') : null;
    if (re ? re.test(lower) : new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i').test(lower)) block('it contains a blocked word.');
  }
  if (am.blockInvites && /(?:invite\/|discord\.gg\/|discord(?:app)?\.com\/invite\/)[\w-]+/i.test(content)) block('invite links are not allowed here.');
  if (am.blockLinks && extractUrls(content).length) block('links are not allowed here.');
  if (am.mentionLimit) {
    const n = new Set([...content.matchAll(/<@[!&]?(\d+)>/g)].map((m) => m[1])).size;
    if (n > am.mentionLimit) {
      if (am.timeoutOnMentionSpam) {
        const until = Date.now() + (am.mentionTimeout || 600) * 1000;
        run('UPDATE guild_members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?', until, guild.id, userId);
        audit(guild.id, null, 'MEMBER_TIMEOUT', { targetId: userId, targetType: 'user', reason: 'AutoMod: mention spam', changes: { timeoutUntil: until } });
        sendToUsers(channelViewerIds(access.channel).filter(isOnline), 'GUILD_MEMBER_UPDATE', { guildId: guild.id, member: getMember(guild.id, userId) });
      }
      block(`too many mentions (limit is ${am.mentionLimit}).`);
    }
  }
  if (am.spamFilter !== false) {
    const list = (recentContent.get(userId) || []).filter((x) => x.at > Date.now() - 30_000);
    const same = list.filter((x) => x.content === lower && lower.length > 0).length;
    list.push({ content: lower, at: Date.now() });
    recentContent.set(userId, list.slice(-10));
    if (same >= 3) block('it looks like spam (the same message repeated).');
  }
}

export function checkVerification(access, user) {
  if (access.isDM) return;
  const { guild, perms, member } = access;
  if (has(perms, P.MANAGE_GUILD) || member.roles.length > 0) return;
  const lvl = guild.verificationLevel;
  if (lvl >= 2 && Date.now() - user.created_at < 5 * 60 * 1000) throw forbidden('This server requires your account to be at least 5 minutes old.');
  if (lvl >= 3 && Date.now() - member.joinedAt < 10 * 60 * 1000) throw forbidden('This server requires you to be a member for at least 10 minutes before talking.');
}

function canSeeHistory(access) {
  return has(access.perms, P.READ_MESSAGE_HISTORY);
}

/**
 * What a forwarded message carries: who wrote the original, when, its text and link previews, plus its file rows (copied
 * by the caller). Needs the sender to be able to read the original, and (for files and previews) to attach files / embed
 * links where it is going. Forwarding a forwarded message keeps pointing at the original author.
 */
function loadForward(userId, ref, destPerms) {
  let src;
  try { src = channelAccess(ref.channelId, userId); } catch { throw notFound('That message is gone.'); }
  if (!canSeeHistory(src)) throw forbidden('You can’t forward that message.');
  const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ref.messageId, src.channel.id);
  if (!row) throw notFound('That message is gone.');
  if (row.type !== 0 && row.type !== 19) throw bad('That kind of message can’t be forwarded.');
  if (getPoll(row.id)) throw bad('Polls can’t be forwarded.');
  if (row.stickers) throw bad('Stickers can’t be forwarded.');
  const inner = row.forward ? parseJSON(row.forward, null) : null;
  let author = inner?.author || null;
  if (!author) {
    const u = row.author_id ? get('SELECT id, username, display_name, avatar FROM users WHERE id = ?', row.author_id) : null;
    author = u ? { id: u.id, name: u.display_name || u.username, username: u.username, avatar: u.avatar || null } : { id: null, name: 'Deleted User', username: null, avatar: null };
  }
  const attachments = all('SELECT * FROM attachments WHERE message_id = ?', row.id);
  if (attachments.length) requirePermLocal(destPerms, P.ATTACH_FILES, 'You do not have permission to attach files in this channel, so you can’t forward a message with files here.');
  const embeds = has(destPerms, P.EMBED_LINKS) ? (inner ? inner.embeds : parseJSON(row.embeds, [])) || [] : [];
  return { snapshot: { author, createdAt: inner?.createdAt || row.created_at, content: inner ? inner.content || '' : row.content, embeds }, attachments };
}

/** Notification bookkeeping: bump mention counters for everyone who was pinged. Returns who was pinged. */
function bumpMentionCounts(access, msgId, authorId, mentions) {
  const ids = new Set();
  const direct = new Set(); // pinged by name or role, as opposed to only by @everyone / @here
  if (access.isDM) {
    for (const r of all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', access.channel.id)) ids.add(r.user_id);
  } else {
    mentions.users.forEach((id) => { ids.add(id); direct.add(id); });
    if (mentions.roles.length) {
      const ph = mentions.roles.map(() => '?').join(',');
      for (const r of all(`SELECT DISTINCT user_id FROM member_roles WHERE guild_id = ? AND role_id IN (${ph})`, access.channel.guild_id, ...mentions.roles)) { ids.add(r.user_id); direct.add(r.user_id); }
    }
    if (mentions.everyone) channelViewerIds(access.channel).forEach((id) => ids.add(id));
  }
  ids.delete(authorId);
  const notified = [];
  const onlyEveryone = new Set();
  for (const uid of ids) {
    if (isBlockedEitherWay(uid, authorId)) continue;
    run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, NULL, 1)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`, uid, access.channel.id);
    notified.push(uid);
    if (!access.isDM && !direct.has(uid)) onlyEveryone.add(uid);
  }
  return { notified, onlyEveryone };
}

async function addEmbeds(msgId, channelRow, content) {
  if (!config.linkPreviews || !extractUrls(content).length) return;
  try {
    const embeds = await unfurlAll(content);
    if (!embeds.length) return;
    const row = get('SELECT * FROM messages WHERE id = ?', msgId);
    if (!row || row.content !== content) return;
    const own = parseJSON(row.embeds, []).filter(isRich); // a bot's cards stay; link previews come after them
    run('UPDATE messages SET embeds = ? WHERE id = ?', JSON.stringify([...own, ...embeds].slice(0, 10)), msgId);
    sendToChannel(channelRow, 'MESSAGE_UPDATE', { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', msgId)])[0], guildId: channelRow.guild_id });
  } catch (e) { /* previews are best-effort */ }
}

function emojiKey(raw) {
  const s = String(raw || '').trim();   // (the router has already decoded it once: decoding again broke on a real "%")
  const custom = /^([a-zA-Z0-9_]{2,32}):(\d{19})$/.exec(s);
  if (custom) {
    const e = get('SELECT * FROM emojis WHERE id = ?', custom[2]);
    if (!e) throw bad('Unknown emoji.');
    return { key: `${e.name}:${e.id}`, guildId: e.guild_id };
  }
  if (!s || s.length > 32 || /[\s<>:]/.test(s) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}#*0-9]\u{FE0F}?\u{20E3}/u.test(s)) throw bad('Invalid emoji.');
  return { key: s, guildId: null };
}

export default function register(r) {
  // ---- read messages ----
  r.get('/api/channels/:id/messages', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) return [];
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 50, 1), 100);
    const { before, after, around } = ctx.query;
    let rows;
    if (around) {
      const half = Math.floor(limit / 2);
      const older = all('SELECT * FROM messages WHERE channel_id = ? AND id <= ? ORDER BY id DESC LIMIT ?', access.channel.id, String(around), half + 1);
      const newer = all('SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?', access.channel.id, String(around), half);
      rows = [...newer.reverse(), ...older];
    } else if (after) {
      rows = all('SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?', access.channel.id, String(after), limit).reverse();
    } else if (before) {
      rows = all('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', access.channel.id, String(before), limit);
    } else {
      rows = all('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', access.channel.id, limit);
    }
    // The reader's quiet replies (routes/quiet.js) are put in where they belong. A page never gets longer than its limit.
    const me = ctx.user.id, cid = access.channel.id;
    if (around) {
      const half = Math.floor(limit / 2);
      const older = quietMerge.before(serializeMessages(rows.filter((m) => m.id <= String(around))), me, cid, half + 1, String(around) + '\uffff');
      const newer = quietMerge.after(serializeMessages(rows.filter((m) => m.id > String(around)).reverse()), me, cid, half, String(around));
      return [...newer.reverse(), ...older];
    }
    if (after) return quietMerge.after(serializeMessages(rows.slice().reverse()), me, cid, limit, String(after)).reverse();
    if (before) return quietMerge.before(serializeMessages(rows), me, cid, limit, String(before));
    return quietMerge.latest(serializeMessages(rows), me, cid, limit); // newest first
  });

  r.get('/api/channels/:id/messages/:messageId', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) throw notFound('Unknown message.');
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!row) throw notFound('Unknown message.');
    return serializeMessages([row])[0];
  });

  // ---- send ----
  const sendMessageHandler = async (ctx) => {
    const extra = ctx.extra || {};
    const access = accessOf(ctx);
    const { channel, perms } = access;
    if (channel.type === ChannelType.CATEGORY) throw bad('You can’t send messages here.');
    if (channel.type === ChannelType.FORUM) throw bad('This is a forum. Start a post instead of sending a message.', 'forum_channel');
    const body = z.object({
      content: z.string().max(MAX_CONTENT, `Messages can be at most ${MAX_CONTENT} characters.`).default(''),
      replyTo: z.string().nullable().optional(),
      attachmentIds: z.array(z.string()).max(10, 'You can attach at most 10 files.').default([]),
      nonce: z.string().max(64).optional(),
      silent: z.boolean().optional(),
      poll: pollInputSchema.optional(),
      embeds: embedsSchema.optional(),   // bots only: cards with a title, text, colour, fields and a picture
      components: z.array(z.any()).max(5, 'A message can have at most 5 rows of buttons or menus.').optional(),   // bots only: buttons and menus (webhooks: link buttons)
      gifId: z.string().max(40).optional(),   // an uploaded GIF: shown right away, without fetching the link
      stickerIds: z.array(z.string().max(40)).max(1, 'You can send one sticker at a time.').default([]),   // a server's sticker (from any server you are in)
      forward: z.object({ channelId: z.string().max(40), messageId: z.string().max(40) }).optional(),   // forward this message (the text above is an optional comment)
    }).parse(ctx.body);
    if (body.embeds?.length && !ctx.user.bot) throw bad('Only bots can send embeds.');
    const richEmbeds = body.embeds?.length ? cleanEmbeds(body.embeds) : [];
    if (body.components?.length && !ctx.user.bot) throw bad('Only bots can send buttons and menus.');
    const components = body.components?.length ? cleanComponents(body.components, { linkOnly: ctx.user.bot === 2 }) : [];
    const typed = body.content.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
    const gif = body.gifId ? get('SELECT * FROM gifs WHERE id = ? AND removed = 0', body.gifId) : null;
    if (body.gifId && !gif) throw bad('That GIF is gone.');
    if (gif && body.poll) throw bad('A poll can’t include a GIF.');
    const gifUrl = gif ? `${originOf(ctx)}${gifUrlOf(gif)}` : null;
    const content = typed || gifUrl || '';
    // A sticker: from a server you are in, and (like custom emoji) from another server only where external emoji are allowed.
    let sticker = null;
    if (body.stickerIds.length) {
      sticker = get('SELECT * FROM stickers WHERE id = ?', body.stickerIds[0]);
      if (!sticker) throw bad('That sticker is gone.');
      if (!get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', sticker.guild_id, ctx.user.id)) throw forbidden('You can only use stickers from servers you are in.');
      if (body.poll) throw bad('A poll can’t include a sticker.');
      if (body.forward) throw bad('A forwarded message can’t also include a sticker.');
      if (!access.isDM && sticker.guild_id !== channel.guild_id && !has(perms, P.USE_EXTERNAL_EMOJIS)) throw forbidden('You can’t use stickers from other servers here.');
    }
    if (body.forward && (body.poll || gif || body.attachmentIds.length)) throw bad('A forwarded message can’t also include a poll, a GIF or new files.');
    if (!content && !body.attachmentIds.length && !body.forward && !richEmbeds.length && !components.length && !sticker && !extra.allowEmpty) throw bad('Your message is empty.');
    // A poll's question is the message text. Polls are plain messages in every other respect (permissions, slowmode, AutoMod).
    const poll = body.poll ? cleanPoll(body.poll, content) : null;
    if (poll && body.attachmentIds.length) throw bad('A poll can’t have attachments.');

    requirePermLocal(perms, threadPermFlag(channel), 'You do not have permission to send messages in this channel.');
    if (channel.type === ChannelType.THREAD) {
      if (channel.locked && !has(perms, P.MANAGE_THREADS)) throw forbidden('This thread is locked.');
    }
    const fwd = body.forward ? loadForward(ctx.user.id, body.forward, perms) : null;

    // Spam protection: global per-user rate limit.
    // (a webhook is often a tool that reports a burst of events at once, so it gets a larger burst: 20 in 10 seconds)
    // (an answer to a command, button or form is already limited by how fast the person can start those, and it must go out inside the 5 seconds the bot has to answer)
    if (extra.interaction) { /* limited by the person who started it */ }
    else if (extra.webhook) enforceRateLimit(`msg:${ctx.user.id}`, 20, 10_000, 'This webhook is sending messages too quickly. Slow down!');
    else enforceRateLimit(`msg:${ctx.user.id}`, 8, 5_000, 'You are sending messages too quickly. Slow down!');

    if (access.isDM) {
      if (channel.type === ChannelType.DM) {
        const other = get('SELECT user_id FROM channel_recipients WHERE channel_id = ? AND user_id != ?', channel.id, ctx.user.id)?.user_id;
        if (other && isBlockedEitherWay(ctx.user.id, other)) throw forbidden('Your message could not be delivered. This usually means you don’t share a server with the recipient or the recipient only accepts direct messages from friends.');
        if (other && relationshipType(ctx.user.id, other) !== 1 && !privacyAllows(ctx.user.id, other, 'dm')) throw forbidden('Your message could not be delivered because this user only accepts direct messages from friends.');
      }
    } else {
      if (!ctx.user.bot) checkVerification(access, ctx.user);
      // Slowmode (bots are exempt, as they are on other chat apps)
      const slow = channel.rate_limit;
      if (slow > 0 && !ctx.user.bot && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS)) {
        const last = get('SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1', channel.id, ctx.user.id);
        if (last && Date.now() - last.created_at < slow * 1000) {
          const wait = Math.ceil((slow * 1000 - (Date.now() - last.created_at)) / 1000);
          throw new HttpError(429, `Slowmode is enabled. Wait ${wait}s before sending another message.`, 'slowmode', { retryAfter: wait });
        }
      }
      runAutomod(access, ctx.user.id, typed + (fwd?.snapshot.content ? `\n${fwd.snapshot.content}` : ''), !!ctx.user.bot);   // (a bare uploaded GIF has no text of its own to check; forwarded text is checked like typed text)
    }

    // Attachments
    let attachments = [];
    if (body.attachmentIds.length) {
      requirePermLocal(perms, P.ATTACH_FILES, 'You do not have permission to attach files in this channel.');
      const ph = body.attachmentIds.map(() => '?').join(',');
      attachments = all(`SELECT * FROM attachments WHERE id IN (${ph}) AND uploader_id = ? AND message_id IS NULL`, ...body.attachmentIds, ctx.user.id);
      if (attachments.length !== new Set(body.attachmentIds).size) throw bad('One of your attachments is missing. Try uploading it again.');
    }

    let replyTo = null;
    if (body.replyTo) {
      const ref = get('SELECT id, channel_id, author_id FROM messages WHERE id = ?', body.replyTo);
      if (!ref || ref.channel_id !== channel.id) throw bad('You can only reply to messages in the same channel.');
      replyTo = ref;
    }

    const mentions = parseMentions(content, access);
    if (replyTo && replyTo.author_id && replyTo.author_id !== ctx.user.id && ctx.body.mentionReplied !== false && !mentions.users.includes(replyTo.author_id) && getUserRow(replyTo.author_id)?.bot !== 2) {   // (a webhook's sender has no one to notify)
      mentions.users.push(replyTo.author_id);
    }
    if (body.silent) { mentions.users = []; mentions.roles = []; mentions.everyone = false; }

    const id = newId();
    const now = Date.now();
    let pinged = { notified: [], onlyEveryone: new Set() };
    // A forwarded message's files get their own names (hard links: no extra disk space), so deleting either message never breaks the other.
    const copies = [];
    try { for (const a of fwd?.attachments || []) copies.push({ ...a, id: newId(), stored_name: duplicateUpload('attachments', a.stored_name) }); }
    catch { copies.forEach((c) => removeUpload('attachments', c.stored_name)); throw bad('One of the files in that message is no longer available, so it can’t be forwarded.'); }
    try {
    tx(() => {
      run(`INSERT INTO messages (id, channel_id, author_id, content, type, reply_to_id, mentions, mention_roles, mention_everyone, created_at, forward, embeds, interaction, webhook, components)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, channel.id, ctx.user.id, content, replyTo ? 19 : 0, replyTo?.id || null, JSON.stringify(mentions.users), JSON.stringify(mentions.roles), mentions.everyone ? 1 : 0, now, fwd ? JSON.stringify(fwd.snapshot) : null,
      JSON.stringify(richEmbeds), extra.interaction ? JSON.stringify(extra.interaction) : null, extra.webhook ? JSON.stringify(extra.webhook) : null, components.length ? JSON.stringify(components) : null);
      for (const a of attachments) run('UPDATE attachments SET message_id = ? WHERE id = ?', id, a.id);
      for (const c of copies) run('INSERT INTO attachments (id, message_id, uploader_id, filename, stored_name, size, content_type, spoiler, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', c.id, id, ctx.user.id, c.filename, c.stored_name, c.size, c.content_type, c.spoiler, c.description || null, now);
      if (sticker) run('UPDATE messages SET stickers = ? WHERE id = ?', JSON.stringify([{ id: sticker.id, name: sticker.name }]), id);
      if (gif) {
        run('UPDATE gifs SET uses = uses + 1 WHERE id = ?', gif.id);
        if (has(perms, P.EMBED_LINKS)) run('UPDATE messages SET embeds = ? WHERE id = ?', JSON.stringify([{ type: 'image', url: gifUrl, image: { url: gifUrl, width: gif.width || undefined, height: gif.height || undefined }, alt: gif.name }]), id);
      }
      run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, channel.id);
      if (channel.type === ChannelType.THREAD) run('UPDATE channels SET message_count = message_count + 1, archived = 0 WHERE id = ?', channel.id);
      if (!extra.webhook) run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
           ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`, ctx.user.id, channel.id, id);
      if (poll) insertPoll(id, poll);
      pinged = bumpMentionCounts(access, id, ctx.user.id, mentions);
    });
    } catch (e) { copies.forEach((c) => removeUpload('attachments', c.stored_name)); throw e; }

    // Re-open closed DMs for the recipients.
    if (access.isDM) {
      const closed = all('SELECT user_id FROM channel_recipients WHERE channel_id = ? AND closed = 1', channel.id);
      if (closed.length) {
        run('UPDATE channel_recipients SET closed = 0 WHERE channel_id = ?', channel.id);
        const row = getChannelRow(channel.id);
        for (const c of closed) sendToUser(c.user_id, 'CHANNEL_CREATE', serializePrivateChannel(row, c.user_id));
      }
    }

    const msg = { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', id)])[0], guildId: channel.guild_id || null, nonce: body.nonce };
    sendToChannel(channel, 'MESSAGE_CREATE', msg);
    // Phones and browsers where NullChat is closed (fire-and-forget; see lib/push.js).
    if (!body.silent) pushForMessage({ channel, isDM: access.isDM, msg, authorId: ctx.user.id, notified: pinged.notified, onlyEveryone: pinged.onlyEveryone });
    if (channel.type === ChannelType.THREAD) {
      const parent = getChannelRow(channel.parent_id);
      const t = getChannelRow(channel.id);
      if (parent) sendToChannel(parent, 'THREAD_UPDATE', serializeChannel(t, []));
    }
    if (has(perms, P.EMBED_LINKS) && !gif) addEmbeds(id, channel, content);
    if (!access.isDM && !ctx.user.bot) awardXp(channel.guild_id, ctx.user.id);
    if (!ctx.user.bot) noteMessageForStreaks(channel, ctx.user.id);
    return msg;
  };
  sendHandlerRef = sendMessageHandler;
  r.post('/api/channels/:id/messages', sendMessageHandler);

  // ---- polls ----
  function pollContext(ctx) {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) throw forbidden();
    const msg = get('SELECT id, author_id FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    const poll = msg && getPoll(msg.id);
    if (!poll) throw notFound('Unknown poll.');
    return { access, msg, poll };
  }
  const broadcastMessage = (access, id) => {
    const msg = { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', id)])[0], guildId: access.channel.guild_id || null };
    sendToChannel(access.channel, 'MESSAGE_UPDATE', msg);
    return msg;
  };

  r.put('/api/channels/:id/messages/:messageId/poll/votes', async (ctx) => {
    const { access, msg, poll } = pollContext(ctx);
    const { optionIds } = z.object({ optionIds: z.array(z.string()).max(10) }).parse(ctx.body);
    requirePermLocal(access.perms, P.ADD_REACTIONS, 'You do not have permission to vote here.');
    if (access.isDM && msg.author_id && isBlockedEitherWay(ctx.user.id, msg.author_id)) throw forbidden('You can’t vote on this poll.');
    enforceRateLimit(`vote:${ctx.user.id}`, 20, 10_000, 'You are voting too fast. Slow down a little.');
    if (pollEnded(poll)) throw bad('This poll has ended.');
    setVotes(poll, ctx.user.id, optionIds);
    return broadcastMessage(access, msg.id);
  });

  // The author (or a moderator) can end a poll early. Results stay visible.
  r.post('/api/channels/:id/messages/:messageId/poll/end', async (ctx) => {
    const { access, msg, poll } = pollContext(ctx);
    if (msg.author_id !== ctx.user.id && (access.isDM || !has(access.perms, P.MANAGE_MESSAGES))) throw forbidden('Only the person who made the poll can end it.');
    if (pollEnded(poll)) throw bad('This poll has already ended.');
    run('UPDATE polls SET closed_at = ? WHERE message_id = ?', Date.now(), msg.id);
    return broadcastMessage(access, msg.id);
  });

  // ---- edit ----
  const editMessageHandler = async (ctx) => {
    const access = accessOf(ctx);
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!row) throw notFound('Unknown message.');
    const body = z.object({ content: z.string().max(MAX_CONTENT).optional(), suppressEmbeds: z.boolean().optional(), embeds: embedsSchema.optional(), components: z.array(z.any()).max(5).nullable().optional() }).parse(ctx.body);
    const extra = ctx.extra || {};
    if (body.suppressEmbeds && (row.author_id === ctx.user.id || has(access.perms, P.MANAGE_MESSAGES))) {
      run("UPDATE messages SET embeds = '[]' WHERE id = ?", row.id);
      row.embeds = '[]';
    }
    if (body.content !== undefined || body.embeds !== undefined || body.components !== undefined) {
      if (row.author_id !== ctx.user.id) throw forbidden('You can only edit your own messages.');
      if (row.crosspost) throw forbidden('A published announcement can’t be edited here. It belongs to the server that sent it.');
      if (row.type !== 0 && row.type !== 19) throw bad('System messages can’t be edited.');
      if (body.embeds?.length && !ctx.user.bot) throw bad('Only bots can send embeds.');
      if (body.components?.length && !ctx.user.bot) throw bad('Only bots can send buttons and menus.');
      const content = (body.content ?? row.content).replace(/\r\n/g, '\n').trim();
      const before = parseJSON(row.embeds, []);
      // A bot's own cards are replaced only when it sends new ones; link previews are dropped when the text changes.
      const rich = body.embeds !== undefined ? cleanEmbeds(body.embeds) : before.filter(isRich);
      const previews = content === row.content ? before.filter((e) => !isRich(e)) : [];
      const hasAtt = get('SELECT 1 FROM attachments WHERE message_id = ?', row.id);
      // buttons and menus stay as they are unless the bot sends new ones (an empty list takes them away)
      const comps = body.components !== undefined ? cleanComponents(body.components, { linkOnly: ctx.user.bot === 2 }) : parseJSON(row.components, []);
      const hasSticker = !!row.stickers && row.stickers !== '[]';
      if (!content && !hasAtt && !hasSticker && !row.forward && !rich.length && !comps.length) throw bad('Your message is empty. Delete it instead.');
      if (!access.isDM) runAutomod(access, ctx.user.id, content + ' ', !!ctx.user.bot);
      const mentions = parseMentions(content, access);
      let interaction = row.interaction;
      if (extra.finishInteraction && interaction) { const it = parseJSON(interaction, {}); delete it.pending; interaction = JSON.stringify(it); }
      run('UPDATE messages SET content = ?, edited_at = ?, mentions = ?, mention_roles = ?, mention_everyone = ?, embeds = ?, interaction = ?, components = ? WHERE id = ?',
        content, extra.finishInteraction ? null : extra.keepEditedAt ? row.edited_at : Date.now(), JSON.stringify(mentions.users), JSON.stringify(mentions.roles), mentions.everyone ? 1 : 0,
        JSON.stringify([...rich, ...previews]), interaction, comps.length ? JSON.stringify(comps) : null, row.id);
      if (content !== row.content && has(access.perms, P.EMBED_LINKS)) addEmbeds(row.id, access.channel, content);
    }
    const msg = { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', row.id)])[0], guildId: access.channel.guild_id };
    sendToChannel(access.channel, 'MESSAGE_UPDATE', msg);
    return msg;
  };
  editHandlerRef = editMessageHandler;
  r.patch('/api/channels/:id/messages/:messageId', editMessageHandler);

  // ---- delete ----
  const deleteMessageHandler = async (ctx) => {
    const access = accessOf(ctx);
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!row) throw notFound('Unknown message.');
    const own = row.author_id === ctx.user.id;
    if (!own) {
      if (access.isDM) throw forbidden('You can only delete your own messages.');
      requirePermLocal(access.perms, P.MANAGE_MESSAGES, 'You can only delete your own messages.');
    }
    const atts = all('SELECT stored_name FROM attachments WHERE message_id = ?', row.id);
    run('DELETE FROM messages WHERE id = ?', row.id);
    atts.forEach((a) => removeUpload('attachments', a.stored_name));
    if (access.channel.last_message_id === row.id) {
      const last = get('SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', access.channel.id);
      run('UPDATE channels SET last_message_id = ? WHERE id = ?', last?.id || null, access.channel.id);
    }
    if (access.channel.type === ChannelType.THREAD) run('UPDATE channels SET message_count = MAX(0, message_count - 1) WHERE id = ?', access.channel.id);
    if (!own && !access.isDM) audit(access.channel.guild_id, ctx.user.id, 'MESSAGE_DELETE', { targetId: row.author_id, targetType: 'user', changes: { channelId: access.channel.id, content: row.content.slice(0, 200) } });
    sendToChannel(access.channel, 'MESSAGE_DELETE', { id: row.id, channelId: access.channel.id, guildId: access.channel.guild_id });
    return { ok: true };
  };
  deleteHandlerRef = deleteMessageHandler;
  r.delete('/api/channels/:id/messages/:messageId', deleteMessageHandler);

  r.post('/api/channels/:id/messages/bulk-delete', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (access.isDM) throw bad('Not available in DMs.');
    requirePermLocal(access.perms, P.MANAGE_MESSAGES);
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(100) }).parse(ctx.body);
    const ph = ids.map(() => '?').join(',');
    const found = all(`SELECT id FROM messages WHERE channel_id = ? AND id IN (${ph})`, access.channel.id, ...ids).map((x) => x.id);
    tx(() => found.forEach((id) => run('DELETE FROM messages WHERE id = ?', id)));
    audit(access.channel.guild_id, ctx.user.id, 'MESSAGE_BULK_DELETE', { targetId: access.channel.id, targetType: 'channel', changes: { count: found.length } });
    sendToChannel(access.channel, 'MESSAGE_DELETE_BULK', { channelId: access.channel.id, ids: found });
    return { ok: true, deleted: found.length };
  });

  // ---- reactions ----
  function broadcastReactions(access, messageId, delta = null) {
    const reacts = all('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at', messageId);
    const map = new Map();
    for (const x of reacts) { if (!map.has(x.emoji)) map.set(x.emoji, []); map.get(x.emoji).push(x.user_id); }
    const reactions = [...map.entries()].map(([emoji, users]) => ({ emoji, users, count: users.length }));
    // (`delta`: who added or removed which emoji. People's apps only need the new list; the Discord-compatible gateway reports each change.)
    sendToChannel(access.channel, 'MESSAGE_REACTIONS_UPDATE', { channelId: access.channel.id, guildId: access.channel.guild_id || null, messageId, reactions, ...(delta ? { delta } : {}) });
    return reactions;
  }

  r.put('/api/channels/:id/messages/:messageId/reactions/:emoji', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) throw forbidden();
    const msg = get('SELECT id, author_id FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!msg) throw notFound('Unknown message.');
    if (access.isDM && msg.author_id && isBlockedEitherWay(ctx.user.id, msg.author_id)) throw forbidden('You can’t react to this message.');
    if (rateLimit(`react:${ctx.user.id}`, 20, 5000)) throw new HttpError(429, 'Slow down on the reactions!', 'rate_limited', { retryAfter: 5 });
    const { key, guildId } = emojiKey(ctx.params.emoji);
    const exists = get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?', msg.id, key);
    if (!exists) {
      requirePermLocal(access.perms, P.ADD_REACTIONS, 'You do not have permission to add reactions here.');
      const distinct = get('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', msg.id).n;
      if (distinct >= 20) throw bad('This message has the maximum number of different reactions.');
      if (guildId && guildId !== access.channel.guild_id) {
        if (!has(access.perms, P.USE_EXTERNAL_EMOJIS)) throw forbidden('You can’t use emojis from other servers here.');
        if (!get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, ctx.user.id)) throw forbidden('You can only use emojis from servers you are in.');
      }
    }
    const added = run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', msg.id, ctx.user.id, key, Date.now());
    return broadcastReactions(access, msg.id, added.changes ? { type: 'add', emoji: key, userId: ctx.user.id } : null);
  });

  r.delete('/api/channels/:id/messages/:messageId/reactions/:emoji/:userId', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const msg = get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!msg) throw notFound('Unknown message.');
    const target = ctx.params.userId === '@me' ? ctx.user.id : ctx.params.userId;
    if (target !== ctx.user.id) requirePermLocal(access.perms, P.MANAGE_MESSAGES);
    const key = ctx.params.emoji;   // (already decoded by the router)
    const removed = run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', msg.id, target, key);
    return broadcastReactions(access, msg.id, removed.changes ? { type: 'remove', emoji: key, userId: target } : null);
  });

  r.delete('/api/channels/:id/messages/:messageId/reactions', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    requirePermLocal(access.perms, P.MANAGE_MESSAGES);
    run('DELETE FROM reactions WHERE message_id = ?', ctx.params.messageId);
    return broadcastReactions(access, ctx.params.messageId, { type: 'clear' });
  });

  // ---- pins ----
  r.get('/api/channels/:id/pins', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) return [];
    return serializeMessages(all('SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY id DESC', access.channel.id));
  });
  async function setPinned(ctx, pinned) {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!access.isDM) requirePermLocal(access.perms, P.MANAGE_MESSAGES, 'You need Manage Messages to pin messages.');
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, access.channel.id);
    if (!row) throw notFound('Unknown message.');
    if (pinned && get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned = 1', access.channel.id).n >= 50) throw bad('This channel has reached the maximum of 50 pins.');
    if (!!row.pinned === pinned) return { ok: true };
    run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, row.id);
    const msg = { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', row.id)])[0], guildId: access.channel.guild_id };
    sendToChannel(access.channel, 'MESSAGE_UPDATE', msg);
    sendToChannel(access.channel, 'CHANNEL_PINS_UPDATE', { channelId: access.channel.id });
    if (pinned) createSystemMessage(access.channel, ctx.user.id, 6, '', { replyToId: row.id });
    if (!access.isDM) audit(access.channel.guild_id, ctx.user.id, pinned ? 'MESSAGE_PIN' : 'MESSAGE_UNPIN', { targetId: row.id, targetType: 'message', changes: { channelId: access.channel.id } });
    return { ok: true };
  }
  r.put('/api/channels/:id/pins/:messageId', (ctx) => setPinned(ctx, true));
  r.delete('/api/channels/:id/pins/:messageId', (ctx) => setPinned(ctx, false));

  // ---- threads ----
  r.post('/api/channels/:id/threads', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { channel, perms } = access;
    if (access.isDM || !isTextLike(channel.type)) throw bad('Threads can only be created in server text channels.');
    requirePermLocal(perms, P.CREATE_THREADS, 'You do not have permission to create threads here.');
    enforceRateLimit(`thread:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const body = z.object({ name: z.string().trim().min(1).max(100), messageId: z.string().optional(), content: z.string().max(MAX_CONTENT).optional() }).parse(ctx.body);
    runAutomod(access, ctx.user.id, body.name, !!ctx.user.bot);
    let starter = null;
    if (body.messageId) {
      starter = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', body.messageId, channel.id);
      if (!starter) throw notFound('Unknown message.');
      if (get('SELECT 1 FROM channels WHERE message_id = ? AND type = ?', starter.id, ChannelType.THREAD)) throw bad('A thread already exists for this message.');
    }
    const id = newId();
    run('INSERT INTO channels (id, guild_id, type, name, parent_id, owner_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, channel.guild_id, ChannelType.THREAD, body.name, channel.id, ctx.user.id, starter?.id || null, Date.now());
    const thread = getChannelRow(id);
    sendToChannel(channel, 'THREAD_CREATE', serializeChannel(thread, []));
    if (starter) {
      sendToChannel(channel, 'MESSAGE_UPDATE', { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', starter.id)])[0], guildId: channel.guild_id });
    } else {
      createSystemMessage(channel, ctx.user.id, 18, body.name, {});
      run('UPDATE messages SET embeds = ? WHERE id = ?', JSON.stringify([{ type: 'thread', threadId: id }]), getChannelRow(channel.id).last_message_id);
    }
    return serializeChannel(thread, []);
  });

  r.get('/api/channels/:id/threads', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (access.isDM) return [];
    return all('SELECT * FROM channels WHERE parent_id = ? AND type = ? ORDER BY COALESCE(last_message_id, id) DESC LIMIT 100', access.channel.id, ChannelType.THREAD)
      .map((t) => serializeChannel(t, []));
  });

  // ---- read state ----
  r.post('/api/channels/:id/ack', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { messageId } = z.object({ messageId: z.string().nullable().optional() }).parse(ctx.body || {});
    const lastId = readMarkWithQuiet(ctx.user.id, access.channel, messageId || access.channel.last_message_id);
    run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`, ctx.user.id, access.channel.id, lastId);
    sendToUser(ctx.user.id, 'READ_STATE_UPDATE', { channelId: access.channel.id, lastReadId: lastId, mentionCount: 0 });
    return { ok: true };
  });

  // "Mark Unread" on a message: the channel counts as read up to the message before it, so that message and everything after it is new again.
  // The server works out the message before (the client may not have loaded it) and how many of the messages from there on mention you.
  r.post('/api/channels/:id/unread', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { messageId } = z.object({ messageId: z.string().min(1).max(40) }).parse(ctx.body || {});
    const target = get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', messageId, access.channel.id);
    if (!target) throw notFound('Unknown message.');
    const before = get('SELECT id FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT 1', access.channel.id, target.id);
    const lastReadId = before?.id || '0000000000000000000';
    let mentionCount = 0;
    const others = all('SELECT mentions, mention_roles, mention_everyone FROM messages WHERE channel_id = ? AND id > ? AND author_id IS NOT ? AND type IN (0, 19) LIMIT 1000', access.channel.id, lastReadId, ctx.user.id);
    if (access.isDM) mentionCount = others.length;
    else {
      const myRoles = new Set(all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', access.channel.guild_id, ctx.user.id).map((x) => x.role_id));
      for (const m of others) {
        if (m.mention_everyone || parseJSON(m.mentions, []).includes(ctx.user.id) || parseJSON(m.mention_roles, []).some((id) => myRoles.has(id))) mentionCount++;
      }
    }
    run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = excluded.mention_count`, ctx.user.id, access.channel.id, lastReadId, mentionCount);
    sendToUser(ctx.user.id, 'READ_STATE_UPDATE', { channelId: access.channel.id, lastReadId, mentionCount });
    return { ok: true, lastReadId, mentionCount };
  });

  r.post('/api/guilds/:id/ack', async (ctx) => {
    const { guild, member } = guildAccess(ctx.params.id, ctx.user.id);
    const chans = getGuildChannels(guild.id).filter((c) => c.lastMessageId && has(computeChannelPermissions(guild, member, c), P.VIEW_CHANNEL));
    tx(() => {
      for (const c of chans) {
        c.readMark = readMarkWithQuiet(ctx.user.id, { id: c.id, last_message_id: c.lastMessageId }, c.lastMessageId);
        run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
             ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`, ctx.user.id, c.id, c.readMark);
      }
    });
    for (const c of chans) sendToUser(ctx.user.id, 'READ_STATE_UPDATE', { channelId: c.id, lastReadId: c.readMark, mentionCount: 0 });
    return { ok: true };
  });

  // ---- search ----
  function buildFts(q) {
    const terms = String(q || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
    return terms.slice(0, 10).map((t) => `"${t}"*`).join(' AND ');
  }

  function search(ctx, channelIds) {
    if (!channelIds.length) return { total: 0, messages: [] };
    const q = ctx.query;
    const where = [`m.channel_id IN (${channelIds.map(() => '?').join(',')})`];
    const vals = [...channelIds];
    const fts = buildFts(q.content);
    if (fts) { where.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'); vals.push(fts); }
    if (q.authorId) { where.push('m.author_id = ?'); vals.push(String(q.authorId)); }
    if (q.mentions) { where.push('m.mentions LIKE ?'); vals.push(`%"${String(q.mentions).replace(/[^0-9]/g, '')}"%`); }
    if (q.pinned === 'true') where.push('m.pinned = 1');
    if (q.before) { where.push('m.created_at < ?'); vals.push(Number(q.before)); }
    if (q.after) { where.push('m.created_at > ?'); vals.push(Number(q.after)); }
    for (const h of String(q.has || '').split(',').filter(Boolean)) {
      if (h === 'link') where.push("(m.content LIKE '%http://%' OR m.content LIKE '%https://%')");
      if (h === 'file') where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');
      if (h === 'image') where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')");
      if (h === 'video') where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'video/%')");
      if (h === 'embed') where.push("m.embeds != '[]'");
    }
    where.push('m.type IN (0, 19)');
    const offset = Math.max(Number(q.offset) || 0, 0);
    const sql = `FROM messages m WHERE ${where.join(' AND ')}`;
    const total = get(`SELECT COUNT(*) AS n ${sql}`, ...vals).n;
    const rows = all(`SELECT m.* ${sql} ORDER BY m.id ${q.sort === 'asc' ? 'ASC' : 'DESC'} LIMIT 25 OFFSET ?`, ...vals, offset);
    return { total, messages: serializeMessages(rows) };
  }

  r.get('/api/guilds/:id/messages/search', async (ctx) => {
    enforceRateLimit(`search:${ctx.user.id}`, 20, 60_000);
    const { guild, member } = guildAccess(ctx.params.id, ctx.user.id);
    const chans = getGuildChannels(guild.id).filter((c) => isTextLike(c.type) || c.type === ChannelType.FORUM);
    const allowed = new Set(chans.filter((c) => has(computeChannelPermissions(guild, member, c), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY)).map((c) => c.id));
    const threadRows = all('SELECT id, parent_id FROM channels WHERE guild_id = ? AND type = ?', guild.id, ChannelType.THREAD).filter((t) => allowed.has(t.parent_id));
    const forumIds = new Set(chans.filter((c) => c.type === ChannelType.FORUM).map((c) => c.id));
    let ids = [...[...allowed].filter((id) => !forumIds.has(id)), ...threadRows.map((t) => t.id)];
    if (ctx.query.channelId) {
      const want = String(ctx.query.channelId);
      // (searching "in" a forum searches all of its posts)
      ids = forumIds.has(want) ? threadRows.filter((t) => t.parent_id === want).map((t) => t.id) : ids.filter((id) => id === want);
    }
    return search(ctx, ids);
  });

  r.get('/api/channels/:id/messages-search', async (ctx) => {
    enforceRateLimit(`search:${ctx.user.id}`, 20, 60_000);
    const access = channelAccess(ctx.params.id, ctx.user.id);
    if (!canSeeHistory(access)) return { total: 0, messages: [] };
    return search(ctx, [access.channel.id]);
  });

  // ---- mentions inbox ----
  r.get('/api/users/@me/mentions', async (ctx) => {
    const rows = all(`SELECT m.* FROM messages m WHERE (m.mentions LIKE ? OR m.mention_everyone = 1) AND m.author_id != ? ORDER BY m.id DESC LIMIT 200`, `%"${ctx.user.id}"%`, ctx.user.id);
    const ok = [];
    const cache = new Map();
    for (const m of rows) {
      if (!cache.has(m.channel_id)) { try { cache.set(m.channel_id, channelAccess(m.channel_id, ctx.user.id)); } catch { cache.set(m.channel_id, null); } }
      const acc = cache.get(m.channel_id);
      if (acc && !acc.isDM && canSeeHistory(acc)) ok.push(m);
      if (ok.length >= 40) break;
    }
    return serializeMessages(ok).map((msg) => {
      const ch = getChannelRow(msg.channelId);
      return { ...msg, guildId: ch?.guild_id || null, channelName: ch?.name || null };
    });
  });

  // ---- GIF search proxy (GIPHY) ----
  r.get('/api/gifs/search', async (ctx) => {
    enforceRateLimit(`gif:${ctx.user.id}`, 40, 60_000);
    if (!config.giphyKey) return { configured: false, results: [] };
    const q = String(ctx.query.q || '').slice(0, 100);
    const endpoint = q ? 'search' : 'trending';
    const url = `https://api.giphy.com/v1/gifs/${endpoint}?api_key=${encodeURIComponent(config.giphyKey)}&limit=30&rating=pg-13${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const json = await res.json();
      return {
        configured: true,
        results: (json.data || []).map((g) => ({
          id: g.id,
          title: g.title,
          url: g.images?.original?.url?.split('?')[0],
          preview: g.images?.fixed_width?.url?.split('?')[0] || g.images?.original?.url,
          width: Number(g.images?.fixed_width?.width) || 200,
          height: Number(g.images?.fixed_width?.height) || 150,
        })).filter((g) => g.url),
      };
    } catch (e) {
      return { configured: true, results: [], error: 'GIF search is unavailable right now.' };
    }
  });

  void idToTimestamp; void getMember; void getGuildCore; void getUserRow; void parseJSON;
}

function requirePermLocal(perms, flag, msg) {
  if ((perms & flag) !== flag) throw forbidden(msg);
}
