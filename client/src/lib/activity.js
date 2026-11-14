// "Playing X": in the desktop app, notice a running game and show its name under the user's name.
// Only the game's display name is sent to the server. The process list stays on this computer.
//
// The server forgets the activity when this person's last connection closes (the app was closed, crashed or lost its network), so
// the tracker says it again whenever the connection comes back, and tries again on the next check if sending failed.
import { api } from './api.js';
import { store } from './state.js';
import { desktop } from './install.js';
import { on as onGateway } from './gateway.js';
import { gameNameFor } from '../../../shared/levels.js';

const POLL_MS = 20_000;
let timer = null;
let offReady = null;
let current = null;     // { name, since } while a game is running, else null
let synced = true;      // does the server know about `current`?
let busy = false;

async function tick() {
  if (!desktop?.processList || busy) return;
  busy = true;
  try {
    const sharing = store.get().settings?.privacy?.shareActivity !== false;
    let game = null;
    if (sharing) {
      try { game = (await desktop.processList()).map(gameNameFor).find(Boolean) || null; } catch { return; }
    }
    if ((game || null) !== (current?.name || null)) {
      current = game ? { name: game, since: Date.now() } : null;
      synced = false;
    }
    if (!synced) synced = await api.patch('/users/@me/presence', { activity: current }).then(() => true, () => false);
  } finally { busy = false; }
}

export function startActivityTracker() {
  if (!desktop?.processList || timer) return () => {};
  tick();
  timer = setInterval(tick, POLL_MS);
  // A fresh connection starts without an activity: send the one that is still going.
  offReady = onGateway('READY', () => { if (current) { synced = false; tick(); } });
  return () => {
    clearInterval(timer); timer = null;
    offReady?.(); offReady = null;
    if (current) { current = null; synced = true; api.patch('/users/@me/presence', { activity: null }).catch(() => {}); }
  };
}
