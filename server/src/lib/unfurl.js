// Rich link previews (Open Graph unfurling). The fetching itself, and the rule that it may only reach the public internet, is in safeHttp.js.
import { safeGet, readText } from './safeHttp.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(content) {
  // Ignore URLs wrapped in <> (suppressed embeds) and those inside code.
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/<https?:\/\/[^>]+>/g, '');
  const urls = [];
  for (const m of stripped.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,!?:;]+$/, '');
    if (!urls.includes(u)) urls.push(u);
    if (urls.length >= 3) break;
  }
  return urls;
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return m;
  });
}

function metaContent(html, keys) {
  for (const key of keys) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return null;
}

export function youtubeId(u) {
  try {
    const url = new URL(u);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(url.pathname);
      if (m) return m[2];
    }
  } catch { /* ignore */ }
  return null;
}

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; NullChatBot/1.0; +link-preview)', Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5' };

/** `opts` (lookup, blocked, timeoutMs, maxRedirects) exists for the tests; the server never passes any. */
export async function unfurl(url, opts = {}) {
  const yt = youtubeId(url);
  const { status, headers, url: finalUrl, stream, done } = await safeGet(url, { headers: HEADERS, ...opts });
  try {
    const type = String(headers['content-type'] || '').toLowerCase();
    if (status < 200 || status >= 300) return null;
    if (type.startsWith('image/')) return { type: 'image', url, image: { url: finalUrl } };
    if (type.startsWith('video/')) return { type: 'video', url, video: { url: finalUrl } };
    if (!type.includes('html')) return null;
    const html = await readText(stream, { limit: 512 * 1024, stopAt: /<\/head>/i });   // (the head is where the preview lives)
    const title = metaContent(html, ['og:title', 'twitter:title']) || decodeEntities((/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim());
    const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
    let image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
    const siteName = metaContent(html, ['og:site_name', 'application-name']) || new URL(finalUrl).hostname.replace(/^www\./, '');
    const color = metaContent(html, ['theme-color']);
    if (image) { try { image = new URL(image, finalUrl).toString(); } catch { image = null; } }
    if (!title && !description && !image) return null;
    const embed = {
      type: yt ? 'video' : 'link',
      url,
      title: title?.slice(0, 256) || null,
      description: description?.slice(0, 350) || null,
      siteName: siteName?.slice(0, 100) || null,
      color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
      thumbnail: image ? { url: image } : null,
    };
    if (yt) embed.youtubeId = yt.replace(/[^\w-]/g, '');
    return embed;
  } finally {
    done();
  }
}

// A flood of links must not turn into a flood of outgoing connections: a few at a time, the rest wait, and a long queue is dropped.
const MAX_AT_ONCE = 6;
const MAX_WAITING = 40;
let running = 0;
const waiting = [];
async function limited(job) {
  if (running >= MAX_AT_ONCE) {
    if (waiting.length >= MAX_WAITING) throw new Error('busy');
    await new Promise((resolve) => waiting.push(resolve));
  } else running++;
  try { return await job(); } finally {
    const next = waiting.shift();
    if (next) next(); else running--;   // (a waiting job takes over this slot)
  }
}

export async function unfurlAll(content) {
  const urls = extractUrls(content);
  const results = await Promise.allSettled(urls.map((u) => limited(() => unfurl(u))));
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}
