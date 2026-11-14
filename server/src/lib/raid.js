// Raid protection and the member log.
//   - Pause: an owner (or anyone who can manage the server) can stop new people joining, by hand ("invites_paused") or automatically
//     ("raid guard": when N people join within a minute, new joins are refused for ten minutes and the managers are told at once).
//   - The member log (guild_member_log) records every join and leave, so the guard can count the last minute exactly (people who joined
//     and were kicked a second later still count) and Server Insights can show who left. Bots are not logged.
// Pausing only stops people who are not in the server yet; everyone already in it is unaffected, and the Nullspace lounge is exempt.
import { get, run } from '../db.js';
import { HttpError } from './http.js';
import { sendToUsers, syncGuild } from '../gateway.js';
import { getGuildCore, getGuildMembers } from '../models.js';
import { computeBasePermissions, P, has } from '../../../shared/permissions.js';
import { pushNotice } from './push.js';
import { audit } from '../services.js';
import { RAID_MIN, RAID_DEFAULT, pauseState } from './pause.js';
import { isBotId } from './bots.js';

export const RAID_WINDOW_MS = 60_000;          // "within a minute"
export const RAID_PAUSE_MS = 10 * 60_000;      // how long an automatic pause lasts
const KEEP_MS = 400 * 24 * 3600 * 1000;        // the log is kept for a little over a year

/** Record that someone joined or left a server (`source` is the "joined from" label of the invite link they used; see shared/community.js) (kind: 'join' | 'leave' | 'start' = "tracked from here on" | 'reset' = "count raid joins from here"). */
export function logMember(guildId, kind, at = Date.now(), source = null) {
  try { run('INSERT INTO guild_member_log (guild_id, kind, at, source) VALUES (?, ?, ?, ?)', guildId, kind, at, source); }
  catch (e) { console.log('[raid] could not write the member log:', e.message); }   // (never stop someone joining over a log line)
}

/** Old log lines go after a little over a year (run at start and hourly). */
export function pruneMemberLog() {
  try { run("DELETE FROM guild_member_log WHERE at < ? AND kind != 'start'", Date.now() - KEEP_MS); } catch { /* next time */ }
}

const PAUSED_JOIN = {
  manual: 'This server isn’t taking new members right now. Ask someone who is in it to help.',
  raid: 'This server paused new members for a few minutes after a lot of people tried to join at once. Try again in a little while.',
};
export const pausedMessage = (state) => PAUSED_JOIN[state.kind] || PAUSED_JOIN.manual;

/** Throws when a new person may not join `g` right now. */
export function assertMayJoin(g) {
  const s = pauseState(g);
  if (s.paused) throw new HttpError(403, pausedMessage(s), 'invites_paused', { kind: s.kind, until: s.until });
}

/** Everyone who should hear about a raid: the owner and members who can manage the server (not bots). */
export function managerIds(guildId) {
  const guild = getGuildCore(guildId);
  if (!guild) return [];
  return getGuildMembers(guildId)
    .filter((m) => !isBotId(m.userId) && (m.userId === guild.ownerId || has(computeBasePermissions(guild, m), P.MANAGE_GUILD)))
    .map((m) => m.userId);
}

/** How many people joined in the last `ms` (counted from the log). */
export function recentJoins(guildId, ms = RAID_WINDOW_MS) {
  // (a 'reset' line, written when someone lifts a pause or changes the guard, means "count from here": lifting must not re-pause on the very next join)
  const reset = get("SELECT MAX(at) AS t FROM guild_member_log WHERE guild_id = ? AND kind = 'reset'", guildId)?.t || 0;
  return get("SELECT COUNT(*) AS n FROM guild_member_log WHERE guild_id = ? AND kind = 'join' AND at >= ?", guildId, Math.max(Date.now() - ms, reset + 1)).n;
}

/** Called after someone joined: if raid guard is on and too many joined this minute, pause new members and tell the managers. */
export function noteJoin(g) {
  try {
    if (!g.raid_guard) return;
    const now = Date.now();
    if (g.invites_paused || (g.raid_until && g.raid_until > now)) return;          // already closed
    const n = recentJoins(g.id);
    if (n < Math.max(RAID_MIN, g.raid_threshold || RAID_DEFAULT)) return;
    const until = now + RAID_PAUSE_MS;
    run('UPDATE guilds SET raid_until = ? WHERE id = ?', until, g.id);
    audit(g.id, null, 'RAID_GUARD', { targetId: g.id, targetType: 'guild', changes: { joins: n, withinSeconds: RAID_WINDOW_MS / 1000, pausedMinutes: RAID_PAUSE_MS / 60_000 } });
    syncGuild(g.id);
    const managers = managerIds(g.id);
    sendToUsers(managers, 'RAID_ALERT', { guildId: g.id, guildName: g.name, joins: n, until });
    pushNotice(managers, { title: `New members paused in ${g.name}`, body: `${n} people joined within a minute, so joining is paused for ${RAID_PAUSE_MS / 60_000} minutes.`, url: `/channels/${g.id}`, tag: `raid-${g.id}` });
    console.log(`[raid] ${g.name}: ${n} joins in a minute, new members paused until ${new Date(until).toISOString()}`);
  } catch (e) { console.log('[raid] guard failed:', e.message); }
}
