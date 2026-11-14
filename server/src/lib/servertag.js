// Server tags: the small rules and lookups (see routes/servertags.js).
//   - A server has at most one tag: text (2 to 4 capital letters or numbers, unique on the whole site), a colour and a badge
//     (one of the built-in icons, or a picture the server uploaded).
//   - A member may wear ONE server's tag at a time (users.tag_guild_id). It is dropped the moment they leave, are kicked or banned, or the server
//     removes its tag or is deleted, so a tag on a person is always one they still belong to.
//   - What the server has set is cached here (it is read for every person drawn on screen); every change goes through forget().
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run } from '../db.js';
import { UPLOAD_DIR } from '../config.js';
import { removeUpload } from './uploads.js';
import { TAG_ICONS, TAG_BADGE_URL, DEFAULT_TAG_ICON, DEFAULT_TAG_COLOR } from '../../../shared/tags.js';

const cache = new Map();   // guildId -> { text, badge, color } | null

/** The badge as it is stored in a guild row: "icon:bolt" or the URL of an uploaded picture. */
export function badgeFromStored(v) {
  if (typeof v === 'string' && TAG_BADGE_URL.test(v)) return { kind: 'image', url: v };
  const name = typeof v === 'string' && v.startsWith('icon:') ? v.slice(5) : DEFAULT_TAG_ICON;
  return { kind: 'icon', name: TAG_ICONS[name] ? name : DEFAULT_TAG_ICON };
}
export const badgeToStored = (b) => (b.kind === 'image' ? b.url : `icon:${b.name}`);

/** A guilds row's tag, as the client uses it, or null when the server has none. */
export function tagFromRow(g) {
  if (!g?.tag) return null;
  return { text: g.tag, badge: badgeFromStored(g.tag_badge), color: g.tag_color || DEFAULT_TAG_COLOR };
}

export function tagOfGuild(guildId) {
  if (!guildId) return null;
  if (cache.has(guildId)) return cache.get(guildId);
  const t = tagFromRow(get('SELECT tag, tag_badge, tag_color FROM guilds WHERE id = ?', guildId));
  cache.set(guildId, t);
  return t;
}
export const forget = (guildId) => { cache.delete(guildId); };

/** The tag a person (a users row) is wearing, or null. Undefined when the row doesn't say (a partial query), so nothing is overwritten. */
export function wornTag(u) {
  if (!u || !('tag_guild_id' in u)) return undefined;
  if (!u.tag_guild_id) return null;
  const t = tagOfGuild(u.tag_guild_id);
  return t ? { guildId: u.tag_guild_id, ...t } : null;
}

/** Stop this person wearing this server's tag. Returns true when they were. */
export function clearWornTag(guildId, userId) {
  return run('UPDATE users SET tag_guild_id = NULL WHERE id = ? AND tag_guild_id = ?', userId, guildId).changes > 0;
}

export const wearerCount = (guildId) => get('SELECT COUNT(*) AS n FROM users WHERE tag_guild_id = ?', guildId).n;

/** Delete an uploaded badge file, unless another server also points at it. */
export function removeBadgeFile(url) {
  if (typeof url !== 'string' || !TAG_BADGE_URL.test(url)) return;
  if (get('SELECT 1 AS x FROM guilds WHERE tag_badge = ?', url)) return;
  removeUpload('tagbadges', path.basename(url));
}

export const badgeFileExists = (url) => TAG_BADGE_URL.test(url) && fs.existsSync(path.join(UPLOAD_DIR, 'tagbadges', path.basename(url)));

/** Uploaded badges nobody uses any more (picked and never saved, or replaced): removed after an hour. Run hourly. */
export function sweepTagBadges() {
  const dir = path.join(UPLOAD_DIR, 'tagbadges');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const used = new Set(all("SELECT tag_badge FROM guilds WHERE tag_badge LIKE '/uploads/tagbadges/%'").map((r) => path.basename(r.tag_badge)));
  const old = Date.now() - 3600 * 1000;
  for (const n of names) {
    if (used.has(n)) continue;
    try { if (fs.statSync(path.join(dir, n)).mtimeMs < old) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* next time */ }
  }
}
