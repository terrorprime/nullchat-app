// Forum channels: a channel that holds posts instead of a stream of messages. Each post is a thread (its own conversation)
// with a title, optional tags and a first message. This file holds the small rules shared by the routes.
import { parseJSON } from '../db.js';
import { newId } from './security.js';
import { bad } from './http.js';

export const MAX_TAGS = 20;          // tags a forum can offer
export const MAX_APPLIED = 5;        // tags one post can carry
export const TAG_NAME_MAX = 20;
/** How many posts a moderator can keep pinned at the top of one forum. */
export const MAX_PINNED_POSTS = 3;
export const TITLE_MAX = 100;

/** The tags a forum offers: [{id, name, emoji}]. */
export const tagsOf = (forumRow) => parseJSON(forumRow?.available_tags, []).filter((t) => t && t.id && t.name);
/** The tags on a post: [id]. */
export const appliedOf = (postRow) => parseJSON(postRow?.applied_tags, []).filter((x) => typeof x === 'string');

/**
 * Check a list of tags typed by a person who manages the forum.
 * A tag that already exists keeps its id (so the posts that carry it keep it); a new one gets an id. Names are unique, ignoring case.
 */
export function cleanTagList(input, existing) {
  if (!Array.isArray(input)) throw bad('Tags must be a list.');
  if (input.length > MAX_TAGS) throw bad(`A forum can have at most ${MAX_TAGS} tags.`, 'too_many_tags');
  const have = new Set(existing.map((t) => t.id));
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, TAG_NAME_MAX);
    if (!name) throw bad('A tag needs a name.', 'bad_tag');
    if (seen.has(name.toLowerCase())) throw bad(`There are two tags called “${name}”.`, 'bad_tag');
    seen.add(name.toLowerCase());
    const emoji = raw?.emoji ? String([...String(raw.emoji)].slice(0, 2).join('')).slice(0, 16) : null;
    out.push({ id: raw?.id && have.has(String(raw.id)) ? String(raw.id) : newId(), name, emoji: emoji || null });
  }
  return out;
}

/** Check the tags chosen for a post against what the forum offers. Throws a plain message. */
export function checkAppliedTags(forumRow, ids) {
  const offered = tagsOf(forumRow);
  const list = [...new Set((ids || []).map(String))];
  if (list.length > MAX_APPLIED) throw bad(`Pick at most ${MAX_APPLIED} tags.`, 'too_many_tags');
  for (const id of list) if (!offered.some((t) => t.id === id)) throw bad('One of those tags no longer exists. Pick again.', 'unknown_tag');
  if (forumRow.require_tag && offered.length && !list.length) throw bad('Pick at least one tag for this post.', 'tag_required');
  return list;
}
