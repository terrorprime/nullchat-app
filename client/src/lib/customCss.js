// Custom CSS: your own styles on top of NullChat's, only for you. Free for everybody.
//
// What is checked, and why: CSS can make the browser fetch things (url(), @import, image-set(), ...). If somebody pastes a "theme" from the
// internet, those fetches could tell its author when you open NullChat, or leak what is on screen one letter at a time (attribute selectors
// plus a background URL). So custom CSS may not load anything from another website: only data: pictures and fonts, #fragments and paths on
// this server. Everything else is refused with a message, nothing is saved, and nothing is applied.
//
// Safety nets for a style that breaks the app (hiding the settings, say):
//   - open NullChat with ?nocss at the end of the address;
//   - press Ctrl+Alt+Shift+C to switch custom CSS off (or back on) on this device, which also works in the desktop app.

export const CSS_MAX = 20000;
const OFF_KEY = 'nullchat.nocss';
const STYLE_ID = 'nullchat-custom-css';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

const stripComments = (s) => s.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
/** The CSS as the browser reads it: escapes decoded, so `u\72l(` cannot hide a url( from the checks below. */
const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex, ch) => {
  if (hex === undefined) return ch;
  const n = parseInt(hex, 16);
  return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '�' : String.fromCodePoint(n);
});

// What a url() may point at: a picture or font inside the CSS itself, an #id inside the page, or a path on this server.
const OKAY_URL = /^(?:data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|x-font-(?:woff2?|ttf|otf)));|#|\/(?!\/))/i;
// functions that can fetch a picture without url() (a lookbehind would be neater, but older Safari cannot read one)
const PICTURE_FUNCTIONS = /image-set\s*\(|(?:^|[^\w-])(?:src|image)\s*\(/i;   // (image-set also with a vendor prefix: -webkit-image-set)
const URL_CALL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"'(]*))\s*\)/gi;

/**
 * Check CSS someone typed, loaded from a file or pasted. Returns { ok: true, css } (the text as it should be applied) or
 * { ok: false, error } with a sentence for the person.
 */
export function sanitizeCss(text) {
  const raw = String(text ?? '').replace(/\0/g, '');
  if (raw.length > CSS_MAX) return { ok: false, error: `That is too long (${raw.length.toLocaleString()} of ${CSS_MAX.toLocaleString()} characters).` };
  if (!raw.trim()) return { ok: true, css: '' };
  if (/<\/?\s*(?:style|script)|<!--/i.test(raw)) return { ok: false, error: 'Paste only the CSS, without <style> tags.' };
  const scan = unescapeCss(stripComments(raw));
  const fail = (what) => ({ ok: false, error: `${what} isn’t allowed. Custom CSS can’t load anything from other websites, only pictures and fonts inside the CSS itself (data: addresses) and files on this server.` });
  if (/@import\b/i.test(scan)) return fail('@import');
  if (PICTURE_FUNCTIONS.test(scan)) return fail('That kind of picture function');
  if (/expression\s*\(|javascript\s*:|vbscript\s*:|behaviou?r\s*:|-moz-binding/i.test(scan)) return { ok: false, error: 'That uses something that is not allowed in custom CSS.' };
  // every url( must be one that was recognised above and points somewhere allowed
  const calls = (scan.match(/url\s*\(/gi) || []).length;
  let seen = 0;
  for (const m of scan.matchAll(URL_CALL)) {
    seen++;
    const target = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!OKAY_URL.test(target)) return fail(`Loading “${target.slice(0, 40)}${target.length > 40 ? '…' : ''}”`);
  }
  if (seen !== calls) return fail('That url()');
  return { ok: true, css: raw };
}

// ---- applying it ---------------------------------------------------------------------------------------------------------------------
/** True when custom CSS must be ignored on this device right now: ?nocss in the address, or switched off with Ctrl+Alt+Shift+C. */
export function customCssSuppressed() {
  try { if (new URLSearchParams(location.search).has('nocss')) return true; } catch { /* no location */ }
  return read(OFF_KEY) === '1';
}

/** Put custom CSS on the page (or take it off). `settings` is { on, css } from the account's settings. */
export function applyCustomCss(settings) {
  const root = document.head || document.documentElement;
  let el = document.getElementById(STYLE_ID);
  const want = settings && settings.on !== false && typeof settings.css === 'string' && settings.css.trim() && !customCssSuppressed();
  const checked = want ? sanitizeCss(settings.css) : null;
  if (!checked || !checked.ok || !checked.css.trim()) { if (el) el.remove(); return false; }
  if (!el) { el = document.createElement('style'); el.id = STYLE_ID; root.appendChild(el); }   // last in <head>, so it wins over NullChat's own styles
  else if (el.parentNode === root && root.lastElementChild !== el) root.appendChild(el);
  if (el.textContent !== checked.css) el.textContent = checked.css;
  return true;
}

/** Ctrl+Alt+Shift+C: switch custom CSS off (or on again) on this device. Returns the new state: true = suppressed. */
export function toggleCustomCssSuppressed() {
  const next = read(OFF_KEY) === '1' ? null : '1';
  write(OFF_KEY, next);
  return next === '1';
}

/** A few starting points that rely on NullChat's colour variables and long-lived class names. */
export const CSS_EXAMPLES = [
  { id: 'accent', label: 'Change the accent colour', css: '/* Every button, link and highlight follows this */\n:root {\n  --accent: #ff7ab8;\n}\n' },
  { id: 'members', label: 'Hide the member list', css: '.member-list { display: none !important; }\n' },
  { id: 'square', label: 'Square profile pictures', css: '.avatar, .avatar img { border-radius: 6px !important; }\n' },
  { id: 'wide', label: 'Bigger, airier messages', css: '.msg-text { line-height: 1.6; }\n:root { --group-spacing: 24px; }\n' },
  { id: 'mono', label: 'Monospace messages', css: '.msg-text { font-family: var(--mono); font-size: .92em; }\n' },
];
