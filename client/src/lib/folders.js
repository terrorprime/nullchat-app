// Server folders: the layout of the server bar. A person's servers are in `settings.guildOrder` (a flat list, in bar order) and their folders
// in `settings.guildFolders` ([{ id, name, color, guildIds }]); both are synced with the account. Everything here works on a list of "items",
// each either a server ({ kind: 'guild', id }) or a folder ({ kind: 'folder', id, name, color, guildIds }), which is what the bar draws.
// The functions that change the layout are pure (they return a new list) so they can be tested; `saveLayout` writes the result back.
import { store } from './state.js';
import { updateSettings } from './settings.js';
import { cleanFolders, FOLDER_COLORS, FOLDERS_MAX } from '../../../shared/community.js';

export const newFolderId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The person's servers in bar order (servers not yet placed come last). */
export function sortGuildIds(guilds, order) {
  const idx = (id) => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; };
  return Object.values(guilds).sort((a, b) => idx(a.id) - idx(b.id)).map((g) => g.id);
}

/** Folders as they are saved, tidied: only servers the person is still in, a folder needs two. */
export function currentFolders(s = store.get()) {
  return cleanFolders(s.settings?.guildFolders, Object.keys(s.guilds));
}

/** The bar: a folder sits where its first server (in bar order) is, and holds its servers in the folder's own order. */
export function buildItems(ids, folders) {
  const byGuild = new Map();
  for (const f of folders) for (const g of f.guildIds) byGuild.set(g, f);
  const have = new Set(ids);
  const done = new Set();
  const items = [];
  for (const id of ids) {
    const f = byGuild.get(id);
    if (!f) { items.push({ kind: 'guild', id }); continue; }
    if (done.has(f.id)) continue;
    done.add(f.id);
    items.push({ kind: 'folder', id: f.id, name: f.name, color: f.color, guildIds: f.guildIds.filter((g) => have.has(g)) });
  }
  return items;
}

export function currentItems(s = store.get()) {
  return buildItems(sortGuildIds(s.guilds, s.settings?.guildOrder || []), currentFolders(s));
}

export function flatten(items) {
  return {
    order: items.flatMap((it) => (it.kind === 'folder' ? it.guildIds : [it.id])),
    folders: items.filter((it) => it.kind === 'folder').map(({ id, name, color, guildIds }) => ({ id, name, color, guildIds })),
  };
}

export function saveLayout(items) {
  const { order, folders } = flatten(items);
  updateSettings({ guildOrder: order, guildFolders: folders });
}

/** A folder with one server is just that server; one with none is gone. */
function tidy(list) {
  const out = [];
  for (const it of list) {
    if (it.kind !== 'folder') { out.push(it); continue; }
    if (it.guildIds.length >= 2) out.push(it);
    else if (it.guildIds.length === 1) out.push({ kind: 'guild', id: it.guildIds[0] });
  }
  return out;
}
const copy = (items) => items.map((it) => (it.kind === 'folder' ? { ...it, guildIds: [...it.guildIds] } : { ...it }));

/**
 * Drop something on the bar. `drag` is { kind, id }. `target` is { kind, id, inFolder? } (inFolder: the server sits inside that folder), or null
 * for "the end of the list". `zone` is 'before', 'after' or 'merge' (merge: put the dragged server together with the target in a folder).
 */
export function moveItem(items, drag, target, zone) {
  let list = copy(items);
  let pulled;
  if (drag.kind === 'folder') {
    const i = list.findIndex((x) => x.kind === 'folder' && x.id === drag.id);
    if (i < 0) return items;
    [pulled] = list.splice(i, 1);
  } else {
    pulled = { kind: 'guild', id: drag.id };
    let found = false;
    for (let i = 0; i < list.length && !found; i++) {
      const it = list[i];
      if (it.kind === 'guild' && it.id === drag.id) { list.splice(i, 1); found = true; }
      else if (it.kind === 'folder' && it.guildIds.includes(drag.id)) { it.guildIds = it.guildIds.filter((x) => x !== drag.id); found = true; }
    }
    if (!found) return items;
  }
  // (a folder that lost its second-last server is not dissolved yet: the target may be one of its servers)
  if (!target) { list.push(pulled); return tidy(list); }

  const at = (ref) => list.findIndex((x) => x.kind === ref.kind && x.id === ref.id);
  if (target.inFolder) {
    const fi = at({ kind: 'folder', id: target.inFolder });
    if (fi < 0) { list.push(pulled); return tidy(list); }
    if (pulled.kind === 'folder') { list.splice(fi, 0, pulled); return tidy(list); }
    const f = list[fi];
    const gi = f.guildIds.indexOf(target.id);
    f.guildIds.splice(gi < 0 ? f.guildIds.length : gi + (zone === 'after' ? 1 : 0), 0, pulled.id);
    return tidy(list);
  }
  const ti = at(target);
  if (ti < 0) { list.push(pulled); return tidy(list); }
  if (zone === 'merge' && pulled.kind === 'guild') {
    const t = list[ti];
    if (t.kind === 'folder') t.guildIds.push(pulled.id);
    else list[ti] = { kind: 'folder', id: newFolderId(), name: '', color: FOLDER_COLORS[0], guildIds: [t.id, pulled.id] };
    return tidy(list);
  }
  list.splice(zone === 'after' ? ti + 1 : ti, 0, pulled);
  return tidy(list);
}

export const folderCount = (items) => items.filter((i) => i.kind === 'folder').length;
export const canMakeFolder = (items) => folderCount(items) < FOLDERS_MAX;

/** Put servers together in a new folder, where the first of them is. */
export function makeFolder(items, guildIds, { name = '', color = FOLDER_COLORS[0] } = {}) {
  const ids = [...new Set(guildIds)];
  let list = copy(items);
  for (const it of list) if (it.kind === 'folder') it.guildIds = it.guildIds.filter((g) => !ids.includes(g));
  const first = list.findIndex((it) => it.kind === 'guild' && ids.includes(it.id));
  list = list.filter((it) => !(it.kind === 'guild' && ids.includes(it.id)));
  const folder = { kind: 'folder', id: newFolderId(), name, color, guildIds: ids };
  list.splice(first < 0 ? list.length : Math.min(first, list.length), 0, folder);
  return tidy(list);
}
export function addToFolder(items, folderId, guildId) {
  const list = copy(items);
  for (const it of list) if (it.kind === 'folder') it.guildIds = it.guildIds.filter((g) => g !== guildId);
  const f = list.find((it) => it.kind === 'folder' && it.id === folderId);
  if (!f) return items;
  f.guildIds.push(guildId);
  return tidy(list.filter((it) => !(it.kind === 'guild' && it.id === guildId)));
}
/** Take a server out of its folder; it lands right after the folder. */
export function removeFromFolder(items, guildId) {
  const list = copy(items);
  const fi = list.findIndex((it) => it.kind === 'folder' && it.guildIds.includes(guildId));
  if (fi < 0) return items;
  list[fi].guildIds = list[fi].guildIds.filter((g) => g !== guildId);
  list.splice(fi + 1, 0, { kind: 'guild', id: guildId });
  return tidy(list);
}
export function editFolder(items, folderId, patch) {
  return items.map((it) => (it.kind === 'folder' && it.id === folderId ? { ...it, ...patch } : it));
}
export function ungroup(items, folderId) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'folder' && it.id === folderId) out.push(...it.guildIds.map((id) => ({ kind: 'guild', id })));
    else out.push(it);
  }
  return out;
}

/** Run a change on the current bar and save it. */
export function changeLayout(fn) {
  const before = currentItems();
  const after = fn(before);
  if (after && after !== before) saveLayout(after);
}
