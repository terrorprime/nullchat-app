// Server insights: how a server is doing, for its owner and anyone who can manage it (Server Settings → Insights).
// Numbers only: who joined and left, how many messages, the busiest hours, the busiest channels and members. Never message text.
//
//   - Days are the VIEWER's days (the client sends its time-zone offset), so "today" and "busiest hour" mean what the owner expects.
//   - Joins before this feature existed are counted from who is still a member; from then on every join and leave is in the
//     member log (lib/raid.js), so people who joined and left are counted too. Leaves are only known from that day, and the answer says so.
//   - Bots are not people here: they are left out of members, joins, messages and the top lists.
//   - A result is kept for 5 minutes (it reads a lot of rows on a big server); "Refresh" asks for a new one, at most a few times a minute.
import { get, all } from '../db.js';
import { z } from 'zod';
import { enforceRateLimit } from '../lib/http.js';
import { guildAccess, requirePerm, publicUser, getUserRow } from '../models.js';
import { P, ChannelType } from '../../../shared/permissions.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const TTL = 5 * 60_000;
const cache = new Map();   // `${guild}:${days}:${tz}` -> { at, data }

const idFloor = (ms) => String(Math.max(0, ms)).padStart(13, '0') + '000000';   // ids start with their time in ms (lib/security.js newId)
const dateOf = (dayIndex) => new Date(dayIndex * DAY).toISOString().slice(0, 10);

function compute(guildId, days, tzMin) {
  const now = Date.now();
  const shift = tzMin * 60_000;                         // local = utc - shift
  const today = Math.floor((now - shift) / DAY);        // today's day number, in the viewer's zone
  const first = today - (2 * days - 1);                 // the previous period + this one
  const startMs = first * DAY + shift;                  // when `first` began, in real time
  const curFirst = first + days;                        // first day of this period
  const idx = (ms) => Math.floor((ms - shift) / DAY);
  const count = (n) => new Array(n).fill(0);
  const N = 2 * days;

  const track = get("SELECT MIN(at) AS t FROM guild_member_log WHERE guild_id = ? AND kind = 'start'", guildId)?.t || now;

  // ---- messages (people only), per day
  const msgDay = count(N), activeDay = count(N);
  const rows = all(`SELECT CAST((m.created_at - ?) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n, COUNT(DISTINCT m.author_id) AS a
    FROM channels c JOIN messages m ON m.channel_id = c.id
    LEFT JOIN users u ON u.id = m.author_id
    WHERE c.guild_id = ? AND m.id >= ? AND m.type IN (0, 19) AND m.crosspost IS NULL AND COALESCE(u.bot, 0) = 0
    GROUP BY d`, shift, guildId, idFloor(startMs));
  for (const r of rows) { const i = r.d - first; if (i >= 0 && i < N) { msgDay[i] = r.n; activeDay[i] = r.a; } }

  const distinct = (fromMs, toMs) => get(`SELECT COUNT(DISTINCT m.author_id) AS n FROM channels c JOIN messages m ON m.channel_id = c.id
    LEFT JOIN users u ON u.id = m.author_id
    WHERE c.guild_id = ? AND m.id >= ? AND m.id < ? AND m.type IN (0, 19) AND m.crosspost IS NULL AND COALESCE(u.bot, 0) = 0`, guildId, idFloor(fromMs), idFloor(toMs)).n;
  const curStartMs = curFirst * DAY + shift;
  const active = { count: distinct(curStartMs, now + DAY), prev: distinct(startMs, curStartMs) };

  // ---- joins and leaves, per day
  const joinDay = count(N), leaveDay = new Array(N).fill(null);
  // (before tracking started: the people who are still members)
  for (const r of all(`SELECT CAST((gm.joined_at - ?) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM guild_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.guild_id = ? AND u.bot = 0 AND gm.joined_at >= ? AND gm.joined_at < ? GROUP BY d`, shift, guildId, startMs, track)) {
    const i = r.d - first; if (i >= 0 && i < N) joinDay[i] += r.n;
  }
  for (const r of all(`SELECT kind, CAST((at - ?) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM guild_member_log
      WHERE guild_id = ? AND kind IN ('join', 'leave') AND at >= ? GROUP BY kind, d`, shift, guildId, startMs)) {
    const i = r.d - first; if (i < 0 || i >= N) continue;
    if (r.kind === 'join') joinDay[i] += r.n;
  }
  const trackedDay = idx(track);
  for (let i = 0; i < N; i++) if (first + i >= trackedDay) leaveDay[i] = 0;
  for (const r of all("SELECT CAST((at - ?) / " + DAY + " AS INTEGER) AS d, COUNT(*) AS n FROM guild_member_log WHERE guild_id = ? AND kind = 'leave' AND at >= ? GROUP BY d", shift, guildId, startMs)) {
    const i = r.d - first; if (i >= 0 && i < N && leaveDay[i] !== null) leaveDay[i] += r.n;
  }

  const sum = (a, from, to) => a.slice(from, to).reduce((x, y) => x + (y || 0), 0);
  const leaveKnown = (from, to) => leaveDay.slice(from, to).filter((v) => v !== null).length;

  // ---- the busiest hours (this period only): weekday x hour of day
  const heat = Array.from({ length: 7 }, () => count(24));
  for (const r of all(`SELECT (CAST((m.created_at - ?) / ${DAY} AS INTEGER) + 4) % 7 AS wd, CAST((m.created_at - ?) / ${HOUR} AS INTEGER) % 24 AS hr, COUNT(*) AS n
    FROM channels c JOIN messages m ON m.channel_id = c.id LEFT JOIN users u ON u.id = m.author_id
    WHERE c.guild_id = ? AND m.id >= ? AND m.type IN (0, 19) AND m.crosspost IS NULL AND COALESCE(u.bot, 0) = 0 GROUP BY wd, hr`, shift, shift, guildId, idFloor(curStartMs))) {
    if (r.wd >= 0 && r.wd < 7 && r.hr >= 0 && r.hr < 24) heat[r.wd][r.hr] = r.n;
  }

  // ---- busiest channels and members (this period)
  // (a thread, or a post in a forum, counts for the channel it lives in)
  const channels = all(`SELECT COALESCE(p.id, c.id) AS id, COALESCE(p.name, c.name) AS name, COUNT(*) AS n
    FROM channels c LEFT JOIN channels p ON p.id = c.parent_id AND c.type = ${ChannelType.THREAD}
    JOIN messages m ON m.channel_id = c.id LEFT JOIN users u ON u.id = m.author_id
    WHERE c.guild_id = ? AND m.id >= ? AND m.type IN (0, 19) AND m.crosspost IS NULL AND COALESCE(u.bot, 0) = 0 GROUP BY COALESCE(p.id, c.id) ORDER BY n DESC LIMIT 8`, guildId, idFloor(curStartMs))
    .map((c) => ({ id: c.id, name: c.name, messages: c.n }));
  const topMembers = all(`SELECT m.author_id AS id, COUNT(*) AS n FROM channels c JOIN messages m ON m.channel_id = c.id LEFT JOIN users u ON u.id = m.author_id
    WHERE c.guild_id = ? AND m.id >= ? AND m.type IN (0, 19) AND m.crosspost IS NULL AND m.author_id IS NOT NULL AND COALESCE(u.bot, 0) = 0 GROUP BY m.author_id ORDER BY n DESC LIMIT 8`, guildId, idFloor(curStartMs))
    .map((r) => ({ user: publicUser(getUserRow(r.id)), messages: r.n })).filter((r) => r.user);

  // ---- new members who have said something
  const newcomers = get(`SELECT COUNT(*) AS joined, COALESCE(SUM(EXISTS (SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE c.guild_id = gm.guild_id AND m.author_id = gm.user_id AND m.type IN (0, 19) AND m.crosspost IS NULL)), 0) AS posted
    FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ? AND u.bot = 0 AND gm.joined_at >= ?`, guildId, curStartMs);

  const members = get('SELECT COUNT(*) AS n FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ? AND u.bot = 0', guildId).n;
  const series = Array.from({ length: days }, (_, k) => {
    const i = days + k;
    return { date: dateOf(first + i), messages: msgDay[i], active: activeDay[i], joined: joinDay[i], left: leaveDay[i] };
  });
  return {
    days, generatedAt: now, trackedSince: track,
    members: {
      now: members,
      joined: sum(joinDay, days, N), joinedPrev: sum(joinDay, 0, days),
      left: sum(leaveDay, days, N), leftPrev: sum(leaveDay, 0, days),
      leftKnownDays: leaveKnown(days, N), leftKnownDaysPrev: leaveKnown(0, days),
    },
    messages: { total: sum(msgDay, days, N), prev: sum(msgDay, 0, days) },
    active,
    newcomers: { joined: newcomers.joined, posted: newcomers.posted },
    series, heat, channels, topMembers,
  };
}

export default function register(r) {
  r.get('/api/guilds/:id/insights', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD, 'Only the server owner and people who can manage the server can see Insights.');
    const q = z.object({
      days: z.coerce.number().int().refine((n) => [7, 30, 90].includes(n), 'days must be 7, 30 or 90').default(30),
      tz: z.coerce.number().int().min(-840).max(840).default(0),
    }).parse(ctx.query);
    const key = `${guild.id}:${q.days}:${q.tz}`;
    const fresh = ctx.query.fresh === '1';
    if (fresh) enforceRateLimit(`insights-fresh:${ctx.user.id}`, 6, 60_000, 'Hold on a moment before refreshing again.');
    enforceRateLimit(`insights:${ctx.user.id}`, 60, 10 * 60_000);
    const hit = cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < TTL) return hit.data;
    const data = compute(guild.id, q.days, q.tz);
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 200) { const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100); for (const [k] of oldest) cache.delete(k); }
    return data;
  });
}
