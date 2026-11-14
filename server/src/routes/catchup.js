// The catch-up card: "while you were gone" for one server. Worked out from what the person has not read yet, per channel they
// can see: how much was said and by whom, one message that stood out, where they were mentioned, what was pinned, and the quiet
// replies waiting for them. Nothing is stored and nothing is marked read by asking.
//
//   - Only channels the person can read, never muted ones, never people they have blocked (or who blocked them).
//   - "Unread" starts at their read mark; in a channel they never opened it starts when they joined. Never more than 14 days back.
//   - Bots' messages count as activity only when they mention the person: a busy bot is not a conversation.
import { get, all, parseJSON } from '../db.js';
import { enforceRateLimit } from '../lib/http.js';
import { guildAccess, getGuildChannels, publicUser, isBlockedEitherWay, DELETED_USER } from '../models.js';
import { quietWaiting, serializeQuiet } from './quiet.js';
import { P, has, isTextLike, computeChannelPermissions } from '../../../shared/permissions.js';

const WINDOW_MS = 14 * 86_400_000;
const PER_CHANNEL = 400;      // unread messages looked at per channel (more than this is shown as "400+")
const idFloor = (ms) => String(Math.max(0, Math.floor(ms))).padStart(13, '0') + '000000';   // ids start with their time in ms
/** A message's words as plain text for the card: mentions become names (as stored they are ids), then cut to a line or two. */
function snippet(t, guildId) {
  let s = String(t || '');
  if (s.includes('<')) {
    s = s.replace(/<@!?(\d{1,25})>/g, (_, id) => {
      const nick = guildId && get('SELECT nick FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, id)?.nick;
      const u = nick ? null : get('SELECT username, display_name FROM users WHERE id = ?', id);
      return '@' + (nick || u?.display_name || u?.username || 'someone');
    }).replace(/<@&(\d{1,25})>/g, (_, id) => '@' + (get('SELECT name FROM roles WHERE id = ?', id)?.name || 'role'))
      .replace(/<#(\d{1,25})>/g, (_, id) => '#' + (get('SELECT name FROM channels WHERE id = ? AND guild_id = ?', id, guildId)?.name || 'channel'))
      .replace(/<a?:([a-zA-Z0-9_]{2,32}):\d{1,25}>/g, ':$1:');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

//   seen: channel id -> the read mark the person's app had just before it opened that channel (opening a channel marks it read
//   a moment before this is asked for). It can only move the start of "unread" back, never past what the person may read anyway.
export function catchUp(guildId, userId, seen = new Map()) {
  const { guild, member } = guildAccess(guildId, userId);
  const now = Date.now();
  const floor = idFloor(Math.max(now - WINDOW_MS, member.joinedAt || 0));
  const settings = get('SELECT muted, channel_overrides FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', userId, guildId);
  const overrides = parseJSON(settings?.channel_overrides, {}) || {};
  const myRoles = new Set(member.roles || []);
  const blocked = new Map();
  const isBlocked = (id) => { if (!blocked.has(id)) blocked.set(id, isBlockedEitherWay(userId, id)); return blocked.get(id); };
  const users = new Map();
  const userOf = (id) => {
    if (!id) return DELETED_USER;
    if (!users.has(id)) users.set(id, get('SELECT * FROM users WHERE id = ?', id) || null);
    const u = users.get(id);
    return u ? publicUser(u) : DELETED_USER;
  };
  const isBot = (id) => { userOf(id); return !!users.get(id)?.bot; };

  const channels = [], mentions = [], pins = [], quiet = [];
  let total = 0, oldest = null;
  for (const c of getGuildChannels(guildId)) {
    if (!isTextLike(c.type)) continue;
    if (overrides[c.id]?.muted || (c.parentId && overrides[c.parentId]?.muted)) continue;
    const perms = computeChannelPermissions(guild, member, c);
    if (!has(perms, P.VIEW_CHANNEL) || !has(perms, P.READ_MESSAGE_HISTORY)) continue;
    const rs = get('SELECT last_read_id FROM read_states WHERE user_id = ? AND channel_id = ?', userId, c.id);
    const mark = seen.has(c.id) && (!rs?.last_read_id || seen.get(c.id) < rs.last_read_id) ? seen.get(c.id) : rs?.last_read_id;
    const from = mark && mark > floor ? mark : floor;

    // Quiet replies waiting here (they are not part of the channel's ordinary messages).
    for (const q of serializeQuiet(quietWaiting(userId, c.id, from))) {
      if (isBlocked(q.author.id)) continue;
      quiet.push({ id: q.id, channelId: c.id, author: q.author, content: snippet(q.content, guildId), createdAt: q.createdAt });
    }
    if (!c.lastMessageId || c.lastMessageId <= from) continue;

    const rows = all(`SELECT id, author_id, content, type, reply_to_id, mentions, mention_roles, mention_everyone, created_at, pinned,
        (SELECT COUNT(*) FROM reactions r WHERE r.message_id = m.id) AS reacts
      FROM messages m WHERE channel_id = ? AND id > ? AND author_id IS NOT ? AND type IN (0, 19, 6) ORDER BY id ASC LIMIT ?`, c.id, from, userId, PER_CHANNEL + 1);
    const capped = rows.length > PER_CHANNEL;
    if (capped) rows.length = PER_CHANNEL;
    const people = new Map();    // author id -> messages
    const answers = new Map();   // message id -> replies it got in this stretch
    let count = 0, first = null, best = null;
    for (const m of rows) {
      if (!m.author_id || isBlocked(m.author_id)) continue;
      if (m.type === 6) {   // "pinned a message": the pin itself, if it is still pinned
        const p = m.reply_to_id && get('SELECT id, author_id, content FROM messages WHERE id = ? AND channel_id = ? AND pinned = 1', m.reply_to_id, c.id);
        if (p && !pins.some((x) => x.id === p.id)) pins.push({ id: p.id, channelId: c.id, author: userOf(p.author_id), content: snippet(p.content, guildId), by: userOf(m.author_id), createdAt: m.created_at });
        continue;
      }
      const mine = parseJSON(m.mentions, []).includes(userId) || parseJSON(m.mention_roles, []).some((r) => myRoles.has(r));
      if (mine || m.mention_everyone) mentions.push({ id: m.id, channelId: c.id, author: userOf(m.author_id), content: snippet(m.content, guildId), createdAt: m.created_at, everyone: !mine });
      if (isBot(m.author_id) && !mine) continue;
      count++;
      first ??= m;
      people.set(m.author_id, (people.get(m.author_id) || 0) + 1);
      if (m.reply_to_id) answers.set(m.reply_to_id, (answers.get(m.reply_to_id) || 0) + 1);
    }
    if (!count) continue;
    // The message that stood out: the most reactions and answers (at least two between them), newest wins a tie.
    for (const m of rows) {
      if (m.type === 6 || !m.content || !m.author_id || isBlocked(m.author_id) || isBot(m.author_id)) continue;
      const score = m.reacts + (answers.get(m.id) || 0);
      if (score >= 2 && (!best || score >= best.score)) best = { score, m };
    }
    total += count;
    if (!oldest || first.created_at < oldest) oldest = first.created_at;
    channels.push({
      id: c.id, count, capped,
      people: [...people.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => userOf(id)),
      peopleCount: people.size,
      firstUnreadId: first.id,
      highlight: best ? { id: best.m.id, author: userOf(best.m.author_id), content: snippet(best.m.content, guildId), reactions: best.m.reacts, replies: answers.get(best.m.id) || 0 } : null,
    });
  }
  channels.sort((a, b) => b.count - a.count);
  const byNewest = (a, b) => b.createdAt - a.createdAt;
  const direct = mentions.filter((m) => !m.everyone);
  return {
    guildId,
    since: oldest,
    total,
    channelCount: channels.length,
    channels: channels.slice(0, 5),
    mentions: (direct.length ? direct : mentions).sort(byNewest).slice(0, 5),
    mentionCount: direct.length || mentions.length,
    pins: pins.sort(byNewest).slice(0, 5),
    quiet: quiet.sort(byNewest).slice(0, 5),
    quietCount: quiet.length,
    // Worth showing without being asked: a real backlog, or something addressed to the person on top of a little one.
    worth: total >= 15 || quiet.length > 0 || ((direct.length > 0 || pins.length > 0) && total >= 5),
  };
}

export default function register(r) {
  r.get('/api/guilds/:id/catchup', async (ctx) => {
    enforceRateLimit(`catchup:${ctx.user.id}`, 30, 60_000, 'Slow down a little.');
    const seen = new Map();
    for (const part of String(ctx.query.seen || '').split(',').slice(0, 20)) {
      const m = /^(\d{1,25}):(\d{1,25})$/.exec(part);
      if (m) seen.set(m[1], m[2] === '0' ? '' : m[2]);
    }
    return catchUp(ctx.params.id, ctx.user.id, seen);
  });
}
