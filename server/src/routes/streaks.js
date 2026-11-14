// Streaks: how many days in a row two friends have talked, and how many days in a row a server has been alive.
//
//  * A direct message between two people counts a day when BOTH of them sent a message in it that day.
//  * A server counts a day when at least two different people (not bots) sent a message in it that day.
//
// A day is a calendar day in one time zone, kept with the streak so that it never shifts under people: for two friends it is
// the time zone of whoever sent the message that started the streak, for a server it is the owner's. Miss a whole day and the
// streak is over; the best one is remembered.
//
// Nothing here reads message contents, and nothing is scanned: each sent message updates one small row.
import { db, get, all, run, parseJSON } from '../db.js';
import { sendToUsers, sendToGuild } from '../gateway.js';
import { guildAccess } from '../models.js';
import { dayNumber, validTimeZone } from '../../../shared/daytime.js';
import { ChannelType } from '../../../shared/permissions.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS streaks (
    key TEXT PRIMARY KEY,            -- 'dm:<channel id>' or 'g:<server id>'
    count INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    last_day INTEGER NOT NULL DEFAULT 0,   -- the last day that counted
    tz TEXT,                         -- the time zone its days are counted in
    day INTEGER NOT NULL DEFAULT 0,  -- the day being filled in ...
    who TEXT                         -- ... and who has written on it so far (one id; the second person completes the day)
  );
`);

const zoneOf = (userId) => {
  const tz = parseJSON(get('SELECT settings FROM users WHERE id = ?', userId)?.settings, {}).timezone;
  return validTimeZone(tz) ? tz : 'UTC';
};

const serialize = (r) => ({ count: r.count, best: r.best, lastDay: r.last_day, tz: r.tz || 'UTC' });

// Most messages change nothing (the day already counted), so remember that and skip the database for them.
const settled = new Map();   // key -> { day, tz } : "this streak already counted day `day`"

/**
 * `userId` just sent a message. `key` names the streak, `zoneUserId` is whose time zone starts a fresh one.
 * Returns the streak when its count went up, else null.
 */
function touch(key, userId, zoneUserId, now) {
  const s = settled.get(key);
  if (s && dayNumber(now, s.tz) === s.day) return null;
  let row = get('SELECT * FROM streaks WHERE key = ?', key);
  if (!row) {
    row = { key, count: 0, best: 0, last_day: 0, tz: zoneOf(zoneUserId), day: 0, who: null };
    run('INSERT INTO streaks (key, count, best, last_day, tz, day, who) VALUES (?, 0, 0, 0, ?, 0, NULL)', key, row.tz);
  }
  let today = dayNumber(now, row.tz);
  if (row.count > 0 && row.last_day < today - 1) {   // a whole day was missed: it starts over, in the time zone of whoever restarts it
    row.count = 0; row.tz = zoneOf(zoneUserId); row.day = 0; row.who = null;
    today = dayNumber(now, row.tz);
  }
  if (row.last_day === today) { settled.set(key, { day: today, tz: row.tz }); return null; }
  let grew = false;
  if (row.day !== today) { row.day = today; row.who = userId; }
  else if (row.who === userId) return null;   // (the same person again: nothing new)
  else {
    row.count = row.last_day === today - 1 ? row.count + 1 : 1;
    row.last_day = today; row.best = Math.max(row.best, row.count); row.who = null;
    grew = true;
  }
  run('UPDATE streaks SET count = ?, best = ?, last_day = ?, tz = ?, day = ?, who = ? WHERE key = ?', row.count, row.best, row.last_day, row.tz, row.day, row.who, key);
  if (grew) settled.set(key, { day: today, tz: row.tz });
  return grew ? serialize(row) : null;
}

/** Called for every message a person (not a bot) sends. */
export function noteMessageForStreaks(channel, userId, now = Date.now()) {
  try {
    if (channel.type === ChannelType.DM) {
      const out = touch(`dm:${channel.id}`, userId, userId, now);
      if (out) sendToUsers(all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id).map((r) => r.user_id), 'STREAK_UPDATE', { channelId: channel.id, streak: out });
    } else if (channel.guild_id) {
      const ownerId = get('SELECT owner_id FROM guilds WHERE id = ?', channel.guild_id)?.owner_id;
      const out = touch(`g:${channel.guild_id}`, userId, ownerId, now);
      if (out) sendToGuild(channel.guild_id, 'STREAK_UPDATE', { guildId: channel.guild_id, streak: out });
    }
  } catch (e) { console.error('[streaks]', e.message); }   // (a streak must never stop a message from being sent)
}

/** For the tests: forget what was remembered in memory. */
export function forgetSettledStreaks() { settled.clear(); }

export default function register(r) {
  // Every streak this person is part of: their direct messages and their servers.
  r.get('/api/streaks', async (ctx) => {
    const dms = {}; const guilds = {};
    for (const row of all(`SELECT s.* FROM streaks s JOIN channel_recipients cr ON s.key = 'dm:' || cr.channel_id WHERE cr.user_id = ? AND s.count > 0`, ctx.user.id)) dms[row.key.slice(3)] = serialize(row);
    for (const row of all(`SELECT s.* FROM streaks s JOIN guild_members gm ON s.key = 'g:' || gm.guild_id WHERE gm.user_id = ? AND s.count > 0`, ctx.user.id)) guilds[row.key.slice(2)] = serialize(row);
    return { dms, guilds };
  });

  r.get('/api/guilds/:id/streak', async (ctx) => {
    const { guild } = guildAccess(ctx.params.id, ctx.user.id);
    const row = get('SELECT * FROM streaks WHERE key = ?', `g:${guild.id}`);
    return row ? serialize(row) : { count: 0, best: 0, lastDay: 0, tz: zoneOf(guild.ownerId) };
  });
}
