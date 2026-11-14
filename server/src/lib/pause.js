// Is a server refusing new members, and what does the client get to know about its safety settings? (No imports: models.js uses this.)
export const RAID_MIN = 3, RAID_MAX = 100, RAID_DEFAULT = 10;

/** Is this server refusing new members right now, and why? `g` is a guilds row. */
export function pauseState(g) {
  if (!g) return { paused: false };
  if (g.invites_paused) return { paused: true, kind: 'manual', until: null };
  if (g.raid_until && g.raid_until > Date.now()) return { paused: true, kind: 'raid', until: g.raid_until };
  return { paused: false };
}

/** The server's safety settings as the client uses them. */
export function safetyOf(g) {
  const s = pauseState(g);
  return {
    invitesPaused: !!g.invites_paused,
    raidGuard: !!g.raid_guard,
    raidThreshold: g.raid_threshold || RAID_DEFAULT,
    raidUntil: g.raid_until && g.raid_until > Date.now() ? g.raid_until : 0,
    paused: s.paused,
  };
}
