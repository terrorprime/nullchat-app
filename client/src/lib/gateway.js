// WebSocket gateway client with automatic reconnect.
import { handleEvent, store } from './state.js';
import { getToken } from './api.js';
import { reconnectDelay } from './backoff.js';

let ws = null;
let attempts = 0;
let reconnectTimer = null;
let manualClose = false;
let nonceCounter = 0;
const pending = new Map();
const listeners = new Map(); // event -> Set(fn)

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
function emit(event, data) {
  listeners.get(event)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  listeners.get('*')?.forEach((fn) => { try { fn(event, data); } catch (e) { console.error(e); } });
}

export function connect() {
  const token = getToken();
  if (!token) return;
  manualClose = false;
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  store.set({ status: store.get().me ? 'reconnecting' : 'connecting' });
  const sock = new WebSocket(`${proto}://${location.host}/gateway`);
  ws = sock;
  sock.onopen = () => {
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    sock.send(JSON.stringify({ op: 'identify', d: { token, mobile } }));
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { t, d } = msg;
    if (t === 'REPLY') {
      const p = pending.get(d.nonce);
      if (p) { pending.delete(d.nonce); p(d); }
      return;
    }
    if (t === 'READY') attempts = 0;
    if (t === 'INVALID_SESSION') { emit('INVALID_SESSION', d); return; }
    handleEvent(t, d);
    emit(t, d);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    for (const [, resolve] of pending) resolve({ error: 'Disconnected' });
    pending.clear();
    emit('DISCONNECTED', { code: ev.code });
    if (manualClose || ev.code === 4004) return;
    store.set({ status: 'reconnecting' });
    const delay = reconnectDelay(attempts);
    attempts++;
    reconnectTimer = setTimeout(connect, delay);
  };
  sock.onerror = () => {};
}

export function disconnect() {
  manualClose = true;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(1000); } catch { /* ignore */ } }
  ws = null;
}

export function send(op, d) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

export function request(op, d, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (ws?.readyState !== 1) { resolve({ error: 'Not connected to NullChat.' }); return; }
    const nonce = `n${++nonceCounter}`;
    pending.set(nonce, resolve);
    ws.send(JSON.stringify({ op, d, nonce }));
    setTimeout(() => { if (pending.has(nonce)) { pending.delete(nonce); resolve({ error: 'Timed out' }); } }, timeoutMs);
  });
}

// Reconnect promptly when the network/tab comes back.
window.addEventListener('online', () => { if (!ws && !manualClose && getToken()) { attempts = 0; connect(); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !ws && !manualClose && getToken()) { attempts = 0; connect(); }
});
