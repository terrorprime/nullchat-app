// Keeps you in the message box, the way Discord does. On a computer:
//   - clicking on messages, empty space, panels or a button in the chat leaves the cursor where it was in the message box;
//   - a letter typed (or something pasted) while nothing else is being typed in goes into the message box;
//   - when a menu, picker, edit box, search or settings screen closes, the cursor comes back to the message box;
//   - PageUp / PageDown scroll the chat while you are in the box (the box is a single line, so they did nothing).
// It never takes the cursor away from another text field, never acts while a menu, window or settings screen is open, and it
// leaves text alone that is being selected (to copy). Phones are left as they were: a box that grabs focus there opens the keyboard.
// "Keep the cursor in the message box" in Settings → Chat turns all of this off.
import { getSetting, getLocal, DEFAULT_KEYBINDS } from './settings.js';
import { comboFromEvent } from './keybinds.js';

// ---- the boxes ---------------------------------------------------------------------------------------------------------
// Every message box says hello here (the channel's, and the one in a thread beside it). The one you used last is "the" box.
const boxes = new Set();
let lastUsed = null;
export function registerComposer(api) {
  boxes.add(api);
  return () => { boxes.delete(api); if (lastUsed === api) lastUsed = null; };
}
const shown = (b) => { const el = b.el; return !!el && el.isConnected && !el.disabled && el.getClientRects().length > 0; };
function activeComposer() {
  const live = [...boxes].filter(shown);
  return (lastUsed && live.includes(lastUsed) ? lastUsed : live[live.length - 1]) || null;
}
/** Put the cursor in the message box (where it was left). */
export function focusComposer() {
  const b = activeComposer();
  if (b && document.activeElement !== b.el) b.el.focus({ preventScroll: true });
}

// ---- what is going on ---------------------------------------------------------------------------------------------------
const TEXT_INPUT = /^(text|search|email|password|number|url|tel|date|datetime-local|month|time|week)$/i;
const isEditable = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text')));
const nothingFocused = () => { const a = document.activeElement; return !a || a === document.body || a === document.documentElement; };
// Anything that sits on top of the chat and has its own business with the keyboard.
const OVERLAY = '.modal-layer, .context-menu, .popout, .settings-overlay, .image-viewer, [aria-modal="true"]';
const fine = () => window.matchMedia('(pointer: fine)').matches;
const enabled = () => getSetting('chat.keepComposerFocus') !== false;
/** Push-to-talk on a plain key (no Ctrl/Alt/Shift): that key has to reach the page, not a text box, so we stay out of the way. */
function pttOnPlainKey() {
  if (getLocal().inputMode !== 'ptt') return false;
  const c = { ...DEFAULT_KEYBINDS, ...(getSetting('keybinds') || {}) }.pushToTalk;
  return !!c && !c.includes('+');
}
const mayAct = () => enabled() && fine() && document.hasFocus() && !pttOnPlainKey() && !document.querySelector(OVERLAY) && !!activeComposer();

let mouseDown = false;
let pendingButton = null;   // a button you clicked that opened a menu: when the menu goes away the cursor goes back to the box (not stay on the button)
/** Nothing has the cursor (a click on empty space, or what had it just went away): give it back to the message box.
 *  `clicked`: this was a plain click (not a drag, not a double-click), so any old selection left standing is not being used. */
function settle(clicked = false) {
  if (mouseDown) return;
  if (pendingButton) {
    if (document.activeElement !== pendingButton) pendingButton = null;
    else if (mayAct()) { pendingButton = null; focusComposer(); return; }
  }
  if (!nothingFocused()) return;
  const sel = window.getSelection();
  if (!clicked && sel && !sel.isCollapsed) return;   // text is selected to be copied: leave it alone until it is let go of
  if (mayAct()) focusComposer();
}
let timer = 0;
const settleSoon = (clicked = false) => { clearTimeout(timer); timer = setTimeout(() => settle(clicked), 0); };

// ---- listeners ----------------------------------------------------------------------------------------------------------
let installed = false;
export function installComposerFocus() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  // Which box was used last.
  document.addEventListener('focusin', (e) => { for (const b of boxes) if (b.el === e.target) lastUsed = b; });
  // The cursor was taken from something (it moved nowhere): maybe a click on empty space.
  document.addEventListener('focusout', (e) => { if (!e.relatedTarget) settleSoon(); });
  // Dragging over text to select it: wait until the mouse is let go, and only then (if nothing is selected) come back.
  let down = null;
  document.addEventListener('mousedown', (e) => { mouseDown = true; down = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('mouseup', (e) => {
    mouseDown = false;
    // A click that did not move (and is not the second click of a double-click that selects a word) means "I am done with that": back to the box.
    const plain = !!down && e.button === 0 && e.detail === 1 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    settleSoon(plain);
  }, true);
  window.addEventListener('blur', () => { mouseDown = false; });
  // A click on a button in the chat (reply, a reaction, a panel toggle, a channel): the button must not keep the cursor.
  document.addEventListener('click', (e) => {
    if (e.detail === 0) return;   // from the keyboard (Enter/Space on a focused button): whoever tabbed there is navigating
    const b = /** @type {Element} */ (e.target)?.closest?.('button, [role="button"], summary');
    if (!b) return;
    setTimeout(() => {
      const a = document.activeElement;
      if ((a === b || nothingFocused()) && !isEditable(a) && mayAct()) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) focusComposer();
      } else if (a === b && enabled() && fine() && document.querySelector(OVERLAY)) pendingButton = b;   // it opened a menu: come back when that is closed
    }, 0);
  }, true);   // (while the click is on its way down: a button that opens a menu stops the click from reaching the page afterwards)
  // A menu, picker, edit box, search, … was closed (removed): whatever had the cursor is gone.
  let raf = 0;
  const watch = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; settle(); }); });
  const start = () => watch.observe(document.body, { childList: true, subtree: true });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // A letter typed with the cursor nowhere in particular (or on a button) goes into the message box.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // PageUp / PageDown in the box: scroll the chat (the box is one line, so they would do nothing).
    if ((e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const b = [...boxes].find((x) => x.el === e.target);
      if (b && enabled() && b.el.scrollHeight <= b.el.clientHeight + 2) {
        const sc = b.el.closest('.chat-main, .chat')?.querySelector('.message-scroll');
        if (sc) { e.preventDefault(); sc.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * sc.clientHeight * 0.9 }); }
      }
      return;
    }
    const printable = e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && (!e.altKey || e.getModifierState?.('AltGraph'));
    if (!printable || isEditable(document.activeElement) || !mayAct()) return;
    // A key the person has given a job (a shortcut they set up) keeps that job.
    const combo = comboFromEvent(e);
    const binds = { ...DEFAULT_KEYBINDS, ...(getSetting('keybinds') || {}) };
    if (Object.values(binds).some((c) => c && c === combo)) return;
    focusComposer();   // the browser then types this very letter into the box
  });
  // Something pasted with the cursor nowhere in particular (text, or a picture/file) goes to the message box.
  document.addEventListener('paste', (e) => {
    if (e.defaultPrevented || isEditable(document.activeElement) || !mayAct()) return;
    const b = activeComposer(); if (!b) return;
    const files = [...(e.clipboardData?.files || [])];
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!files.length && !text) return;
    e.preventDefault();
    focusComposer();
    if (files.length) b.addFiles(files); else b.insert(text);
  });
}
