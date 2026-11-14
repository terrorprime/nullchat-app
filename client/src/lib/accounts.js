// Other accounts signed in on this device, so you can switch between them without typing a password.
//
// What is kept, and where: for each account you chose to add, its name, picture and its sign-in token, in this browser's (or this app's) storage.
// That is the same place your current sign-in already lives, and nothing is sent anywhere. An account is only added when you choose "Add Account",
// and it is taken out again by "Log out" (which also ends that sign-in on the server), by "Remove" in the switcher, or when its sign-in stops
// working (a password change, "log out all devices", or an administrator ending it).
import { getToken, setToken } from './api.js';

const KEY = 'nullchat.accounts';
const ADDING = 'nullchat.adding';   // while you are signing in to another account: who to go back to if you cancel
export const MAX_ACCOUNTS = 5;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((a) => a && typeof a.id === 'string' && typeof a.token === 'string') : [];
  } catch { return []; }
}
function write(list) {
  try { if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); else localStorage.removeItem(KEY); } catch { /* storage unavailable: nothing is remembered */ }
}
const shape = (u, token) => ({ id: u.id, username: u.username, displayName: u.displayName || null, avatar: u.avatar || null, token });

/** Every account remembered on this device (newest sign-in last). */
export const listAccounts = () => read();
/** The remembered accounts other than the one in use. */
export const otherAccounts = (meId) => read().filter((a) => a.id !== meId);

/** Remember (or refresh) an account together with the token it is using. */
export function rememberAccount(user, token) {
  if (!user?.id || !token) return false;
  const list = read();
  const i = list.findIndex((a) => a.id === user.id);
  if (i >= 0) list[i] = shape(user, token);
  else {
    if (list.length >= MAX_ACCOUNTS) return false;
    list.push(shape(user, token));
  }
  write(list);
  return true;
}
/** Keep the name and picture shown in the switcher up to date (does nothing for an account that was not added). */
export function refreshAccount(user) {
  if (!user?.id) return;
  const list = read();
  const i = list.findIndex((a) => a.id === user.id);
  if (i < 0) return;
  const next = shape(user, list[i].token);
  if (next.username === list[i].username && next.displayName === list[i].displayName && next.avatar === list[i].avatar) return;
  list[i] = next;
  write(list);
}
export function forgetAccount(id) {
  const list = read();
  const rest = list.filter((a) => a.id !== id);
  if (rest.length !== list.length) write(rest);
}
/** Forget whichever account uses this token (a sign-in that no longer works is not kept for switching). */
export function forgetToken(token) {
  if (!token) return;
  const list = read();
  const rest = list.filter((a) => a.token !== token);
  if (rest.length !== list.length) write(rest);
}
export const isRemembered = (id) => read().some((a) => a.id === id);

/** Make another remembered account the one in use. The page starts over, so nothing of the old account is left on screen. */
export function switchToAccount(id, to = '/channels/@me') {
  const a = read().find((x) => x.id === id);
  if (!a) return false;
  try { sessionStorage.removeItem(ADDING); } catch { /* */ }
  setToken(a.token, true);
  location.assign(to);
  return true;
}

/** Start signing in to one more account: the one in use is kept (not logged out), and the login page opens. */
export function beginAddAccount(me) {
  const token = getToken();
  if (!me || !token) return false;
  if (!isRemembered(me.id) && !rememberAccount(me, token)) return false;
  try { sessionStorage.setItem(ADDING, me.id); } catch { /* */ }
  setToken(null);
  location.assign('/login');
  return true;
}
/** Who was in use before "Add Account" (null when you are not adding one). */
export function addingFrom() {
  try { return sessionStorage.getItem(ADDING) || null; } catch { return null; }
}
export function endAddAccount() { try { sessionStorage.removeItem(ADDING); } catch { /* */ } }

/** Sign-in just worked (login, two-factor or sign-up): if it was for "Add Account", remember it. */
export function finishAddAccount(user, token) {
  if (!addingFrom()) return false;
  endAddAccount();
  return rememberAccount(user, token);
}

/** Log a remembered account out on the server and forget it here. (For one that is not the account in use.) */
export async function removeAccount(id) {
  const a = read().find((x) => x.id === id);
  if (!a) return;
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${a.token}` } }); } catch { /* it will expire on its own, or be ended from the devices list */ }
  forgetAccount(id);
}
