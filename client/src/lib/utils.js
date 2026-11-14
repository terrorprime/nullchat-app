import { normalizeSource } from '../../../shared/community.js';
export const cx = (...a) => a.filter(Boolean).join(' ');

export function idTime(id) { return Number(String(id).slice(0, 13)); }

const AVATAR_COLORS = ['#7c6cff', '#3fa7ff', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6'];
export function colorFor(id) {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  return parts.slice(0, 3).map((p) => Array.from(p)[0]).join('').toUpperCase();
}

let locale = 'en';
let hour24 = false;
export function setFormatOptions(opts) { if (opts.locale) locale = opts.locale; if (opts.hour24 !== undefined) hour24 = opts.hour24; }

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: !hour24 });
}
export function formatDate(ts) {
  return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}
export function formatShortDate(ts) {
  return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
export function formatTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today at ${formatTime(ts)}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${formatTime(ts)}`;
  return `${formatShortDate(ts)} ${formatTime(ts)}`;
}
/** The time next to a name in chat, the way Discord writes it: just the time for today, "Yesterday at ..." for yesterday, the date and time before that. */
export function formatMessageTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return formatTime(ts);
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${formatTime(ts)}`;
  return `${formatShortDate(ts)} ${formatTime(ts)}`;
}
export function formatFull(ts) {
  return new Date(ts).toLocaleString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: !hour24 });
}
export function relativeTime(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return formatShortDate(ts);
}
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const isMobileDevice = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export function intToHex(n) { return '#' + (n || 0).toString(16).padStart(6, '0'); }
export function hexToInt(h) { return parseInt(String(h).replace('#', ''), 16) || 0; }

export const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' };

/** An invite link; `source` is the "joined from" label (/invite/<code>/youtube) that lets the server count where people came from. */
export function inviteUrl(code, source) { return `${location.origin}/invite/${code}${source ? `/${source}` : ''}`; }
/** What a pasted invite is: a link of this site, a nullchat:// link or a bare code, with its "joined from" label if it has one. */
export function parseInvite(text) {
  const t = String(text || '').trim();
  const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  const m = /\/invite\/([^/?#\s]+)(?:\/([^/?#\s]+))?/i.exec(t);
  if (m) return { code: dec(m[1]), source: normalizeSource(dec(m[2] || '')) || null };
  return { code: dec(t.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || ''), source: null };
}

export function plural(n, word, pluralWord) { return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`; }
