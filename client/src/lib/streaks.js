// Streaks: days in a row that two friends have written to each other, and days in a row a server has been alive
// (server: routes/streaks.js; what a "day" is: shared/daytime.js).
import { store } from './state.js';
import { api } from './api.js';
import { getSetting } from './settings.js';
import { toast } from './toast.js';
import { displayName } from './state.js';

/** Load every streak this account is part of. Called when the app connects; after that, STREAK_UPDATE events keep them current. */
export async function loadStreaks() {
  try {
    const d = await api.get('/streaks');
    store.set({ streaks: { dms: d.dms || {}, guilds: d.guilds || {} } });
  } catch { /* streaks are a nicety */ }
}

/** Tell the server which time zone this device is in, when it does not know or it changed (streak days and birthdays use it). */
export function reportTimeZone() {
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* very old browser */ }
  if (!tz || store.get().settings?.timezone === tz) return;
  api.patch('/users/@me/settings', { timezone: tz }).catch(() => {});
}

const MILESTONES = new Set([3, 7, 14, 30, 50, 100, 150, 200, 250, 300, 365, 500, 730, 1000]);

/** A streak just went up: a small cheer at the round numbers. `openGuildId` is the server on screen (other servers stay quiet). */
export function cheerStreak(d, openGuildId) {
  if (getSetting('chat.streaks') === false || !MILESTONES.has(d.streak.count)) return;
  const s = store.get();
  if (d.channelId) {
    const other = s.channels[d.channelId]?.recipients?.[0];
    toast(`🔥 ${d.streak.count} days in a row with ${other ? displayName(s, other) : 'your friend'}`, 'success', 5000);
  } else if (d.guildId === openGuildId && s.guilds[d.guildId]) {
    toast(`🔥 ${s.guilds[d.guildId].name} has been active ${d.streak.count} days in a row`, 'success', 5000);
  }
}
