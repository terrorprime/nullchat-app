// The "Nullspace" lounge: a server every new account is added to, so people have somewhere to meet each other.
// It is created automatically (owned by the site admin) and the admin can switch the auto-join off in Admin -> Site.
// Existing accounts are not added; the admin can invite them like to any other server.
import { get, run } from '../db.js';
import { config } from '../config.js';
import { P } from '../../../shared/permissions.js';
import { createGuildRecord } from '../routes/guilds.js';
import { addMemberToGuild, createSystemMessage } from '../services.js';
import { guildPayloadFor } from '../models.js';
import { sendToUser } from '../gateway.js';
import { getMeta, setMeta } from './site.js';

export const LOUNGE_NAME = 'Nullspace';
const DESCRIPTION = 'The lounge. Say hi and meet the other people on this NullChat.';
const K_ID = 'site.lounge_guild_id';
const K_ON = 'site.lounge_autojoin';

/** Is every new account added to the lounge? On unless the admin turned it off. */
export const autoJoinOn = () => getMeta(K_ON) !== '0';
export const setAutoJoin = (on) => setMeta(K_ON, on ? '1' : '0');

/** The account that owns the lounge: whoever is the site admin (ADMIN_USERS, else the oldest account). */
function adminRow() {
  if (config.adminUsers.length) {
    const marks = config.adminUsers.map(() => '?').join(',');
    return get(`SELECT * FROM users WHERE lower(username) IN (${marks}) OR lower(email) IN (${marks}) ORDER BY created_at ASC, id ASC LIMIT 1`, ...config.adminUsers, ...config.adminUsers);
  }
  return get('SELECT * FROM users ORDER BY created_at ASC, id ASC LIMIT 1');
}

const textChannel = (gid, name) => get('SELECT * FROM channels WHERE guild_id = ? AND type = 0 AND name = ?', gid, name);

/** The lounge server's row, or null if there is none (never made, or the owner deleted it). */
export function loungeGuild() {
  const id = getMeta(K_ID);
  return id ? get('SELECT * FROM guilds WHERE id = ?', id) || null : null;
}

/** Makes a fresh lounge owned by `owner` and records it. Returns the new server's id. */
export function createLounge(owner) {
  const gid = createGuildRecord(owner.id, LOUNGE_NAME, 'lounge', { systemChannelName: 'general' });
  run('UPDATE guilds SET description = ? WHERE id = ?', DESCRIPTION, gid);
  const welcome = textChannel(gid, 'welcome');
  const intro = textChannel(gid, 'introductions');
  const general = textChannel(gid, 'general');
  // #welcome is read-only for members (the owner and admins can still post there).
  run('INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 0, 0, ?)', welcome.id, gid, P.SEND_MESSAGES);
  createSystemMessage(welcome, owner.id, 0,
    `**Welcome to ${LOUNGE_NAME}!** 👋\n\nThis is the lounge for everyone on this NullChat. Say hi in <#${general.id}>, tell us who you are in <#${intro.id}>, and join the voice room whenever you feel like talking.\n\nBe kind to each other. If something's wrong, message ${owner.display_name || owner.username}.`);
  createSystemMessage(intro, owner.id, 0, 'Introduce yourself: what should people call you, and what are you into?');
  setMeta(K_ID, gid);
  sendToUser(owner.id, 'GUILD_SYNC', guildPayloadFor(gid, owner.id));
  return gid;
}

/**
 * Makes sure the lounge exists. Created once; if the owner later deletes it, it stays deleted (the admin can
 * make a new one from the panel). Returns the server row, or null when there is none.
 */
export function ensureLounge() {
  if (getMeta(K_ID) !== null) return loungeGuild();
  if (!autoJoinOn()) return null;
  const owner = adminRow();
  if (!owner) return null;
  try { return get('SELECT * FROM guilds WHERE id = ?', createLounge(owner)); }
  catch (e) { console.error('[lounge] could not create:', e.message); return null; }
}

/** Adds a new account to the lounge. Returns {guildId, channelId} for the client to open, or null. Never throws. */
export function joinLounge(userId) {
  try {
    if (!autoJoinOn()) return null;
    const g = ensureLounge();
    if (!g) return null;
    addMemberToGuild(g.id, userId, { skipGuard: true });
    return { guildId: g.id, channelId: g.system_channel_id || textChannel(g.id, 'general')?.id || null };
  } catch (e) {
    // banned from it, or already in 200 servers: signing up must still work
    return null;
  }
}

/** What the admin panel shows. */
export function loungeInfo() {
  const g = loungeGuild();
  return {
    autoJoin: autoJoinOn(),
    guild: g ? {
      id: g.id, name: g.name,
      channelId: g.system_channel_id || textChannel(g.id, 'general')?.id || null,
      members: get('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?', g.id).n,
    } : null,
    deleted: !g && getMeta(K_ID) !== null,
  };
}
