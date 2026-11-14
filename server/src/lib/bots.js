// Bot helpers shared by the routes: looking apps up, adding them to servers and taking them out, and listing their slash commands.
//
// An app is a row in "users" (bot = 1) plus a row in "bots" (its token, owner, description, who may add it). It is *installed* into servers:
// each install (bot_installs) is a member entry and a role of its own in that server, so one app can be in many servers at once.
// Taking it out of a server only removes that install; deleting the app removes it everywhere.
import { get, all, run, tx, parseJSON } from '../db.js';
import { sendToGuild, disconnectUser, syncGuild, onMemberRemoved } from '../gateway.js';
import { clearBotLog } from './botlog.js';
import { bad } from './http.js';
import { newId } from './security.js';
import { getUserRow, getMember, publicUser, guildAccess } from '../models.js';
import { P, has } from '../../../shared/permissions.js';

export const MAX_BOTS_PER_SERVER = 25;
export const MAX_APPS_PER_USER = 25;
export const VISIBILITIES = ['private', 'link', 'listed'];

// ---- permission presets: what an app's role gets when it is added to a server --------------------------------------------------
const CHAT = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.SEND_MESSAGES_IN_THREADS | P.READ_MESSAGE_HISTORY | P.EMBED_LINKS | P.ATTACH_FILES
  | P.ADD_REACTIONS | P.USE_EXTERNAL_EMOJIS | P.CREATE_THREADS;
export const BOT_PRESETS = {
  basic: CHAT,
  moderator: CHAT | P.MANAGE_MESSAGES | P.MANAGE_THREADS | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MODERATE_MEMBERS | P.MANAGE_NICKNAMES,
  admin: P.ADMINISTRATOR,
};
export const presetPermissions = (name) => BOT_PRESETS[name] ?? BOT_PRESETS.basic;

/** Is this user id a bot (1) rather than a person? */
export const isBotId = (id) => get('SELECT bot FROM users WHERE id = ?', id)?.bot === 1;

export const getBot = (id) => get('SELECT * FROM bots WHERE id = ?', id);

// ---- installs ---------------------------------------------------------------------------------------------------------------
export const installsOf = (botId) => all('SELECT * FROM bot_installs WHERE bot_id = ? ORDER BY installed_at, guild_id', botId);
export const installOf = (botId, guildId) => (botId && guildId ? get('SELECT * FROM bot_installs WHERE bot_id = ? AND guild_id = ?', botId, guildId) : undefined);
export const botGuildIds = (botId) => installsOf(botId).map((i) => i.guild_id);
export const installCount = (botId) => get('SELECT COUNT(*) AS n FROM bot_installs WHERE bot_id = ?', botId).n;
export const appsOwnedBy = (userId) => get('SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?', userId).n;

/** The apps in a server, each with its install details (its role there, who added it, when). */
export function botsInGuild(guildId) {
  return all(`SELECT b.*, i.guild_id AS install_guild_id, i.role_id AS install_role_id, i.installed_by, i.installed_at
                FROM bots b JOIN bot_installs i ON i.bot_id = b.id WHERE i.guild_id = ? ORDER BY i.installed_at, b.created_at`, guildId);
}

// ---- who may do what ---------------------------------------------------------------------------------------------------------
/**
 * Who may change an app (its name, picture, token, who can add it) and delete it everywhere: the person who made it.
 * One more case keeps the old way working: an app nobody else can add (private) and that lives in one server is that server's bot,
 * so people who manage that server may look after it.
 */
export function canManageBot(userId, bot) {
  if (!userId || !bot) return false;
  if (bot.owner_id === userId) return true;
  if (bot.visibility !== 'private') return false;
  const installs = installsOf(bot.id);
  if (installs.length !== 1) return false;
  try { return has(guildAccess(installs[0].guild_id, userId).perms, P.MANAGE_GUILD); } catch { return false; }
}

/** What this person may do with an app: 'manage' (look after it and add it), 'install' (add it to servers they manage), or null (it does not exist for them). */
export function appAccess(userId, bot) {
  if (!bot) return null;
  if (canManageBot(userId, bot)) return 'manage';
  if (bot.hidden) return null;
  return bot.visibility === 'link' || bot.visibility === 'listed' ? 'install' : null;
}

// ---- adding to a server and taking out -----------------------------------------------------------------------------------------
/**
 * Add an app to a server: it becomes a member with a role of its own. The caller has already checked who may do this.
 * `guild` is the server's record (with its roles). Returns the role it was given.
 */
export function installBot(bot, guild, { installedBy = null } = {}) {
  if (installOf(bot.id, guild.id)) throw bad('That app is already in this server.', 'already_installed');
  if (get('SELECT COUNT(*) AS n FROM bot_installs WHERE guild_id = ?', guild.id).n >= MAX_BOTS_PER_SERVER) throw bad(`A server can have at most ${MAX_BOTS_PER_SERVER} bots.`);
  if (guild.roles.length >= 250) throw bad('This server has the maximum number of roles.');
  const user = getUserRow(bot.id);
  if (!user) throw bad('That app doesn’t exist any more.');
  const permissions = presetPermissions(bot.perm_preset);
  const roleId = newId();
  tx(() => {
    run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', guild.id);
    run('INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable) VALUES (?, ?, ?, 0, ?, 1, 0, 0)', roleId, guild.id, user.display_name, permissions);
    run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guild.id, bot.id, Date.now());
    run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', guild.id, bot.id, roleId);
    run('INSERT INTO bot_installs (bot_id, guild_id, role_id, installed_by, installed_at) VALUES (?, ?, ?, ?, ?)', bot.id, guild.id, roleId, installedBy, Date.now());
  });
  sendToGuild(guild.id, 'GUILD_MEMBER_ADD', { guildId: guild.id, member: getMember(guild.id, bot.id), user: publicUser(getUserRow(bot.id)) });
  syncGuild(guild.id);   // (the app's own connection learns about the server from this)
  if (get('SELECT 1 FROM bot_commands WHERE bot_id = ?', bot.id)) announceCommands(guild.id);
  return { roleId, permissions };
}

/** Take an app out of one server: its member entry and role there go. It stays connected for its other servers and keeps its token. */
export function uninstallBot(botId, guildId) {
  const inst = installOf(botId, guildId);
  if (!inst) return false;
  tx(() => {
    run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, botId);
    if (inst.role_id) run('DELETE FROM roles WHERE id = ? AND guild_id = ?', inst.role_id, guildId);
    run('DELETE FROM bot_installs WHERE bot_id = ? AND guild_id = ?', botId, guildId);
  });
  onMemberRemoved(guildId, botId);
  sendToGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, userId: botId });
  announceCommands(guildId);
  syncGuild(guildId);
  return true;
}

/**
 * Delete an app everywhere: it leaves every server it was in, loses its token and its commands, and is disconnected.
 * The account itself stays (without a way to log in) so the messages it already sent keep their author.
 */
export function deleteBot(botId) {
  const bot = getBot(botId);
  if (!bot) return false;
  const installs = installsOf(botId);
  tx(() => {
    for (const i of installs) {
      run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', i.guild_id, botId);
      if (i.role_id) run('DELETE FROM roles WHERE id = ? AND guild_id = ?', i.role_id, i.guild_id);
    }
    run('DELETE FROM bots WHERE id = ?', botId);   // (its installs and commands go with it)
  });
  clearBotLog(botId);
  disconnectUser(botId, 'Bot removed');
  for (const i of installs) {
    onMemberRemoved(i.guild_id, botId);
    sendToGuild(i.guild_id, 'GUILD_MEMBER_REMOVE', { guildId: i.guild_id, userId: botId });
    announceCommands(i.guild_id);
    syncGuild(i.guild_id);
  }
  return true;
}

// ---- slash commands -----------------------------------------------------------------------------------------------------------
export function serializeCommand(c) {
  return { id: c.id, botId: c.bot_id, name: c.name, description: c.description, options: parseJSON(c.options, []) };
}

/** Every slash command from the apps in a server (what the message box offers after you type "/"). */
export function commandsForGuild(guildId) {
  return all(`SELECT c.* FROM bot_commands c JOIN bot_installs i ON i.bot_id = c.bot_id WHERE i.guild_id = ? ORDER BY c.name, c.created_at`, guildId).map(serializeCommand);
}

/** Tell everyone in the server to reload the command list. */
export function announceCommands(guildId) {
  sendToGuild(guildId, 'COMMANDS_UPDATE', { guildId });
}
/** The same for every server an app is in (it changed its commands). */
export function announceBotCommands(botId) {
  for (const gid of botGuildIds(botId)) announceCommands(gid);
}

/** Hourly clean-up: bot accounts nobody can use any more and that never said anything, and apps whose owner is gone and that are in no server. */
export function sweepBotUsers() {
  for (const b of all('SELECT id FROM bots WHERE owner_id IS NULL AND id NOT IN (SELECT bot_id FROM bot_installs)')) deleteBot(b.id);
  run(`DELETE FROM users WHERE bot = 1 AND id NOT IN (SELECT id FROM bots)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_id = users.id)`);
}
