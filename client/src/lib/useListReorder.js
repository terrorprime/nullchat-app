// Drag-to-reorder for a plain vertical list (the roles of a server), on pointer events so a mouse, a pen and a finger all work.
// Grab a row by its handle: a label follows the pointer, a line shows where the row will land, the page scrolls itself near its
// top and bottom edges, and Escape (or letting go well outside the list) cancels. What happens on drop is up to the caller.
// Rows are marked  data-list-row  data-id="…"  inside the element `listRef` points at.
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveListDrop } from './reorder.js';
import { pageZoom } from './zoom.js';

const EDGE = 56, MAX_SPEED = 16, SLOP = 3;

function scrollParent(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement;
}
function swallowNextClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 80);
}

/** ids: the list in order · locked: how many at the top can't move · onDrop(order, id) */
export function useListReorder({ listRef, ids, locked = 0, enabled = true, onDrop }) {
  const [view, setView] = useState(null); // null | { id, x, y, marker: { top } | null }
  const ghostRef = useRef(null);
  const sess = useRef(null);
  const live = useRef({});
  live.current = { ids, locked, enabled, onDrop };

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
      if (stillDown) window.addEventListener('pointerup', swallowNextClick, { capture: true, once: true });
      else swallowNextClick();
    }
  }, []);

  const press = useCallback((e, id) => {
    if (!live.current.enabled || sess.current || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* the window listeners still get it */ }
    const s = { pointerId: e.pointerId, id, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, raf: 0, drop: null, key: '' };
    sess.current = s;

    const aim = () => {
      const list = listRef.current;
      if (!list) return null;
      const lr = list.getBoundingClientRect();
      let drop = null;
      if (s.x >= lr.left - 64 && s.x <= lr.right + 64) {
        const rows = [...list.querySelectorAll('[data-list-row]')].map((el) => ({ id: el.dataset.id, r: el.getBoundingClientRect() })).filter((x) => x.r.height > 0);
        if (rows.length) {
          let hit = rows.find((x) => s.y < x.r.bottom);
          let after = true;
          if (hit) after = s.y >= hit.r.top + hit.r.height / 2; else hit = rows[rows.length - 1];
          drop = resolveListDrop(live.current.ids, s.id, hit.id, after, live.current.locked);
        }
      }
      let marker = null;
      const a = drop && !drop.noop ? drop.anchor : null;
      if (a) {
        const el = list.querySelector(`[data-list-row][data-id="${CSS.escape(a.before || a.after)}"]`);
        if (el) { const r = el.getBoundingClientRect(); marker = { top: Math.round((a.before ? r.top : r.bottom) - lr.top) / pageZoom() }; }   // (screen → CSS pixels)
      }
      const key = JSON.stringify(marker);
      if (key !== s.key) { s.key = key; setView((v) => (v ? { ...v, marker } : v)); }
      s.drop = drop;
      return drop;
    };

    const tick = () => {
      s.raf = 0;
      if (!s.started || sess.current !== s) return;
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${(s.x - s.x0) / pageZoom()}px, ${(s.y - s.y0) / pageZoom()}px)`;
      const sc = scrollParent(listRef.current);
      let dy = 0;
      if (sc) {
        const sr = sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : sc.getBoundingClientRect();
        if (s.y < sr.top + EDGE) dy = -Math.min(MAX_SPEED, Math.ceil(((sr.top + EDGE - s.y) / EDGE) * MAX_SPEED));
        else if (s.y > sr.bottom - EDGE) dy = Math.min(MAX_SPEED, Math.ceil(((s.y - (sr.bottom - EDGE)) / EDGE) * MAX_SPEED));
        if (dy) { const was = sc.scrollTop; sc.scrollTop = was + dy; if (sc.scrollTop === was) dy = 0; }
      }
      aim();
      if (dy) s.raf = requestAnimationFrame(tick);
    };

    s.onMove = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX; s.y = ev.clientY;
      if (!s.started) {
        if (Math.hypot(s.x - s.x0, s.y - s.y0) < SLOP) return;
        if (ev.pointerType === 'mouse' && ev.buttons === 0) { stop(); return; }
        s.started = true;
        document.body.classList.add('reordering');
        if (ev.pointerType === 'touch') navigator.vibrate?.(10);
        setView({ id: s.id, x: s.x0, y: s.y0, marker: null });
      }
      if (!s.raf) s.raf = requestAnimationFrame(tick);
    };
    s.onUp = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX; s.y = ev.clientY;
      const { started, id: dragId } = s;
      const drop = started ? aim() : null;
      stop();
      if (started && drop && !drop.noop) live.current.onDrop?.(drop.order, dragId);
    };
    s.onCancel = (ev) => { if (ev.pointerId === s.pointerId) stop(); };
    s.onKey = (ev) => { if (ev.key === 'Escape' && s.started) { ev.stopPropagation(); ev.preventDefault(); stop(true); } };
    window.addEventListener('pointermove', s.onMove);
    window.addEventListener('pointerup', s.onUp);
    window.addEventListener('pointercancel', s.onCancel);
    window.addEventListener('keydown', s.onKey, true);
  }, [listRef, stop]);

  useEffect(() => { if (!enabled) stop(); }, [enabled, stop]);
  useEffect(() => () => stop(), [stop]);

  /** Props for the grip of one row. */
  const handleProps = (id) => ({
    'data-reorder-handle': '',
    onPointerDown: (e) => { e.stopPropagation(); press(e, id); },
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); },
  });

  return { view, ghostRef, handleProps };
}
