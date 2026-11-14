// Close friends: the friends you starred. They sort to the top of your friends list, and (if you turn it on in Settings → Notifications)
// they are the only people whose direct messages and mentions still notify you while you are on Do Not Disturb.
// The list is part of your synced settings, so it follows your account. Nobody else can see it: the other person is never told.
import { store } from './state.js';
import { updateSettings, getSetting } from './settings.js';
import { toast } from './toast.js';

export const MAX_CLOSE_FRIENDS = 50;

const listOf = (s) => (Array.isArray(s.settings?.closeFriends) ? s.settings.closeFriends : []);

/** Starred, and still a friend (someone you removed or blocked stops counting without you having to un-star them). */
export const isCloseFriend = (s, userId) => s.relationships[userId]?.type === 1 && listOf(s).includes(userId);

export function toggleCloseFriend(userId) {
  const s = store.get();
  const cur = listOf(s).filter((id) => s.relationships[id]?.type === 1);   // (tidies away people who are no longer friends)
  if (cur.includes(userId)) { updateSettings({ closeFriends: cur.filter((id) => id !== userId) }); return false; }
  if (s.relationships[userId]?.type !== 1) { toast('Only friends can be close friends.', 'error'); return false; }
  if (cur.length >= MAX_CLOSE_FRIENDS) { toast(`You can have up to ${MAX_CLOSE_FRIENDS} close friends. Un-star someone first.`, 'error'); return false; }
  updateSettings({ closeFriends: [...cur, userId] });
  return true;
}

/** While you are on Do Not Disturb: does this message get through because a close friend sent it? (The server has the same rule for phone notifications: lib/push.js.) */
export function closeFriendMayNotify(s, msg, isDM, mentioned) {
  return !!getSetting('notifications.closeFriendsBreakDnd') && (isDM || mentioned) && isCloseFriend(s, msg.author.id);
}
