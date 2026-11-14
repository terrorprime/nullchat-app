// UI-only state (panels, overlays, mobile navigation) — not synced to the server.
import { createStore, useStoreOf } from './store.js';
import { getLocal, setLocal } from './settings.js';

export const uiStore = createStore({
  mobileNav: false,          // phones: the servers + channels screen is showing (otherwise the chat/page is)
  reorderGuild: null,        // the server whose channel list is in Reorder mode (every row shows a drag handle), or null
  navGuild: null,            // phones: the server whose channels the list is showing, before one is opened (null = the open one)
  memberList: getLocal().memberListOpen,
  mobileMembers: false,      // member list on narrow screens (overlay, closed by default)
  rightPanel: null,          // null | 'search' | 'members'
  search: null,              // { scope: 'guild'|'channel', id, query, filters }
  settings: null,            // { type: 'user', tab } | { type: 'guild', guildId, tab } | { type: 'channel', channelId, tab }
  lastChannel: {},           // guildId -> channelId
  replyTo: {},               // channelId -> message
  editing: null,             // messageId being edited
  drafts: {},                // channelId -> text
});
export const useUI = (sel) => useStoreOf(uiStore, sel);
export const setUI = (p) => uiStore.set(p);

/** True on a phone-sized screen (the layout with a servers/channels screen, a back arrow and a bottom tab bar). */
export const isPhone = () => window.matchMedia('(max-width: 768px)').matches;

// Opening settings without naming a page (the gear, the "You" tab) starts on the list of pages on a phone, like Discord.
// Naming one (a link that says "go to Privacy") goes straight to it.
export function openUserSettings(tab) { uiStore.set({ settings: { type: 'user', tab: tab || 'account', list: tab === undefined } }); }
export function openGuildSettings(guildId, tab) { uiStore.set({ settings: { type: 'guild', guildId, tab: tab || 'overview', list: tab === undefined } }); }
export function openChannelSettings(channelId, tab) { uiStore.set({ settings: { type: 'channel', channelId, tab: tab || 'overview', list: tab === undefined } }); }
// Unsaved changes: a settings page whose Save bar is showing registers here, and leaving that page (another tab, Back, the X, Esc)
// is refused until the changes are saved or reset. The Save bar shakes and says so. `force` is for when the page has to
// go anyway (the server or channel it edits was deleted, the person logged out).
const unsaved = new Set();
export function setUnsaved(key, on) { if (on) unsaved.add(key); else unsaved.delete(key); }
export const hasUnsaved = () => unsaved.size > 0;
export function refuseIfUnsaved() {
  if (!unsaved.size) return false;
  window.dispatchEvent(new CustomEvent('nullchat:unsaved'));
  navigator.vibrate?.(30);
  return true;
}
/** Closes settings. Returns false (and leaves them open) when there are unsaved changes, unless forced. */
export function closeSettings(force = false) {
  if (force !== true && refuseIfUnsaved()) return false; // (only a plain `true` forces it: a click event passed in by mistake must not)
  uiStore.set({ settings: null });
  return true;
}

export function toggleMemberList() {
  if (window.matchMedia('(max-width: 860px)').matches) { uiStore.set({ mobileMembers: !uiStore.get().mobileMembers }); return; }
  const v = !uiStore.get().memberList;
  uiStore.set({ memberList: v });
  setLocal({ memberListOpen: v });
}
export function setReply(channelId, message) {
  uiStore.set({ replyTo: { ...uiStore.get().replyTo, [channelId]: message } });
}
export function setDraft(channelId, text) {
  const d = uiStore.get().drafts;
  if ((d[channelId] || '') === text) return;
  uiStore.set({ drafts: { ...d, [channelId]: text } });
}
