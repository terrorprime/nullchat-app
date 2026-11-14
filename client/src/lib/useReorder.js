// Drag-to-reorder for the channel list, built on pointer events so one code path serves a mouse, a pen and a finger.
//   · With a mouse (or pen) any category header or channel row can be picked up: press, move a few pixels, drag.
//   · A finger can't do that (it is how you scroll), so on a touch screen the list has a "Reorder" mode where every row shows a
//     handle; a finger on a handle drags straight away.
// While dragging: a label follows the pointer, a line (or a highlighted category) shows where it will land, the list scrolls itself
// near its top and bottom edges, Escape or letting go outside the list cancels, and dragging a category folds all categories up
// so the whole order is on screen at once. What happens on drop is up to the caller (`onDrop`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveCategoryDrop, resolveChannelDrop } from './reorder.js';
import { pageZoom } from './zoom.js';

const EDGE = 56;       // px from the top/bottom of the list where it starts scrolling
const MAX_SPEED = 16;  // px per frame at the very edge
const SLOP_ROW = 6;    // px of movement before a press on a row becomes a drag (so a click is still a click)
const SLOP_HANDLE = 3;

/** The click that follows letting go of a drag must not also open the channel or fold the category. */
function swallowNextClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 80);
}

export function useReorder({ scrollRef, layout, enabled, onDrop }) {
  const [view, setView] = useState(null); // null | { id, kind, label, type, x, y, marker }
  const ghostRef = useRef(null);
  const sess = useRef(null);
  const live = useRef({});
  live.current = { layout, enabled, onDrop };

  const stop = useCallback((stillDown = false) => {
    const s = sess.current;
    if (!s) return;
    sess.current = null;
    cancelAnimationFrame(s.raf);
    window.removeEventListener('pointermove', s.onMove);
    window.removeEventListener('pointerup', s.onUp);
    window.removeEventListener('pointercancel', s.onCancel);
    window.removeEventListener('keydown', s.onKey, true);
    document.body.classList.remove('reordering');
    if (s.started) {
      setView(null);
      // Escape leaves the button still held down: the click comes when it is let go, so wait for that.
      if (stillDown) window.addEventListener('pointerup', swallowNextClick, { capture: true, once: true });
      else swallowNextClick();
    }
  }, []);

  const press = useCallback((e, kind, item, handle) => {
    if (!live.current.enabled || sess.current || e.button !== 0) return;
    if (!handle && e.pointerType === 'touch') return;                                   // fingers use the handle
    if (!handle && e.target.closest?.('button, input, textarea, select, [data-reorder-handle]')) return;
    if (handle) { try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not capturable: window listeners still get it */ } }
    const s = { pointerId: e.pointerId, kind, id: item.id, label: item.name, type: item.type, handle, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, raf: 0, drop: null, key: '' };
    sess.current = s;

    // Work out what is under the pointer; draw the marker; remember the answer for the drop.
    const aim = () => {
      const sc = scrollRef.current;
      if (!sc) return null;
      const sr = sc.getBoundingClientRect();
      let drop = null;
      if (s.x >= sr.left - 48 && s.x <= sr.right + 48) {                                 // let go well outside the list = cancel
        const rows = [...sc.querySelectorAll('[data-reorder-row]')]
          .map((el) => ({ el, kind: el.dataset.reorderRow, id: el.dataset.id, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.height > 0 && (s.kind === 'channel' || x.kind === 'category'));
        if (rows.length) {
          let hit = rows.find((x) => s.y < x.r.bottom);
          let after = true;
          if (hit) after = s.y >= hit.r.top + hit.r.height / 2; else hit = rows[rows.length - 1];
          drop = s.kind === 'category'
            ? resolveCategoryDrop(live.current.layout, s.id, hit.id, after)
            : resolveChannelDrop(live.current.layout, s.id, { kind: hit.kind, id: hit.id }, after);
        }
      }
      let marker = null;
      const a = drop && !drop.noop ? drop.anchor : null;
      if (a?.into) marker = { into: a.into };
      else if (a?.zone) marker = { zone: true };
      else if (a) {
        const el = sc.querySelector(`[data-reorder-row][data-id="${CSS.escape(a.before || a.after)}"]`);
        if (el) { const r = el.getBoundingClientRect(); marker = { top: Math.round((a.before ? r.top : r.bottom) - sr.top) / pageZoom() + (a.before ? -1 : 1) + sc.scrollTop }; }   // (screen → CSS pixels)
      }
      const key = JSON.stringify(marker);
      if (key !== s.key) { s.key = key; setView((v) => (v ? { ...v, marker } : v)); }
      s.drop = drop;
      return drop;
    };

    const tick = () => {
      s.raf = 0;
      if (!s.started || sess.current !== s) return;
      const sc = scrollRef.current;
      if (!sc) return;
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${(s.x - s.x0) / pageZoom()}px, ${(s.y - s.y0) / pageZoom()}px)`;
      const sr = sc.getBoundingClientRect();
      let dy = 0;
      if (s.y < sr.top + EDGE) dy = -Math.min(MAX_SPEED, Math.ceil(((sr.top + EDGE - s.y) / EDGE) * MAX_SPEED));
      else if (s.y > sr.bottom - EDGE) dy = Math.min(MAX_SPEED, Math.ceil(((s.y - (sr.bottom - EDGE)) / EDGE) * MAX_SPEED));
      if (dy) { const was = sc.scrollTop; sc.scrollTop = was + dy; if (sc.scrollTop === was) dy = 0; }
      aim();
      if (dy) s.raf = requestAnimationFrame(tick);
    };

    s.onMove = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX; s.y = ev.clientY;
      if (!s.started) {
        if (Math.hypot(s.x - s.x0, s.y - s.y0) < (s.handle ? SLOP_HANDLE : SLOP_ROW)) return;
        if (ev.pointerType === 'mouse' && ev.buttons === 0) { stop(); return; }           // the button was let go somewhere we didn't see
        s.started = true;
        document.body.classList.add('reordering');
        if (ev.pointerType === 'touch') navigator.vibrate?.(10);
        setView({ id: s.id, kind: s.kind, label: s.label, type: s.type, x: s.x0, y: s.y0, marker: null });
      }
      if (!s.raf) s.raf = requestAnimationFrame(tick);
    };
    s.onUp = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX; s.y = ev.clientY;
      const { started, kind, id } = s;
      const drop = started ? aim() : null;
      stop();
      if (started && drop && !drop.noop) live.current.onDrop?.(kind, id, drop);
    };
    s.onCancel = (ev) => { if (ev.pointerId === s.pointerId) stop(); };
    s.onKey = (ev) => { if (ev.key === 'Escape' && s.started) { ev.stopPropagation(); ev.preventDefault(); stop(true); } };
    window.addEventListener('pointermove', s.onMove);
    window.addEventListener('pointerup', s.onUp);
    window.addEventListener('pointercancel', s.onCancel);
    window.addEventListener('keydown', s.onKey, true);
  }, [scrollRef, stop]);

  useEffect(() => { if (!enabled) stop(); }, [enabled, stop]);
  useEffect(() => () => stop(), [stop]);

  /** Props for a whole row: a mouse can pick it up anywhere. */
  const rowProps = (kind, item) => (enabled ? {
    onPointerDown: (e) => press(e, kind, item, false),
    onDragStart: (e) => e.preventDefault(),   // the browser's own link-dragging would otherwise take over from an <a>
  } : {});
  /** Props for the handle shown in Reorder mode: a finger (or anything) can pick it up. */
  const handleProps = (kind, item) => ({
    'data-reorder-handle': '',
    onPointerDown: (e) => { e.stopPropagation(); press(e, kind, item, true); },
    onTouchStart: (e) => e.stopPropagation(),  // not the start of a long-press (which opens the channel's menu)
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); },
  });

  return { view, ghostRef, rowProps, handleProps };
}
