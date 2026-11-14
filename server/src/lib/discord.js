// Discord-shaped data. NullChat keeps its own formats everywhere else; this file is the one place that knows what Discord's look like, so the
// REST layer (routes/discord.js) and the gateway (discordGateway.js) describe things the same way.
//
// What this is for: letting a bot written with a Discord library (discord.js, discord.py, JDA, ...) run against NullChat with a changed
// address and token. See docs/DISCORD_BOTS.md for what is and is not covered.
import { get, all, parseJSON } from '../db.js';
import { getUserRow, publicUser, getGuildCore, getMember, getChannelRow, serializeChannel } from '../models.js';
import { P, ChannelType, computeChannelPermissions } from '../../../shared/permissions.js';
import { bad } from './http.js';

export const DISCORD_VERSION = 10;
export const DISCORD_GATEWAY_PATH = '/discord-gateway';

// ---- permissions -------------------------------------------------------------------------------------------------------------------------
// NullChat's permission bits are not Discord's, so every permission set is translated. Discord's are 64-bit numbers sent as strings.
const BIT = (n) => 1n << BigInt(n);
const PERMISSION_PAIRS = [
  [P.CREATE_INVITE, 0], [P.KICK_MEMBERS, 1], [P.BAN_MEMBERS, 2], [P.ADMINISTRATOR, 3], [P.MANAGE_CHANNELS, 4], [P.MANAGE_GUILD, 5],
  [P.ADD_REACTIONS, 6], [P.VIEW_AUDIT_LOG, 7], [P.PRIORITY_SPEAKER, 8], [P.STREAM, 9], [P.VIEW_CHANNEL, 10], [P.SEND_MESSAGES, 11],
  [P.MANAGE_MESSAGES, 13], [P.EMBED_LINKS, 14], [P.ATTACH_FILES, 15], [P.READ_MESSAGE_HISTORY, 16], [P.MENTION_EVERYONE, 17],
  [P.USE_EXTERNAL_EMOJIS, 18], [P.CONNECT, 20], [P.SPEAK, 21], [P.MUTE_MEMBERS, 22], [P.DEAFEN_MEMBERS, 23], [P.MOVE_MEMBERS, 24],
  [P.CHANGE_NICKNAME, 26], [P.MANAGE_NICKNAMES, 27], [P.MANAGE_ROLES, 28], [P.MANAGE_EMOJIS, 30], [P.MANAGE_THREADS, 34],
  [P.CREATE_THREADS, 35], [P.SEND_MESSAGES_IN_THREADS, 38], [P.MODERATE_MEMBERS, 40],
];
export const PERMISSION_TABLE = PERMISSION_PAIRS.map(([flag, bit]) => ({ flag, bit }));
const has = (f, flag) => (f & flag) === flag;

/** NullChat permission flags → the string Discord uses. */
export function toDiscordPermissions(flags) {
  const f = Number(flags) || 0;
  let out = 0n;
  for (const [flag, bit] of PERMISSION_PAIRS) if (has(f, flag)) out |= BIT(bit);
  if (has(f, P.SEND_MESSAGES)) out |= BIT(31);          // USE_APPLICATION_COMMANDS: whoever can write can run commands
  if (has(f, P.CREATE_THREADS)) out |= BIT(36);         // CREATE_PRIVATE_THREADS (NullChat has one "create threads")
  return out.toString();
}
/** A Discord permission number or string → NullChat flags (bits NullChat has no use for are dropped). */
export function fromDiscordPermissions(value) {
  let big;
  try { big = BigInt(value ?? 0); } catch { return 0; }
  let out = 0;
  for (const [flag, bit] of PERMISSION_PAIRS) if (big & BIT(bit)) out |= flag;
  return out;
}

// ---- small helpers -----------------------------------------------------------------------------------------------------------------------
export const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const hashOf = (p) => { const m = /\/([^/]+?)(?:\.[a-z0-9]+)?$/i.exec(String(p || '')); return m ? m[1] : null; };
const colorInt = (c) => {
  if (typeof c === 'number') return c;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  return m ? parseInt(m[1], 16) : null;
};
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

/** The address people reach this server at (used for links to pictures and the gateway). */
export function originOfRequest(req, fallback) {
  const h = req?.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.\-:[\]]{1,255}$/i.test(host)) return fallback;
  const proto = String(h['x-forwarded-proto'] || (req?.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

// ---- users, members, roles, channels, emoji, guilds ----------------------------------------------------------------------------------------
/** `u` is NullChat's public user. */
export function toUser(u) {
  if (!u) return null;
  return clean({
    id: u.id, username: u.username, discriminator: '0', global_name: u.displayName || null, avatar: /^https?:/i.test(String(u.avatar || '')) ? null : hashOf(u.avatar),   // (a webhook message's own picture is a plain link, not one of our uploads)
    ...(u.bot ? { bot: true } : {}), system: false, public_flags: 0, banner: null, accent_color: colorInt(u.accentColor),
  });
}
export const userById = (id) => toUser(publicUser(getUserRow(id)));

export function toMember(m, user) {
  return clean({
    user: user ?? undefined, nick: m.nick || null, avatar: null, roles: m.roles || [], joined_at: iso(m.joinedAt),
    premium_since: null, deaf: false, mute: false, flags: 0, pending: false,
    communication_disabled_until: m.timeoutUntil ? iso(m.timeoutUntil) : null,
  });
}

export function toRole(r) {
  return { id: r.id, name: r.name, description: null, permissions: toDiscordPermissions(r.permissions), position: r.position, color: r.color || 0, hoist: !!r.hoist, managed: false, mentionable: !!r.mentionable, icon: null, unicode_emoji: null, flags: 0 };
}

export function toChannel(c) {
  const out = {
    id: c.id, type: c.type, ...(c.guildId ? { guild_id: c.guildId } : {}), name: c.name || null, position: c.position ?? 0, flags: 0,
    permission_overwrites: (c.overwrites || []).map((o) => ({ id: o.id, type: o.type, allow: toDiscordPermissions(o.allow), deny: toDiscordPermissions(o.deny) })),
    parent_id: c.parentId ?? null, nsfw: !!c.nsfw, last_message_id: c.lastMessageId ?? null,
  };
  if (c.type === ChannelType.TEXT || c.type === ChannelType.ANNOUNCEMENT || c.type === ChannelType.FORUM) { out.topic = c.topic || null; out.rate_limit_per_user = c.rateLimit || 0; out.last_pin_timestamp = null; }
  if (c.type === ChannelType.VOICE || c.type === ChannelType.STAGE) { out.bitrate = c.bitrate || 64000; out.user_limit = c.userLimit || 0; out.rtc_region = null; }
  if (c.type === ChannelType.THREAD) {
    out.owner_id = c.ownerId ?? null; out.message_count = c.messageCount || 0; out.member_count = 1; out.rate_limit_per_user = 0;
    out.thread_metadata = { archived: !!c.archived, auto_archive_duration: 1440, archive_timestamp: iso(c.createdAt), locked: !!c.locked };
  }
  return out;
}

const CUSTOM_EMOJI = /^([A-Za-z0-9_]{2,32}):(\d{19})$/;
/** How a reaction's emoji is stored here ("👍" or "name:id") → Discord's { id, name }. */
export const toEmojiRef = (key) => { const m = CUSTOM_EMOJI.exec(String(key || '')); return m ? { id: m[2], name: m[1] } : { id: null, name: String(key || '') }; };
/** Discord's way of writing an emoji in a web address ("👍" or "name:id") is the same as ours. */
export const emojiParam = (raw) => String(raw || '');

export function toEmoji(e) {
  return { id: e.id, name: e.name, roles: [], require_colons: true, managed: false, animated: !!e.animated, available: true };
}

/** `g` is NullChat's guild: the core (roles included) or the full payload with channels, members and emoji. */
export function toGuild(g, { counts = false } = {}) {
  return clean({
    id: g.id, name: g.name, icon: hashOf(g.icon), icon_hash: null, splash: null, discovery_splash: null, owner_id: g.ownerId, afk_channel_id: null, afk_timeout: 300,
    widget_enabled: false, widget_channel_id: null, verification_level: Math.min(4, g.verificationLevel || 0), default_message_notifications: 0, explicit_content_filter: 0,
    roles: (g.roles || []).map(toRole), emojis: (g.emojis || []).map(toEmoji), features: [], mfa_level: 0, application_id: null,
    system_channel_id: g.systemChannelId ?? null, system_channel_flags: 0, rules_channel_id: null, max_presences: null, max_members: 500000,
    vanity_url_code: g.vanityCode || null, description: g.description || null, banner: hashOf(g.banner), premium_tier: g.boostLevel || 0,
    premium_subscription_count: g.boostCount || 0, preferred_locale: 'en-US', public_updates_channel_id: null, safety_alerts_channel_id: null,
    nsfw_level: 0, premium_progress_bar_enabled: false, stickers: [],
    ...(counts ? { approximate_member_count: g.memberCount ?? g.members?.length ?? null, approximate_presence_count: null } : {}),
  });
}

/** The big payload sent when a bot connects (GUILD_CREATE): the guild with its channels and members. */
export function toGuildCreate(payload, botId) {
  const rows = all('SELECT u.* FROM users u JOIN guild_members m ON m.user_id = u.id WHERE m.guild_id = ?', payload.id);
  const users = new Map(rows.map((u) => [u.id, toUser(publicUser(u))]));
  const me = (payload.members || []).find((m) => m.userId === botId);
  return {
    ...toGuild(payload, { counts: false }),
    joined_at: iso(me?.joinedAt ?? payload.createdAt), large: false, unavailable: false, member_count: payload.memberCount ?? payload.members?.length ?? 0,
    voice_states: [], members: (payload.members || []).map((m) => toMember(m, users.get(m.userId))).filter((m) => m.user),
    channels: (payload.channels || []).map(toChannel), threads: [], presences: [], stage_instances: [], guild_scheduled_events: [],
  };
}

// ---- embeds and messages -------------------------------------------------------------------------------------------------------------------
function toEmbed(e) {
  if (!e) return null;
  if (e.type === 'rich') {
    return clean({
      type: 'rich', title: e.title ?? undefined, description: e.description ?? undefined, url: e.url ?? undefined,
      color: e.color ? colorInt(e.color) ?? undefined : undefined, timestamp: e.timestamp ? iso(e.timestamp) : undefined,
      footer: e.footer ? clean({ text: e.footer.text, icon_url: e.footer.iconUrl ?? undefined }) : undefined,
      image: e.image?.url ? { url: e.image.url } : undefined, thumbnail: e.thumbnail?.url ? { url: e.thumbnail.url } : undefined,
      author: e.author ? clean({ name: e.author.name, url: e.author.url ?? undefined, icon_url: e.author.iconUrl ?? undefined }) : undefined,
      fields: e.fields?.length ? e.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })) : undefined,
    });
  }
  // link previews and the like
  if (e.type === 'image') return clean({ type: 'image', url: e.url, thumbnail: e.image?.url ? { url: e.image.url } : undefined });
  if (e.type === 'video') return clean({ type: 'video', url: e.url, title: e.title ?? undefined, thumbnail: e.thumbnail?.url ? { url: e.thumbnail.url } : undefined });
  return clean({
    type: 'link', url: e.url, title: e.title ?? undefined, description: e.description ?? undefined, color: e.color ? colorInt(e.color) ?? undefined : undefined,
    thumbnail: e.thumbnail?.url ? { url: e.thumbnail.url } : undefined, provider: e.siteName ? { name: e.siteName } : undefined,
  });
}

// ---- buttons and menus ---------------------------------------------------------------------------------------------------------------------------
const toDiscordEmoji = (e) => (e ? clean({ name: e.name || undefined, id: e.id || undefined }) : undefined);
function toDiscordComponent(c) {
  if (c.type === 2) {
    return clean({ type: 2, style: c.style, label: c.label || undefined, emoji: toDiscordEmoji(c.emoji), custom_id: c.customId || undefined, url: c.url || undefined, disabled: c.disabled ? true : undefined });
  }
  if (c.type >= 5 && c.type <= 8) {
    return clean({
      type: c.type, custom_id: c.customId, placeholder: c.placeholder || undefined, min_values: c.minValues, max_values: c.maxValues, disabled: c.disabled ? true : undefined,
      default_values: c.defaultValues?.length ? c.defaultValues.map((d) => ({ id: d.id, type: d.type })) : undefined,
      channel_types: c.type === 8 && c.channelTypes?.length ? c.channelTypes : undefined,
    });
  }
  return clean({
    type: 3, custom_id: c.customId, placeholder: c.placeholder || undefined, min_values: c.minValues, max_values: c.maxValues, disabled: c.disabled ? true : undefined,
    options: (c.options || []).map((o) => clean({ label: o.label, value: o.value, description: o.description || undefined, emoji: toDiscordEmoji(o.emoji), default: o.default || undefined })),
  });
}
export const toDiscordRow = (row) => ({ type: 1, components: (row.components || []).map(toDiscordComponent) });

/**
 * A NullChat message as Discord shows it. `o`: { viewerId (who is asking: for "me" on reactions), origin (for links to uploaded files),
 * guildId, withMember (add the author's server profile, as the gateway does), users (a cache shared while turning a list) }.
 */
export function toMessage(m, o = {}) {
  const users = o.users || new Map();
  const lookup = (id) => { if (!users.has(id)) users.set(id, userById(id)); return users.get(id); };
  const guildId = o.guildId ?? m.guildId ?? null;
  const origin = (o.origin || '').replace(/\/$/, '');
  const author = toUser(m.author);
  const out = {
    id: m.id, channel_id: m.channelId, ...(guildId ? { guild_id: guildId } : {}),
    author, content: m.content || '', timestamp: iso(m.createdAt), edited_timestamp: iso(m.editedAt), tts: false,
    mention_everyone: !!m.mentionEveryone, mentions: (m.mentions || []).map(lookup).filter(Boolean), mention_roles: m.mentionRoles || [], mention_channels: [],
    attachments: (m.attachments || []).map((a) => clean({
      id: a.id, filename: a.filename, size: a.size, url: origin + a.url, proxy_url: origin + a.url, content_type: a.contentType || undefined, description: a.description || undefined,
    })),
    embeds: (m.embeds || []).map(toEmbed).filter(Boolean), pinned: !!m.pinned, type: m.interaction ? 20 : (m.type ?? 0), flags: m.ephemeral ? 64 : 0,
    components: (m.components || []).map(toDiscordRow), sticker_items: (m.stickers || []).filter((x) => !x.removed).map((x) => ({ id: x.id, name: x.name, format_type: x.animated ? 4 : 1 })), stickers: [],
    reactions: (m.reactions || []).map((r) => ({ count: r.count, count_details: { burst: 0, normal: r.count }, me: !!o.viewerId && r.users.includes(o.viewerId), me_burst: false, emoji: toEmojiRef(r.emoji), burst_colors: [] })),
  };
  if (m.nonce !== undefined && m.nonce !== null) out.nonce = String(m.nonce);
  if (m.author?.webhook) out.webhook_id = author.id;
  else if (author?.bot) out.application_id = author.id;
  if (m.interaction) out.interaction = { id: m.id, type: 2, name: m.interaction.name, user: toUser(m.interaction.user) };
  if (m.replyTo) {
    out.message_reference = { type: 0, message_id: m.replyTo.id, channel_id: m.channelId, ...(guildId ? { guild_id: guildId } : {}) };
    out.referenced_message = m.replyTo.deleted ? null : {
      id: m.replyTo.id, channel_id: m.channelId, ...(guildId ? { guild_id: guildId } : {}), author: toUser(m.replyTo.author), content: m.replyTo.content || '',
      timestamp: iso(Number(String(m.replyTo.id).slice(0, 13))), edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [],
      attachments: [], embeds: [], pinned: false, type: 0, flags: 0, components: [],
    };
  }
  if (o.withMember && guildId && m.author?.id && m.author.id !== '0') {
    const mem = getMember(guildId, m.author.id);
    if (mem) out.member = toMember(mem, undefined);
  }
  return out;
}
export function toMessages(list, o = {}) {
  const users = o.users || new Map();
  return list.map((m) => toMessage(m, { ...o, users }));
}

// ---- slash commands --------------------------------------------------------------------------------------------------------------------------
const OPTION_TO_DISCORD = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, number: 10 };
const OPTION_FROM_DISCORD = Object.fromEntries(Object.entries(OPTION_TO_DISCORD).map(([k, v]) => [v, k]));

/** A stored command (a row of bot_commands) → Discord's application command. */
export function toApplicationCommand(row, guildId = null) {
  return clean({
    id: row.id, application_id: row.bot_id, version: row.id, default_member_permissions: null, type: 1, name: row.name, description: row.description,
    dm_permission: false, contexts: [0], integration_types: [0], nsfw: false, guild_id: guildId || undefined,
    options: parseJSON(row.options, []).map((o) => clean({
      type: OPTION_TO_DISCORD[o.type] || 3, name: o.name, description: o.description, required: !!o.required,
      choices: o.choices?.length ? o.choices.map((c) => ({ name: c.name, value: c.value })) : undefined,
    })),
  });
}

/** What a bot sends to register a command → the shape NullChat stores (checked afterwards by the usual rules). */
export function fromApplicationCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A command must be an object.');
  if (body.type !== undefined && body.type !== 1) throw bad('Only slash commands (type 1) are supported. User and message context-menu commands are not.');
  const options = [];
  for (const o of Array.isArray(body.options) ? body.options : []) {
    if (o?.type === 1 || o?.type === 2) throw bad('Subcommands and subcommand groups are not supported yet. Use separate commands (for example /ban-add instead of /ban add).');
    if (o?.type === 9) throw bad('Mentionable options are not supported. Use a user or a role option.');
    if (o?.type === 11) throw bad('Attachment options are not supported.');
    const type = OPTION_FROM_DISCORD[o?.type];
    if (!type) throw bad(`Unknown option type ${o?.type}.`);
    options.push(clean({ name: o.name, description: o.description, type, required: !!o.required, choices: Array.isArray(o.choices) && o.choices.length ? o.choices.map((c) => ({ name: c.name, value: c.value })) : undefined }));
  }
  return { name: body.name, description: body.description, options };
}

// ---- interactions (a person ran a slash command) --------------------------------------------------------------------------------------------
/** The event NullChat sends a bot (INTERACTION_CREATE) → Discord's interaction. */
export function toInteraction(d, botId, origin) {
  if (d.type === 'component' || d.type === 'modal') return toComponentInteraction(d, botId, origin);
  const cmd = get('SELECT * FROM bot_commands WHERE id = ?', d.commandId);
  const defs = parseJSON(cmd?.options, []);
  const guild = getGuildCore(d.guildId);
  const channelRow = getChannelRow(d.channelId);
  const resolved = { users: {}, members: {}, roles: {}, channels: {} };
  const options = [];
  for (const def of defs) {
    if (!d.options || !(def.name in d.options)) continue;
    const value = d.options[def.name];
    options.push({ name: def.name, type: OPTION_TO_DISCORD[def.type] || 3, value });
    if (def.type === 'user') {
      const u = userById(value); const mem = getMember(d.guildId, value);
      if (u) resolved.users[value] = u;
      if (mem) resolved.members[value] = toMember(mem, undefined);
    } else if (def.type === 'role') {
      const r = guild?.roles.find((x) => x.id === value);
      if (r) resolved.roles[value] = toRole(r);
    } else if (def.type === 'channel') {
      const c = getChannelRow(value);
      if (c) resolved.channels[value] = { id: c.id, type: c.type, name: c.name, permissions: '0' };
    }
  }
  const data = { id: d.commandId, name: d.commandName, type: 1, ...(options.length ? { options } : {}) };
  for (const k of Object.keys(resolved)) if (Object.keys(resolved[k]).length) (data.resolved ||= {})[k] = resolved[k];
  const invoker = toUser(d.user);
  const invokerMember = d.member || getMember(d.guildId, d.user.id);
  let memberPerms = 0, appPerms = 0;
  if (guild && channelRow) {
    const ch = serializeChannel(channelRow);
    memberPerms = invokerMember ? computeChannelPermissions(guild, invokerMember, ch) : 0;
    const botMember = getMember(d.guildId, botId);
    appPerms = botMember ? computeChannelPermissions(guild, botMember, ch) : 0;
  }
  return {
    id: d.id, application_id: botId, type: 2, data, guild_id: d.guildId, channel_id: d.channelId,
    channel: channelRow ? { id: channelRow.id, type: channelRow.type, name: channelRow.name, guild_id: d.guildId, permissions: toDiscordPermissions(memberPerms) } : undefined,
    member: { ...toMember(invokerMember || {}, invoker), permissions: toDiscordPermissions(memberPerms) },
    token: d.token, version: 1, app_permissions: toDiscordPermissions(appPerms), locale: 'en-US', guild_locale: 'en-US', context: 0,
    authorizing_integration_owners: { 0: d.guildId }, entitlements: [], attachment_size_limit: 8388608,
  };
}

const DISCORD_COMPONENT_TYPES = { button: 2, select: 3, user_select: 5, role_select: 6, mentionable_select: 7, channel_select: 8 };
/** The details NullChat sends with a pick in a menu of people, roles or channels, in Discord's shape (its members come without the user inside). */
function toResolved(r) {
  const out = {};
  const users = Object.entries(r.users || {});
  if (users.length) {
    out.users = Object.fromEntries(users.map(([id, u]) => [id, toUser(u)]));
    out.members = Object.fromEntries(Object.entries(r.members || {}).map(([id, m]) => { const { user, ...rest } = toMember(m, null); return [id, rest]; }));
  }
  const roles = Object.entries(r.roles || {});
  if (roles.length) out.roles = Object.fromEntries(roles.map(([id, role]) => [id, toRole(role)]));
  const channels = Object.entries(r.channels || {});
  if (channels.length) out.channels = Object.fromEntries(channels.map(([id, c]) => [id, { id: c.id, type: c.type, name: c.name, guild_id: c.guildId, parent_id: c.parentId, permissions: '0' }]));
  return out;
}

/** Someone pressed a button / picked from a menu (type 3), or sent a form (type 5). */
function toComponentInteraction(d, botId, origin) {
  const guild = getGuildCore(d.guildId);
  const channelRow = getChannelRow(d.channelId);
  const invoker = toUser(d.user);
  const invokerMember = d.member || getMember(d.guildId, d.user.id);
  let memberPerms = 0, appPerms = 0;
  if (guild && channelRow) {
    const ch = serializeChannel(channelRow);
    memberPerms = invokerMember ? computeChannelPermissions(guild, invokerMember, ch) : 0;
    const botMember = getMember(d.guildId, botId);
    appPerms = botMember ? computeChannelPermissions(guild, botMember, ch) : 0;
  }
  const data = d.type === 'modal'
    ? { custom_id: d.customId, components: Object.entries(d.values || {}).map(([custom_id, value]) => ({ type: 1, components: [{ type: 4, custom_id, value }] })) }
    : { custom_id: d.customId, component_type: DISCORD_COMPONENT_TYPES[d.componentType] || 2, ...(d.values ? { values: d.values } : {}), ...(d.resolved ? { resolved: toResolved(d.resolved) } : {}) };
  return {
    id: d.id, application_id: botId, type: d.type === 'modal' ? 5 : 3, data, guild_id: d.guildId, channel_id: d.channelId,
    channel: channelRow ? { id: channelRow.id, type: channelRow.type, name: channelRow.name, guild_id: d.guildId, permissions: toDiscordPermissions(memberPerms) } : undefined,
    member: { ...toMember(invokerMember || {}, invoker), permissions: toDiscordPermissions(memberPerms) },
    ...(d.message ? { message: toMessage(d.message, { guildId: d.guildId, origin }) } : {}),
    token: d.token, version: 1, app_permissions: toDiscordPermissions(appPerms), locale: 'en-US', guild_locale: 'en-US', context: 0,
    authorizing_integration_owners: { 0: d.guildId }, entitlements: [], attachment_size_limit: 8388608,
  };
}

// ---- errors ------------------------------------------------------------------------------------------------------------------------------------
/** Discord's JSON error codes for the "unknown thing" answers. */
export const UNKNOWN = { application: 10002, channel: 10003, guild: 10004, member: 10007, message: 10008, role: 10011, user: 10013, emoji: 10014, webhook: 10015, ban: 10026, command: 10063, interaction: 10062 };
