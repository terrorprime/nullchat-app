// Global keyboard shortcuts and push-to-talk.
import { getSetting, DEFAULT_KEYBINDS } from './settings.js';
import { setPushToTalk } from './voice.js';

const handlers = new Map();
export function registerAction(name, fn) { handlers.set(name, fn); return () => { if (handlers.get(name) === fn) handlers.delete(name); }; }

const KEY_NAMES = { ' ': 'Space', Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
export function keyName(e) {
  let k = e.key;
  if (KEY_NAMES[k]) k = KEY_NAMES[k];
  if (k.length === 1) k = k.toUpperCase();
  // With Shift held, symbol keys change (e.g. "/" → "?"); fall back to the physical code.
  if (e.shiftKey && /^Digit\d$|^(Slash|Comma|Period|Semicolon|Quote|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash)$/.test(e.code)) {
    const map = { Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
    k = map[e.code] || e.code.replace('Digit', '');
  }
  return k;
}
export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = keyName(e);
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(k)) parts.push(k);
  return parts.join('+');
}
export function prettyCombo(c) {
  if (!c) return 'Not set';
  const mac = /Mac/.test(navigator.platform);
  return c.split('+').map((p) => ({ Ctrl: mac ? '⌘' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' }[p] || p)).join(' + ');
}

function inTextField(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

let capturing = null; // when the keybind editor is recording
export function captureNextCombo(fn) { capturing = fn; }

function binds() { return { ...DEFAULT_KEYBINDS, ...(getSetting('keybinds') || {}) }; }

window.addEventListener('keydown', (e) => {
  if (capturing) {
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const fn = capturing; capturing = null;
    fn(e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey ? null : comboFromEvent(e));
    return;
  }
  const combo = comboFromEvent(e);
  const b = binds();
  if (b.pushToTalk && combo === b.pushToTalk && !e.repeat) {
    const hasModifier = combo.includes('+');
    if (hasModifier || !inTextField(e)) { setPushToTalk(true); if (!hasModifier) e.preventDefault(); }
  }
  for (const [action, c] of Object.entries(b)) {
    if (!c || c !== combo || action === 'pushToTalk') continue;
    const fn = handlers.get(action);
    if (!fn) continue;
    // Plain keys (no modifiers) don't fire while typing, except Escape.
    if (!combo.includes('+') && inTextField(e) && combo !== 'Escape') continue;
    const handled = fn(e);
    if (handled !== false) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
}, true);

window.addEventListener('keyup', (e) => {
  const b = binds();
  if (!b.pushToTalk) return;
  const last = b.pushToTalk.split('+').pop();
  if (keyName(e) === last || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) setPushToTalk(false);
});
window.addEventListener('blur', () => setPushToTalk(false));
