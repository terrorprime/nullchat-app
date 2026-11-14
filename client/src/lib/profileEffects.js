// Profile effects: the particles behind the animated overlay on a profile card (see components/ProfileEffect.jsx).
//
// An effect is a handful of small elements, each given its own start position, speed and phase through CSS variables;
// the look and the movement of every kind live in styles.css (".pfx-<id>"). The numbers come from a seeded generator, so an
// effect is the same every time it is shown, and the whole thing is pure and can be tested without a browser.
import { PROFILE_EFFECT_IDS } from '../../../shared/perks.js';

// n      how many particles
// t      seconds for one pass: [fastest, slowest]
// s      size factor: [smallest, biggest]
// w      sideways drift in px (each particle gets a random amount up to this, to the left or right)
// r      how far it turns over one pass, in degrees (each particle gets a random amount up to this)
// x      where along the width particles start, in % ([0, 100] is the card; rain slants, so it starts further right)
// free   the particle stays around a spot (sparkles, fireflies) instead of travelling top to bottom: it gets a y as well
// text   the particle is a column of characters (code rain)
const SPEC = {
  sakura:    { n: 16, t: [8, 13],     s: [0.75, 1.3],  w: 55, r: 540 },
  snow:      { n: 30, t: [7, 12],     s: [0.5, 1.4],   w: 28, r: 0 },
  sparkles:  { n: 18, t: [2.4, 4.6],  s: [0.6, 1.4],   w: 0,  r: 0, free: true },
  hearts:    { n: 14, t: [6.5, 10.5], s: [0.7, 1.35],  w: 30, r: 0 },
  fireflies: { n: 16, t: [6, 10],     s: [0.7, 1.3],   w: 46, r: 0, free: true },
  embers:    { n: 22, t: [3.8, 6.8],  s: [0.5, 1.3],   w: 38, r: 0 },
  storm:     { n: 28, t: [0.6, 1],    s: [0.7, 1.2],   w: 0,  r: 0, x: [0, 125] },
  bubbles:   { n: 15, t: [7, 12],     s: [0.6, 1.7],   w: 34, r: 0 },
  confetti:  { n: 26, t: [4.2, 7.8],  s: [0.7, 1.25],  w: 42, r: 720 },
  leaves:    { n: 12, t: [8.5, 13.5], s: [0.8, 1.45],  w: 65, r: 420 },
  starfall:  { n: 7,  t: [3.6, 6.4],  s: [0.7, 1.3],   w: 0,  r: 0, x: [25, 140] },
  code:      { n: 22, t: [4.2, 8.2],  s: [0.8, 1.25],  w: 0,  r: 0, text: true },
};

// A tiny seeded generator (mulberry32), so an effect looks the same for everyone, every time.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const GLYPHS = '01ABCDEFXYZ#$%&*+<>=';
const COLUMN = 8;   // characters in a column of code rain

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

const cache = new Map();
/**
 * The particles of an effect: [{ key, style, text }], or null if `effect` is not one. Cached, since the list never changes.
 * `style` is a plain object of CSS variables for React's style prop.
 * Where a particle starts across the card, and how far through its pass it is, follow a low-discrepancy sequence (so no clumps), which also means
 * any first few of them (all a small thumbnail shows) are spread over the whole card and over the whole pass.
 */
export function particlesFor(effect) {
  if (!PROFILE_EFFECT_IDS.includes(effect)) return null;
  if (cache.has(effect)) return cache.get(effect);
  const sp = SPEC[effect];
  const rnd = seeded(hash(`pfx:${effect}`));
  const [x0, x1] = sp.x || [0, 100];
  const off = [rnd(), rnd(), rnd()];                        // each effect starts its sequences somewhere else, so no two share a layout
  const seq = (k, i, step) => (off[k] + i * step) % 1;
  const list = [];
  for (let i = 0; i < sp.n; i++) {
    const t = sp.t[0] + rnd() * (sp.t[1] - sp.t[0]);
    const sign = rnd() < 0.5 ? -1 : 1;
    const style = {
      '--x': `${r1(x0 + seq(0, i, 0.7548776662466927) * (x1 - x0))}%`,
      '--t': `${r2(t)}s`,
      '--d': `${r2(-seq(1, i, 0.5698402909980532) * t)}s`,   // already part-way through its pass when the card opens
      '--s': String(r2(sp.s[0] + rnd() * (sp.s[1] - sp.s[0]))),
      '--w': `${Math.round(sign * (0.35 + rnd() * 0.65) * sp.w)}px`,
      '--r': `${Math.round((rnd() < 0.5 ? -1 : 1) * (0.4 + rnd() * 0.6) * sp.r)}deg`,
    };
    if (sp.free) style['--y'] = `${r1(6 + seq(2, i, 0.6180339887498949) * 88)}%`;
    let text = null;
    if (sp.text) {
      let col = '';
      for (let k = 0; k < COLUMN; k++) col += (k ? '\n' : '') + GLYPHS[Math.floor(rnd() * GLYPHS.length)];
      text = col;
    }
    list.push({ key: `${effect}-${i}`, style, text });
  }
  cache.set(effect, list);
  return list;
}
