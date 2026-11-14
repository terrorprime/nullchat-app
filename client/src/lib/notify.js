// Desktop notifications, notification sounds and the unread badge in the tab title.
import { on } from './gateway.js';
import { store, isMentioned, displayName, authorName, isChannelMuted, unreadMentionTotal } from './state.js';
import { play } from './sounds.js';
import { getSetting } from './settings.js';
import { toPlainText } from './markdown.jsx';
import { navigate } from './router.jsx';
import { closeNotificationsFor } from './push.js';
import { closeFriendMayNotify } from './closeFriends.js';

let activeChannelId = null;
export function setActiveChannel(id) {
  activeChannelId = id;
  if (document.visibilityState === 'visible') closeNotificationsFor(id);   // (what a phone showed for this chat is read now)
}
// Coming back to the app on a chat: its notifications are read too.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && activeChannelId) closeNotificationsFor(activeChannelId); });
export function getActiveChannel() { return activeChannelId; }

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

function shouldNotify(s, msg) {
  const myId = s.me?.id;
  if (!myId || msg.author.id === myId) return null;
  if (s.relationships[msg.author.id]?.type === 2) return null;
  const ch = s.channels[msg.channelId];
  if (!ch) return null;
  const status = s.presences[myId]?.status || s.me.status;
  const mentioned = isMentioned(s, msg);
  // Do Not Disturb silences everything, except (when you chose so) a close friend who messages or mentions you.
  const through = status === 'dnd' && closeFriendMayNotify(s, msg, !ch.guildId, mentioned);
  if (!ch.guildId) {
    if (isChannelMuted(s, ch)) return null;
    return { mention: true, through };
  }
  const gs = s.guildSettings[ch.guildId] || { muted: false, notifications: 0 };
  const override = gs.channelOverrides?.[ch.id] || (ch.parentId ? gs.channelOverrides?.[ch.parentId] : null);
  let level = gs.notifications ?? 0;
  if (override?.notifications !== undefined && override.notifications >= 0) level = override.notifications;
  if (override?.muted && !mentioned) return null;
  if (gs.muted && !mentioned) return null;
  if (level === 2) return null;
  if (level === 1 && !mentioned) return null;
  if (status === 'dnd' && !through) return null;
  return { mention: mentioned, through };
}

on('MESSAGE_CREATE', (msg) => {
  const s = store.get();
  const verdict = shouldNotify(s, msg);
  if (!verdict) return;
  const focused = document.hasFocus() && document.visibilityState === 'visible';
  if (focused && activeChannelId === msg.channelId) return;
  const quiet = (s.presences[s.me.id]?.status || s.me.status) === 'dnd' && !verdict.through;
  if (!quiet) play(verdict.mention ? 'mention' : 'message');
  if (!getSetting('notifications.desktop') || focused || quiet) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const ch = s.channels[msg.channelId];
  const guild = ch?.guildId ? s.guilds[ch.guildId] : null;
  const author = authorName(s, msg.author, ch?.guildId);
  const title = guild ? `${author} (#${ch.name}, ${guild.name})` : ch?.type === 3 ? `${author} (${ch.name || 'Group'})` : author;
  let body = toPlainText(msg.content, s, ch?.guildId);
  if (!body && msg.attachments?.length) body = `Uploaded ${msg.attachments.length > 1 ? `${msg.attachments.length} files` : msg.attachments[0].filename}`;
  if (!body && msg.forward) body = 'Forwarded a message';
  try {
    const n = new Notification(title, { body: body.slice(0, 200), icon: msg.author.avatar || '/icon-192.png', tag: msg.channelId, silent: true });
    n.onclick = () => {
      window.focus();
      if (ch?.guildId) navigate(`/channels/${ch.guildId}/${ch.type === 11 ? ch.parentId : ch.id}${ch.type === 11 ? `?thread=${ch.id}` : ''}`);
      else navigate(`/channels/@me/${msg.channelId}`);
      n.close();
    };
  } catch { /* some browsers require service worker notifications */ }
});

// ---- title badge + the number on the installed app's icon ----
let lastTitle = '';
let lastBadge = -1;
store.subscribe(() => {
  const s = store.get();
  if (!s.me) return;
  let count = unreadMentionTotal(s);
  for (const id of Object.keys(s.relationships)) if (s.relationships[id].type === 3) count++;
  const showBadge = getSetting('notifications.unreadBadge');
  const title = `${showBadge && count ? `(${count}) ` : ''}NullChat`;
  if (title !== lastTitle) { lastTitle = title; document.title = title; }
  // Installed web app (Chrome/Edge desktop, Android, Safari 17+ on Mac): show the count on the app icon.
  const badge = showBadge ? count : 0;
  if (badge !== lastBadge) {
    lastBadge = badge;
    try { if (badge > 0) navigator.setAppBadge?.(badge)?.catch?.(() => {}); else navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* not supported */ }
  }
});
