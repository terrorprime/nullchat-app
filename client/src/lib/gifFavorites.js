// Your favorite GIFs. One list, shared by the GIF picker (the star on every GIF, the Favorites tab) and by chat (the star on a GIF
// someone sent). It is loaded when the app starts and kept right on every device you use by the server's GIF_FAVORITES_UPDATE.
import { store } from './state.js';
import { on } from './gateway.js';
import { api } from './api.js';
import { toast, toastError } from './toast.js';

/** A GIF is told apart by where it came from and its id there (an uploaded one and a GIPHY one could share an id). */
export const gifKey = (g) => `${g.source}:${g.id}`;

// ---- the list ----------------------------------------------------------------------------------------------------------
let loading = null;
/** Loads the list (once; `force` loads it again). Resolves with the items, or null when it could not be loaded. */
export function loadGifFavorites(force = false) {
  const have = store.get().gifFavorites;
  if (!force && have) return Promise.resolve(have);
  if (loading) return loading;
  loading = api.get('/gif-favorites')
    .then((r) => { store.set({ gifFavorites: r.items, gifFavoritesFailed: false }); return r.items; })
    .catch(() => { store.set({ gifFavoritesFailed: true }); return null; })
    .finally(() => { loading = null; });
  return loading;
}
on('READY', () => { loadGifFavorites(true); });

// What is in the list changes in one place each: starred (to the front, or updated where it already is), un-starred, or renamed.
const put = (item) => {
  const cur = store.get().gifFavorites;
  if (!cur) return;   // not loaded yet: the load that is coming will have it
  const i = cur.findIndex((x) => gifKey(x) === gifKey(item));
  store.set({ gifFavorites: i >= 0 ? cur.map((x, j) => (j === i ? { ...x, ...item } : x)) : [item, ...cur] });
};
export const dropFavorite = (source, id) => {
  const cur = store.get().gifFavorites;
  if (cur) store.set({ gifFavorites: cur.filter((x) => !(x.source === source && x.id === id)) });
};
/** A GIF that is already a favorite was edited (renamed): show the new name. */
export const syncFavorite = (item) => {
  const cur = store.get().gifFavorites;
  if (cur?.some((x) => gifKey(x) === gifKey(item))) put(item);
};

on('GIF_FAVORITES_UPDATE', (d) => {
  if (!store.get().gifFavorites) return;
  if (d.op === 'add' && d.item) put(d.item);
  else if (d.op === 'remove') dropFavorite(d.source, d.id);
  else loadGifFavorites(true);   // a GIF someone starred was renamed
});

// ---- starring ----------------------------------------------------------------------------------------------------------
/** What the server needs to remember a favorite: for an uploaded GIF just its id, for a GIPHY one also where to find it. */
const bodyOf = (g) => (g.source === 'giphy'
  ? { source: 'giphy', id: g.id, title: g.title || '', url: g.url, preview: g.preview, width: Math.round(g.width) || 0, height: Math.round(g.height) || 0 }
  : { source: 'library', id: g.id });

/** Star (`on`) or un-star a GIF you are looking at in the picker. The star changes at once; if the server says no it changes back and says why. */
export async function setFavorite(g, on) {
  const before = (store.get().gifFavorites || []).find((x) => gifKey(x) === gifKey(g));
  if (on) put({ ...g, favorite: true, favoritedAt: Date.now() }); else dropFavorite(g.source, g.id);
  try {
    if (on) await api.put('/gif-favorites', bodyOf(g));
    else await api.del(`/gif-favorites/${g.source}/${encodeURIComponent(g.id)}`);
    return true;
  } catch (e) {
    if (on) dropFavorite(g.source, g.id); else if (before) put(before);
    toastError(e, 'Couldn’t save that. Try again.');
    return false;
  }
}

// ---- GIFs in chat ------------------------------------------------------------------------------------------------------
const GIPHY_HOST = /^(media\d*|i)\.giphy\.com$/;
/** What a GIF link points at: an uploaded GIF's file, or GIPHY's id for it. null when it is neither (then there is no star). */
export function gifIdentity(link) {
  let u;
  try { u = new URL(String(link), location.origin); } catch { return null; }
  const mine = /^\/uploads\/gifs\/([0-9a-f]{32}\.(?:gif|webp))$/.exec(u.pathname);
  if (mine) return u.origin === location.origin ? `lib:${mine[1]}` : null;   // only a picture this server really serves (another site's look-alike path gets no star)
  if (u.protocol === 'https:' && GIPHY_HOST.test(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);   // media/<id>/giphy.gif, or media/v1.<token>/<id>/giphy.gif
    if (parts[0] === 'media' && parts.length >= 3) return `giphy:${parts[parts.length - 2]}`;
  }
  return null;
}
export const findFavoriteByLink = (items, link) => {
  const id = gifIdentity(link);
  return id ? (items || []).find((f) => gifIdentity(f.url) === id) || null : null;
};
/** The favorite-able GIF in a message: the link of its first picture that is an uploaded GIF or a GIPHY one. */
export function gifLinkOf(message) {
  for (const e of message?.embeds || []) {
    if (e.type !== 'image') continue;
    const link = e.image?.url || e.url;
    if (link && gifIdentity(link)) return { link, width: e.image?.width, height: e.image?.height };
  }
  return null;
}

/** The star on a GIF in chat (and "Add GIF to Favorites" in the message menu): star it if it isn't, un-star it if it is. */
export async function toggleChatGif({ link, width, height }) {
  let items = store.get().gifFavorites;
  if (!items) items = await loadGifFavorites();
  if (!items) { toast('Couldn’t load your favorite GIFs. Try again in a moment.', 'error'); return; }
  const have = findFavoriteByLink(items, link);
  if (have) {
    if (await setFavorite(have, false)) toast('Removed from your favorite GIFs', 'info', 2500);
    return;
  }
  try {
    const item = await api.put('/gif-favorites/link', { url: link, ...(width ? { width: Math.round(width) } : {}), ...(height ? { height: Math.round(height) } : {}) });
    put(item);
    toast('Added to your favorite GIFs', 'success', 2500);
  } catch (e) { toastError(e, 'Couldn’t save that. Try again.'); }
}
