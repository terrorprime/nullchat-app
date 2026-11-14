// Picture-in-picture for calls: the call in a small window that stays on top of everything else while you use other tabs or apps.
// It shows whoever is sharing a screen or camera (or everyone's pictures, lit while they speak) with mute, deafen and hang up.
//
// The window comes from the browser's Document Picture-in-Picture (Chrome, Edge) or, in the desktop app, from a small always-on-top
// window the app opens for it (desktop/main.cjs). Either way it is an empty page of ours that this file draws into; the call itself
// (sound, connections) stays in the main window.
//
// Where neither is there (a desktop app installed before this existed, Safari), the call is painted onto a canvas and that picture is
// shown in the browser's ordinary video picture-in-picture: the same view, without our buttons (the browser adds its own mute and
// hang up where it can). Browsers with none of the three (Firefox) are not offered the button.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createStore, useStoreOf } from '../lib/store.js';
import { useStore, getState, displayName, channelPermissions } from '../lib/state.js';
import { useVoice, voiceStore, leaveVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreen, reacquireMic, refreshOutputs, switchCamera } from '../lib/voice.js';
import { configureSounds } from '../lib/sounds.js';
import { chooseDevice, outputSink, canChooseOutput, deviceName } from '../lib/devices.js';
import { api } from '../lib/api.js';
import { loadMessages, sendMessage, ackChannel } from '../lib/actions.js';
import { Markdown } from '../lib/markdown.jsx';
import { setPickerHost, loadPrefs as loadSharePrefs, savePrefs as saveSharePrefs, SHARE_QUALITIES } from './ScreenSharePicker.jsx';
import { getLocal, setLocal, onLocalChange } from '../lib/settings.js';
import { inNativeApp } from '../lib/native.js';
import { navigate } from '../lib/router.jsx';
import { toast, toastError } from '../lib/toast.js';
import { cx, colorFor, initials, inviteUrl, formatMessageTime } from '../lib/utils.js';
import { ChannelType, P, has } from '../../../shared/permissions.js';
import { Avatar, ToggleSetting } from './ui.jsx';
import { Icon } from './icons.jsx';

const SIZE = { width: 480, height: 340 };
const MAX_FACES = 6;
const BIG = { width: 1000, height: 640 };   // the ordinary window (minimise, maximise, close) the small one can be turned into
const pipStore = createStore({ win: null, video: null, kind: null });   // kind: 'pip' (small, on top) | 'window' (an ordinary window) | 'desktop' (the desktop app's)
export const usePopoutOpen = () => useStoreOf(pipStore, (s) => !!(s.win || s.video));
/** Whether the call is in a window of its own (with all its buttons): the app's own view of the call then steps aside. */
export const usePopoutWindow = () => useStoreOf(pipStore, (s) => !!s.win);

const desktopApp = () => !!(typeof window !== 'undefined' && window.nullchatDesktop?.isDesktop);
// (a desktop app new enough to open the small window says so; older ones refuse to open any window)
const desktopWindow = () => desktopApp() && !!window.nullchatDesktop.callWindow;
const documentPip = () => 'documentPictureInPicture' in window && !desktopApp();
// (an ordinary browser window of our own: any computer browser can open one; a phone would open a tab instead)
const plainWindow = () => typeof window !== 'undefined' && !desktopApp() && !!window.matchMedia?.('(pointer: fine)').matches;
const videoPip = () => typeof document !== 'undefined' && !!document.pictureInPictureEnabled && typeof HTMLVideoElement !== 'undefined' && 'requestPictureInPicture' in HTMLVideoElement.prototype;
/** Whether this browser or app can show a call in a small window of its own. */
export function popoutSupported() {
  if (typeof window === 'undefined' || inNativeApp()) return false;
  return documentPip() || desktopWindow() || plainWindow() || videoPip();
}

/** Give the small window the app's look: its style sheets, and the theme that is set on <html> (kept in step while it is open). */
function dress(win) {
  const doc = win.document;
  doc.title = 'NullChat call';
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    if (node.tagName === 'LINK') { const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = node.href; doc.head.appendChild(l); }
    else { const s = doc.createElement('style'); s.textContent = node.textContent; doc.head.appendChild(s); }
  }
  const root = document.documentElement;
  const copy = () => {
    const to = doc.documentElement;
    to.className = root.className;
    to.lang = root.lang;
    if (root.dataset.theme) to.dataset.theme = root.dataset.theme;
    to.style.cssText = root.style.cssText;
    to.style.zoom = '';   // (the Zoom setting is for the main window)
    to.style.setProperty('--zoom', '1');
  };
  copy();
  doc.body.className = 'call-popout-body';
  const mo = new MutationObserver(copy);
  mo.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'lang'] });
  return () => mo.disconnect();
}

let opening = false;
/** Open the small window (while in a call). `auto`: the browser asked for it because you switched tabs; nothing is said if it can't. */
export async function openCallPopout({ auto = false } = {}) {
  if (pipStore.get().win || pipStore.get().video || opening || !voiceStore.get().channelId || !popoutSupported()) return false;
  opening = true;
  let win = null;
  try {
    if (documentPip()) {
      try { win = await window.documentPictureInPicture.requestWindow(SIZE); } catch { win = null; }
    } else if (desktopWindow()) {
      try { win = window.open('about:blank', 'nullchat-pip', `width=${BIG.width},height=${BIG.height}`); } catch { win = null; }
      if (win && getLocal().popoutOnTop) keepOnTop(true);
    }
    // No small on-top window to be had: an ordinary window does everything else (all the buttons, maximise, full screen).
    if (!win && !auto && plainWindow() && voiceStore.get().channelId) {
      const big = openBig();
      if (big) { adopt(big, 'window'); return true; }
    }
    // Last resort (a desktop app from before the pop-out existed, a browser that blocks new windows): a picture of the call.
    if (!win && videoPip() && await openVideoPopout()) return true;
  } finally { opening = false; }
  if (!win) { if (!auto) toast('The call could not be popped out here.', 'error'); return false; }
  if (!voiceStore.get().channelId) { try { win.close(); } catch { /* gone */ } return false; }   // (the call ended while the window was opening)
  adopt(win, documentPip() ? 'pip' : 'desktop');
  return true;
}

/** Desktop app: keep the call's window above other windows, or let it behave like any other window. */
const canPin = () => desktopApp() && typeof window.nullchatDesktop.callWindowOnTop === 'function';
function keepOnTop(on) { try { Promise.resolve(window.nullchatDesktop.callWindowOnTop(!!on)).catch(() => {}); } catch { /* an older app */ } }

/** Start drawing the call into a window that was just opened, and notice when it goes away. */
function adopt(win, kind) {
  const undress = dress(win);
  let done = false;
  const closed = () => { if (done) return; done = true; clearInterval(watch); undress(); if (pipStore.get().win === win) pipStore.set({ win: null, kind: null }); };
  win.addEventListener('pagehide', closed);
  const watch = setInterval(() => { if (win.closed) closed(); }, 1000);   // (a window the desktop app made does not always say goodbye)
  pipStore.set({ win, kind });
  // The call now lives in that window: a call that was filling the screen here gets out of the way.
  if (document.body.classList.contains('call-fullscreen')) {
    document.body.classList.remove('call-fullscreen'); delete document.body.dataset.callFs;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.dispatchEvent(new Event('fullscreenchange'));
  }
}

/**
 * The button in the corner of the pop-out. The small on-top window can not be maximised or made full screen (browsers do not
 * allow it), so from there this moves the call into an ordinary window, which has minimise, maximise and close like any other.
 * In that window (and in the desktop app's) it switches full screen on and off.
 */
function openBig() {
  let big = null;
  const left = Math.max(0, Math.round((window.screen.availWidth - BIG.width) / 2)), top = Math.max(0, Math.round((window.screen.availHeight - BIG.height) / 2));
  try { big = window.open('about:blank', 'nullchat-call', `popup=yes,width=${BIG.width},height=${BIG.height},left=${left},top=${top}`); } catch { big = null; }
  if (!big) return null;
  try { big.document.body.replaceChildren(); big.document.head.replaceChildren(); } catch { /* a fresh window */ }
  return big;
}

export function expandCallPopout() {
  const { win, kind } = pipStore.get();
  if (!win || win.closed) return;
  if (kind === 'pip') {
    const big = openBig();
    if (!big) { toast('Your browser blocked the new window. Allow pop-ups for this site and try again.', 'error'); return; }
    pipStore.set({ win: null, kind: null });
    try { win.close(); } catch { /* already gone */ }
    adopt(big, 'window');
    try { big.focus(); } catch { /* the browser decides */ }
    return;
  }
  const doc = win.document;
  try {
    if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
    else doc.documentElement.requestFullscreen().catch(() => toast('Full screen is not available here. Use the window’s maximise button.', 'error'));
  } catch { /* not supported */ }
}

export function closeCallPopout() {
  const { win, video } = pipStore.get();
  if (video) { video.stop(); return; }
  if (!win) return;
  pipStore.set({ win: null, kind: null });
  try { win.close(); } catch { /* already gone */ }
}

/* ---- the call as a picture, for video picture-in-picture ---- */

const CW = 960, CH = 540;
const pictures = new Map();   // avatar url -> <img> (or false when it would not load)
function picture(url) {
  if (!url) return null;
  if (!pictures.has(url)) {
    const img = new Image();
    img.crossOrigin = 'anonymous';   // (a picture from elsewhere without permission would lock the canvas; it falls back to initials)
    img.onerror = () => pictures.set(url, false);
    img.src = url;
    pictures.set(url, img);
  }
  const img = pictures.get(url);
  return img && img.complete && img.naturalWidth ? img : null;
}

/** What the small window should show right now, worked out from the app's state (the same choices <Popout> makes). */
function callView() {
  const v = voiceStore.get();
  const s = getState();
  const channel = s.channels[v.channelId];
  if (!channel) return null;
  const guildId = channel.guildId || null;
  const myId = s.me.id;
  const states = Object.values(s.voiceStates).filter((x) => x.channelId === v.channelId).sort((a, b) => a.joinedAt - b.joinedAt);
  const streamOf = (st, id) => (id && v.peers[st.userId]?.streams?.[id]) || null;
  const others = states.filter((st) => st.userId !== myId);
  let shown = null;
  for (const st of others) { const x = st.selfStream && streamOf(st, st.screenStreamId); if (x) { shown = { st, stream: x, screen: true }; break; } }
  if (!shown) {
    const cams = others.filter((st) => st.selfVideo && streamOf(st, st.cameraStreamId));
    const st = cams.find((x) => v.speaking[x.userId]) || cams[0];
    if (st) shown = { st, stream: streamOf(st, st.cameraStreamId) };
  }
  const me = states.find((st) => st.userId === myId);
  if (!shown && me?.selfVideo && v.localCamera) shown = { st: me, stream: v.localCamera, self: true };
  const faces = channel.type === ChannelType.STAGE ? states.filter((st) => !st.suppress) : states;
  const order = [...faces].sort((a, b) => (v.speaking[b.userId] ? 1 : 0) - (v.speaking[a.userId] ? 1 : 0));
  let title = channel.name || '';
  if (!channel.guildId) title = channel.type === ChannelType.DM ? displayName(s, channel.recipients[0]) : (channel.name || channel.recipients.map((r) => displayName(s, r)).join(', '));
  const person = (st) => ({
    id: st.userId, name: displayName(s, st.userId, guildId), speaking: !!v.speaking[st.userId], muted: !!(st.selfMute || st.mute || st.suppress),
    color: tintOf(avatarUrlOf(s, st.userId, guildId)) || tileColor(s.users[st.userId], st.userId),
    avatar: (guildId && s.members[guildId]?.[st.userId]?.avatar) || s.users[st.userId]?.avatar || null,
  });
  return {
    title, status: v.status, shown: shown && { ...shown, name: displayName(s, shown.st.userId, guildId) }, people: order.map(person),
    muted: !!(v.selfMute || v.noMic || s.voiceStates[myId]?.mute), deaf: !!v.selfDeaf,
  };
}

function clip(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function paint(ctx, view, feed) {
  const css = getComputedStyle(document.documentElement);
  const font = (css.getPropertyValue('--font') || '').trim() || 'system-ui, sans-serif';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CW, CH);
  ctx.textBaseline = 'middle';
  if (!view) return;
  // which call this is, top left; whether you are muted (or it is reconnecting), top right
  const TOP = 48, PAD = 12, GAP = 12;
  const state = view.status !== 'connected' ? (view.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…') : view.deaf ? 'Deafened' : view.muted ? 'Muted' : '';
  ctx.font = `600 22px ${font}`;
  let right = CW - PAD - 4;
  if (state) {
    ctx.textAlign = 'right'; ctx.fillStyle = view.status !== 'connected' ? '#e0b34a' : '#f23f43';
    ctx.fillText(state, right, TOP / 2 + 2);
    right -= ctx.measureText(state).width + 24;
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#f2f3f5';
  ctx.fillText(clip(ctx, view.title, right - PAD - 4), PAD + 4, TOP / 2 + 2);
  const X = PAD, Y = TOP, W = CW - PAD * 2, H = CH - TOP - PAD;
  const pill = (text, x, y, max) => {   // a name in the bottom-left corner of a tile
    ctx.font = `600 20px ${font}`;
    const t = clip(ctx, text, max - 24);
    const w = ctx.measureText(t).width + 20;
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.beginPath(); ctx.roundRect(x, y - 32, w, 32, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(t, x + 10, y - 15);
  };
  if (view.shown && feed.readyState >= 2 && feed.videoWidth) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(X, Y, W, H, 14); ctx.clip();
    const k = Math.min(W / feed.videoWidth, H / feed.videoHeight), w = feed.videoWidth * k, h = feed.videoHeight * k;
    if (view.shown.self && getLocal().mirrorCamera !== false) { ctx.translate(CW, 0); ctx.scale(-1, 1); }
    ctx.drawImage(feed, X + (W - w) / 2, Y + (H - h) / 2, w, h);
    ctx.restore();
    pill(view.shown.name + (view.shown.screen ? '’s screen' : ''), X + 12, Y + H - 12, W - 24);
    return;
  }
  // everyone as tiles that share the picture
  const list = view.people.slice(0, view.people.length > MAX_FACES ? MAX_FACES - 1 : MAX_FACES);
  const more = view.people.length - list.length;
  const n = list.length + (more ? 1 : 0);
  if (!n) { ctx.fillStyle = '#b5bac1'; ctx.font = `22px ${font}`; ctx.textAlign = 'center'; ctx.fillText('Nobody is here yet.', CW / 2, Y + H / 2); return; }
  const lay = layoutTiles(n, W, H, GAP);
  const cols = lay.cols, rows = Math.ceil(n / cols), tw = lay.w, th = lay.h;
  const top = Y + (H - (rows * th + (rows - 1) * GAP)) / 2;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols), inRow = row === rows - 1 ? n - row * cols : cols;   // (a last row with fewer tiles is centred)
    const tx = X + (W - (inRow * tw + (inRow - 1) * GAP)) / 2 + (tw + GAP) * (i % cols), ty = top + (th + GAP) * row;
    const p = list[i];
    ctx.fillStyle = '#15161a';
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 14); ctx.fill();
    if (p) { ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = p.color; ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 14); ctx.fill(); ctx.restore(); }
    const cx0 = tx + tw / 2, cy0 = ty + th / 2, r = Math.min(84, tw * 0.15, th * 0.22);
    ctx.textAlign = 'center';
    if (!p) { ctx.fillStyle = '#dbdee1'; ctx.font = `700 ${Math.round(r * 0.8)}px ${font}`; ctx.fillText(`+${more}`, cx0, cy0); continue; }
    const img = picture(p.avatar);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx0, cy0, r, 0, Math.PI * 2); ctx.clip();
    if (img) {
      const k = Math.max(2 * r / img.naturalWidth, 2 * r / img.naturalHeight);
      ctx.drawImage(img, cx0 - img.naturalWidth * k / 2, cy0 - img.naturalHeight * k / 2, img.naturalWidth * k, img.naturalHeight * k);
    } else {
      ctx.fillStyle = colorFor(p.id); ctx.fillRect(cx0 - r, cy0 - r, 2 * r, 2 * r);
      ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(r * 0.8)}px ${font}`; ctx.fillText(initials(p.name), cx0, cy0 + 2);
    }
    ctx.restore();
    if (p.speaking) { ctx.strokeStyle = '#23a55a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.roundRect(tx + 2, ty + 2, tw - 4, th - 4, 12); ctx.stroke(); }
    pill(p.name + (p.muted ? ' (muted)' : ''), tx + 12, ty + th - 12, tw - 24);
  }
}

/** A clock that keeps ticking while the page is in the background (page timers slow to one a second there; sound does not). */
function startClock(tick) {
  let ac = null, node = null;
  const timer = setInterval(tick, 1000);   // (the floor, if the sound clock cannot be had)
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    node = ac.createScriptProcessor(4096, 1, 1);   // (about 12 a second)
    const quiet = ac.createGain();
    quiet.gain.value = 0;
    node.onaudioprocess = tick;
    node.connect(quiet); quiet.connect(ac.destination);
    ac.resume?.().catch(() => {});
  } catch { /* the slow timer does */ }
  return () => {
    clearInterval(timer);
    if (node) node.onaudioprocess = null;
    // (taken apart a moment later, never in the middle of a click or of one of its own ticks)
    setTimeout(() => { try { node?.disconnect(); ac?.close().catch(() => {}); } catch { /* gone */ } }, 0);
  };
}

/** Show the call in the browser's video picture-in-picture. Must be called from a click. */
async function openVideoPopout() {
  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream || !ctx.roundRect) return false;
  const feed = document.createElement('video');   // (plays the screen share or camera so it can be painted)
  feed.muted = true; feed.playsInline = true;
  const out = document.createElement('video');
  out.muted = true; out.playsInline = true;
  out.setAttribute('data-call-popout-video', '');
  out.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:0;bottom:0';
  const draw = () => {
    const view = callView();
    const stream = view?.shown?.stream || null;
    if (feed.srcObject !== stream) { feed.srcObject = stream; if (stream) feed.play().catch(() => {}); }
    try { paint(ctx, view, feed); } catch { /* one bad frame */ }
    out.dataset.view = view?.shown ? (view.shown.screen ? 'screen' : 'camera') : 'faces';
    out.dataset.people = String(view?.people.length || 0);
  };
  draw();
  let stopClock = () => {};
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    stopClock();
    unsub();
    out.removeEventListener('leavepictureinpicture', stop);
    try { if (document.pictureInPictureElement === out) document.exitPictureInPicture().catch(() => {}); } catch { /* gone */ }
    try { out.srcObject?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    out.srcObject = null; feed.srcObject = null;
    out.remove();
    mediaButtons(false);
    if (pipStore.get().video?.el === out) pipStore.set({ video: null });
  };
  const unsub = voiceStore.subscribe(() => { if (!done) { draw(); mediaButtons(true); } });
  try {
    out.srcObject = canvas.captureStream(15);
    document.body.appendChild(out);
    await out.play();
    await out.requestPictureInPicture();
  } catch {
    stop();
    return false;
  }
  if (!voiceStore.get().channelId) { stop(); return false; }
  out.addEventListener('leavepictureinpicture', stop);
  stopClock = startClock(draw);
  mediaButtons(true);
  pipStore.set({ video: { el: out, stop } });
  return true;
}

/** Mute and hang up on the browser's own picture-in-picture window, where it offers them. */
function mediaButtons(on) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* this browser has no such button */ } };
  set('togglemicrophone', on ? () => toggleMute() : null);
  set('hangup', on ? () => leaveVoice() : null);
  if (on) { try { const v = voiceStore.get(); ms.setMicrophoneActive?.(!(v.selfMute || v.noMic)); } catch { /* not supported */ } }
}
export const toggleCallPopout = () => (pipStore.get().win || pipStore.get().video ? closeCallPopout() : openCallPopout());

function Video({ stream, mirror, contain }) {
  const [el, setEl] = useState(null);
  useEffect(() => { if (el && el.srcObject !== stream) { el.srcObject = stream || null; el.play?.().catch(() => {}); } }, [el, stream]);
  return <video ref={setEl} autoPlay playsInline muted className={cx('pop-video', mirror && 'mirror', contain && 'contain')} />;
}

/** The colour of a person's default picture, or their own profile colour when they picked one (used until their picture is read). */
const tileColor = (user, id) => (typeof user?.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(user.accentColor) ? user.accentColor : colorFor(id));

/** The overall colour of a picture, so a person's tile can take its colour from their avatar. Null until the picture has loaded. */
/** The colour of a person's tile, for the app's own call view: taken from their picture once it has loaded. */
export function useTileColor(userId, guildId) {
  const fallback = useStore((s) => tileColor(s.users[userId], userId));
  const url = useStore((s) => avatarUrlOf(s, userId, guildId));
  const [tint, setTint] = useState(() => tintOf(url));
  useEffect(() => {
    let live = true;
    const read = () => { if (live) setTint(tintOf(url)); };
    read();
    const timer = url && !tints.has(url) ? setInterval(() => { read(); if (tints.has(url)) clearInterval(timer); }, 250) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [url]);
  return tint || fallback;
}

const tints = new Map();   // avatar url -> 'rgb(r, g, b)' (or false when it can not be read)
function tintOf(url) {
  if (!url) return null;
  if (tints.has(url)) return tints.get(url) || null;
  const img = picture(url);
  if (!img) return null;
  let tint = false;
  try {
    const c = document.createElement('canvas');
    c.width = 12; c.height = 12;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 12, 12);
    const d = g.getImageData(0, 0, 12, 12).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) { if (d[k + 3] < 128) continue; r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; }
    if (n) tint = `rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`;
  } catch { /* a picture from elsewhere: keep the fallback colour */ }
  tints.set(url, tint);
  return tint || null;
}
const avatarUrlOf = (s, userId, guildId) => (guildId && s.members[guildId]?.[userId]?.avatar) || s.users[userId]?.avatar || null;

/**
 * How to lay n tiles out in a space: every tile the same 16:9 shape, as large as fits, in as many columns as makes them largest.
 * Returns { cols, w, h } in pixels.
 */
export function layoutTiles(n, W, H, gap = 8) {
  let best = { cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(Math.max(1, n) / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    if (w > best.w) best = { cols, w, h: w * 9 / 16 };
  }
  return { cols: best.cols, w: Math.max(40, Math.floor(best.w)), h: Math.max(24, Math.floor(best.h)) };
}

/** One tile: a person (their picture, or their camera when it is on) or someone's shared screen. Click it to make it the big one. */
function Tile({ t, guildId, w, h, focused, mini, onPick }) {
  const id = t.st.userId;
  const screen = t.kind === 'screen';
  const name = useStore((s) => displayName(s, id, guildId));
  const fallback = useStore((s) => tileColor(s.users[id], id));
  const url = useStore((s) => avatarUrlOf(s, id, guildId));
  const speaking = useVoice((x) => !!x.speaking[id]) && !screen;
  // the tile takes its colour from the person's picture, once that has loaded
  const [tint, setTint] = useState(() => tintOf(url));
  useEffect(() => {
    let live = true;
    const read = () => { if (live) setTint(tintOf(url)); };
    read();
    const timer = url && !tints.has(url) ? setInterval(() => { read(); if (tints.has(url)) clearInterval(timer); }, 250) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [url]);
  const tiny = mini || (!focused && h < 110);   // (a tile too small for the full-size name)
  const size = Math.round(Math.max(tiny ? 28 : 40, Math.min(120, h * 0.3, w * 0.2)));
  const muted = !screen && (t.st.selfMute || t.st.mute || t.st.suppress);
  const video = !!t.stream;
  const what = screen ? { 'data-pop-shown': 'screen' } : video ? { 'data-pop-shown': 'camera' } : { 'data-pop-face': id };
  const label = focused ? 'Show everyone' : screen ? `Watch ${name}’s screen` : `Focus on ${name}`;
  return (
    <div role="button" tabIndex={0} className={cx('pop-face', video && 'video', screen && 'screen', speaking && 'speaking', focused && 'focused', tiny && 'mini')}
      style={{ '--tile': tint || fallback, ...(focused ? null : { width: w, height: h }) }} title={label} aria-label={label}
      onClick={onPick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
      data-pop-tile={t.key} data-speaking={speaking ? 'yes' : 'no'} data-tinted={tint ? 'yes' : 'no'} {...what}>
      {video
        ? <Video stream={t.stream} mirror={!screen && t.self && getLocal().mirrorCamera !== false} contain={screen || focused} />
        : <span className="pop-face-pic"><Avatar userId={id} guildId={guildId} size={focused ? Math.max(size, 96) : size} /></span>}
      <span className={cx('pop-face-name truncate', video && 'pop-label')}>
        {screen && <span className="live-badge">LIVE</span>}
        {muted && <Icon name="micOff" size={12} />}
        {name}{screen ? '’s screen' : ''}
      </span>
    </div>
  );
}

/** Shown beside you while you are alone in a server's voice channel: one button that makes an invite link and copies it. */
export function InviteTile({ win, channelId, w, h }) {
  const [state, setState] = useState({ step: '', link: '' });
  const invite = async () => {
    if (state.step === 'busy') return;
    setState({ step: 'busy', link: '' });
    try {
      const s = getState();
      const own = s.guilds[s.channels[channelId]?.guildId]?.vanityCode || null;   // (a server with its own link shares that one)
      const code = own || (await api.post(`/channels/${channelId}/invites`, { maxAge: 7 * 86400, maxUses: 0 })).code;
      const link = inviteUrl(code);
      let copied = false;
      try { await win.navigator.clipboard.writeText(link); copied = true; } catch { /* shown instead, to be copied by hand */ }
      setState({ step: copied ? 'copied' : 'shown', link });
    } catch (e) { setState({ step: '', link: '' }); toastError(e); }
  };
  return (
    <div className="pop-face pop-invite" style={{ width: w, height: h }} data-pop-invite>
      <svg className="pop-invite-art" viewBox="0 0 120 72" aria-hidden="true">
        <circle cx="38" cy="40" r="20" fill="currentColor" opacity=".28" />
        <circle cx="82" cy="40" r="20" fill="currentColor" opacity=".28" />
        <circle cx="60" cy="34" r="24" fill="currentColor" opacity=".9" />
        <path d="M60 23v22M49 34h22" stroke="#0b0b0d" strokeWidth="5" strokeLinecap="round" fill="none" />
      </svg>
      <span className="pop-invite-text">It’s quiet in here. Bring someone in.</span>
      <button className="pop-invite-btn" onClick={invite} disabled={state.step === 'busy'} data-pop-invite-btn>
        <Icon name={state.step === 'copied' ? 'check' : 'userPlus'} size={16} /> {state.step === 'copied' ? 'Invite link copied' : state.step === 'busy' ? 'Making a link…' : 'Invite to Voice'}
      </button>
      {state.link && <span className="pop-invite-link" data-pop-invite-link>{state.link}</span>}
    </div>
  );
}

/**
 * Desktop app: choosing what to share, inside the call's window (every screen and window with a preview, the quality, and
 * whether to share the computer's sound). `done(choice | null)` ends it.
 */
function PopSharePicker({ win, done }) {
  const desktop = window.nullchatDesktop;
  const [state, setState] = useState({ loading: true, sources: [], audio: false, error: null });
  const [tab, setTab] = useState('screen');
  const [selected, setSelected] = useState(null);
  const [prefs, setPrefs] = useState(loadSharePrefs);
  const first = useRef(true);
  useEffect(() => {
    let alive = true, timer = 0;
    const tick = async () => {
      try {
        const r = await desktop.screenSources();
        if (!alive) return;
        if (!r?.ok) { setState({ loading: false, sources: [], audio: false, error: r?.error || 'failed' }); return; }
        setState({ loading: false, sources: r.sources, audio: !!r.audio, error: null });
        if (first.current) { first.current = false; if (!r.sources.some((s) => s.type === 'screen') && r.sources.length) setTab('window'); }
        setSelected((cur) => (cur && r.sources.some((s) => s.id === cur) ? cur : null));
      } catch { if (alive) setState({ loading: false, sources: [], audio: false, error: 'failed' }); return; }
      timer = setTimeout(tick, 3000);
    };
    tick();
    const key = (e) => { if (e.key === 'Escape') done(null); };
    win.document.addEventListener('keydown', key);
    return () => { alive = false; clearTimeout(timer); try { win.document.removeEventListener('keydown', key); } catch { /* the window is gone */ } };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const screens = state.sources.filter((s) => s.type === 'screen'), windows = state.sources.filter((s) => s.type === 'window');
  const shown = tab === 'screen' ? screens : windows;
  const chosen = state.sources.find((s) => s.id === selected) || null;
  const setPref = (patch) => setPrefs((p) => { const n = { ...p, ...patch }; saveSharePrefs(n); return n; });
  const go = (src = chosen) => { if (src) done({ id: src.id, name: src.name, type: src.type, audio: state.audio && prefs.audio, quality: prefs.quality }); };
  return (
    <div className="pop-share" data-pop-share onPointerDown={(e) => { if (e.target === e.currentTarget) done(null); }}>
      <div className="pop-share-card" role="dialog" aria-label="Share your screen">
        <div className="pop-share-head">
          <b>Share your screen</b>
          <span className="pop-gap" />
          <button className="pop-btn pop-chat-close" onClick={() => done(null)} aria-label="Cancel" title="Cancel"><Icon name="x" size={16} /></button>
        </div>
        <div className="pop-share-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'screen'} className={cx(tab === 'screen' && 'on')} onClick={() => setTab('screen')} data-pop-share-tab="screen">Screens{state.loading ? '' : ` (${screens.length})`}</button>
          <button role="tab" aria-selected={tab === 'window'} className={cx(tab === 'window' && 'on')} onClick={() => setTab('window')} data-pop-share-tab="window">Windows{state.loading ? '' : ` (${windows.length})`}</button>
        </div>
        <div className="pop-share-body">
          {state.loading ? <div className="pop-chat-note">Looking for screens and windows…</div>
            : state.error === 'permission' ? <div className="pop-chat-note">NullChat needs permission to record your screen. Open System Settings → Privacy &amp; Security → Screen Recording, turn on NullChat, then restart the app.</div>
            : state.error ? <div className="pop-chat-note">Couldn’t list your screens. Close this and try again.</div>
            : !shown.length ? <div className="pop-chat-note">{tab === 'screen' ? 'No screens found.' : 'No other windows are open. Open the app you want to share and it will show up here.'}</div>
            : (
              <div className="pop-share-grid" role="listbox">
                {shown.map((s) => (
                  <button key={s.id} role="option" aria-selected={selected === s.id} className={cx('pop-share-tile', selected === s.id && 'on')} onClick={() => setSelected(s.id)} onDoubleClick={() => go(s)} title={s.name} data-pop-share-source={s.id}>
                    <span className="pop-share-thumb">{s.thumb ? <img src={s.thumb} alt="" draggable={false} /> : <Icon name="screen" size={26} />}</span>
                    <span className="pop-share-name">{s.icon && <img src={s.icon} alt="" draggable={false} />}<span className="truncate">{s.name}</span></span>
                  </button>
                ))}
              </div>
            )}
        </div>
        <div className="pop-share-foot">
          <label className="pop-share-opt">Quality
            <select value={prefs.quality} onChange={(e) => setPref({ quality: e.target.value })} data-pop-share-quality>
              {SHARE_QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </label>
          {state.audio && <label className="pop-share-opt check"><input type="checkbox" checked={!!prefs.audio} onChange={(e) => setPref({ audio: e.target.checked })} data-pop-share-sound /> Share computer sound</label>}
          <span className="pop-gap" />
          <button className="pop-share-btn" onClick={() => done(null)}>Cancel</button>
          <button className="pop-share-btn go" disabled={!chosen} onClick={() => go()} data-pop-share-go>Share{chosen ? (chosen.type === 'screen' ? ' screen' : ' window') : ''}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The call's text chat, inside the call's window: the latest messages (text, links, pictures and files) and a box to write in.
 * It is the same chat as in the app (the voice channel's own chat, or the conversation the call is in), kept simple: the app's
 * menus, emoji picker and pop-ups all open in the main window, so they are not offered here.
 */
function PopChat({ win, channelId, guildId, onClose }) {
  const name = useStore((s) => { const c = s.channels[channelId]; return !c ? '' : c.guildId ? c.name : c.type === ChannelType.DM ? displayName(s, c.recipients[0]) : (c.name || 'Group'); });
  const entry = useStore((s) => s.messages[channelId]);
  const canSend = useStore((s) => !s.channels[channelId]?.guildId || has(channelPermissions(s, channelId), P.SEND_MESSAGES));
  const canAttach = useStore((s) => !s.channels[channelId]?.guildId || has(channelPermissions(s, channelId), P.ATTACH_FILES));
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  const input = useRef(null);
  const picker = useRef(null);
  const stick = useRef(true);   // (whether the list is at the bottom, and so should follow new messages)
  useEffect(() => { loadMessages(channelId).catch(() => {}); }, [channelId]);
  const list = (entry?.list || []).filter((m) => !m.type || m.content || m.attachments?.length).slice(-100);
  const lastId = list.length ? list[list.length - 1].id : '';
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    if (lastId) ackChannel(channelId);
  }, [lastId, channelId, entry?.loaded]);
  useEffect(() => { try { input.current?.focus(); } catch { /* not focusable yet */ } }, []);
  const onScroll = () => { const el = scroller.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  const submit = async () => {
    const body = text.trim();
    if ((!body && !files.length) || busy) return;
    setBusy(true);
    stick.current = true;
    try { await sendMessage(channelId, body, { files }); setText(''); setFiles([]); if (input.current) input.current.style.height = ''; }
    catch (e) { toastError(e); }
    setBusy(false);
    try { input.current?.focus(); } catch { /* gone */ }
  };
  const grow = (el) => { el.style.height = ''; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; };
  const addFiles = (fl) => setFiles((cur) => [...cur, ...[...fl]].slice(0, 10));
  let prev = null;
  return (
    <aside className="pop-chat-panel" data-pop-chat-panel>
      <header className="pop-chat-head">
        <Icon name="chat" size={16} /><b className="truncate">{name ? `${name} chat` : 'Chat'}</b><span className="pop-gap" />
        <button className="pop-btn pop-chat-close" onClick={onClose} aria-label="Hide the chat" title="Hide the chat"><Icon name="x" size={16} /></button>
      </header>
      <div className="pop-chat-list" ref={scroller} onScroll={onScroll} data-pop-chat-list>
        {!entry?.loaded && <div className="pop-chat-note">Loading…</div>}
        {entry?.loaded && list.length === 0 && <div className="pop-chat-note">No messages yet. Say something.</div>}
        {list.map((m) => {
          const a = m.author || {};
          const joined = prev && prev.author?.id === a.id && m.createdAt - prev.createdAt < 5 * 60 * 1000 && !prev.type && !m.type;
          prev = m;
          return (
            <div key={m.id} className={cx('pop-msg', joined && 'joined', m.pending && 'pending')} data-pop-msg={m.id}>
              {!joined && <span className="pop-msg-pic"><Avatar userId={a.id} guildId={guildId} size={28} /></span>}
              <div className="pop-msg-body">
                {!joined && <div className="pop-msg-head"><b className="truncate">{a.id ? <PopName id={a.id} guildId={guildId} fallback={a.displayName || a.username} /> : (a.displayName || a.username || 'Unknown')}</b><span className="pop-msg-time">{formatMessageTime(m.createdAt)}</span></div>}
                {m.content && <div className="pop-msg-text"><Markdown text={m.content} /></div>}
                {(m.attachments || []).map((f) => (/^image\//.test(f.contentType || '') && !f.spoiler
                  ? <a key={f.id} className="pop-msg-img" href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={f.description || f.filename} loading="lazy" /></a>
                  : <a key={f.id} className="pop-msg-file" href={f.url} target="_blank" rel="noreferrer"><Icon name="link" size={13} /> <span className="truncate">{f.filename}</span></a>))}
                {!m.content && !(m.attachments || []).length && <div className="pop-msg-text muted">(open the app to see this message)</div>}
              </div>
            </div>
          );
        })}
      </div>
      {canSend ? (
        <div className="pop-chat-write">
          {files.length > 0 && (
            <div className="pop-chat-files">
              {files.map((f, i) => <span key={i} className="pop-chat-file"><span className="truncate">{f.name}</span><button onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}><Icon name="x" size={12} /></button></span>)}
            </div>
          )}
          <div className="pop-chat-row">
            {canAttach && <button className="pop-btn pop-chat-attach" onClick={() => picker.current?.click()} aria-label="Attach a file" title="Attach a file"><Icon name="plus" size={18} /></button>}
            <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} data-pop-chat-file />
            <textarea ref={input} className="pop-chat-input" rows={1} maxLength={4000} placeholder={`Message ${name || 'the call'}`} value={text}
              onChange={(e) => { setText(e.target.value); grow(e.target); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
              onPaste={(e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.length && canAttach) { e.preventDefault(); addFiles(fl); } }}
              data-pop-chat-input />
            <button className="pop-btn pop-chat-send" onClick={submit} disabled={busy || (!text.trim() && !files.length)} aria-label="Send" title="Send"><Icon name="send" size={17} /></button>
          </div>
        </div>
      ) : <div className="pop-chat-note">You can’t send messages here.</div>}
    </aside>
  );
}
function PopName({ id, guildId, fallback }) {
  const name = useStore((s) => (s.users[id] ? displayName(s, id, guildId) : fallback));
  return name || 'Unknown';
}

/** The little menu behind the arrow next to the microphone or camera button: which device to use. */
function DeviceMenu({ win, what, close }) {
  const [list, setList] = useState(null);
  const [l, setL] = useState(getLocal());
  useEffect(() => onLocalChange(() => setL(getLocal())), []);
  useEffect(() => {
    let live = true;
    navigator.mediaDevices?.enumerateDevices?.().then((d) => { if (live) setList(d); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const d = win.document;
    const down = (e) => { if (!e.target?.closest?.('[data-pop-menu], [data-pop-caret]')) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    d.addEventListener('pointerdown', down); d.addEventListener('keydown', key);
    return () => { try { d.removeEventListener('pointerdown', down); d.removeEventListener('keydown', key); } catch { /* the window is gone */ } };
  }, [win]);   // eslint-disable-line react-hooks/exhaustive-deps
  const sections = what === 'mic'
    ? [['Microphone', 'audioinput', 'inputDeviceId', (v) => { chooseDevice('audioinput', v, list || []); setTimeout(reacquireMic, 50); }],
      ...(canChooseOutput() ? [['Speakers', 'audiooutput', 'outputDeviceId', (v) => { chooseDevice('audiooutput', v, list || []); configureSounds({ deviceId: outputSink() || 'default' }); setTimeout(refreshOutputs, 50); }]] : [])]
    : [['Camera', 'videoinput', 'videoDeviceId', (v) => { chooseDevice('videoinput', v, list || []); switchCamera(v); }]];
  return (
    <div className="pop-menu" role="menu" data-pop-menu={what}>
      {sections.map(([title, kind, key, choose]) => {
        const devices = (list || []).filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        const cur = l[key] || 'default';
        const item = (id, label) => (
          <button key={id} className={cx('pop-menu-item', cur === id && 'on')} role="menuitemradio" aria-checked={cur === id} onClick={() => { choose(id); close(); }} data-pop-device={id}>
            <span className="truncate">{label}</span>{cur === id && <Icon name="check" size={14} />}
          </button>
        );
        return (
          <div key={kind} className="pop-menu-part">
            <div className="pop-menu-head">{title}</div>
            {item('default', 'Default')}
            {devices.map((d, i) => item(d.deviceId, deviceName(d.label) || `${title} ${i + 1}`))}
            {list === null && <div className="pop-menu-note">Looking…</div>}
          </div>
        );
      })}
    </div>
  );
}

/** What the call's window shows. */
function Popout({ win, kind }) {
  const channelId = useVoice((v) => v.channelId);
  const v = useVoice((x) => ({ selfMute: x.selfMute, selfDeaf: x.selfDeaf, noMic: x.noMic, peers: x.peers, localCamera: x.localCamera, localScreen: x.localScreen, screen: x.screen, speaking: x.speaking, status: x.status }));
  const myId = useStore((s) => s.me.id);
  const channel = useStore((s) => s.channels[channelId]);
  const guildId = channel?.guildId || null;
  const stage = channel?.type === ChannelType.STAGE;
  const states = useStore((s) => Object.values(s.voiceStates).filter((x) => x.channelId === channelId).sort((a, b) => a.joinedAt - b.joinedAt));
  const serverMute = useStore((s) => !!s.voiceStates[s.me.id]?.mute);
  const canStream = useStore((s) => has(channelPermissions(s, channelId), P.STREAM));
  const canInvite = useStore((s) => !!s.channels[channelId]?.guildId && has(channelPermissions(s, channelId), P.CREATE_INVITE));
  const title = useStore((s) => {
    if (!channel) return '';
    if (channel.guildId) return channel.name;
    if (channel.type === ChannelType.DM) return displayName(s, channel.recipients[0]);
    return channel.name || channel.recipients.map((r) => displayName(s, r)).join(', ');
  });
  // the size of the window, so the tiles can grow with it; and whether it is full screen
  const [box, setBox] = useState({ w: win.innerWidth || SIZE.width, h: win.innerHeight || SIZE.height, full: false });
  useEffect(() => {
    const read = () => setBox({ w: win.innerWidth, h: win.innerHeight, full: !!win.document.fullscreenElement });
    read();
    win.addEventListener('resize', read);
    win.document.addEventListener('fullscreenchange', read);
    return () => { try { win.removeEventListener('resize', read); win.document.removeEventListener('fullscreenchange', read); } catch { /* the window is gone */ } };
  }, [win]);
  const small = kind === 'pip';
  // The text chat, beside the tiles (when the window is wide enough for both). It stays the way you last left it.
  const canRead = useStore((s) => !s.channels[channelId]?.guildId || has(channelPermissions(s, channelId), P.READ_MESSAGE_HISTORY));
  const [chatWanted, setChatWanted] = useState(() => !!getLocal().popChatOpen);
  const chatFits = canRead && !small && box.w >= 720;
  const chat = chatFits && chatWanted;
  const CHAT_W = Math.min(360, Math.round(box.w * 0.34));
  const toggleChat = () => { const next = !chatWanted; setChatWanted(next); setLocal({ popChatOpen: next }); };
  const lastMsg = useStore((s) => { const l = s.messages[channelId]?.list; return l?.length ? l[l.length - 1].id : ''; });
  const [seenMsg, setSeenMsg] = useState(lastMsg);
  useEffect(() => { if (chat || !seenMsg) setSeenMsg(lastMsg); }, [chat, lastMsg]);   // eslint-disable-line react-hooks/exhaustive-deps
  const unread = !chat && !!lastMsg && lastMsg !== seenMsg;
  const tight = box.h < 380 || box.w - (chat ? CHAT_W : 0) < 520;   // (a window too small for more than the tiles and the buttons)

  // Every tile: one per person (their camera in it when it is on), and one per shared screen.
  const streamOf = (st, id) => (id && v.peers[st.userId]?.streams?.[id]) || null;
  const me = states.find((st) => st.userId === myId);
  const faces = stage ? states.filter((st) => !st.suppress) : states;
  const people = faces.map((st) => {
    const self = st.userId === myId;
    return { key: `u:${st.userId}`, kind: 'person', st, self, stream: (self ? (me?.selfVideo && v.localCamera) : (st.selfVideo && streamOf(st, st.cameraStreamId))) || null };
  });
  const screens = states.map((st) => {
    const self = st.userId === myId;
    const stream = self ? (v.screen && v.localScreen) || null : (st.selfStream && streamOf(st, st.screenStreamId)) || null;
    return stream ? { key: `s:${st.userId}`, kind: 'screen', st, self, stream } : null;
  }).filter(Boolean);
  const all = [...people, ...screens];
  // The big one: the tile you clicked; until you choose, somebody else's shared screen. Clicking the big one shows everyone again.
  const [pick, setPick] = useState(undefined);   // undefined: not chosen · null: everyone · a tile's key
  const auto = (screens.find((t) => !t.self) || {}).key || null;
  const picked = pick && all.some((t) => t.key === pick);
  useEffect(() => { if (pick && !picked) setPick(undefined); }, [pick, picked]);
  useEffect(() => { if (auto) setPick(undefined); }, [auto]);   // (a screen share that has just started is shown, whatever you were looking at)
  const focusKey = pick === null ? null : picked ? pick : auto;
  const focus = focusKey ? all.find((t) => t.key === focusKey) : null;
  const choose = (key) => setPick(focusKey === key ? null : key);

  // the top line and the buttons fade away while the mouse is still (they come back the moment it moves)
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState(null);   // 'mic' | 'camera': the device menu that is open
  useEffect(() => {
    let timer = 0;
    const wake = () => { setIdle(false); clearTimeout(timer); timer = setTimeout(() => setIdle(true), 3500); };
    wake();
    const d = win.document;
    const names = ['mousemove', 'pointerdown', 'keydown', 'focusin'];
    names.forEach((n) => d.addEventListener(n, wake));
    return () => { clearTimeout(timer); try { names.forEach((n) => d.removeEventListener(n, wake)); } catch { /* the window is gone */ } };
  }, [win]);

  const back = () => {
    if (channel) navigate(channel.guildId ? `/channels/${channel.guildId}/${channel.id}` : `/channels/@me/${channel.id}`);
    try { window.focus(); } catch { /* the browser decides */ }
    closeCallPopout();
  };
  const muted = v.selfMute || v.noMic || serverMute;
  const camOn = !!v.localCamera;
  const sharing = !!v.screen;
  // Asked from this window: a browser only lets the window that was clicked open its screen picker, and the desktop app's own
  // picker (screens and windows with previews) is shown right here instead of in the main window.
  const [picking, setPicking] = useState(null);   // { done } while the desktop app's picker is open in this window
  useEffect(() => {
    if (typeof window.nullchatDesktop?.screenSources !== 'function' || !window.nullchatDesktop.callWindowShare) return undefined;
    setPickerHost((from) => (from === win ? new Promise((resolve) => setPicking({ done: (v) => { setPicking(null); resolve(v); } })) : null));
    return () => { setPickerHost(null); setPicking((cur) => { cur?.done(null); return null; }); };
  }, [win]);
  const share = () => {
    // (a desktop app from before this shows its picker in the main window, so that one is brought forward)
    if (!sharing && kind === 'desktop' && !window.nullchatDesktop?.callWindowShare) { try { window.focus(); } catch { /* the system decides */ } }
    Promise.resolve(toggleScreen(win)).catch(toastError);
  };

  // How the tiles are laid out in the space between the top line and the buttons.
  const stageW = box.w - 24 - (chat ? CHAT_W : 0), stageH = box.h - (box.h < 260 ? 104 : 124);
  const cap = small || tight ? MAX_FACES : 12;
  const over = all.length > cap;
  // (when there are too many to show, the ones speaking are never the ones left out)
  const ordered = over ? [...all].sort((a, b) => (v.speaking[b.st.userId] ? 1 : 0) - (v.speaking[a.st.userId] ? 1 : 0)) : all;
  const gridTiles = ordered.slice(0, over ? cap - 1 : cap);
  const invite = canInvite && !tight && states.length === 1 && !focus;
  const count = gridTiles.length + (over ? 1 : 0) + (invite ? 1 : 0);
  const grid = layoutTiles(count, stageW, stageH);
  const others = focus ? all.filter((t) => t.key !== focus.key) : [];
  const strip = focus && !tight && others.length > 0;

  const [onTop, setOnTop] = useState(() => !!getLocal().popoutOnTop);
  const pin = () => { const next = !onTop; setOnTop(next); setLocal({ popoutOnTop: next }); keepOnTop(next); };
  const expandLabel = small ? 'Open in a full window' : box.full ? 'Leave full screen' : 'Full screen';
  const caret = (what, label) => (
    <button className={cx('pop-caret', menu === what && 'open')} onClick={() => setMenu(menu === what ? null : what)} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={menu === what} data-pop-caret={what}>
      <Icon name="chevronDown" size={13} />
    </button>
  );
  return (
    <div className={cx('call-popout', chat && 'with-chat', idle && !menu && !small && 'idle')} data-call-popout data-pop-idle={idle && !menu && !small ? 'yes' : 'no'}>
     <div className="pop-main">
      <div className="pop-top">
        <button className="pop-title" onClick={back} title="Back to the call" data-pop-back><Icon name={channel?.guildId ? 'volume' : 'phone'} size={15} /><span className="truncate">{title}</span></button>
        {states.length > 0 && <span className="pop-count" data-pop-count>{states.length} in call</span>}
        <span className="pop-gap" />
        {chatFits && <button className={cx('pop-btn pop-chat', chat && 'on')} onClick={toggleChat} aria-label={chat ? 'Hide the chat' : 'Show the chat'} title={chat ? 'Hide the chat' : 'Show the chat'} aria-pressed={chat} data-pop-chat data-unread={unread ? 'yes' : 'no'}><Icon name="chat" size={18} />{unread && <span className="pop-dot" />}</button>}
      </div>
      <div className={cx('pop-stage', focus && 'has-focus')}>
        {focus ? (
          <>
            <Tile key={focus.key} t={focus} guildId={guildId} focused onPick={() => choose(focus.key)} />
            {strip && (
              <div className="pop-strip" data-pop-strip>
                {others.map((t) => <Tile key={t.key} t={t} guildId={guildId} mini w={144} h={81} onPick={() => choose(t.key)} />)}
              </div>
            )}
          </>
        ) : (
          <div className={cx('pop-faces', count <= 1 && 'one')} data-pop-cols={grid.cols}>
            {gridTiles.map((t) => <Tile key={t.key} t={t} guildId={guildId} w={grid.w} h={grid.h} onPick={() => choose(t.key)} />)}
            {over && <div className="pop-face more" style={{ width: grid.w, height: grid.h }} data-pop-more>+{all.length - (cap - 1)}</div>}
            {invite && <InviteTile win={win} channelId={channelId} w={grid.w} h={grid.h} />}
            {all.length === 0 && <span className="muted small">Nobody is speaking yet.</span>}
          </div>
        )}
        {v.status !== 'connected' && <div className="pop-status"><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> {v.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</div>}
      </div>
      <div className="pop-bar">
        <div className="pop-group">
          <span className="pop-split">
            <button className={cx('pop-btn', muted && 'off')} onClick={toggleMute} aria-label={v.selfMute ? 'Unmute' : 'Mute'} title={v.selfMute ? 'Unmute' : 'Mute'} aria-pressed={!!v.selfMute} data-pop-mute><Icon name={muted ? 'micOff' : 'mic'} size={18} /></button>
            {caret('mic', 'Microphone and speakers')}
            {menu === 'mic' && <DeviceMenu win={win} what="mic" close={() => setMenu(null)} />}
          </span>
          <span className="pop-split">
            <button className={cx('pop-btn', camOn && 'on')} disabled={!canStream} onClick={() => { Promise.resolve(toggleCamera()).catch(toastError); }} aria-label={camOn ? 'Turn off camera' : 'Turn on camera'} title={camOn ? 'Turn off camera' : 'Turn on camera'} aria-pressed={camOn} data-pop-camera><Icon name={camOn ? 'video' : 'videoOff'} size={18} /></button>
            {caret('camera', 'Choose a camera')}
            {menu === 'camera' && <DeviceMenu win={win} what="camera" close={() => setMenu(null)} />}
          </span>
        </div>
        <div className="pop-group">
          <button className={cx('pop-btn', sharing && 'on')} disabled={!canStream} onClick={share} aria-label={sharing ? 'Stop sharing your screen' : 'Share your screen'} title={sharing ? 'Stop sharing your screen' : 'Share your screen'} aria-pressed={sharing} data-pop-screen><Icon name={sharing ? 'screenOff' : 'screen'} size={18} /></button>
          <button className={cx('pop-btn', v.selfDeaf && 'off')} onClick={toggleDeafen} aria-label={v.selfDeaf ? 'Undeafen' : 'Deafen'} title={v.selfDeaf ? 'Undeafen' : 'Deafen'} aria-pressed={!!v.selfDeaf} data-pop-deafen><Icon name={v.selfDeaf ? 'headphonesOff' : 'headphones'} size={18} /></button>
        </div>
        <button className="pop-btn hangup" onClick={() => leaveVoice()} aria-label="Disconnect" title="Disconnect" data-pop-hangup><Icon name="phoneOff" size={20} /></button>
        <div className="pop-corner">
          {kind === 'desktop' && canPin() && <button className={cx('pop-btn pop-pin', onTop && 'on')} onClick={pin} aria-label={onTop ? 'Stop keeping this window on top' : 'Keep this window on top'} title={onTop ? 'Stop keeping this window on top' : 'Keep this window on top'} aria-pressed={onTop} data-pop-pin><Icon name="pin" size={18} /></button>}
          <button className="pop-btn pop-in" onClick={back} aria-label="Put the call back in NullChat" title="Put the call back in NullChat" data-pop-in><Icon name="popin" size={18} /></button>
          <button className="pop-btn pop-expand" onClick={expandCallPopout} aria-label={expandLabel} title={expandLabel} data-pop-expand data-pop-kind={kind}><Icon name={small ? 'popout' : 'fullscreen'} size={18} /></button>
        </div>
      </div>
     </div>
     {picking && <PopSharePicker win={win} done={picking.done} />}
     {chat && <div className="pop-chat-wrap" style={{ width: CHAT_W }}><PopChat win={win} channelId={channelId} guildId={guildId} onClose={toggleChat} /></div>}
    </div>
  );
}

/** Mounted once by the app: draws into the small window while it is open, and closes it when the call ends. */
export function CallPopoutHost() {
  const win = useStoreOf(pipStore, (s) => s.win);
  const kind = useStoreOf(pipStore, (s) => s.kind);
  const inCall = useVoice((v) => !!v.channelId);
  const [auto, setAuto] = useState(() => getLocal().autoPopout !== false);
  useEffect(() => onLocalChange((l) => setAuto(l.autoPopout !== false)), []);
  useEffect(() => { if (!inCall) closeCallPopout(); }, [inCall]);
  useEffect(() => () => closeCallPopout(), []);
  // an ordinary window does not close by itself when this page is closed or reloaded
  useEffect(() => { const bye = () => closeCallPopout(); window.addEventListener('pagehide', bye); return () => window.removeEventListener('pagehide', bye); }, []);
  // Chrome and Edge can pop the call out by themselves when you switch to another tab during a call (and put it away when you
  // come back). They only do it for a page that is using the microphone and that asked for it like this.
  useEffect(() => {
    if (!inCall || !auto || !documentPip() || !navigator.mediaSession) return undefined;
    try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => { openCallPopout({ auto: true }); }); } catch { return undefined; }
    return () => { try { navigator.mediaSession.setActionHandler('enterpictureinpicture', null); } catch { /* not supported */ } };
  }, [inCall, auto]);
  if (!win || win.closed) return null;
  return createPortal(<Popout key={kind} win={win} kind={kind} />, win.document.body);
}

/** The button in a call's controls (`className` lets the sidebar's smaller buttons use it too). */
export function PopoutButton({ className = 'cc-btn', size = 22 }) {
  const open = usePopoutOpen();
  if (!popoutSupported()) return null;
  const label = open ? 'Put the call back' : 'Pop out the call';
  return (
    <button className={cx(className, open && (className === 'cc-btn' ? 'on' : 'active'))} onClick={toggleCallPopout} aria-label={label} aria-pressed={open} data-tooltip={label} data-tooltip-side="top" data-popout-button>
      <Icon name="pip" size={size} />
    </button>
  );
}

/** In Settings → Voice & Video. */
export function PopoutSettings() {
  const [auto, setAuto] = useState(() => getLocal().autoPopout !== false);
  useEffect(() => onLocalChange((l) => setAuto(l.autoPopout !== false)), []);
  if (!popoutSupported()) return null;
  const canAuto = documentPip();
  return (
    <div className="settings-section" data-popout-settings>
      <h3>Picture-in-Picture</h3>
      <p className="muted small">{canAuto || desktopWindow()
        ? <>During a call, <b>Pop out the call</b> (next to the mute button) puts it in a small window that stays on top while you use other tabs and apps. The button in that window’s corner opens it as a full window you can maximise or make full screen.</>
        : <>During a call, <b>Pop out the call</b> (next to the mute button) opens it in its own window, which you can move to another screen, maximise or make full screen.</>}</p>
      {canAuto && <ToggleSetting title="Pop out by itself when I switch tabs" description="While you are in a call. It goes away again when you come back. Your browser may ask you to allow it the first time." checked={auto} onChange={(x) => setLocal({ autoPopout: x })} />}
    </div>
  );
}
