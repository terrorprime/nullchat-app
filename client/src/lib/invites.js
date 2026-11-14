// Invite links inside a message (the card NullChat shows under them), and a small cache of what an invite looks like.

const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODE = '[A-Za-z0-9_-]{2,64}';
const MAX_CARDS = 3;

/**
 * The invite links to this site in some message text, as `{ code, source, url }` (at most 3, each code once).
 * Links inside code, and links wrapped in <angle brackets> (the way to say "no preview"), are left alone.
 * `origin` is this site's address (https://nullchat.fly.dev); the nullchat:// form the app uses is understood too.
 */
export function inviteLinksIn(content, origin = typeof location !== 'undefined' ? location.origin : '') {
  if (!content || !/invite\//i.test(content)) return [];
  const text = String(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<(?:https?|nullchat):\/\/[^>\s]+>/gi, ' ');
  const prefixes = [origin ? `${esc(origin.replace(/\/+$/, ''))}/invite/` : null, 'nullchat://invite/'].filter(Boolean);
  const out = [];
  for (const prefix of prefixes) {
    const re = new RegExp(`(?<![A-Za-z0-9_.@/=?&#%-])${prefix}(${CODE})(?:/([A-Za-z0-9_-]{1,64}))?(?![A-Za-z0-9_-])`, 'gi');
    for (const m of text.matchAll(re)) {
      if (!out.some((x) => x.code.toLowerCase() === m[1].toLowerCase())) out.push({ code: m[1], source: m[2] || null, url: m[0], at: m.index });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, MAX_CARDS).map(({ code, source, url }) => ({ code, source, url }));
}

// ---- what an invite looks like, asked for once per minute per code (a channel full of the same link makes one request)
const cache = new Map();   // code -> { at, promise }
const TTL = 60_000;

/** Resolves to `{ status: 'ok', invite }`, `{ status: 'gone' }` (invalid, expired or used up) or `{ status: 'error' }`. */
export function lookupInvite(api, code, { fresh = false } = {}) {
  const key = String(code).toLowerCase();
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.promise;
  const promise = api.get(`/invites/${encodeURIComponent(code)}`, { noAuthRedirect: true })
    .then((invite) => ({ status: 'ok', invite }))
    .catch((e) => (e?.status === 404 ? { status: 'gone' } : { status: 'error' }));
  cache.set(key, { at: Date.now(), promise });
  promise.then((r) => { if (r.status === 'error' && cache.get(key)?.promise === promise) cache.delete(key); });   // (a failed lookup is tried again next time)
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return promise;
}

export const forgetInvite = (code) => cache.delete(String(code).toLowerCase());
