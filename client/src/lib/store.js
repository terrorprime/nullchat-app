// Minimal global store built on React's useSyncExternalStore (no external state library needed).
import { useSyncExternalStore, useRef, useCallback } from 'react';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set: (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      if (next === state || next == null) return;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
}

// Structural equality for selector results, a few levels deep. Leaves (e.g. store objects)
// are compared by identity, so this stays cheap while allowing selectors to build small
// derived arrays/objects without causing re-render loops.
function shallowEqual(a, b, depth = 4) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (Object.is(a[k], b[k])) continue;
    if (depth <= 0 || !shallowEqual(a[k], b[k], depth - 1)) return false;
  }
  return true;
}

/** Subscribe to a slice of a store. Re-renders only when the selected value changes (shallowly). */
export function useStoreOf(store, selector) {
  const last = useRef({ has: false, value: undefined });
  const sel = useRef(selector);
  sel.current = selector;
  const getSnapshot = useCallback(() => {
    const v = sel.current(store.get());
    if (last.current.has && shallowEqual(v, last.current.value)) return last.current.value;
    last.current = { has: true, value: v };
    return v;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
