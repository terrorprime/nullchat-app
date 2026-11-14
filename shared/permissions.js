// Shared permission logic used by both the NullChat server and client.
// Permissions are bit flags kept within 31 bits so plain JS bitwise ops are safe.

export const P = {
  CREATE_INVITE: 1 << 0,
  KICK_MEMBERS: 1 << 1,
  BAN_MEMBERS: 1 << 2,
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_GUILD: 1 << 5,
  ADD_REACTIONS: 1 << 6,
  VIEW_AUDIT_LOG: 1 << 7,
  PRIORITY_SPEAKER: 1 << 8,
  STREAM: 1 << 9,
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  MANAGE_MESSAGES: 1 << 12,
  EMBED_LINKS: 1 << 13,
  ATTACH_FILES: 1 << 14,
  READ_MESSAGE_HISTORY: 1 << 15,
  MENTION_EVERYONE: 1 << 16,
  USE_EXTERNAL_EMOJIS: 1 << 17,
  CONNECT: 1 << 18,
  SPEAK: 1 << 19,
  MUTE_MEMBERS: 1 << 20,
  DEAFEN_MEMBERS: 1 << 21,
  MOVE_MEMBERS: 1 << 22,
  CHANGE_NICKNAME: 1 << 23,
  MANAGE_NICKNAMES: 1 << 24,
  MANAGE_ROLES: 1 << 25,
  MANAGE_EMOJIS: 1 << 26,
  CREATE_THREADS: 1 << 27,
  MANAGE_THREADS: 1 << 28,
  MODERATE_MEMBERS: 1 << 29,
  SEND_MESSAGES_IN_THREADS: 1 << 30,
};

export const ALL_PERMISSIONS = Object.values(P).reduce((a, b) => a | b, 0);

export const DEFAULT_EVERYONE_PERMISSIONS =
  P.CREATE_INVITE | P.ADD_REACTIONS | P.STREAM | P.VIEW_CHANNEL | P.SEND_MESSAGES |
  P.EMBED_LINKS | P.ATTACH_FILES | P.READ_MESSAGE_HISTORY | P.USE_EXTERNAL_EMOJIS |
  P.CONNECT | P.SPEAK | P.CHANGE_NICKNAME | P.CREATE_THREADS | P.SEND_MESSAGES_IN_THREADS;

// Human-readable groups for the role / overwrite editors.
export const PERMISSION_INFO = [
  { group: 'General', items: [
    ['VIEW_CHANNEL', 'View Channels', 'Allows members to view channels by default.'],
    ['MANAGE_CHANNELS', 'Manage Channels', 'Create, edit and delete channels.'],
    ['MANAGE_ROLES', 'Manage Roles', 'Create and edit roles lower than their highest role.'],
    ['MANAGE_EMOJIS', 'Manage Emojis and Stickers', 'Upload and remove the server’s custom emojis and stickers.'],
    ['VIEW_AUDIT_LOG', 'View Audit Log', 'View a record of who made which changes in this server.'],
    ['MANAGE_GUILD', 'Manage Server', 'Change the server name, icon, moderation and automod settings.'],
  ] },
  { group: 'Membership', items: [
    ['CREATE_INVITE', 'Create Invite', 'Invite new people to this server.'],
    ['CHANGE_NICKNAME', 'Change Nickname', 'Change their own nickname and their picture in this server.'],
    ['MANAGE_NICKNAMES', 'Manage Nicknames', 'Change the nicknames of other members.'],
    ['KICK_MEMBERS', 'Kick Members', 'Remove other members from this server.'],
    ['BAN_MEMBERS', 'Ban Members', 'Permanently ban members from this server.'],
    ['MODERATE_MEMBERS', 'Timeout Members', 'Temporarily stop members from chatting, reacting or speaking.'],
  ] },
  { group: 'Text Channels', items: [
    ['SEND_MESSAGES', 'Send Messages', 'Send messages in text channels.'],
    ['SEND_MESSAGES_IN_THREADS', 'Send Messages in Threads', 'Send messages in threads.'],
    ['CREATE_THREADS', 'Create Threads', 'Start new threads.'],
    ['EMBED_LINKS', 'Embed Links', 'Links sent show a rich preview.'],
    ['ATTACH_FILES', 'Attach Files', 'Upload files and images.'],
    ['ADD_REACTIONS', 'Add Reactions', 'Add new emoji reactions to messages.'],
    ['USE_EXTERNAL_EMOJIS', 'Use External Emojis and Stickers', 'Use custom emojis and stickers from other servers.'],
    ['MENTION_EVERYONE', 'Mention @everyone, @here and All Roles', 'Notify everyone in the channel.'],
    ['MANAGE_MESSAGES', 'Manage Messages', 'Delete and pin messages from other members.'],
    ['MANAGE_THREADS', 'Manage Threads', 'Rename, archive and delete threads.'],
    ['READ_MESSAGE_HISTORY', 'Read Message History', 'Read messages sent before they joined.'],
  ] },
  { group: 'Voice Channels', items: [
    ['CONNECT', 'Connect', 'Join voice channels.'],
    ['SPEAK', 'Speak', 'Talk in voice channels.'],
    ['STREAM', 'Video', 'Share their camera or screen.'],
    ['PRIORITY_SPEAKER', 'Priority Speaker', 'Be more easily heard in voice channels.'],
    ['MUTE_MEMBERS', 'Mute Members', 'Mute other members in voice channels. On a stage channel this also lets them invite people to speak.'],
    ['DEAFEN_MEMBERS', 'Deafen Members', 'Deafen other members in voice channels.'],
    ['MOVE_MEMBERS', 'Move Members', 'Disconnect or move members between voice channels.'],
  ] },
  { group: 'Advanced', items: [
    ['ADMINISTRATOR', 'Administrator', 'Grants every permission and bypasses channel overwrites. Dangerous!'],
  ] },
];

export const ChannelType = { TEXT: 0, DM: 1, VOICE: 2, GROUP_DM: 3, CATEGORY: 4, ANNOUNCEMENT: 5, THREAD: 11, STAGE: 13, FORUM: 15 };

/** An announcement channel is a text channel whose posts can be published to the servers that follow it. */
export const isTextLike = (type) => type === ChannelType.TEXT || type === ChannelType.ANNOUNCEMENT;
/** A stage channel is a voice channel where a few people speak and the rest listen. */
export const isVoiceLike = (type) => type === ChannelType.VOICE || type === ChannelType.STAGE;
/** The most people who can speak on a stage at once (every speaker sends audio straight to every listener, so this keeps it light). */
export const STAGE_MAX_SPEAKERS = 10;
/** The most people on a stage at once when the channel has no limit of its own. */
export const STAGE_DEFAULT_LIMIT = 50;

export function has(perms, flag) {
  return (perms & flag) === flag;
}

/**
 * Compute guild-level permissions for a member.
 * guild: { id, ownerId, roles: [{id, permissions}] }
 * member: { userId, roles: [roleId], timeoutUntil }
 */
export function computeBasePermissions(guild, member) {
  if (!member) return 0;
  if (guild.ownerId === member.userId) return ALL_PERMISSIONS;
  const roleMap = new Map(guild.roles.map((r) => [r.id, r]));
  let perms = roleMap.get(guild.id)?.permissions ?? 0;
  for (const rid of member.roles || []) perms |= roleMap.get(rid)?.permissions ?? 0;
  if (has(perms, P.ADMINISTRATOR)) return ALL_PERMISSIONS;
  return perms;
}

/**
 * Compute permissions in a specific channel. For threads pass the parent channel.
 */
export function computeChannelPermissions(guild, member, channel) {
  if (!member) return 0;
  let perms = computeBasePermissions(guild, member);
  if (has(perms, P.ADMINISTRATOR) || guild.ownerId === member.userId) return ALL_PERMISSIONS;
  const overwrites = channel?.overwrites || [];
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
  let allow = 0, deny = 0;
  const roles = new Set(member.roles || []);
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guild.id && roles.has(o.id)) { allow |= o.allow; deny |= o.deny; }
  }
  perms = (perms & ~deny) | allow;
  const mo = overwrites.find((o) => o.type === 1 && o.id === member.userId);
  if (mo) perms = (perms & ~mo.deny) | mo.allow;
  // Timed out members may only read.
  if (member.timeoutUntil && member.timeoutUntil > Date.now()) {
    perms &= P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY;
  }
  if (!has(perms, P.VIEW_CHANNEL)) return 0;
  return perms;
}

/** Highest role position of a member (owner = Infinity). */
export function highestRolePosition(guild, member) {
  if (!member) return -1;
  if (guild.ownerId === member.userId) return Infinity;
  let pos = 0;
  for (const r of guild.roles) if ((member.roles || []).includes(r.id) && r.position > pos) pos = r.position;
  return pos;
}
