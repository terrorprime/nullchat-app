// Profile song: a short clip of music on a person's profile. This file turns a picked audio file into the small WAV the server
// accepts, and plays a profile's clip (one at a time, quietly) when the profile is opened.
import { store } from './state.js';
import { api } from './api.js';
import { getLocal } from './settings.js';
import { createStore } from './store.js';
import { voiceStore } from './voice.js';

export const MAX_SECONDS = 15;
const RATE = 32000;      // fine for music at this size: fifteen seconds in stereo is 1.9 MB
const VOLUME = 0.3;      // a profile song sits in the background; it never competes with a call or a video

/** Read an audio file the browser understands. Returns the decoded sound (an AudioBuffer). */
export async function readSong(file) {
  if (file.size > 60 * 1024 * 1024) throw new Error('That file is too large. Pick an audio file up to 60 MB.');
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !(window.OfflineAudioContext || window.webkitOfflineAudioContext)) throw new Error('This browser can not prepare sounds.');
  const ctx = new AC();
  try { return await ctx.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('NullChat could not read that file as a sound. Try an MP3, WAV or OGG file.'); }
  finally { ctx.close().catch(() => {}); }
}

/**
 * Cut the clip out of a decoded song: up to fifteen seconds from `start`, in stereo, evened out in loudness, with a short fade
 * in and a longer fade out so it never starts or stops with a click. Returns { blob, seconds }.
 */
export async function prepareProfileSong(decoded, start = 0) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const from = Math.max(0, Math.min(start, Math.max(0, decoded.duration - 1)));
  const seconds = Math.min(decoded.duration - from, MAX_SECONDS);
  if (seconds < 1) throw new Error('A profile song has to be at least a second long.');
  const frames = Math.ceil(seconds * RATE);
  const off = new Offline(2, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0, from, seconds);
  const out = await off.startRendering();
  const L = out.getChannelData(0), R = out.getChannelData(1);
  let peak = 0; let sum = 0;
  for (let i = 0; i < frames; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; sum += (L[i] * L[i] + R[i] * R[i]) / 2; }
  if (peak < 0.0005) throw new Error('That part of the file is silent.');
  const gain = Math.min(0.12 / Math.max(Math.sqrt(sum / frames), 1e-6), 0.9 / peak, 20);
  const fadeIn = Math.floor(RATE * 0.15), fadeOut = Math.min(Math.floor(RATE * 1.2), Math.floor(frames / 3));
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const tail = frames - i;
    const k = gain * (i < fadeIn ? i / fadeIn : 1) * (tail < fadeOut ? tail / fadeOut : 1);
    pcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(L[i] * k * 32767)));
    pcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(R[i] * k * 32767)));
  }
  const head = new DataView(new ArrayBuffer(44));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) head.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); head.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 2, true);
  head.setUint32(24, RATE, true); head.setUint32(28, RATE * 4, true); head.setUint16(32, 4, true); head.setUint16(34, 16, true);
  text(36, 'data'); head.setUint32(40, pcm.length * 2, true);
  return { blob: new Blob([head, pcm], { type: 'audio/wav' }), seconds };
}

const setMe = (me) => {
  const s = store.get();
  if (s.me?.id === me.id) store.set({ me: { ...s.me, ...me }, users: { ...s.users, [me.id]: { ...(s.users[me.id] || {}), ...me } } });
  return me;
};
export const saveProfileSong = (blob, title) => api('PUT', `/users/@me/profile-song?title=${encodeURIComponent(title || '')}`, blob).then(setMe);
export const renameProfileSong = (title) => api.patch('/users/@me/profile-song', { title }).then(setMe);
export const removeProfileSong = () => api.del('/users/@me/profile-song').then(setMe);

/* ---- playing ---- */

export const songStore = createStore({ url: null });   // the clip that is playing now, if any
let audio = null;

export function stopProfileSong(url) {
  if (url && songStore.get().url !== url) return;
  if (audio) { try { audio.pause(); } catch { /* gone */ } audio.src = ''; audio = null; }
  if (songStore.get().url) songStore.set({ url: null });
}

/** Play a clip (stopping any other). Resolves to whether it started: a browser may refuse sound it was not clicked for. */
export async function playProfileSong(url) {
  stopProfileSong();
  if (!url) return false;
  const el = new Audio(url);
  el.volume = VOLUME;
  audio = el;
  el.addEventListener('ended', () => { if (audio === el) stopProfileSong(); });
  el.addEventListener('error', () => { if (audio === el) stopProfileSong(); });
  try { await el.play(); } catch { if (audio === el) stopProfileSong(); return false; }
  if (audio !== el) return false;
  songStore.set({ url });
  return true;
}

/** Whether opening this person's profile should start their song by itself. */
export function shouldAutoplay(userId) {
  if (getLocal().profileSongs === false) return false;
  if (voiceStore.get().channelId) return false;                      // (never over a call)
  if (store.get().relationships?.[userId]?.type === 2) return false;   // (someone you blocked)
  return true;
}
