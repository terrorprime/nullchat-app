// Birthdays. A person can tell NullChat the day and month of their birthday (never the year), and choose two things separately:
// whether their profile shows it, and whether the servers they are in may announce it. A server chooses a channel for the
// announcements; without one, nothing is posted there. On the day, at nine in the morning where the person lives (the time zone
// their app reported), each such server gets one "It's X's birthday" message.
import { z } from 'zod';
import { db, get, all, run, parseJSON } from '../db.js';
import { bad } from '../lib/http.js';
import { guildAccess, requirePerm, getChannelRow, getUserRow, privateUser, guildPayloadFor, channelViewerIds, birthdayOf } from '../models.js';
import { broadcastUserUpdate, syncGuild } from '../gateway.js';
import { audit, createSystemMessage } from '../services.js';
import { localDate, validTimeZone, validBirthday, isBirthdayOn } from '../../../shared/daytime.js';
import { P, ChannelType } from '../../../shared/permissions.js';

export const BIRTHDAY_MESSAGE_TYPE = 21;
const ANNOUNCE_HOUR = 9;

if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'birthday'").get()) db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');   // JSON: { month, day, announce, profile }
if (!db.prepare("SELECT 1 FROM pragma_table_info('guilds') WHERE name = 'birthday_channel_id'").get()) db.exec('ALTER TABLE guilds ADD COLUMN birthday_channel_id TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS birthday_posts (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, year)
  );
  CREATE INDEX IF NOT EXISTS idx_users_birthday ON users(birthday) WHERE birthday IS NOT NULL;
`);

const zoneOfRow = (u) => { const tz = parseJSON(u.settings, {}).timezone; return validTimeZone(tz) ? tz : 'UTC'; };

/** Post the announcements that are due. Runs every few minutes; safe to run as often as you like. Returns how many it posted. */
export function announceBirthdays(now = Date.now()) {
  let posted = 0;
  for (const u of all('SELECT id, birthday, settings FROM users WHERE birthday IS NOT NULL AND COALESCE(bot, 0) = 0')) {
    const b = birthdayOf(u);
    if (!b || !b.announce) continue;
    const here = localDate(now, zoneOfRow(u));
    if (here.hour < ANNOUNCE_HOUR || !isBirthdayOn(b, here)) continue;
    const guilds = all(`SELECT g.id, g.birthday_channel_id FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
      WHERE gm.user_id = ? AND g.birthday_channel_id IS NOT NULL`, u.id);
    for (const g of guilds) {
      if (get('SELECT 1 FROM birthday_posts WHERE guild_id = ? AND user_id = ? AND year = ?', g.id, u.id, here.year)) continue;
      run('INSERT INTO birthday_posts (guild_id, user_id, year) VALUES (?, ?, ?)', g.id, u.id, here.year);
      const ch = getChannelRow(g.birthday_channel_id);
      // Only where the person can see the channel themselves: a birthday is not announced behind someone's back.
      if (!ch || ch.guild_id !== g.id || ch.type !== ChannelType.TEXT || !channelViewerIds(ch, (id) => id === u.id).includes(u.id)) continue;
      createSystemMessage(ch, u.id, BIRTHDAY_MESSAGE_TYPE);
      posted++;
    }
  }
  run('DELETE FROM birthday_posts WHERE year < ?', new Date(now).getUTCFullYear() - 1);
  return posted;
}

export default function register(r) {
  // Save it ({ month, day, announce, profile }) or forget it ({ birthday: null }).
  r.put('/api/users/@me/birthday', async (ctx) => {
    const body = z.object({
      birthday: z.object({ month: z.number().int(), day: z.number().int(), announce: z.boolean().optional(), profile: z.boolean().optional() }).nullable(),
    }).parse(ctx.body);
    if (ctx.user.bot) throw bad('Bots do not have birthdays.');
    const b = body.birthday;
    if (b && !validBirthday(b)) throw bad('That is not a day of the year.');
    const saved = b ? { month: b.month, day: b.day, announce: b.announce !== false, profile: !!b.profile } : null;
    run('UPDATE users SET birthday = ? WHERE id = ?', saved ? JSON.stringify(saved) : null, ctx.user.id);
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });

  // Where this server announces birthdays ({ channelId }), or nowhere ({ channelId: null }).
  r.put('/api/guilds/:id/birthdays', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const { channelId } = z.object({ channelId: z.string().max(40).nullable() }).parse(ctx.body);
    if (channelId) {
      const ch = getChannelRow(channelId);
      if (!ch || ch.guild_id !== guild.id || ch.type !== ChannelType.TEXT) throw bad('Birthdays are announced in a text channel of this server.');
    }
    run('UPDATE guilds SET birthday_channel_id = ? WHERE id = ?', channelId, guild.id);
    audit(guild.id, ctx.user.id, 'GUILD_UPDATE', { targetId: guild.id, targetType: 'guild', changes: { birthdayChannelId: channelId } });
    syncGuild(guild.id);
    return guildPayloadFor(guild.id, ctx.user.id);
  });

  // The birthdays coming up in a server, for the people who chose to show theirs: [{ userId, month, day }], soonest first.
  r.get('/api/guilds/:id/birthdays', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    const today = localDate(Date.now(), zoneOfRow(ctx.user));
    const rank = (b) => { const d = (b.month - today.month) * 31 + (b.day - today.day); return d < 0 ? d + 12 * 31 : d; };
    return all('SELECT u.id, u.birthday FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ? AND u.birthday IS NOT NULL', guild.id)
      .map((u) => ({ userId: u.id, b: birthdayOf(u) })).filter((x) => x.b && x.b.profile)
      .map((x) => ({ userId: x.userId, month: x.b.month, day: x.b.day }))
      .sort((a, b) => rank(a) - rank(b)).slice(0, 50);
  });

  setInterval(() => { try { announceBirthdays(); } catch (e) { console.error('[birthdays]', e.message); } }, 5 * 60_000).unref();
  setTimeout(() => { try { announceBirthdays(); } catch (e) { console.error('[birthdays]', e.message); } }, 20_000).unref();
}
