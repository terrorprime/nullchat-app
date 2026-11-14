// Profile "extras" that are free for everyone: profile themes, styled display names, avatar
// decorations and profile effects. This file is shared by the server (to validate what people save) and by the web
// client (to build the pickers), so both sides always agree on what is allowed.

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v) => typeof v === 'string' && HEX.test(v);

// ---- avatar decorations ---------------------------------------------------------------------
// Pure CSS, drawn around the avatar and scaled to its size (see ".avatar-deco" in styles.css).
export const AVATAR_DECORATIONS = [
  { id: 'aurora', label: 'Aurora Ring' },
  { id: 'rainbow', label: 'Rainbow Spin' },
  { id: 'neon', label: 'Neon Pulse' },
  { id: 'gold', label: 'Golden Halo' },
  { id: 'frost', label: 'Frost' },
  { id: 'flame', label: 'Flames' },
  { id: 'sakura', label: 'Sakura' },
  { id: 'sparkle', label: 'Sparkles' },
  { id: 'glitch', label: 'Glitch' },
  { id: 'cat', label: 'Cat Ears' },
  { id: 'crown', label: 'Crown' },
  { id: 'orbit', label: 'Orbit' },
];
export const DECORATION_IDS = AVATAR_DECORATIONS.map((d) => d.id);

// The admin's own decoration. It is not in the public list on purpose: the server only hands it out
// to (and only shows it for) the site admin, and it is the admin's default until they pick another.
export const ADMIN_DECORATION_ID = 'admin';
export const ADMIN_DECORATION_LABEL = 'Admin Crest';

// ---- custom avatar decorations (designed by the user in Settings -> Profiles) ----------------------
// A small, fully validated recipe that the client turns into CSS (see ".deco-custom" in styles.css).
export const DECO_RING_STYLES = [
  { id: 'solid', label: 'Solid' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'double', label: 'Double' },
];
export const DECO_MOTIONS = [
  { id: 'none', label: 'Still' },
  { id: 'spin', label: 'Spin' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'flicker', label: 'Flicker' },
];
export const DECO_ACCESSORIES = [
  { id: 'none', label: 'None' },
  { id: 'ears', label: 'Cat ears' },
  { id: 'crown', label: 'Crown' },
  { id: 'halo', label: 'Halo' },
  { id: 'horns', label: 'Horns' },
  { id: 'sparkles', label: 'Sparkles' },
  { id: 'bunny', label: 'Bunny ears' },
  { id: 'bow', label: 'Bow' },
  { id: 'headphones', label: 'Headphones' },
  { id: 'wings', label: 'Wings' },
  { id: 'flowers', label: 'Flower crown' },
];
export const DECO_RING_STYLE_IDS = DECO_RING_STYLES.map((d) => d.id);
export const DECO_MOTION_IDS = DECO_MOTIONS.map((d) => d.id);
export const DECO_ACCESSORY_IDS = DECO_ACCESSORIES.map((d) => d.id);
export const DECO_WIDTH_LABELS = ['', 'Thin', 'Medium', 'Thick'];
export const DECO_GLOW_LABELS = ['Off', 'Soft', 'Medium', 'Strong'];

/** A starting point for the maker. */
export const DEFAULT_CUSTOM_DECORATION = Object.freeze({
  kind: 'custom', style: 'gradient', colors: ['#7b61ff', '#00d1ff', '#ff4ecd'], width: 2, glow: 2, motion: 'spin', acc: 'none', accColor: '#ffd166',
});

// ---- display name styles ----------------------------------------------------------------------
// The same choices Discord's "Display Name Styles" has: eleven fonts besides the default, and the effects Solid, Gradient,
// Neon, Toon, Pop, Gummy and Prism (plus Glow, Shimmer and Outline from earlier versions). The fonts are open-licence
// typefaces shipped with the app in /fonts/names (see LICENSES.txt there); nothing is downloaded from anywhere else.
// Each id has a ".nfont-<id>" / ".neffect-<id>" rule in styles.css.
export const NAME_FONTS = [
  { id: 'default', label: 'Default' },
  { id: 'tempo', label: 'Tempo' },
  { id: 'sakura', label: 'Sakura' },
  { id: 'jellybean', label: 'Jellybean' },
  { id: 'modern', label: 'Modern' },
  { id: 'medieval', label: 'Medieval' },
  { id: '8bit', label: '8Bit' },
  { id: 'vampyre', label: 'Vampyre' },
  { id: 'monkeybars', label: 'Monkey Bars' },
  { id: 'mainframe', label: 'Mainframe' },
  { id: 'headbang', label: 'Headbang' },
  { id: 'journal', label: 'Journal' },
];
// The first five fonts NullChat had (system fonts). Still valid and still drawn, so nobody's saved name changes,
// but they are no longer offered for new choices.
export const LEGACY_NAME_FONTS = [
  { id: 'rounded', label: 'Rounded' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Typewriter' },
  { id: 'script', label: 'Handwritten' },
  { id: 'display', label: 'Poster' },
];
// "Solid" is no effect (one colour); two colours make a gradient. The editor offers Gradient as its own button.
export const NAME_EFFECTS = [
  { id: 'none', label: 'Solid' },
  { id: 'neon', label: 'Neon' },
  { id: 'toon', label: 'Toon' },
  { id: 'pop', label: 'Pop' },
  { id: 'gummy', label: 'Gummy' },
  { id: 'prism', label: 'Prism' },
  { id: 'glow', label: 'Glow' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'outline', label: 'Outline' },
];
export const NAME_FONT_IDS = [...NAME_FONTS, ...LEGACY_NAME_FONTS].map((f) => f.id);
export const NAME_EFFECT_IDS = NAME_EFFECTS.map((e) => e.id);
/** Prism is a five-colour rainbow that slowly moves along the name. This is its starting palette. */
export const PRISM_DEFAULT_COLORS = ['#ff4d6d', '#ffb703', '#3ddc84', '#00b4ff', '#a259ff'];
export const PRISM_COLORS = 5;
/** How many colours a name style may carry: five for Prism, two (a gradient) for everything else. */
export const nameColorLimit = (effect) => (effect === 'prism' ? PRISM_COLORS : 2);

// ---- profile effects ---------------------------------------------------------------------------
// Animated overlays on the whole profile card (the small card and the full profile), like Discord's profile effects.
// Discord's are shop artwork, so these are NullChat's own, of the same kinds. Each id is drawn by client/src/lib/profileEffects.js
// (the particles) and the ".pfx-<id>" rules in styles.css. Free for everyone; one effect at a time.
export const PROFILE_EFFECTS = [
  { id: 'sakura', label: 'Sakura Petals' },
  { id: 'snow', label: 'Snowfall' },
  { id: 'sparkles', label: 'Sparkles' },
  { id: 'hearts', label: 'Floating Hearts' },
  { id: 'fireflies', label: 'Fireflies' },
  { id: 'embers', label: 'Embers' },
  { id: 'storm', label: 'Storm' },
  { id: 'bubbles', label: 'Bubbles' },
  { id: 'confetti', label: 'Confetti' },
  { id: 'leaves', label: 'Autumn Leaves' },
  { id: 'starfall', label: 'Starfall' },
  { id: 'code', label: 'Code Rain' },
];
export const PROFILE_EFFECT_IDS = PROFILE_EFFECTS.map((e) => e.id);

// ---- sanitizers (the server runs everything through these before saving) -----------------------
/** A profile effect id, or null for none (anything that is not one of the ids above). */
export function sanitizeProfileEffect(v) {
  return typeof v === 'string' && PROFILE_EFFECT_IDS.includes(v) ? v : null;
}

export function sanitizeProfileTheme(v) {
  if (!v || typeof v !== 'object') return null;
  if (!isHex(v.primary) || !isHex(v.secondary)) return null;
  return { primary: v.primary.toLowerCase(), secondary: v.secondary.toLowerCase() };
}

export function sanitizeNameStyle(v) {
  if (!v || typeof v !== 'object') return null;
  const font = NAME_FONT_IDS.includes(v.font) ? v.font : 'default';
  const effect = NAME_EFFECT_IDS.includes(v.effect) ? v.effect : 'none';
  const colors = Array.isArray(v.colors) ? v.colors.filter(isHex).slice(0, nameColorLimit(effect)).map((c) => c.toLowerCase()) : [];
  if (font === 'default' && effect === 'none' && colors.length === 0) return null;
  return { font, effect, colors };
}

const clampInt = (n, lo, hi, dflt) => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

/** Validates a user-designed decoration. Always returns a fresh object with every key in a fixed
 *  order (so two equal designs stringify the same), or null if there is no usable colour. */
export function sanitizeCustomDecoration(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const colors = Array.isArray(v.colors) ? v.colors.filter(isHex).slice(0, 3).map((c) => c.toLowerCase()) : [];
  if (colors.length === 0) return null;
  return {
    kind: 'custom',
    style: DECO_RING_STYLE_IDS.includes(v.style) ? v.style : 'solid',
    colors,
    width: clampInt(v.width, 1, 3, 2),
    glow: clampInt(v.glow, 0, 3, 2),
    motion: DECO_MOTION_IDS.includes(v.motion) ? v.motion : 'none',
    acc: DECO_ACCESSORY_IDS.includes(v.acc) ? v.acc : 'none',
    accColor: isHex(v.accColor) ? v.accColor.toLowerCase() : '#ffd166',
  };
}

// ---- uploaded image decorations (the user's own artwork, drawn over their avatar) -------------------
// Only files this server stored for avatar decorations are allowed, so a decoration can never point
// at somebody else's site or at a different kind of upload.
export const IMAGE_DECORATION_URL = /^\/uploads\/decorations\/[0-9a-f]{32}\.(png|gif|webp)$/;
export const IMAGE_DECORATION_MIN_SCALE = 0.3;
export const IMAGE_DECORATION_MAX_SCALE = 4;
export const IMAGE_DECORATION_DEFAULT_SCALE = 1.2;
export const IMAGE_DECORATION_MAX_SHIFT = 1.5;

const round3 = (n) => Math.round(n * 1000) / 1000;

/** { kind: 'image', url, scale, x, y } or null.
 *  `scale` is how big the picture is drawn compared to the avatar; `x` and `y` move it sideways and up/down,
 *  in avatar widths (0 = centred on the avatar). Fitting a picture whose ring is off-centre needs all three. */
export function sanitizeImageDecoration(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.url !== 'string' || !IMAGE_DECORATION_URL.test(v.url)) return null;
  const n = Number(v.scale);
  const scale = Number.isFinite(n) ? round3(Math.min(IMAGE_DECORATION_MAX_SCALE, Math.max(IMAGE_DECORATION_MIN_SCALE, n))) : IMAGE_DECORATION_DEFAULT_SCALE;
  const shift = (raw) => { const m = Number(raw); return Number.isFinite(m) ? round3(Math.min(IMAGE_DECORATION_MAX_SHIFT, Math.max(-IMAGE_DECORATION_MAX_SHIFT, m))) : 0; };
  return { kind: 'image', url: v.url, scale, x: shift(v.x), y: shift(v.y) };
}

/** One decoration value: null, a ready-made id (or the admin's 'admin'), a custom design or an uploaded image.
 *  A JSON string (how a custom design is stored in the database) is accepted too.
 *  Whether 'admin' may actually be used is decided by the server, never here. */
export function sanitizeDecoration(v) {
  if (typeof v === 'string') {
    if (v.charCodeAt(0) === 123 /* { */) {
      try { return sanitizeDecoration(JSON.parse(v)); } catch { return null; }
    }
    return v === ADMIN_DECORATION_ID || DECORATION_IDS.includes(v) ? v : null;
  }
  if (v && typeof v === 'object' && v.kind === 'image') return sanitizeImageDecoration(v);
  return sanitizeCustomDecoration(v);
}
