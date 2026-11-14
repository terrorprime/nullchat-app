// Your own join and leave sounds: which sound a person entering or leaving a voice channel makes on this device, and turning a
// picked audio file into the small WAV the server accepts.
import { store } from './state.js';
import { api } from './api.js';
import { getLocal } from './settings.js';
import { play, playClip } from './sounds.js';

export const MAX_SECONDS = 5;
const RATE = 24000;          // plenty for a short sound, and five seconds of it is 240 KB
const REPEAT_MS = 20000;     // somebody hopping in and out gets the standard sound after the first time

const heard = new Map();     // `${userId}:${kind}` -> when their own sound last played here

/** The address of the sound to play for this person, or null for the standard one. */
export function personSound(userId, kind, guildId) {
  const s = store.get();
  const l = getLocal();
  if (l.voiceSounds === false || l.plainSoundFor?.[userId]) return null;
  if (guildId && s.guilds[guildId]?.voiceSoundsOff) return null;
  if (s.relationships?.[userId]?.type === 2) return null;   // (someone you blocked)
  const u = userId === s.me?.id ? s.me : s.users[userId];
  return u?.voiceSounds?.[kind] || null;
}

/** Somebody (or you) came into, or left, the voice channel you are in. */
export function playVoiceSound(userId, kind, guildId) {
  const url = personSound(userId, kind, guildId);
  const key = `${userId}:${kind}`;
  const now = Date.now();
  if (!url || now - (heard.get(key) || 0) < REPEAT_MS) { play(kind); return; }
  heard.set(key, now);
  playClip(url, kind, { maxSeconds: MAX_SECONDS });
}
export const forgetHeardVoiceSounds = () => heard.clear();

/**
 * Turn any audio file the browser can read into a WAV for the server: one channel, the first five seconds, evened out in
 * loudness (quiet recordings are brought up, loud ones down), with a short fade at the end. Returns { blob, seconds, trimmed }.
 */
export async function prepareVoiceSound(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is too large. Pick a short sound, up to 20 MB.');
  const AC = window.AudioContext || window.webkitAudioContext;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !Offline) throw new Error('This browser can not prepare sounds.');
  let decoded;
  const ctx = new AC();
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('NullChat could not read that file as a sound. Try an MP3, WAV or OGG file.'); }
  finally { ctx.close().catch(() => {}); }
  const seconds = Math.min(decoded.duration, MAX_SECONDS);
  if (seconds < 0.1) throw new Error('That sound is too short to hear.');
  const off = new Offline(1, Math.ceil(seconds * RATE), RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const data = (await off.startRendering()).getChannelData(0);
  // loudness: aim for the same average level for everybody, without ever clipping
  let peak = 0; let sum = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; sum += data[i] * data[i]; }
  const rms = Math.sqrt(sum / data.length);
  if (peak < 0.0005) throw new Error('That file is silent.');
  const gain = Math.min(0.14 / Math.max(rms, 1e-6), 0.9 / peak, 20);
  const fade = Math.min(Math.floor(RATE * 0.05), data.length);
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const tail = data.length - i;
    const v = data[i] * gain * (tail < fade ? tail / fade : 1);
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return { blob: wavBlob(pcm, RATE), seconds, trimmed: decoded.duration > MAX_SECONDS + 0.05 };
}

function wavBlob(pcm, rate) {
  const head = new DataView(new ArrayBuffer(44));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) head.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); head.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  text(36, 'data'); head.setUint32(40, pcm.length * 2, true);
  return new Blob([head, pcm], { type: 'audio/wav' });
}

const setMe = (me) => {
  const s = store.get();
  if (s.me?.id === me.id) store.set({ me: { ...s.me, ...me }, users: { ...s.users, [me.id]: { ...(s.users[me.id] || {}), ...me } } });
  return me;
};
export const saveVoiceSound = (kind, blob) => api('PUT', `/users/@me/voice-sounds/${kind}`, blob).then(setMe);
export const removeVoiceSound = (kind) => api.del(`/users/@me/voice-sounds/${kind}`).then(setMe);
export const setGuildVoiceSounds = (guildId, enabled) => api.put(`/guilds/${guildId}/voice-sounds`, { enabled });
