// What someone picked in a bot's menu of people, roles or channels (types 5 to 8): every pick is checked against the server the message is in,
// and the bot gets the ids together with who and what they are (so it doesn't have to look each one up).
//
//   resolved: { users: { id: user }, members: { id: member }, roles: { id: role }, channels: { id: channel } }
//
// A person is only offered what they can already see: the members of the server, its roles (not @everyone) and the channels they can open.
import { bad } from './http.js';
import { publicUser, getUserRow, getMember, serializeChannel, getChannelRow } from '../models.js';
import { P, has, ChannelType, computeChannelPermissions } from '../../../shared/permissions.js';
import { PICKER_KINDS } from './components.js';

export const isPicker = (c) => !!c && c.type >= 5 && c.type <= 8;

/** The name the bot sees for the kind of component that was used: 'select' for a plain menu, then these. */
export const COMPONENT_TYPE_NAMES = { 3: 'select', 5: 'user_select', 6: 'role_select', 7: 'mentionable_select', 8: 'channel_select' };
export const componentTypeName = (c) => COMPONENT_TYPE_NAMES[c.type] || 'button';

/**
 * Check a person's pick. `guild` is the server's record (with its roles), `userId` the person choosing.
 * Returns `{ values: [id…], resolved }`; throws, in words they can act on, when something isn't allowed.
 */
export function resolvePick(menu, given, { guild, userId }) {
  const kind = PICKER_KINDS[menu.type];
  const list = Array.isArray(given) ? given.map(String) : [];
  if (new Set(list).size !== list.length) throw bad('Pick each one only once.');
  if (list.length < menu.minValues) throw bad(`Pick at least ${menu.minValues}.`);
  if (list.length > menu.maxValues) throw bad(`Pick at most ${menu.maxValues}.`);

  const resolved = { users: {}, members: {}, roles: {}, channels: {} };
  const asMember = (id) => {
    const m = getMember(guild.id, id);
    const u = m && getUserRow(id);
    if (!m || !u) return false;
    resolved.users[id] = publicUser(u);
    resolved.members[id] = m;
    return true;
  };
  const asRole = (id) => {
    if (id === guild.id) return false;   // (@everyone is not something to pick)
    const r = guild.roles.find((x) => x.id === id);
    if (!r) return false;
    resolved.roles[id] = r;
    return true;
  };
  const asChannel = (id) => {
    const row = getChannelRow(id);
    if (!row || row.guild_id !== guild.id) return false;
    if (menu.channelTypes?.length && !menu.channelTypes.includes(row.type)) return false;
    const member = getMember(guild.id, userId);
    const permRow = row.type === ChannelType.THREAD ? (getChannelRow(row.parent_id) || row) : row;
    if (!member || !has(computeChannelPermissions(guild, member, serializeChannel(permRow)), P.VIEW_CHANNEL)) return false;   // (a channel you can't open isn't offered)
    resolved.channels[id] = { id: row.id, guildId: guild.id, name: row.name, type: row.type, parentId: row.parent_id || null };
    return true;
  };

  for (const id of list) {
    if (!/^\d{1,25}$/.test(id)) throw bad('That choice isn’t available any more.');
    const found = kind === 'user' ? asMember(id) : kind === 'role' ? asRole(id) : kind === 'channel' ? asChannel(id) : (asMember(id) || asRole(id));
    if (!found) {
      throw bad(kind === 'user' ? 'One of the people you picked isn’t in this server any more.'
        : kind === 'role' ? 'One of the roles you picked isn’t available any more.'
          : kind === 'channel' ? 'One of the channels you picked isn’t available any more.'
            : 'One of your choices isn’t in this server any more.');
    }
  }
  return { values: list, resolved };
}
