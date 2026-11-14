// Tiny client-side router built on the History API.
import { useSyncExternalStore } from 'react';

const listeners = new Set();
function notify() { listeners.forEach((l) => l()); }
window.addEventListener('popstate', notify);

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
}

function subscribe(l) { listeners.add(l); return () => listeners.delete(l); }
const getPath = () => location.pathname;
const getSearch = () => location.search;

export function usePath() { return useSyncExternalStore(subscribe, getPath, getPath); }
export function useSearch() { return new URLSearchParams(useSyncExternalStore(subscribe, getSearch, getSearch)); }

/** decodeURIComponent that does not throw on a stray "%" (a broken link): the text is used as it is. */
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Match "/channels/:guildId/:channelId?" style patterns. */
export function matchPath(pattern, path) {
  const keys = [];
  // Single pass so parameter names stay in the same order as their capture groups.
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)(\?)?/g, (_, k, opt) => {
    keys.push(k);
    return opt ? '(?:/([^/]+))?' : '/([^/]+)';
  }) + '/?$');
  const m = re.exec(path);
  if (!m) return null;
  const params = {};
  keys.forEach((k, i) => { params[k] = m[i + 1] ? safeDecode(m[i + 1]) : undefined; });
  return params;
}

export function Link({ to, children, onClick, ...rest }) {
  return (
    <a href={to} {...rest} onClick={(e) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}
