// Polls: a question with 2-10 options attached to a normal chat message. Everyone who can see the channel can
// vote (one choice, or several when the poll allows it) and change their vote until the poll ends.
// The question is the message's own text, so search, replies and notifications keep working.
import { z } from 'zod';
import { all, get, run, tx } from '../db.js';
import { newId } from './security.js';
import { bad } from './http.js';

export const MAX_QUESTION = 300;
export const pollInputSchema = z.object({
  options: z.array(z.string().trim().min(1, 'Poll options can’t be empty.').max(100, 'Poll options can be at most 100 characters.')).min(2, 'A poll needs at least 2 options.').max(10, 'A poll can have at most 10 options.'),
  multi: z.boolean().default(false),
  /** hours until voting closes; omit or null for a poll that stays open until its author ends it */
  durationHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
});

/** Checks the question and options, returns the cleaned-up poll definition. */
export function cleanPoll(input, question) {
  const q = String(question || '').trim();
  if (!q) throw bad('A poll needs a question.');
  if (q.length > MAX_QUESTION) throw bad(`The question can be at most ${MAX_QUESTION} characters.`);
  const seen = new Set();
  for (const o of input.options) {
    const k = o.toLowerCase();
    if (seen.has(k)) throw bad(`“${o}” is listed twice. Every option must be different.`);
    seen.add(k);
  }
  return { options: input.options, multi: !!input.multi, endsAt: input.durationHours ? Date.now() + input.durationHours * 3600_000 : null };
}

/** Call inside a transaction, right after the message row exists. */
export function insertPoll(messageId, poll) {
  run('INSERT INTO polls (message_id, multi, ends_at) VALUES (?, ?, ?)', messageId, poll.multi ? 1 : 0, poll.endsAt);
  poll.options.forEach((text, i) => run('INSERT INTO poll_options (id, message_id, position, text) VALUES (?, ?, ?, ?)', newId(), messageId, i, text));
}

export const pollEnded = (p) => !!p && (!!p.closed_at || (p.ends_at != null && p.ends_at <= Date.now()));

/** Map of messageId -> poll, shaped for clients. One option list per poll, voters as user ids (like reactions). */
export function pollsFor(messageIds) {
  const out = new Map();
  if (!messageIds.length) return out;
  const ph = messageIds.map(() => '?').join(',');
  const polls = all(`SELECT * FROM polls WHERE message_id IN (${ph})`, ...messageIds);
  if (!polls.length) return out;
  const ids = polls.map((p) => p.message_id);
  const ph2 = ids.map(() => '?').join(',');
  const options = all(`SELECT id, message_id, text FROM poll_options WHERE message_id IN (${ph2}) ORDER BY message_id, position`, ...ids);
  const votes = all(`SELECT message_id, option_id, user_id FROM poll_votes WHERE message_id IN (${ph2}) ORDER BY created_at`, ...ids);
  for (const p of polls) {
    out.set(p.message_id, {
      multi: !!p.multi,
      endsAt: p.ends_at,
      closed: !!p.closed_at,
      options: options.filter((o) => o.message_id === p.message_id).map((o) => ({ id: o.id, text: o.text, voters: votes.filter((v) => v.option_id === o.id).map((v) => v.user_id) })),
    });
  }
  return out;
}

export const getPoll = (messageId) => get('SELECT * FROM polls WHERE message_id = ?', messageId);

/** Replace a person's votes. optionIds may be empty to take the vote back. */
export function setVotes(poll, userId, optionIds) {
  const unique = [...new Set(optionIds)];
  if (!poll.multi && unique.length > 1) throw bad('This poll allows only one choice.');
  const valid = new Set(all('SELECT id FROM poll_options WHERE message_id = ?', poll.message_id).map((o) => o.id));
  if (unique.some((id) => !valid.has(id))) throw bad('That option isn’t part of this poll.');
  tx(() => {
    run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', poll.message_id, userId);
    const now = Date.now();
    for (const id of unique) run('INSERT INTO poll_votes (message_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)', poll.message_id, id, userId, now);
  });
}
