// "A new version is ready" support, for the browser, the installed web app and the desktop app.
//
// Web: the server writes a build id into the page it serves (<meta name="nullchat-build">) and reports the
// current one from /api/health. After you deploy a new version, the id the open page was loaded with no
// longer matches, so we offer an Update button (reloads the page). It is checked every few minutes, whenever
// the window is focused again, and right after the connection to the server comes back (a deploy restarts it).
//
// Desktop app: its window loads the same site, so web updates work the same way. Updates to the app itself
// (the installer) are downloaded by the desktop shell, which reports progress here (see desktop/main.cjs).
import { createStore, useStoreOf } from './store.js';
import { desktop } from './install.js';
import { voiceStore } from './voice.js';
import { on } from './gateway.js';

const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="nullchat-build"]')?.content : null;
/** The build this page was loaded with. null when running from the dev server (nothing to compare then). */
export const CURRENT_BUILD = meta || null;

const MIN_GAP_MS = 30 * 1000;
const POLL_MS = 5 * 60 * 1000;

const store = createStore({
  web: 'unknown', // 'unknown' | 'current' | 'available'
  serverBuild: null,
  checking: false,
  checkedAt: 0,
  dismissed: null, // build id the person chose "Later" for
  shell: null, // desktop app: { state: 'checking' | 'downloading' | 'ready' | 'available', version, percent }
});
export const useUpdates = () => useStoreOf(store, (s) => s);
export const getUpdates = () => store.get();

/** Ask the server which build is current. Resolves to 'available' | 'current' | 'unsupported' | 'error'. */
export async function checkForUpdate({ force = false } = {}) {
  if (!CURRENT_BUILD) return 'unsupported';
  const s = store.get();
  if (s.checking) return s.web === 'available' ? 'available' : 'current';
  if (!force && Date.now() - s.checkedAt < MIN_GAP_MS) return s.web === 'available' ? 'available' : 'current';
  store.set({ checking: true });
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    const build = data?.build || null;
    const available = !!build && build !== CURRENT_BUILD;
    store.set({ checking: false, checkedAt: Date.now(), serverBuild: build, web: available ? 'available' : 'current' });
    return available ? 'available' : 'current';
  } catch {
    store.set({ checking: false });
    return 'error';
  }
}

/** Load the new version. Clears the app-shell cache first so nothing old is reused, then reloads. */
export async function applyUpdate() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
  } catch { /* ignore */ }
  try {
    const keys = (await window.caches?.keys?.()) || [];
    await Promise.all(keys.map((k) => window.caches.delete(k)));
  } catch { /* ignore */ }
  window.location.reload();
}

/** True while the person is in a voice call (an update reloads the page, which hangs up). */
export const inVoiceCall = () => !!voiceStore.get().channelId;

export function dismissUpdate() {
  const { serverBuild, shell } = store.get();
  store.set({ dismissed: shell?.state === 'ready' ? `shell:${shell.version}` : serverBuild });
}

/** Desktop app: restart into the downloaded update. */
export function installShellUpdate() { desktop?.installUpdate?.(); }

/** Desktop app: ask the shell to look for an app update now. Resolves to 'restarting' | 'none' | 'available'. */
export async function checkShellUpdate() {
  if (!desktop?.checkForUpdates) return 'none';
  store.set({ shell: { ...(store.get().shell || {}), state: store.get().shell?.state === 'ready' ? 'ready' : 'checking' } });
  const r = await desktop.checkForUpdates().catch(() => 'none');
  if (r === 'none' && store.get().shell?.state === 'checking') store.set({ shell: null });
  return r;
}

let started = false;
/** Start the background checks. Safe to call more than once. */
export function startUpdateChecks() {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (CURRENT_BUILD) {
    setTimeout(() => checkForUpdate(), 15 * 1000);
    setInterval(() => checkForUpdate(), POLL_MS);
    const soon = () => { if (document.visibilityState !== 'hidden') checkForUpdate(); };
    document.addEventListener('visibilitychange', soon);
    window.addEventListener('focus', soon);
    window.addEventListener('online', () => checkForUpdate({ force: true }));
    // A deploy restarts the server: the connection drops and comes back, which is the moment to look.
    on('READY', () => checkForUpdate({ force: true }));
  }
  if (desktop?.onUpdate) {
    desktop.onUpdate((d) => store.set({ shell: d && d.state ? d : null }));
    desktop.info?.().then((i) => { if (i?.update?.state) store.set({ shell: i.update }); }).catch(() => {});
  }
}
