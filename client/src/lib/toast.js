// Tiny toast notification system.
import { createStore, useStoreOf } from './store.js';

export const toastStore = createStore({ toasts: [] });
let counter = 0;

/** opts.onClick makes the toast clickable (e.g. "jump to the message"); opts.actionLabel is the small hint shown on it.
 *  opts.actions adds extra buttons: [{ label, onClick }] (each one also closes the toast). */
export function toast(message, type = 'info', ms = 4500, opts = {}) {
  const id = ++counter;
  toastStore.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, type, onClick: opts.onClick, actionLabel: opts.actionLabel, actions: opts.actions }] }));
  setTimeout(() => dismissToast(id), ms);
  return id;
}
export function dismissToast(id) {
  toastStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export const useToasts = () => useStoreOf(toastStore, (s) => s.toasts);

/** Show an API error nicely. */
export function toastError(e, fallback = 'Something went wrong.') {
  toast(e?.message || fallback, 'error');
}
