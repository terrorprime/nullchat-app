// Where a dragged channel or category lands, and the position updates that make it so.
// Pure functions (no DOM, no store) so the rules can be tested on their own.
//
// `layout` is what sortedGuildChannels() returns: { uncategorized: [channel], categories: [{ category, channels: [channel] }] }.
// Inside one category (or the uncategorized list) text channels are listed first and voice channels after them, each kind in its own
// order, so a channel can only be placed among its own kind. A voice channel dropped on a text channel lands at the top of the voice
// channels, a text channel dropped on a voice channel at the bottom of the text channels.
import { isVoiceLike } from '../../../shared/permissions.js';

const isVoice = (c) => isVoiceLike(c.type);   // voice and stage channels sit together under the text ones

const containerList = (layout, parentId) => (parentId ? layout.categories.find((c) => c.category.id === parentId)?.channels : layout.uncategorized) || [];

function findChannel(layout, id) {
  for (const c of layout.uncategorized) if (c.id === id) return c;
  for (const { channels } of layout.categories) { const c = channels.find((x) => x.id === id); if (c) return c; }
  return null;
}
export const parentOf = (layout, id) => {
  if (layout.uncategorized.some((c) => c.id === id)) return null;
  return layout.categories.find((c) => c.channels.some((x) => x.id === id))?.category.id ?? null;
};

/**
 * Work out where a dragged channel would go if it were dropped on `hover`.
 *   hover: { kind: 'channel' | 'category' | 'zone', id }   (a zone is the "no category" drop area; a category is its header)
 *   after: the pointer is in the lower half of the hovered row
 * Returns { parentId, index, anchor, noop } or null when the channel isn't in this layout.
 *   index  — the place in the list of that kind of channel, with the dragged channel taken out first
 *   anchor — what to draw the drop marker against: { before: id } | { after: id } | { into: categoryId } | { zone: true }
 *   noop   — dropping here would change nothing
 */
export function resolveChannelDrop(layout, dragId, hover, after) {
  const dragged = findChannel(layout, dragId);
  if (!dragged) return null;
  const voice = isVoice(dragged);
  const from = parentOf(layout, dragId);

  let parentId, index, intoHeader = false;
  if (hover.kind === 'category') {
    parentId = hover.id; index = 0; intoHeader = true;
  } else if (hover.kind === 'zone') {
    parentId = null; index = Infinity;
  } else {
    if (hover.id === dragId) return { parentId: from, index: -1, anchor: null, noop: true };
    const h = findChannel(layout, hover.id);
    if (!h) return null;
    parentId = parentOf(layout, hover.id);
    const run = containerList(layout, parentId).filter((c) => isVoice(c) === voice && c.id !== dragId);
    if (isVoice(h) === voice) index = run.findIndex((c) => c.id === h.id) + (after ? 1 : 0);
    else index = voice ? 0 : run.length; // dropped on the other kind: top of the voice run / bottom of the text run
  }

  const all = containerList(layout, parentId).filter((c) => c.id !== dragId);
  const run = all.filter((c) => isVoice(c) === voice);
  index = Math.max(0, Math.min(index, run.length));

  let anchor;
  if (intoHeader) anchor = { into: parentId };
  else if (run[index]) anchor = { before: run[index].id };
  else if (run.length) anchor = { after: run[run.length - 1].id };
  else if (all.length) anchor = voice ? { after: all[all.length - 1].id } : { before: all[0].id };
  else anchor = parentId ? { into: parentId } : { zone: true };

  const sameRun = containerList(layout, from).filter((c) => isVoice(c) === voice);
  const next = [...run.slice(0, index), dragged, ...run.slice(index)];
  const noop = parentId === from && next.length === sameRun.length && next.every((c, i) => c.id === sameRun[i].id);
  return { parentId, index, anchor, noop };
}

/** The position updates for a resolved channel drop, in the shape PATCH /guilds/:id/channels takes. */
export function planChannelMove(layout, dragId, drop) {
  const dragged = findChannel(layout, dragId);
  if (!dragged || !drop || drop.noop) return [];
  const voice = isVoice(dragged);
  const run = containerList(layout, drop.parentId).filter((c) => isVoice(c) === voice && c.id !== dragId);
  const index = Math.max(0, Math.min(drop.index, run.length));
  run.splice(index, 0, dragged);
  return run.map((c, i) => ({ id: c.id, position: i, parentId: drop.parentId }));
}

/** Where a dragged category lands if dropped on the header `hoverId` (before it, or after it when `after`). */
export function resolveCategoryDrop(layout, dragId, hoverId, after) {
  const all = layout.categories.map((c) => c.category);
  const dragged = all.find((c) => c.id === dragId);
  if (!dragged) return null;
  if (hoverId === dragId) return { index: -1, anchor: null, noop: true };
  const others = all.filter((c) => c.id !== dragId);
  const at = others.findIndex((c) => c.id === hoverId);
  if (at < 0) return null;
  const index = at + (after ? 1 : 0);
  const anchor = others[index] ? { before: others[index].id } : { after: others[others.length - 1].id };
  const next = [...others.slice(0, index), dragged, ...others.slice(index)];
  return { index, anchor, noop: next.every((c, i) => c.id === all[i].id) };
}

export function planCategoryMove(layout, dragId, drop) {
  const all = layout.categories.map((c) => c.category);
  const dragged = all.find((c) => c.id === dragId);
  if (!dragged || !drop || drop.noop) return [];
  const others = all.filter((c) => c.id !== dragId);
  others.splice(Math.max(0, Math.min(drop.index, others.length)), 0, dragged);
  return others.map((c, i) => ({ id: c.id, position: i }));
}

/** One step up (-1) or down (+1) among the channels of its own kind in its own category. [] when it is already at that end. */
export function planChannelStep(layout, id, dir) {
  const ch = findChannel(layout, id);
  if (!ch) return [];
  const parentId = parentOf(layout, id);
  const run = containerList(layout, parentId).filter((c) => isVoice(c) === isVoice(ch));
  const i = run.findIndex((c) => c.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= run.length) return [];
  const next = run.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next.map((c, k) => ({ id: c.id, position: k, parentId }));
}

/** Can this channel move one step up / down? Used to grey out the menu items. */
export function canStep(layout, id, dir) { return planChannelStep(layout, id, dir).length > 0; }

// ---- a plain list (the roles of a server) ------------------------------------------------------------------------------------
/**
 * Where a dragged item lands in a flat list when it is dropped on `hoverId`.
 *   ids         — the whole list in its current order
 *   locked      — how many items at the top cannot be moved, or be moved past (roles above your own highest role)
 *   after       — the pointer is in the lower half of the hovered row
 * Returns { order, index, anchor, noop } or null when the dragged item can't move.
 *   anchor — what to draw the drop line against: { before: id } | { after: id }
 */
export function resolveListDrop(ids, dragId, hoverId, after, locked = 0) {
  const from = ids.indexOf(dragId);
  if (from < locked) return null;                       // not in the list, or one of the fixed ones
  if (hoverId === dragId) return { order: ids.slice(), index: from, anchor: null, noop: true };
  const rest = ids.filter((x) => x !== dragId);
  const at = rest.indexOf(hoverId);
  if (at < 0) return null;
  const index = Math.max(locked, Math.min(at + (after ? 1 : 0), rest.length));
  const order = [...rest.slice(0, index), dragId, ...rest.slice(index)];
  const anchor = rest[index] ? { before: rest[index] } : { after: rest[rest.length - 1] };
  return { order, index, anchor, noop: order.every((x, i) => x === ids[i]) };
}

/** One step up (-1) or down (+1). Returns the new order, or null when it is already at that end or the step would cross a fixed item. */
export function stepInList(ids, id, dir, locked = 0) {
  const i = ids.indexOf(id), j = i + dir;
  if (i < locked || j < locked || j >= ids.length) return null;
  const next = ids.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
