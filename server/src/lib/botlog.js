// Developer Portal activity log: the last things each bot was asked to do (a slash command, a button press, a menu pick, a form)
// and how it went, so the person building the bot can see what arrives and how quickly it answers.
//
//   · Kept in memory only (50 per bot), so it starts empty after the server restarts.
//   · It holds WHO asked and WHAT (the command name or the button's id), never what they typed into a command or a form.
const MAX_ENTRIES = 50;
const logs = new Map();   // bot id -> entries, oldest first
const open = new Map();   // interaction id -> its entry (to fill in the outcome)

function push(botId, entry) {
  let list = logs.get(botId);
  if (!list) { list = []; logs.set(botId, list); }
  list.push(entry);
  while (list.length > MAX_ENTRIES) { const old = list.shift(); open.delete(old.id); }
  return entry;
}

const base = (id, kind, name, who) => ({
  id, at: Date.now(), kind, name: String(name).slice(0, 100), userId: who.userId, userName: String(who.userName || '').slice(0, 64),
  channelId: who.channelId, guildId: who.guildId, status: 'waiting', ms: null, how: null, error: null,
});

/** The bot was sent an interaction and now has a few seconds to answer. `kind`: command | button | menu | form. */
export function logDelivered(it, kind, name, userName) {
  const e = push(it.botId, base(it.id, kind, name, { userId: it.userId, userName, channelId: it.channelId, guildId: it.guildId }));
  open.set(it.id, e);
}

/** Someone tried to use the bot while it was not connected. */
export function logOffline(botId, kind, name, who) {
  push(botId, { ...base(`off-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, name, who), status: 'offline' });
}

/** The bot gave its first answer (`how`: message, defer, update, defer_update or modal). */
export function logAnswered(it, how) {
  const e = open.get(it.id);
  if (!e || e.status !== 'waiting') return;
  e.status = 'answered'; e.ms = Date.now() - e.at; e.how = how || 'message';
}

/** The answer was refused or could not be delivered. */
export function logFailed(it, message) {
  const e = open.get(it.id);
  if (!e) return;
  e.status = 'failed'; e.error = String(message || 'Something went wrong').slice(0, 200);
  if (e.ms === null) e.ms = Date.now() - e.at;
}

/** Nobody answered in time. */
export function logTimeout(it) {
  const e = open.get(it.id);
  if (!e || e.status !== 'waiting') return;
  e.status = 'timeout'; e.ms = Date.now() - e.at;
}

/** Newest first. */
export function botActivity(botId) {
  return [...(logs.get(botId) || [])].reverse();
}

export function clearBotLog(botId) {
  for (const e of logs.get(botId) || []) open.delete(e.id);
  logs.delete(botId);
}
