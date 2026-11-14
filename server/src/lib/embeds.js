// Rich embeds: the cards a bot can attach to a message (title, text, colored side bar, fields, picture, footer).
// People can't send these; link previews (lib/unfurl.js) use the same message column but a different "type".
import { z } from 'zod';
import { bad } from './http.js';

export const MAX_EMBEDS = 10;
const MAX_EMBED_TEXT = 6000; // all the text in one message's embeds

function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}
const link = z.string().trim().max(2000).refine(isHttpUrl, 'must be a link starting with http:// or https://');
// Accept both { url } and a bare link for pictures, and both camelCase and snake_case for the few two-word keys.
const picture = z.union([link, z.object({ url: link })]).transform((v) => (typeof v === 'string' ? v : v.url));

const snake = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = { ...o };
  if ('icon_url' in out && !('iconUrl' in out)) out.iconUrl = out.icon_url;
  return out;
};

export const embedSchema = z.preprocess(snake, z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4000).optional(),
  url: link.optional(),
  color: z.union([z.number().int().min(0).max(0xffffff), z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'must look like #5865f2')]).optional(),
  author: z.preprocess(snake, z.object({ name: z.string().min(1).max(256), url: link.optional(), iconUrl: link.optional() })).optional(),
  fields: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })).max(25).optional(),
  thumbnail: picture.optional(),
  image: picture.optional(),
  footer: z.preprocess(snake, z.object({ text: z.string().min(1).max(2048), iconUrl: link.optional() })).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
}));

export const embedsSchema = z.array(embedSchema).max(MAX_EMBEDS, `A message can have at most ${MAX_EMBEDS} embeds.`);

function toColor(c) {
  if (c === undefined || c === null) return null;
  if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
  return '#' + c.replace('#', '').toLowerCase();
}
function toTime(t) {
  if (t === undefined || t === null || t === '') return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Turn validated input into what is stored and sent to clients. */
export function cleanEmbeds(list) {
  const out = [];
  let text = 0;
  for (const e of list || []) {
    const clean = {
      type: 'rich',
      title: e.title || null,
      description: e.description || null,
      url: e.url || null,
      color: toColor(e.color),
      author: e.author ? { name: e.author.name, url: e.author.url || null, iconUrl: e.author.iconUrl || null } : null,
      fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })),
      thumbnail: e.thumbnail ? { url: e.thumbnail } : null,
      image: e.image ? { url: e.image } : null,
      footer: e.footer ? { text: e.footer.text, iconUrl: e.footer.iconUrl || null } : null,
      timestamp: toTime(e.timestamp),
    };
    const empty = !clean.title && !clean.description && !clean.author && !clean.fields.length && !clean.thumbnail && !clean.image && !clean.footer;
    if (empty) continue;
    text += (clean.title?.length || 0) + (clean.description?.length || 0) + (clean.author?.name.length || 0) + (clean.footer?.text.length || 0)
      + clean.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    out.push(clean);
  }
  if (text > MAX_EMBED_TEXT) {
    throw bad(`The text in a message’s embeds can be at most ${MAX_EMBED_TEXT} characters in total.`);
  }
  return out;
}

export const isRich = (e) => e && e.type === 'rich';
