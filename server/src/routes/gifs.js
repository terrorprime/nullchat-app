// GIFs that people on this server upload themselves. Everyone can search them and send them; no outside service
// (or API key) is involved. GIPHY, when an administrator has set it up, stays available as a second source in the picker.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { receiveUpload, sniffImage, removeUpload } from '../lib/uploads.js';
import { isAdmin } from '../lib/admin.js';
import { sendToUser } from '../gateway.js';
import { config, UPLOAD_DIR } from '../config.js';

export const GIF_MAX_BYTES = 5 * 1024 * 1024;   // GIFs are loaded many at a time in the picker, so keep them light
export const GIF_PER_PERSON = 300;
export const MAX_FAVORITE_GIFS = 200;
const PAGE = 24;

export const gifUrlOf = (row) => `/uploads/gifs/${row.stored_name}`;

export function serializeGif(row, user) {
  const mine = !!user && row.uploader_id === user.id;
  return {
    id: row.id,
    name: row.name,
    tags: row.tags ? row.tags.split(' ') : [],
    url: gifUrlOf(row),
    preview: gifUrlOf(row),
    width: row.width || 0,
    height: row.height || 0,
    uses: row.uses,
    uploaderId: row.uploader_id,
    mine,
    canDelete: mine || isAdmin(user),
    createdAt: row.created_at,
  };
}

export function cleanName(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'GIF';
}
/** "funny, cat  #lol" -> "funny cat lol" (lower-case words, at most 10) */
export function cleanTags(v) {
  const out = [];
  for (const t of String(v ?? '').toLowerCase().normalize('NFKC').split(/[,\s#]+/)) {
    if (/^[\p{L}\p{N}_-]{1,24}$/u.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 10) break;
  }
  return out.join(' ');
}

// ---- favorites ---------------------------------------------------------------------------------------------------
// A GIPHY favorite keeps the link it was found at, so only GIPHY's own picture hosts are accepted: nobody can park an arbitrary
// address in their list (and have it loaded into every picker they open) by calling the API by hand.
const GIPHY_HOST = /^(media\d*|i)\.giphy\.com$/;
export function cleanGiphyUrl(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:' || !GIPHY_HOST.test(u.hostname) || u.username || u.password) return null;
    const out = u.origin + u.pathname;
    return out.length <= 400 ? out : null;
  } catch { return null; }
}

const favoriteInput = z.object({
  source: z.enum(['library', 'giphy']),
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
  preview: z.string().max(500).optional(),
  width: z.number().int().min(0).max(5000).optional(),
  height: z.number().int().min(0).max(5000).optional(),
});

/** The favorite as the picker shows it: the same shape as a search result, plus where it came from. */
function serializeFavorite(f, user) {
  if (f.source === 'library') {
    const g = get('SELECT * FROM gifs WHERE id = ? AND removed = 0', f.ref);
    return g ? { ...serializeGif(g, user), source: 'library', favorite: true, favoritedAt: f.created_at } : null;
  }
  return { id: f.ref, source: 'giphy', favorite: true, favoritedAt: f.created_at, title: f.title, url: f.url, preview: f.preview || f.url, width: f.width || 200, height: f.height || 150 };
}

/** Tell every app this person has open (the phone, the laptop) that their favorites changed, so the star is right on all of them. */
const tell = (userId, payload) => { try { sendToUser(userId, 'GIF_FAVORITES_UPDATE', payload); } catch { /* live updates are a nicety */ } };

/**
 * A GIF link from a chat message -> the favorite it stands for: a GIF uploaded to this server, or one on GIPHY.
 * null when it is neither; { gone: true } for an uploaded GIF that has since been removed.
 */
export function favoriteFromLink(link) {
  let u;
  try { u = new URL(String(link), 'http://localhost'); } catch { return null; }
  const mine = /^\/uploads\/gifs\/([0-9a-f]{32}\.(?:gif|webp))$/.exec(u.pathname);
  if (mine) {
    const g = get('SELECT id FROM gifs WHERE stored_name = ? AND removed = 0', mine[1]);
    return g ? { source: 'library', id: g.id } : { gone: true };
  }
  const url = cleanGiphyUrl(link);
  if (!url) return null;
  const parts = new URL(url).pathname.split('/').filter(Boolean);   // media/<id>/giphy.gif, or media/v1.<token>/<id>/giphy.gif
  const id = parts[0] === 'media' && parts.length >= 3 ? parts[parts.length - 2] : null;
  if (!id || !/^[A-Za-z0-9_-]{3,40}$/.test(id)) return null;
  return { source: 'giphy', id, url, preview: url.replace(/\/giphy\.gif$/, '/200w.gif') };
}

/** Star it (an uploaded GIF by id, a GIPHY one by link). Starring one that is already starred changes nothing. */
function saveFavorite(user, b) {
  let title = '', url = null, preview = null, width = 0, height = 0;
  if (b.source === 'library') {
    if (!get('SELECT 1 FROM gifs WHERE id = ? AND removed = 0', b.id)) throw notFound('That GIF is gone.');
  } else {
    url = cleanGiphyUrl(b.url);
    preview = b.preview ? cleanGiphyUrl(b.preview) : url;
    if (!url || !preview) throw bad('That isn’t a GIF from GIPHY.');
    title = String(b.title ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    width = b.width || 0; height = b.height || 0;
  }
  let added = false;
  if (!get('SELECT 1 FROM gif_favorites WHERE user_id = ? AND source = ? AND ref = ?', user.id, b.source, b.id)) {
    purgeGifFavorites(user.id);
    if (get('SELECT COUNT(*) AS n FROM gif_favorites WHERE user_id = ?', user.id).n >= MAX_FAVORITE_GIFS) {
      throw bad(`You can keep up to ${MAX_FAVORITE_GIFS} favorite GIFs. Un-star one to add another.`, 'favorites_full');
    }
    run('INSERT INTO gif_favorites (user_id, source, ref, title, url, preview, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, b.source, b.id, title, url, preview, width, height, Date.now());
    added = true;
  }
  const item = serializeFavorite(get('SELECT * FROM gif_favorites WHERE user_id = ? AND source = ? AND ref = ?', user.id, b.source, b.id), user);
  if (added) tell(user.id, { op: 'add', item });
  return item;
}

/** Favorites of GIFs that were removed leave the list. Cheap, and run at start, every hour, and before anyone's list is counted. */
export function purgeGifFavorites(userId) {
  const where = "source = 'library' AND ref NOT IN (SELECT id FROM gifs WHERE removed = 0)";
  if (userId) run(`DELETE FROM gif_favorites WHERE user_id = ? AND ${where}`, userId);
  else run(`DELETE FROM gif_favorites WHERE ${where}`);
}

/** Width and height from the file itself (GIF header, or the WebP canvas). 0 when it can't be told. */
function dimensions(file, type) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, 0); fs.closeSync(fd);
    if (type === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.slice(12, 16).toString('ascii') === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  } catch { /* the picker uses the image's own size */ }
  return { width: 0, height: 0 };
}

/**
 * An earlier build shipped 36 ready-made GIFs and added them to the database the first time the server started. They are
 * gone again: this clears them from a server that already got them. Only those rows are touched: they have no uploader and a
 * creation time of a few seconds after 1970, which no real upload ever has (a GIF whose uploader's account was deleted also has
 * no uploader, but it has a real date). One already sent in chat is hidden instead, so those messages keep their picture.
 */
export function removeStarterGifs() {
  const rows = all('SELECT id, stored_name, uses FROM gifs WHERE uploader_id IS NULL AND created_at < 100000');
  for (const g of rows) {
    if (g.uses > 0) run('UPDATE gifs SET removed = 1 WHERE id = ?', g.id);
    else { run('DELETE FROM gifs WHERE id = ?', g.id); removeUpload('gifs', g.stored_name); }
    run("DELETE FROM gif_favorites WHERE source = 'library' AND ref = ?", g.id);
  }
  run("DELETE FROM _meta WHERE key = 'gifs.seeded'");
  if (rows.length) console.log(`[gifs] removed ${rows.length} starter GIFs`);
}

const likeTerm = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

export default function register(r) {
  // Search (or, with no words, the most used and newest) — `scope=mine` for only your own uploads.
  r.get('/api/gifs', async (ctx) => {
    enforceRateLimit(`gifs:${ctx.user.id}`, 120, 60_000);
    const q = String(ctx.query.q || '').normalize('NFKC').slice(0, 100);
    const terms = q.toLowerCase().split(/[\s,#]+/).filter(Boolean).slice(0, 5).map((t) => t.slice(0, 30));
    const mine = ctx.query.scope === 'mine';
    const offset = Math.max(0, Math.min(Number.parseInt(ctx.query.offset, 10) || 0, 5000));
    const where = ['removed = 0'];
    const args = [];
    if (mine) { where.push('uploader_id = ?'); args.push(ctx.user.id); }
    for (const t of terms) { where.push("(name LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')"); args.push(likeTerm(t), likeTerm(t)); }
    const rows = all(`SELECT * FROM gifs WHERE ${where.join(' AND ')} ORDER BY ${mine ? 'created_at DESC' : 'uses DESC, created_at DESC'} LIMIT ? OFFSET ?`, ...args, PAGE + 1, offset);
    return { results: rows.slice(0, PAGE).map((g) => serializeGif(g, ctx.user)), hasMore: rows.length > PAGE, giphy: !!config.giphyKey };
  });

  // Upload one. The body is the file itself; the name and tags travel in the query string.
  r.post('/api/gifs', { raw: true }, async (ctx) => {
    try {
      enforceRateLimit(`gifup:${ctx.user.id}`, 20, 60 * 60_000, 'You are uploading GIFs too quickly. Try again in a little while.');
      if (get('SELECT COUNT(*) AS n FROM gifs WHERE uploader_id = ? AND removed = 0', ctx.user.id).n >= GIF_PER_PERSON) {
        throw bad(`You already have ${GIF_PER_PERSON} GIFs uploaded. Remove one to add another.`);
      }
    } catch (e) { ctx.req.resume(); throw e; }
    const up = await receiveUpload(ctx.req, 'gifs', GIF_MAX_BYTES);
    const sig = sniffImage(up.head);
    if (!sig || (sig.type !== 'image/gif' && sig.type !== 'image/webp')) {
      fs.rmSync(up.filePath, { force: true });
      throw bad('Please upload a GIF (an animated WebP works too).');
    }
    const storedName = up.storedName + sig.ext;
    fs.renameSync(up.filePath, path.join(UPLOAD_DIR, 'gifs', storedName));
    const dim = dimensions(path.join(UPLOAD_DIR, 'gifs', storedName), sig.type);
    const id = newId();
    run(`INSERT INTO gifs (id, uploader_id, name, tags, stored_name, content_type, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.user.id, cleanName(ctx.query.name), cleanTags(ctx.query.tags), storedName, sig.type, up.size, dim.width, dim.height, Date.now());
    return serializeGif(get('SELECT * FROM gifs WHERE id = ?', id), ctx.user);
  });

  // Change the name or tags of a GIF you uploaded.
  r.patch('/api/gifs/:id', async (ctx) => {
    const g = get('SELECT * FROM gifs WHERE id = ? AND removed = 0', ctx.params.id);
    if (!g) throw notFound('That GIF is gone.');
    if (g.uploader_id !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('You can only change your own GIFs.');
    const b = ctx.body || {};
    const name = b.name === undefined ? g.name : cleanName(b.name);
    const tags = b.tags === undefined ? g.tags : cleanTags(b.tags);
    run('UPDATE gifs SET name = ?, tags = ? WHERE id = ?', name, tags, g.id);
    for (const f of all("SELECT user_id FROM gif_favorites WHERE source = 'library' AND ref = ?", g.id)) tell(f.user_id, { op: 'refresh' });   // the new name shows in their favorites
    return serializeGif(get('SELECT * FROM gifs WHERE id = ?', g.id), ctx.user);
  });

  // Remove one. Your own, or any if you run the server.
  r.delete('/api/gifs/:id', async (ctx) => {
    const g = get('SELECT * FROM gifs WHERE id = ? AND removed = 0', ctx.params.id);
    if (!g) throw notFound('That GIF is gone.');
    if (g.uploader_id !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('You can only remove your own GIFs.');
    if (g.uses > 0) run('UPDATE gifs SET removed = 1 WHERE id = ?', g.id);   // already sent in chat: it leaves the picker, the file stays so those messages still show it
    else { run('DELETE FROM gifs WHERE id = ?', g.id); removeUpload('gifs', g.stored_name); }
    const fans = all("SELECT user_id FROM gif_favorites WHERE source = 'library' AND ref = ?", g.id);
    run("DELETE FROM gif_favorites WHERE source = 'library' AND ref = ?", g.id);   // and out of everyone's favorites
    for (const f of fans) tell(f.user_id, { op: 'remove', source: 'library', id: g.id });
    return { ok: true };
  });

  // ---- favorites: the star in the picker. Private to you, and the same on every device you use. ----
  r.get('/api/gif-favorites', async (ctx) => {
    enforceRateLimit(`giffavs:${ctx.user.id}`, 120, 60_000);
    const rows = all('SELECT * FROM gif_favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC', ctx.user.id);
    return { items: rows.map((f) => serializeFavorite(f, ctx.user)).filter(Boolean), limit: MAX_FAVORITE_GIFS, giphy: !!config.giphyKey };
  });

  // Star one. Starring one that is already starred changes nothing (it keeps its place in the list).
  r.put('/api/gif-favorites', async (ctx) => {
    enforceRateLimit(`giffavw:${ctx.user.id}`, 60, 60_000);
    return saveFavorite(ctx.user, favoriteInput.parse(ctx.body || {}));
  });

  // Star the GIF in a chat message, from its link: one uploaded to this server, or one from GIPHY.
  r.put('/api/gif-favorites/link', async (ctx) => {
    enforceRateLimit(`giffavw:${ctx.user.id}`, 60, 60_000);
    const b = z.object({
      url: z.string().min(1).max(600),
      title: z.string().max(200).optional(),
      width: z.number().int().min(0).max(5000).optional(),
      height: z.number().int().min(0).max(5000).optional(),
    }).parse(ctx.body || {});
    const found = favoriteFromLink(b.url);
    if (!found) throw bad('Only GIFs from this server or from GIPHY can be added to your favorites.', 'not_a_favorite_gif');
    if (found.gone) throw notFound('That GIF has been removed, so it can’t be added to your favorites.');
    return saveFavorite(ctx.user, { ...found, title: b.title, width: b.width, height: b.height });
  });

  r.delete('/api/gif-favorites/:source/:id', async (ctx) => {
    enforceRateLimit(`giffavw:${ctx.user.id}`, 60, 60_000);
    run('DELETE FROM gif_favorites WHERE user_id = ? AND source = ? AND ref = ?', ctx.user.id, ctx.params.source, ctx.params.id);
    tell(ctx.user.id, { op: 'remove', source: ctx.params.source, id: ctx.params.id });
    return { ok: true };
  });
}
