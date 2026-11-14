// Client helpers for the free "Nitro-style" profile extras: profile themes, styled names and
// avatar decorations. The lists and sanitizers live in shared/perks.js (the server uses them too).
export * from '../../../shared/perks.js';
import { sanitizeCustomDecoration, DECO_ACCESSORY_IDS, PRISM_COLORS, PRISM_DEFAULT_COLORS } from '../../../shared/perks.js';

// ---- colour maths -----------------------------------------------------------------------------
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex) {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function mixHex(a, b, t = 0.5) {
  const A = rgb(a); const B = rgb(b);
  const out = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ---- ready-made profile themes ------------------------------------------------------------------
export const PROFILE_THEME_PRESETS = [
  { id: 'sunset', label: 'Sunset', primary: '#ff7e5f', secondary: '#feb47b' },
  { id: 'ocean', label: 'Ocean', primary: '#2193b0', secondary: '#6dd5ed' },
  { id: 'forest', label: 'Forest', primary: '#134e5e', secondary: '#71b280' },
  { id: 'grape', label: 'Grape', primary: '#654ea3', secondary: '#eaafc8' },
  { id: 'night', label: 'Night', primary: '#232526', secondary: '#414345' },
  { id: 'rose', label: 'Rose', primary: '#ee9ca7', secondary: '#ffdde1' },
  { id: 'mint', label: 'Mint', primary: '#00b09b', secondary: '#96c93d' },
  { id: 'ember', label: 'Ember', primary: '#cb2d3e', secondary: '#ef473a' },
  { id: 'candy', label: 'Candy', primary: '#ff6fd8', secondary: '#3813c2' },
  { id: 'gold', label: 'Gold', primary: '#f7971e', secondary: '#ffd200' },
  { id: 'arctic', label: 'Arctic', primary: '#a1c4fd', secondary: '#c2e9fb' },
  { id: 'slate', label: 'Slate', primary: '#485563', secondary: '#29323c' },
];

export const NAME_COLOR_PRESETS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac', '#ffffff', '#ced4da'];

// ---- readable text on any profile theme --------------------------------------------------------
// A profile card is a gradient from the primary to the secondary colour (flat for the first 24%).
// Text must stay readable everywhere on it, whatever two colours the person picked, so we measure the
// gradient at a few points, choose white or dark text, and add only as much shading as the contrast needs.
const FG_LIGHT = [255, 255, 255];
const FG_DARK = [20, 21, 26];
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
function lin(v) { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const blend = (base, over, a) => base.map((v, i) => v * (1 - a) + over[i] * a);
const hexOf = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** { mode: 'dark' | 'light', alpha } where mode 'dark' means a dark card with white text. */
export function profileTextPlan(primary, secondary) {
  const p = rgb(primary); const q = rgb(secondary);
  const samples = Array.from({ length: 13 }, (_, i) => i / 12).map((t) => (t <= 0.24 ? p : blend(p, q, (t - 0.24) / 0.76)));
  let best = null;
  for (const mode of ['dark', 'light']) {
    const fg = mode === 'dark' ? FG_LIGHT : FG_DARK;
    const shade = mode === 'dark' ? [0, 0, 0] : [255, 255, 255];
    const dimA = mode === 'dark' ? 0.8 : 0.78;
    for (let alpha = 0; alpha <= 0.7001; alpha += 0.05) {
      let worst = Infinity;
      for (const bg of samples) {
        const eff = blend(bg, shade, alpha);
        worst = Math.min(worst, ratio(fg, eff), ratio(blend(eff, fg, dimA), eff));
      }
      if (worst >= 4.6) { if (!best || alpha < best.alpha - 1e-9) best = { mode, alpha: Math.round(alpha * 100) / 100 }; break; }
    }
  }
  return best || { mode: lum(blend(p, q, 0.5)) > 0.2 ? 'light' : 'dark', alpha: 0.7 };
}

/**
 * CSS variables for a user's profile theme, to put on the popout / profile modal / preview.
 * Returns { className, style } (both empty when the user has no theme).
 */
export function profileThemeProps(user) {
  const t = user?.profileTheme;
  if (!t) return { className: '', style: undefined };
  const { mode, alpha } = profileTextPlan(t.primary, t.secondary);
  const light = mode === 'light';
  const shade = light ? [255, 255, 255] : [0, 0, 0];
  return {
    className: light ? 'themed themed-light' : 'themed themed-dark',
    style: {
      '--pt-a': t.primary,
      '--pt-b': t.secondary,
      '--pt-fg': light ? '#14151a' : '#ffffff',
      '--pt-fg-dim': light ? 'rgba(20,21,26,.78)' : 'rgba(255,255,255,.8)',
      '--pt-scrim': `rgba(${shade.join(',')},${alpha})`,
      '--pt-ring': hexOf(blend(rgb(t.primary), shade, alpha)),
    },
  };
}

/** The colour a profile banner shows when there is no banner image. */
export function bannerFallback(user) {
  const t = user?.profileTheme;
  if (t) return `linear-gradient(135deg, ${t.primary}, ${t.secondary})`;
  return user?.accentColor || 'var(--accent)';
}

/**
 * Class and style for a styled display name. `roleColor` is the colour the name would have
 * anyway (from the member's top role). A colour the person picked beats it.
 * Returns { className, style } and is safe to spread on any element.
 */
export function nameStyleProps(user, roleColor) {
  const ns = user?.nameStyle;
  if (!ns) return { className: '', style: roleColor ? { color: roleColor } : undefined };
  const colors = ns.colors || [];
  const [a, b] = colors;
  const cls = [];
  const style = {};
  if (ns.font && ns.font !== 'default') cls.push(`nfont-${ns.font}`);
  if (ns.effect && ns.effect !== 'none') cls.push(`neffect-${ns.effect}`);
  const base = a || roleColor || null;
  if (ns.effect === 'prism') {
    // five colours that run along the name and slowly move; two to four are repeated to fill five, and with fewer than two (a single colour
    // would just be flat) it is the rainbow
    const pal = colors.length >= 2 ? Array.from({ length: PRISM_COLORS }, (_, i) => colors[i % colors.length]) : PRISM_DEFAULT_COLORS;
    pal.forEach((c, i) => { style[`--ns-p${i + 1}`] = c; });
    style['--ns-a'] = pal[0];
  } else if (a && b) {
    cls.push('ngrad');
    style['--ns-a'] = a;
    style['--ns-b'] = b;
  } else if (base) {
    style.color = base;
    style['--ns-a'] = base;
  }
  if (ns.effect && ns.effect !== 'none') style['--ns-glow'] = ns.effect === 'prism' ? style['--ns-p1'] : (base || 'var(--accent)');
  if (roleColor) style['--ns-role'] = roleColor;   // what “Display name styles: off” falls back to (see .plain-names in styles.css)
  return { className: cls.join(' '), style: Object.keys(style).length ? style : undefined };
}

// ---- the decoration maker: ready-made starting points and a randomiser ----------------------------
const T = (id, label, d) => ({ id, label, design: sanitizeCustomDecoration({ kind: 'custom', ...d }) });
export const DECO_TEMPLATES = [
  T('cyber', 'Cyber', { style: 'gradient', colors: ['#00f5ff', '#7a5cff', '#ff2bd6'], width: 2, glow: 3, motion: 'spin', acc: 'none' }),
  T('sunset', 'Sunset', { style: 'gradient', colors: ['#ff9a3c', '#ff3d6e', '#7b2ff7'], width: 2, glow: 2, motion: 'spin', acc: 'none' }),
  T('ocean', 'Ocean', { style: 'dashed', colors: ['#00c6ff', '#0072ff', '#00e5a8'], width: 2, glow: 1, motion: 'spin', acc: 'none' }),
  T('royal', 'Royal', { style: 'double', colors: ['#ffd43b', '#7048e8'], width: 2, glow: 2, motion: 'none', acc: 'crown', accColor: '#ffd43b' }),
  T('angel', 'Angel', { style: 'solid', colors: ['#ffffff'], width: 1, glow: 3, motion: 'pulse', acc: 'halo', accColor: '#ffe066' }),
  T('devil', 'Devil', { style: 'gradient', colors: ['#ff1744', '#7f0000', '#ff6d00'], width: 2, glow: 3, motion: 'flicker', acc: 'horns', accColor: '#e03131' }),
  T('bunny', 'Bunny', { style: 'double', colors: ['#ffc2e2', '#ffffff'], width: 2, glow: 1, motion: 'none', acc: 'bunny', accColor: '#ffffff' }),
  T('streamer', 'Streamer', { style: 'gradient', colors: ['#7c4dff', '#00e5ff'], width: 2, glow: 2, motion: 'spin', acc: 'headphones', accColor: '#ff4d6d' }),
  T('garden', 'Garden', { style: 'dashed', colors: ['#69db7c', '#ffd43b'], width: 2, glow: 1, motion: 'spin', acc: 'flowers', accColor: '#ff8fab' }),
  T('winged', 'Winged', { style: 'solid', colors: ['#f8f9fa'], width: 1, glow: 2, motion: 'pulse', acc: 'wings', accColor: '#ffffff' }),
  T('cutie', 'Cutie', { style: 'solid', colors: ['#ff8fab'], width: 2, glow: 2, motion: 'pulse', acc: 'bow', accColor: '#ff4d6d' }),
  T('ember', 'Ember', { style: 'gradient', colors: ['#ffd43b', '#ff6b00', '#c92a2a'], width: 3, glow: 3, motion: 'flicker', acc: 'none' }),
];

function hslHex(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => { const k = (n + h / 30) % 12; const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
/** "Surprise me": a random but always good-looking design (colours share a hue family, spin only where it shows). */
export function randomCustomDecoration() {
  const h = Math.floor(Math.random() * 360);
  const style = pick(['solid', 'gradient', 'gradient', 'dashed', 'double']);
  const hues = [h, (h + 35 + Math.random() * 40) % 360, (h + 150 + Math.random() * 60) % 360];
  const colors = hues.slice(0, style === 'solid' ? 1 : 2 + Math.floor(Math.random() * 2)).map((x) => hslHex(Math.round(x), 88, 60));
  const canSpin = style === 'gradient' || style === 'dashed';
  return sanitizeCustomDecoration({
    kind: 'custom', style, colors, width: 1 + Math.floor(Math.random() * 3), glow: 1 + Math.floor(Math.random() * 3),
    motion: pick(canSpin ? ['none', 'spin', 'spin', 'pulse'] : ['none', 'pulse', 'flicker']),
    acc: pick(['none', ...DECO_ACCESSORY_IDS.filter((x) => x !== 'none')]),
    accColor: hslHex(Math.round((h + 180) % 360), 90, 66),
  });
}
