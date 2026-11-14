// Data access + serialization helpers shared by routes and the realtime gateway.
import { isAdmin, isPlainMod, isDevJr } from './lib/admin.js';
import { get, all, parseJSON } from './db.js';
import { pollsFor } from './lib/polls.js';
import { computeChannelPermissions, computeBasePermissions, ChannelType, P, has } from '../../shared/permissions.js';
import { notFound, forbidden } from './lib/http.js';
import { sanitizeProfileTheme, sanitizeNameStyle, sanitizeDecoration, sanitizeProfileEffect, ADMIN_DECORATION_ID } from '../../shared/perks.js';
import { levelFor, boostLevelFor } from '../../shared/levels.js';
import { validBirthday } from '../../shared/daytime.js';
import { safetyOf } from './lib/pause.js';
import { wornTag, tagFromRow } from './lib/servertag.js';

// ---- users -----------------------------------------------------------------
/** What decoration a user wears. A custom design or a ready-made one is shown as saved. The Admin
 *  Crest is honoured only for the site admin (so it can never be faked), and it is the admin's
 *  default until they choose something else; an empty string means they chose "none" on purpose. */
export function decorationOf(u) {
  const raw = u.avatar_decoration;
  if (raw == null) return isAdmin(u) ? ADMIN_DECORATION_ID : null;
  const d = sanitizeDecoration(raw);
  return d === ADMIN_DECORATION_ID && !isAdmin(u) ? null : d;
}

/** A person's own join and leave sounds: { join, leave }, each the address of a sound file or null. */
export function voiceSoundsOf(u) {
  const v = parseJSON(u?.voice_sounds, null) || {};
  const ok = (x) => (typeof x === 'string' && /^\/uploads\/voicesounds\/[a-f0-9]{32}\.wav$/.test(x) ? x : null);
  return { join: ok(v.join), leave: ok(v.leave) };
}

/** A person's profile song: { url, title } or null. */
export function profileSongOf(u) {
  const v = parseJSON(u?.profile_song, null);
  if (!v || typeof v.url !== 'string' || !/^\/uploads\/profilesongs\/[a-f0-9]{32}\.wav$/.test(v.url)) return null;
  return { url: v.url, title: typeof v.title === 'string' ? v.title.slice(0, 60) : '' };
}

/** A person's birthday as they saved it ({ month, day, announce, profile }), or null. Never a year. */
export function birthdayOf(u) {
  const b = parseJSON(u?.birthday, null);
  return validBirthday(b) ? { month: b.month, day: b.day, announce: !!b.announce, profile: !!b.profile } : null;
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || null,
    avatar: u.avatar || null,
    banner: u.banner || null,
    bio: u.bio || '',
    pronouns: u.pronouns || '',
    accentColor: u.accent_color || null,
    // Profile extras (free for everyone). Re-sanitized on the way out as a second safety net.
    profileTheme: sanitizeProfileTheme(parseJSON(u.profile_theme, null)),
    nameStyle: sanitizeNameStyle(parseJSON(u.name_style, null)),
    avatarDecoration: decorationOf(u),
    profileEffect: sanitizeProfileEffect(u.profile_effect),
    level: u.bot || parseJSON(u.settings, {}).privacy?.hideLevel ? null : levelFor(u.xp),
    // A bot is an account too; the client shows a BOT badge and skips friend / DM actions for it.
    ...(u.bot ? { bot: true } : {}),
    // An incoming webhook's sender is a bot account of a special kind (bot = 2): shown with a WEBHOOK badge and no profile to open.
    ...(u.bot === 2 ? { webhook: true } : {}),
    isMod: isPlainMod(u),   // (always present, so that a demotion replaces an old "true" on screens that merge updates)
    isDevJr: isDevJr(u),
    serverTag: wornTag(u),   // the tag of a server they chose to wear, or null (left out when the row doesn't say, so a partial query never wipes it)
    // Their birthday (day and month), only when they chose to show it on their profile.
    ...('birthday' in u ? { birthday: (() => { const b = birthdayOf(u); return b && b.profile ? { month: b.month, day: b.day } : null; })() } : {}),   // (left out when the row doesn't say, like the tag)
    // Their own join and leave sounds for voice channels (left out when the row doesn't say).
    ...('voice_sounds' in u ? { voiceSounds: voiceSoundsOf(u) } : {}),
    // A short clip of music that plays for someone who opens their profile (left out when the row doesn't say).
    ...('profile_song' in u ? { profileSong: profileSongOf(u) } : {}),
    createdAt: u.created_at,
  };
}

export function privateUser(u) {
  return {
    ...publicUser(u),
    birthday: birthdayOf(u),   // (their own: with the two choices)
    email: u.email,
    emailVerified: !!u.email_verified,
    mfaEnabled: !!u.mfa_enabled,
    status: u.status,
    customStatus: activeCustomStatus(u),
    onboarded: !!u.onboarded,
    isAdmin: isAdmin(u),
  };
}

export function activeCustomStatus(u) {
  const cs = parseJSON(u.custom_status, null);
  if (!cs) return null;
  if (cs.expiresAt && cs.expiresAt < Date.now()) return null;
  return cs;
}

export const getUserRow = (id) => get('SELECT * FROM users WHERE id = ?', id);
export const getUser = (id) => publicUser(getUserRow(id));

export const DELETED_USER = { id: '0', username: 'deleted_user', displayName: 'Deleted User', avatar: null, banner: null, bio: '', pronouns: '', accentColor: null, createdAt: 0 };

// ---- relationships -----------------------------------------------------------
export function relationshipType(userId, otherId) {
  return get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId)?.type || 0;
}
export function isBlockedEitherWay(a, b) {
  return !!get('SELECT 1 FROM relationships WHERE type = 2 AND ((user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?))', a, b, b, a);
}
export function friendIds(userId) {
  return all('SELECT other_id FROM relationships WHERE user_id = ? AND type = 1', userId).map((r) => r.other_id);
}

// ---- guilds ------------------------------------------------------------------
export function serializeRole(r) {
  return { id: r.id, guildId: r.guild_id, name: r.name, color: r.color, permissions: r.permissions, position: r.position, hoist: !!r.hoist, mentionable: !!r.mentionable };
}

export function serializeChannel(c, overwrites) {
  const ow = overwrites ?? all('SELECT * FROM channel_overwrites WHERE channel_id = ?', c.id);
  const out = {
    id: c.id,
    guildId: c.guild_id,
    type: c.type,
    name: c.name,
    topic: c.topic || '',
    position: c.position,
    parentId: c.parent_id,
    nsfw: !!c.nsfw,
    rateLimit: c.rate_limit,
    userLimit: c.user_limit,
    bitrate: c.bitrate,
    ownerId: c.owner_id,
    icon: c.icon,
    lastMessageId: c.last_message_id,
    createdAt: c.created_at,
    overwrites: ow.map((o) => ({ id: o.target_id, type: o.target_type, allow: o.allow, deny: o.deny })),
  };
  if (c.type === ChannelType.THREAD) {
    out.messageId = c.message_id;
    out.archived = !!c.archived;
    out.locked = !!c.locked;
    out.pinned = !!c.pinned_at;   // (a pinned post of a forum stays at the top of its list)
    out.messageCount = c.message_count;
    if (c.applied_tags != null) out.appliedTags = parseJSON(c.applied_tags, []);   // (only posts in a forum channel have tags)
  }
  if (c.type === ChannelType.VOICE) {   // (a mood room: routes/mood.js)
    out.mood = c.mood || null;
    out.moodLocked = !!c.mood_locked;
    out.musicLocked = !!c.music_locked;   // (the shared music queue: routes/music.js)
  }
  if (c.type === ChannelType.FORUM) {
    out.availableTags = parseJSON(c.available_tags, []);
    out.forumSort = c.forum_sort || 0;
    out.requireTag = !!c.require_tag;
  }
  return out;
}

export function getMember(guildId, userId) {
  const m = get('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);
  if (!m) return null;
  return serializeMember(m, all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', guildId, userId).map((r) => r.role_id));
}

export function serializeMember(m, roles) {
  return { guildId: m.guild_id, userId: m.user_id, nick: m.nick || null, avatar: m.avatar || null, roles, joinedAt: m.joined_at, timeoutUntil: m.timeout_until && m.timeout_until > Date.now() ? m.timeout_until : null };
}

export function getGuildCore(guildId) {
  const g = get('SELECT * FROM guilds WHERE id = ?', guildId);
  if (!g) return null;
  const boostCount = get('SELECT COUNT(*) AS n FROM guild_boosts WHERE guild_id = ?', guildId).n;
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    banner: g.banner,
    description: g.description || '',
    ownerId: g.owner_id,
    discoverable: !!g.discoverable,
    verificationLevel: g.verification_level,
    safety: safetyOf(g),
    tag: tagFromRow(g),
    systemChannelId: g.system_channel_id,
    birthdayChannelId: g.birthday_channel_id || null,
    voiceSoundsOff: !!g.voice_sounds_off,   // (this server plays the standard sound for everyone)
    automod: parseJSON(g.automod, {}),
    boostCount,
    boostLevel: boostLevelFor(boostCount),
    createdAt: g.created_at,
    roles: all('SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC', guildId).map(serializeRole),
  };
}

export function getGuildChannels(guildId) {
  const chans = all('SELECT * FROM channels WHERE guild_id = ? AND type != ? ORDER BY position, created_at', guildId, ChannelType.THREAD);
  const ows = all('SELECT o.* FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ?', guildId);
  const byChan = new Map();
  for (const o of ows) { if (!byChan.has(o.channel_id)) byChan.set(o.channel_id, []); byChan.get(o.channel_id).push(o); }
  return chans.map((c) => serializeChannel(c, byChan.get(c.id) || []));
}

export function getGuildMembers(guildId) {
  const members = all('SELECT * FROM guild_members WHERE guild_id = ?', guildId);
  const roleRows = all('SELECT user_id, role_id FROM member_roles WHERE guild_id = ?', guildId);
  const roleMap = new Map();
  for (const r of roleRows) { if (!roleMap.has(r.user_id)) roleMap.set(r.user_id, []); roleMap.get(r.user_id).push(r.role_id); }
  return members.map((m) => serializeMember(m, roleMap.get(m.user_id) || []));
}

export function getGuildEmojis(guildId) {
  return all('SELECT * FROM emojis WHERE guild_id = ? ORDER BY name', guildId).map(serializeEmoji);
}
export function getGuildStickers(guildId) {
  return all('SELECT * FROM stickers WHERE guild_id = ? ORDER BY name', guildId).map(serializeSticker);
}
export function serializeSticker(s) {
  return { id: s.id, guildId: s.guild_id, name: s.name, tag: s.tag || '', animated: !!s.animated, url: `/uploads/stickers/${s.stored_name}` };
}
export function serializeEmoji(e) {
  return { id: e.id, guildId: e.guild_id, name: e.name, animated: !!e.animated, url: `/uploads/emojis/${e.stored_name}` };
}

/** Full guild payload as seen by a specific user (private channels filtered out). */
export function guildPayloadFor(guildId, userId) {
  const core = getGuildCore(guildId);
  if (!core) return null;
  const members = getGuildMembers(guildId);
  const me = members.find((m) => m.userId === userId);
  if (!me) return null;
  const channels = getGuildChannels(guildId);
  const visible = channels.filter((c) => c.type === ChannelType.CATEGORY
    ? true
    : has(computeChannelPermissions(core, me, c), P.VIEW_CHANNEL));
  // Hide empty categories the user can't see into unless they can view the category itself.
  const visibleCats = visible.filter((c) => c.type === ChannelType.CATEGORY && (
    has(computeChannelPermissions(core, me, c), P.VIEW_CHANNEL) || visible.some((v) => v.parentId === c.id)));
  const finalChannels = visible.filter((c) => c.type !== ChannelType.CATEGORY || visibleCats.includes(c));
  const visibleIds = new Set(finalChannels.map((c) => c.id));
  // (the posts of a forum channel are listed by the forum itself, a page at a time: a busy forum has far too many to send with the server)
  const forumIds = new Set(finalChannels.filter((c) => c.type === ChannelType.FORUM).map((c) => c.id));
  const threads = all('SELECT * FROM channels WHERE guild_id = ? AND type = ? AND archived = 0', guildId, ChannelType.THREAD)
    .filter((t) => visibleIds.has(t.parent_id) && !forumIds.has(t.parent_id)).map((t) => serializeChannel(t, []));
  // The server's own invite link is shown to the people who may invite (everyone else could not make an invite either).
  const base = computeBasePermissions(core, me);
  const vanity = get('SELECT vanity_code FROM guilds WHERE id = ?', guildId)?.vanity_code || null;
  return {
    ...core,
    vanityCode: vanity && (has(base, P.CREATE_INVITE) || has(base, P.MANAGE_GUILD)) ? vanity : null,
    channels: finalChannels,
    threads,
    members,
    emojis: getGuildEmojis(guildId),
    stickers: getGuildStickers(guildId),
    memberCount: members.length,
  };
}

export function userGuildIds(userId) {
  return all('SELECT guild_id FROM guild_members WHERE user_id = ?', userId).map((r) => r.guild_id);
}
export function guildMemberIds(guildId) {
  return all('SELECT user_id FROM guild_members WHERE guild_id = ?', guildId).map((r) => r.user_id);
}

// ---- channels & permissions ---------------------------------------------------
export function getChannelRow(id) { return get('SELECT * FROM channels WHERE id = ?', id); }

/**
 * Resolve a channel and the caller's permissions in it.
 * For DMs: full messaging perms if the user is a recipient.
 * Throws 404 if the channel does not exist or cannot be seen.
 */
export function channelAccess(channelId, userId) {
  const row = getChannelRow(channelId);
  if (!row) throw notFound('Unknown channel.');
  if (!row.guild_id) {
    const rec = get('SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?', channelId, userId);
    if (!rec) throw notFound('Unknown channel.');
    const perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES |
      P.EMBED_LINKS | P.CONNECT | P.SPEAK | P.STREAM | P.USE_EXTERNAL_EMOJIS | P.CREATE_THREADS | P.SEND_MESSAGES_IN_THREADS;
    return { channel: row, guild: null, member: null, perms, isDM: true };
  }
  const guild = getGuildCore(row.guild_id);
  const member = getMember(row.guild_id, userId);
  if (!member) throw notFound('Unknown channel.');
  let permChannel = row;
  if (row.type === ChannelType.THREAD) permChannel = getChannelRow(row.parent_id) || row;
  const perms = computeChannelPermissions(guild, member, serializeChannel(permChannel));
  if (!has(perms, P.VIEW_CHANNEL)) throw notFound('Unknown channel.');
  return { channel: row, guild, member, perms, isDM: false };
}

/**
 * What a webhook may do in a channel. A webhook is added by someone with Manage Server, so (like a bot's own messages) it is not held to
 * the channel's send rule or slowmode; it can't ping @everyone, and can only ping roles that are set to be mentionable.
 */
export function webhookAccess(channelId) {
  const row = getChannelRow(channelId);
  const guild = row?.guild_id && getGuildCore(row.guild_id);
  if (!row || !guild) throw notFound('Unknown channel.');
  const perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.SEND_MESSAGES_IN_THREADS | P.READ_MESSAGE_HISTORY | P.EMBED_LINKS;
  return { channel: row, guild, member: null, perms, isDM: false };
}

export function requirePerm(perms, flag, msg) {
  if (!has(perms, flag)) throw forbidden(msg);
}

export function guildAccess(guildId, userId) {
  const guild = getGuildCore(guildId);
  if (!guild) throw notFound('Unknown server.');
  const member = getMember(guildId, userId);
  if (!member) throw notFound('Unknown server.');
  const perms = computeBasePermissions(guild, member);
  return { guild, member, perms };
}

/** Users who can currently view a guild channel (used for realtime fan-out). */
/** Who can see a channel. `only`: when given, people it says no to are left out before anything is worked out for them (cheaper in a big server). */
export function channelViewerIds(channelRow, only = null) {
  if (!channelRow.guild_id) {
    const ids = all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channelRow.id).map((r) => r.user_id);
    return only ? ids.filter(only) : ids;
  }
  const guild = getGuildCore(channelRow.guild_id);
  const permRow = channelRow.type === ChannelType.THREAD ? (getChannelRow(channelRow.parent_id) || channelRow) : channelRow;
  const chan = serializeChannel(permRow);
  return getGuildMembers(channelRow.guild_id)
    .filter((m) => (!only || only(m.userId)) && has(computeChannelPermissions(guild, m, chan), P.VIEW_CHANNEL))
    .map((m) => m.userId);
}

// ---- private channels (DMs / group DMs) ------------------------------------
export function serializePrivateChannel(row, viewerId) {
  const recips = all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', row.id).map((r) => r.user_id);
  return {
    id: row.id,
    type: row.type,
    name: row.name || null,
    icon: row.icon || null,
    ownerId: row.owner_id,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at,
    recipients: recips.filter((id) => id !== viewerId),
  };
}

// ---- messages ---------------------------------------------------------------
export function serializeAttachment(a) {
  return {
    id: a.id,
    filename: a.filename,
    size: a.size,
    contentType: a.content_type,
    spoiler: !!a.spoiler,
    description: a.description || null,
    url: `/uploads/attachments/${a.stored_name}`,
  };
}

/** Serialize a list of message rows with authors, attachments, reactions, replies and threads. */
export function serializeMessages(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const atts = all(`SELECT * FROM attachments WHERE message_id IN (${ph})`, ...ids);
  const reacts = all(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`, ...ids);
  const threads = all(`SELECT id, name, message_count, archived, message_id, last_message_id FROM channels WHERE message_id IN (${ph}) AND type = ${ChannelType.THREAD}`, ...ids);
  const polls = pollsFor(ids);
  // the sticker a message was sent with: its picture while the server still has it, otherwise just its name
  const stickerRows = new Map();
  const stickerIds = [...new Set(rows.flatMap((r) => (r.stickers ? parseJSON(r.stickers, []) : []).map((x) => x.id)))];
  if (stickerIds.length) for (const x of all(`SELECT * FROM stickers WHERE id IN (${stickerIds.map(() => '?').join(',')})`, ...stickerIds)) stickerRows.set(x.id, serializeSticker(x));
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
  const replies = replyIds.length
    ? all(`SELECT id, author_id, content, channel_id, forward IS NOT NULL AS forwarded, (stickers IS NOT NULL AND stickers != '[]') AS sticker FROM messages WHERE id IN (${replyIds.map(() => '?').join(',')})`, ...replyIds)
    : [];
  const userIds = new Set(rows.map((r) => r.author_id).filter(Boolean));
  replies.forEach((r) => r.author_id && userIds.add(r.author_id));
  const interactions = new Map(); // message id -> { name, userId, pending }: a bot's answer to a slash command
  for (const r of rows) {
    if (!r.interaction) continue;
    const it = parseJSON(r.interaction, null);
    if (!it) continue;
    interactions.set(r.id, it);
    if (it.userId) userIds.add(it.userId);
  }
  const users = new Map();
  if (userIds.size) {
    const list = [...userIds];
    for (const u of all(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')})`, ...list)) users.set(u.id, publicUser(u));
  }
  const replyMap = new Map(replies.map((r) => [r.id, r]));
  return rows.map((r) => {
    const reactionMap = new Map();
    for (const x of reacts) {
      if (x.message_id !== r.id) continue;
      if (!reactionMap.has(x.emoji)) reactionMap.set(x.emoji, []);
      reactionMap.get(x.emoji).push(x.user_id);
    }
    const ref = r.reply_to_id ? replyMap.get(r.reply_to_id) : null;
    const thread = threads.find((t) => t.message_id === r.id);
    const it = interactions.get(r.id);
    let author = users.get(r.author_id) || DELETED_USER;
    if (r.webhook && author.webhook) {   // sent through a webhook: the name and picture it was sent with, when it gave any
      const w = parseJSON(r.webhook, {});
      author = { ...author, ...(w.name ? { displayName: w.name } : {}), ...(w.avatar ? { avatar: w.avatar } : {}) };
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      author,
      content: r.content,
      type: r.type,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      pinned: !!r.pinned,
      mentions: parseJSON(r.mentions, []),
      mentionRoles: parseJSON(r.mention_roles, []),
      mentionEveryone: !!r.mention_everyone,
      embeds: parseJSON(r.embeds, []),
      components: parseJSON(r.components, []),   // a bot's buttons and menus (rows)
      forward: r.forward ? parseJSON(r.forward, null) : null,
      crosspost: r.crosspost ? parseJSON(r.crosspost, null) : null,   // a published announcement copied in from another server
      published: !!r.published_at,                                      // an announcement that was sent on to the servers following its channel
      attachments: atts.filter((a) => a.message_id === r.id).map(serializeAttachment),
      poll: polls.get(r.id) || null,
      stickers: (r.stickers ? parseJSON(r.stickers, []) : []).map((x) => stickerRows.get(x.id) || { id: x.id, name: x.name, removed: true }),
      interaction: it ? { name: it.name, label: it.label || null, user: users.get(it.userId) || DELETED_USER, pending: !!it.pending } : null,
      reactions: [...reactionMap.entries()].map(([emoji, users]) => ({ emoji, users, count: users.length })),
      replyTo: r.reply_to_id
        ? (ref ? { id: ref.id, author: users.get(ref.author_id) || DELETED_USER, content: ref.content.slice(0, 200), ...(ref.forwarded ? { forwarded: true } : {}), ...(ref.sticker ? { sticker: true } : {}) } : { id: r.reply_to_id, deleted: true })
        : null,
      thread: thread ? { id: thread.id, name: thread.name, messageCount: thread.message_count, archived: !!thread.archived, lastMessageId: thread.last_message_id } : null,
    };
  });
}

export function getMessage(id) {
  const row = get('SELECT * FROM messages WHERE id = ?', id);
  return row ? serializeMessages([row])[0] : null;
}
