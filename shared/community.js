// Rules for the community tools, shared by the server (to check what is saved) and the web client (to show the same limits).

// ---- a server's own invite link: /invite/<name> ----
export const VANITY_MIN = 3, VANITY_MAX = 32;
/** Lower-case letters, numbers and single hyphens inside; it starts and ends with a letter or number. */
export const VANITY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
/** Names that would read like part of the site or like staff; nobody can take them. */
export const VANITY_RESERVED = [
  'invite', 'invites', 'api', 'admin', 'administrator', 'login', 'logout', 'register', 'signup', 'channels', 'discovery', 'discover', 'install',
  'download', 'downloads', 'uploads', 'assets', 'health', 'null', 'nullchat', 'nullspace', 'everyone', 'here', 'support', 'help', 'staff', 'mod',
  'mods', 'moderator', 'system', 'root', 'official', 'app', 'apps', 'settings', 'terms', 'privacy', 'status', 'new', 'join', 'bot', 'bots',
];
export const normalizeVanity = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
export const validVanity = (s) => VANITY_PATTERN.test(s) && !s.includes('--');
export const isReservedVanity = (s) => VANITY_RESERVED.includes(String(s).toLowerCase());

// ---- removing many members at once ----
/** The most people one bulk kick or ban can take in a single go. */
export const BULK_MAX = 200;

// ---- announcement channels ----
/** How many servers can follow one announcement channel, and how many announcement channels one channel can receive. */
export const FOLLOWERS_MAX = 50;
export const FOLLOWING_MAX = 10;

// ---- server folders (kept in the account's settings as settings.guildFolders) ----
export const FOLDER_NAME_MAX = 32;
export const FOLDERS_MAX = 50;
export const FOLDER_COLORS = ['#c2ff3d', '#6cc4ff', '#ff8a5c', '#d58bff', '#ffd23d', '#5cf0b0', '#ff6b8b', '#b4b9c2'];

/**
 * Make a list of folders safe to use: only servers the person is in, each server in at most one folder, a folder needs two or more servers
 * (a folder of one is just the server), names trimmed. `knownIds` is the set of server ids the person is in.
 */
export function cleanFolders(folders, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  const used = new Set();
  const seenFolder = new Set();
  const out = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || seenFolder.has(f.id)) continue;
    const ids = [];
    for (const id of Array.isArray(f.guildIds) ? f.guildIds : []) {
      if (typeof id === 'string' && known.has(id) && !used.has(id)) { used.add(id); ids.push(id); }
    }
    if (ids.length < 2) continue;
    seenFolder.add(f.id);
    out.push({
      id: f.id.slice(0, 40),
      name: String(f.name ?? '').trim().slice(0, FOLDER_NAME_MAX),
      color: FOLDER_COLORS.includes(f.color) ? f.color : FOLDER_COLORS[0],
      guildIds: ids,
    });
    if (out.length >= FOLDERS_MAX) break;
  }
  return out;
}

// ---- "joined from": a label on an invite link, /invite/<code>/<label>, so a server can see where its new members came from ----
/** The labels the Invite People window offers, grouped. Anyone can also type their own (see normalizeSource). */
export const JOIN_SOURCE_GROUPS = [
  { id: 'social', label: 'Social media', sources: [
    ['youtube', 'YouTube'], ['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['x', 'X (Twitter)'], ['facebook', 'Facebook'], ['reddit', 'Reddit'],
    ['twitch', 'Twitch'], ['snapchat', 'Snapchat'], ['threads', 'Threads'], ['bluesky', 'Bluesky'], ['linkedin', 'LinkedIn'], ['pinterest', 'Pinterest'],
  ] },
  { id: 'chat', label: 'Chat apps', sources: [
    ['discord', 'Discord'], ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['text-message', 'Text message'],
  ] },
  { id: 'people', label: 'People', sources: [
    ['friend', 'Heard from a friend'], ['family', 'Family'], ['school-or-work', 'School or work'], ['in-person', 'In person or at an event'],
  ] },
  { id: 'elsewhere', label: 'Elsewhere', sources: [
    ['website', 'Website or blog'], ['search', 'Search engine'], ['email', 'Email or newsletter'], ['podcast', 'Podcast'], ['ad', 'An ad'], ['other', 'Other'],
  ] },
];
/** Labels the server adds by itself. */
export const JOIN_SOURCE_AUTO = { discovery: 'Server Discovery' };
export const JOIN_SOURCES = JOIN_SOURCE_GROUPS.flatMap((g) => g.sources.map(([id, label]) => ({ id, label, group: g.id })));
const SOURCE_LABELS = Object.fromEntries([...JOIN_SOURCES.map((s) => [s.id, s.label]), ...Object.entries(JOIN_SOURCE_AUTO)]);
export const SOURCE_MAX = 24;
/** Lower-case letters, numbers and single hyphens inside; it starts and ends with a letter or number. */
export const SOURCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
/** Whatever was typed or came in a link, made into a label that is safe to store and show; '' when nothing usable is left. */
export function normalizeSource(s) {
  const v = (typeof s === 'string' ? s : '').trim().toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, SOURCE_MAX).replace(/-+$/g, '');
  return SOURCE_PATTERN.test(v) ? v : '';
}
/** What to call a label: the nice name for the known ones, the label itself for one somebody made up. */
export const sourceLabel = (id) => SOURCE_LABELS[id] || id;
export const isKnownSource = (id) => Object.prototype.hasOwnProperty.call(SOURCE_LABELS, id);
