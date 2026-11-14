// Custom app themes (free for everyone). A theme is a background colour, an optional accent and an
// optional sidebar gradient. Every other colour (sidebars, inputs, text, ...) is derived from the
// background so any combination stays readable. Stored in settings as { theme: 'custom', customTheme }.
import { isHex, luminance, mixHex } from './perks.js';

const WHITE = '#ffffff';
const BLACK = '#000000';

export const DEFAULT_CUSTOM_THEME = { bg: '#1e2027', accent: null, gradient: null };

const grad = (a, b, angle = 160) => ({ a, b, angle });

/** Ready-made themes. Each one lists every key so applying a preset fully replaces the old theme. */
export const THEME_PRESETS = [
  { id: 'midnight-blue', label: 'Midnight Blue', accent: '#5b8cff', theme: { bg: '#1b2233', gradient: grad('#0f1626', '#233a63') } },
  { id: 'sunset', label: 'Sunset', accent: '#ff7a59', theme: { bg: '#2a1b24', gradient: grad('#3a1c2e', '#7a3232') } },
  { id: 'forest', label: 'Forest', accent: '#3ddc97', theme: { bg: '#16241f', gradient: grad('#0e1a16', '#1f4a3a') } },
  { id: 'ocean', label: 'Ocean', accent: '#38bdf8', theme: { bg: '#0f2230', gradient: grad('#0a1a26', '#0d4f6b') } },
  { id: 'amethyst', label: 'Amethyst', accent: '#a78bfa', theme: { bg: '#231a36', gradient: grad('#1a1230', '#51299a') } },
  { id: 'cyberpunk', label: 'Cyberpunk', accent: '#ff2bd6', theme: { bg: '#14101f', gradient: grad('#0b1020', '#3b0a5a', 150) } },
  { id: 'crimson', label: 'Crimson', accent: '#ef4444', theme: { bg: '#241416', gradient: null } },
  { id: 'mocha', label: 'Mocha', accent: '#d9a066', theme: { bg: '#2b231f', gradient: null } },
  { id: 'nord', label: 'Nord', accent: '#88c0d0', theme: { bg: '#2e3440', gradient: null } },
  { id: 'dracula', label: 'Dracula', accent: '#bd93f9', theme: { bg: '#282a36', gradient: null } },
  { id: 'sakura', label: 'Sakura', accent: '#ec6a9c', theme: { bg: '#fff5f8', gradient: grad('#ffe3ee', '#f7c6dc') } },
  { id: 'mint', label: 'Mint', accent: '#10b981', theme: { bg: '#f3fbf7', gradient: grad('#dff7ea', '#b7ecd2') } },
  { id: 'paper', label: 'Paper', accent: '#b45309', theme: { bg: '#faf6ee', gradient: null } },
];

/** Clean a theme coming from settings or from a pasted code. Returns null when it is unusable. */
export function sanitizeCustomTheme(v) {
  if (!v || typeof v !== 'object' || !isHex(v.bg)) return null;
  const g = v.gradient;
  const gradient = g && typeof g === 'object' && isHex(g.a) && isHex(g.b)
    ? { a: g.a.toLowerCase(), b: g.b.toLowerCase(), angle: Number.isFinite(+g.angle) ? Math.min(360, Math.max(0, Math.round(+g.angle))) : 160 }
    : null;
  return { bg: v.bg.toLowerCase(), accent: isHex(v.accent) ? v.accent.toLowerCase() : null, gradient };
}

/** Light backgrounds get dark text and the other way round (break-even contrast is about 0.18). */
export const isLightBg = (bg) => luminance(bg) > 0.2;

/**
 * Turn a theme into CSS variables.
 * Returns { mode: 'dark' | 'light', vars: {--name: value}, gradient: 'linear-gradient(...)' | null }.
 */
export function buildTheme(ct) {
  const bg = ct.bg;
  const light = isLightBg(bg);
  const m = (c, t) => mixHex(bg, c, t);
  const vars = light ? {
    '--bg-primary': bg, '--bg-secondary': m(BLACK, 0.04), '--bg-secondary-alt': m(BLACK, 0.07), '--bg-tertiary': m(BLACK, 0.11),
    '--bg-floating': m(WHITE, 0.55), '--bg-input': m(BLACK, 0.07),
    '--text-normal': m(BLACK, 0.86), '--text-muted': m(BLACK, 0.6), '--text-faint': m(BLACK, 0.44),
    '--header-primary': m(BLACK, 0.97), '--header-secondary': m(BLACK, 0.76),
    '--interactive-normal': m(BLACK, 0.7), '--interactive-hover': m(BLACK, 0.92), '--interactive-active': BLACK, '--interactive-muted': m(BLACK, 0.14),
    '--scroll-thumb': m(BLACK, 0.16), '--code-bg': m(BLACK, 0.05), '--skeleton': m(BLACK, 0.1), '--embed-bg': m(BLACK, 0.045), '--tooltip-bg': '#111214',
  } : {
    '--bg-primary': bg, '--bg-secondary': m(BLACK, 0.22), '--bg-secondary-alt': m(BLACK, 0.3), '--bg-tertiary': m(BLACK, 0.4),
    '--bg-floating': m(BLACK, 0.45), '--bg-input': m(BLACK, 0.28),
    '--text-normal': m(WHITE, 0.86), '--text-muted': m(WHITE, 0.54), '--text-faint': m(WHITE, 0.36),
    '--header-primary': m(WHITE, 0.96), '--header-secondary': m(WHITE, 0.72),
    '--interactive-normal': m(WHITE, 0.68), '--interactive-hover': m(WHITE, 0.9), '--interactive-active': WHITE, '--interactive-muted': m(WHITE, 0.2),
    '--scroll-thumb': m(WHITE, 0.14), '--code-bg': m(BLACK, 0.25), '--skeleton': m(WHITE, 0.1), '--embed-bg': m(BLACK, 0.18), '--tooltip-bg': m(BLACK, 0.6),
  };
  const g = ct.gradient;
  return { mode: light ? 'light' : 'dark', vars, gradient: g ? `linear-gradient(${g.angle}deg, ${g.a}, ${g.b})` : null };
}

// ---- sharing: a theme code is the theme as base64 text, easy to paste into a chat ----------------
const PREFIX = 'nct1:';

export function exportThemeCode(ct, accent) {
  const clean = sanitizeCustomTheme(ct);
  if (!clean) return '';
  const body = { ...clean, accent: isHex(accent) ? accent.toLowerCase() : clean.accent };
  return PREFIX + btoa(JSON.stringify(body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns a sanitized theme (with `accent`) or null when the text is not a valid code. */
export function parseThemeCode(text) {
  try {
    const t = String(text || '').trim();
    if (!t.startsWith(PREFIX) || t.length > 600) return null;
    const b64 = t.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return sanitizeCustomTheme(JSON.parse(json));
  } catch {
    return null;
  }
}
