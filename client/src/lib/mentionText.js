// @people, @roles and #channels: what a person types (and sees while editing) versus what is stored.
//   typed:   hi @bob and @Mods, see #random          stored:   hi <@123…> and <@&456…>, see <#789…>
// The composer turns typed into stored when a message is sent; the edit box shows typed (not the raw numbers) and turns it back when saved.
import { store, channelPermissions } from './state.js';
import { P, has, ChannelType, isVoiceLike } from '../../../shared/permissions.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Who and what can be mentioned in this channel by this person (`perms`: pass them in if already at hand). */
export function mentionContext(channelId, perms) {
  const s = store.get();
  const ch = s.channels[channelId];
  if (!ch) return { s, users: [], roles: [], channels: [], emojis: [] };
  const p = perms ?? channelPermissions(s, channelId);
  let users = [];
  let roles = [];
  let channels = [];
  if (ch.guildId) {
    users = Object.keys(s.members[ch.guildId] || {});
    roles = (s.guilds[ch.guildId]?.roles || []).filter((r) => r.id !== ch.guildId && (r.mentionable || has(p, P.MENTION_EVERYONE)));
    channels = (s.guildChannels[ch.guildId] || []).map((id) => s.channels[id]).filter((c) => c && c.type !== ChannelType.CATEGORY);
  } else users = [s.me.id, ...ch.recipients];
  const emojis = has(p, P.USE_EXTERNAL_EMOJIS) ? Object.values(s.guilds).flatMap((g) => g.emojis || []) : (s.guilds[ch.guildId]?.emojis || []);
  return { s, ch, users, roles, channels, emojis };
}

/** Typed → stored. Only a whole word counts: "joe@dev.com" is an e-mail address, not a mention of a role called "dev". */
export function encodeMentions(raw, { s, users, roles, channels }) {
  let out = raw;
  const byUsername = new Map(users.map((id) => [s.users[id]?.username, id]).filter(([u]) => u));
  out = out.replace(/(^|[^\w<])@([a-z0-9_.]{2,32})(?![a-z0-9_])/g, (m, pre, name) => {
    // (a name can end in a period, and so can a sentence: try the name as written, then without the trailing periods)
    for (let n = name; n.length >= 2; n = n.slice(0, -1)) {
      if (byUsername.has(n)) return `${pre}<@${byUsername.get(n)}>${name.slice(n.length)}`;
      if (!n.endsWith('.')) break;
    }
    return m;
  });
  for (const r of [...roles].sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`(^|[^\\w<])@${escapeRe(r.name)}(?!\\w)`, 'g'), `$1<@&${r.id}>`);
  }
  for (const c of [...channels].sort((a, b) => b.name.length - a.name.length)) {
    if (isVoiceLike(c.type)) continue;
    out = out.replace(new RegExp(`(^|\\s)#${escapeRe(c.name)}(?=$|[\\s.,!?])`, 'g'), `$1<#${c.id}>`);
  }
  return out;
}

/** Stored → typed, for the edit box. Whatever could not be turned back into exactly the same thing stays as it is. */
export function decodeMentions(content, ctx) {
  const { s, users, roles, channels } = ctx;
  const known = new Set(users);
  const names = new Set(users.map((id) => s.users[id]?.username).filter(Boolean));
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const chById = new Map(channels.filter((c) => !isVoiceLike(c.type)).map((c) => [c.id, c]));
  const word = /\w/;
  let out = content.replace(/<@!?(\d{19})>/g, (m, id, at, str) => (known.has(id) && s.users[id]?.username && !word.test(str[at - 1] || '') && !word.test(str[at + m.length] || '') ? `@${s.users[id].username}` : m));
  out = out.replace(/<@&(\d{19})>/g, (m, id, at, str) => { const r = roleById.get(id); return r && !names.has(r.name) && !word.test(str[at - 1] || '') && !word.test(str[at + m.length] || '') ? `@${r.name}` : m; });
  out = out.replace(/<#(\d{19})>/g, (m, id, at, str) => (chById.has(id) && (at === 0 || /\s/.test(str[at - 1])) && (at + m.length === str.length || /[\s.,!?]/.test(str[at + m.length])) ? `#${chById.get(id).name}` : m));
  // The safety net: if typing this back in would not give the message as it is stored, show it as it is stored.
  return encodeMentions(out, ctx) === content ? out : content;
}

/**
 * Where the mentions are in what is typed, so the message box can draw them as chips and treat each one as a single character.
 * The matching is exactly what encodeMentions() would turn into <@id> / <@&id> / <#id> when the message is sent (so a highlighted
 * mention is one that will really ping), plus @everyone / @here when `everyone` is true (they are not rewritten, the server reads them
 * as they are). Returns [{ start, end, kind: 'user' | 'role' | 'channel' | 'everyone', id }], in order, never overlapping.
 */
export function mentionSpans(raw, { s, users, roles, channels }, { everyone = false } = {}) {
  if (!raw || (raw.indexOf('@') < 0 && raw.indexOf('#') < 0)) return [];
  const spans = [];
  // Like encodeMentions, each kind is looked for in what the one before left: a found mention is blanked out, with something the same length
  // that looks like what sending writes (<…>), so whatever is next to it is judged exactly as it is when sending.
  let masked = raw;
  const blank = (a, b) => { masked = masked.slice(0, a) + '<' + 'x'.repeat(Math.max(0, b - a - 2)) + '>' + masked.slice(b); };
  const found = [];
  const byUsername = new Map(users.map((id) => [s.users[id]?.username, id]).filter(([u]) => u));
  const userRe = /(^|[^\w<])@([a-z0-9_.]{2,32})(?![a-z0-9_])/g;
  for (let m = userRe.exec(raw); m; m = userRe.exec(raw)) {
    const at = m.index + m[1].length;
    for (let n = m[2]; n.length >= 2; n = n.slice(0, -1)) {
      if (byUsername.has(n)) { found.push({ start: at, end: at + 1 + n.length, kind: 'user', id: byUsername.get(n) }); break; }
      if (!n.endsWith('.')) break;
    }
  }
  const take = () => { for (const x of found) { spans.push(x); blank(x.start, x.end); } found.length = 0; };
  take();
  for (const r of [...roles].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|[^\\w<])@${escapeRe(r.name)}(?!\\w)`, 'g');
    for (let m = re.exec(masked); m; m = re.exec(masked)) found.push({ start: m.index + m[1].length, end: m.index + m[0].length, kind: 'role', id: r.id, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null });
    take();
  }
  for (const c of [...channels].sort((a, b) => b.name.length - a.name.length)) {
    if (isVoiceLike(c.type)) continue;
    const re = new RegExp(`(^|\\s)#${escapeRe(c.name)}(?=$|[\\s.,!?])`, 'g');
    for (let m = re.exec(masked); m; m = re.exec(masked)) found.push({ start: m.index + m[1].length, end: m.index + m[0].length, kind: 'channel', id: c.id });
    take();
  }
  if (everyone) {
    const re = /(^|[^\w<])@(everyone|here)(?!\w)/g;
    for (let m = re.exec(masked); m; m = re.exec(masked)) found.push({ start: m.index + m[1].length, end: m.index + m[0].length, kind: 'everyone', id: m[2] });
    take();
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** mentionSpans() for the text of one channel's message box (who can be mentioned there, and whether @everyone / @here are allowed to this person). */
export function typedMentionSpans(raw, channelId, perms) {
  if (!raw || (raw.indexOf('@') < 0 && raw.indexOf('#') < 0)) return [];
  const ctx = mentionContext(channelId, perms);
  const p = perms ?? channelPermissions(store.get(), channelId);
  return mentionSpans(raw, ctx, { everyone: !!ctx.ch?.guildId && has(p, P.MENTION_EVERYONE) });
}
