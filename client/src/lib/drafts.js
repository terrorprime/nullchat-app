// Half-written messages survive a reload, an app update or the phone closing the app in the background.
// They live in this browser only, one set per account, and are wiped when you log out.
const key = (uid) => `nullchat.drafts.${uid}`;
const MAX_DRAFTS = 60, MAX_LENGTH = 4000;
const pending = new Map(); // "uid|channelId" -> text, waiting to be written
let timer = null;

function read(uid) {
  try {
    const o = JSON.parse(localStorage.getItem(key(uid)) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/** The saved draft for a channel ('' if none). */
export function readStoredDraft(uid, channelId) {
  if (!uid) return '';
  const waiting = pending.get(`${uid}|${channelId}`);
  if (waiting !== undefined) return waiting;
  const v = read(uid)[channelId];
  return typeof v === 'string' ? v : '';
}

/** Remember what is typed in a channel (written a moment later, so typing does not hit storage on every key). */
export function storeDraft(uid, channelId, text) {
  if (!uid) return;
  pending.set(`${uid}|${channelId}`, text);
  clearTimeout(timer);
  timer = setTimeout(flushDrafts, 600);
}

export function flushDrafts() {
  clearTimeout(timer); timer = null;
  if (!pending.size) return;
  const byUser = new Map();
  for (const [k, text] of pending) {
    const i = k.indexOf('|'), uid = k.slice(0, i), channelId = k.slice(i + 1);
    if (!byUser.has(uid)) byUser.set(uid, {});
    byUser.get(uid)[channelId] = text;
  }
  pending.clear();
  for (const [uid, changes] of byUser) {
    try {
      const all = read(uid);
      for (const [channelId, text] of Object.entries(changes)) {
        delete all[channelId]; // (re-adding puts it last, so the oldest drafts are the ones dropped below)
        if (text && text.trim()) all[channelId] = text.slice(0, MAX_LENGTH);
      }
      const ids = Object.keys(all);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_DRAFTS))) delete all[id];
      if (Object.keys(all).length) localStorage.setItem(key(uid), JSON.stringify(all)); else localStorage.removeItem(key(uid));
    } catch { /* storage full or blocked: the draft just will not survive a reload */ }
  }
}

/** Forget everything saved for this account (on logout). */
export function clearStoredDrafts(uid) {
  pending.clear();
  clearTimeout(timer); timer = null;
  try { if (uid) localStorage.removeItem(key(uid)); } catch { /* ignore */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
}
