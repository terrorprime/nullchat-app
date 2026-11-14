// Bots on the client side: the slash commands of the bots in each server, running one, and private ("only you can see this") answers.
//
// A command is typed in the message box as  /name  followed by its options, either as "name:value" pairs or, for the first option, plain text:
//   /echo hello world            →  text = "hello world"
//   /echo hello times:3          →  text = "hello", times = 3
//   /pick color:Red who:@sam     →  color = "Red", who = Sam
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';
import { toastError } from './toast.js';

const loading = new Map();

/** Fetch (once) the slash commands of the bots in a server. Pass force to reload. */
export function loadCommands(guildId, force = false) {
  if (!guildId) return Promise.resolve([]);
  const have = store.get().commands[guildId];
  if (have && !force) return Promise.resolve(have);
  if (loading.has(guildId)) return loading.get(guildId);
  const p = api.get(`/guilds/${guildId}/commands`)
    .then((list) => { store.set({ commands: { ...store.get().commands, [guildId]: list } }); return list; })
    .catch(() => store.get().commands[guildId] || [])
    .finally(() => loading.delete(guildId));
  loading.set(guildId, p);
  return p;
}

// The bots in a server add / change / remove commands whenever they like: refresh what we already showed.
on('COMMANDS_UPDATE', (d) => { if (store.get().commands[d.guildId]) loadCommands(d.guildId, true); });

/** The bot command a typed line starts with, or null. `prefer` is the id picked from the list (two bots may share a name). */
export function matchBotCommand(guildId, text, prefer = null) {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const list = (store.get().commands[guildId] || []).filter((c) => c.name === name);
  if (!list.length) return null;
  const cmd = list.find((c) => c.id === prefer) || list[0];
  return { cmd, rest: (m[2] || '').replace(/^\s+/, '') };
}

/**
 * Split the text after the command name into its options.
 * Returns { values: { optionName: rawText }, order: [names in the order they appear] }.
 * Text before the first "name:" belongs to the command's first option.
 */
export function parseOptionText(cmd, rest) {
  const names = (cmd.options || []).map((o) => o.name);
  const values = {};
  if (!names.length) return { values, order: [] };
  const re = new RegExp(`(^|\\s)(${names.map((n) => n.replace(/[-]/g, '\\-')).join('|')}):`, 'g');
  const marks = [];
  for (let m = re.exec(rest); m; m = re.exec(rest)) marks.push({ name: m[2], start: m.index + m[1].length, valueStart: m.index + m[0].length });
  const first = marks.length ? rest.slice(0, marks[0].start).trim() : rest.trim();
  if (first) values[names[0]] = first;
  marks.forEach((mk, i) => { const v = rest.slice(mk.valueStart, marks[i + 1] ? marks[i + 1].start : undefined).trim(); if (v) values[mk.name] = v; });
  return { values, order: Object.keys(values) };
}

/** Turn what was typed into the values the server expects (ids for users / channels / roles, numbers, true / false). Throws a readable message. */
export function resolveOptions(cmd, guildId, values) {
  const s = store.get();
  const out = {};
  for (const o of cmd.options || []) {
    let v = values[o.name];
    if (v === undefined || v === '') {
      if (o.required) throw new Error(`“${o.name}” is needed. Type it after the command, for example  ${o.name}:…`);
      continue;
    }
    if (o.choices?.length) {
      const hit = o.choices.find((c) => c.name.toLowerCase() === v.toLowerCase() || String(c.value).toLowerCase() === v.toLowerCase());
      if (!hit) throw new Error(`“${o.name}” must be one of: ${o.choices.map((c) => c.name).join(', ')}.`);
      out[o.name] = hit.value; continue;
    }
    if (o.type === 'user') {
      const raw = v.replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '').toLowerCase();
      const id = Object.keys(s.members[guildId] || {}).find((uid) => uid === raw || s.users[uid]?.username?.toLowerCase() === raw || s.users[uid]?.displayName?.toLowerCase() === raw);
      if (!id) throw new Error(`“${o.name}”: no member called ${v}.`);
      v = id;
    } else if (o.type === 'channel') {
      const raw = v.replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').toLowerCase();
      const id = (s.guildChannels[guildId] || []).find((cid) => cid === raw || s.channels[cid]?.name?.toLowerCase() === raw);
      if (!id) throw new Error(`“${o.name}”: no channel called ${v}.`);
      v = id;
    } else if (o.type === 'role') {
      const raw = v.replace(/^<@&(\d+)>$/, '$1').replace(/^@/, '').toLowerCase();
      const role = (s.guilds[guildId]?.roles || []).find((r) => r.id === raw || r.name.toLowerCase() === raw);
      if (!role) throw new Error(`“${o.name}”: no role called ${v}.`);
      v = role.id;
    } else if (o.type === 'boolean') {
      if (/^(true|yes|on|1)$/i.test(v)) v = true; else if (/^(false|no|off|0)$/i.test(v)) v = false;
      else throw new Error(`“${o.name}” must be true or false.`);
    } else if (o.type === 'integer') {
      if (!/^-?\d+$/.test(v)) throw new Error(`“${o.name}” must be a whole number.`);
      v = Number(v);
    } else if (o.type === 'number') {
      if (!Number.isFinite(Number(v))) throw new Error(`“${o.name}” must be a number.`);
      v = Number(v);
    }
    out[o.name] = v;
  }
  return out;
}

/** Run a bot's command in a channel. Returns true when the bot was reached (its answer arrives as a normal message). */
export async function runBotCommand(channelId, cmd, options) {
  // Show "<bot> is typing…" from the moment the command goes out. A quick bot may answer before the request even comes back:
  // its answer (a normal message) clears the indicator, so it must already be there to be cleared. It also fades on its own.
  const mark = (on) => {
    const s = store.get();
    const here = { ...(s.typing[channelId] || {}) };
    if (on) here[cmd.botId] = Date.now(); else delete here[cmd.botId];
    store.set({ typing: { ...s.typing, [channelId]: here } });
  };
  mark(true);
  try {
    await api.post(`/channels/${channelId}/interactions`, { commandId: cmd.id, options });
    return true;
  } catch (e) { mark(false); toastError(e); return false; }
}

/** Remove a private answer from the list (it only ever existed on this screen). */
export function dismissEphemeral(channelId, messageId) {
  const s = store.get();
  const entry = s.messages[channelId];
  if (!entry) return;
  store.set({ messages: { ...s.messages, [channelId]: { ...entry, list: entry.list.filter((m) => m.id !== messageId) } } });
}
