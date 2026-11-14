// The shared music queue of a voice channel (server: routes/music.js). The server keeps the list and a clock; this app plays the
// current track for itself (a YouTube player or an <audio> element, see components/Music.jsx) and keeps to that clock.
// Nothing goes into anyone's microphone, and the volume and the off switch are each person's own (kept on this device).
import { store } from './state.js';
import { api } from './api.js';
import { toastError } from './toast.js';
import { setLocal } from './settings.js';

/** Where the room's current track should be right now, in milliseconds. `room` is an entry of store.music. */
export function expectedPositionMs(room, now = Date.now()) {
  if (!room || !room.tracks.length) return 0;
  const pos = room.positionMs + (room.playing ? now - room.receivedAt : 0);
  const dur = room.tracks[0].duration;
  return Math.max(0, dur ? Math.min(pos, dur * 1000) : pos);
}

/** 83 -> "1:23", 3725 -> "1:02:05" */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Load a room's queue (when joining it, or opening its window): the events only say what changes afterwards. */
export async function loadMusic(channelId) {
  try {
    const d = await api.get(`/channels/${channelId}/music`);
    const music = { ...store.get().music };
    if (d.tracks.length) music[channelId] = { ...d, receivedAt: Date.now() }; else delete music[channelId];
    store.set({ music });
  } catch { /* the queue is a nicety: the room works without it */ }
}

export async function addTrack(channelId, url) {
  return api.post(`/channels/${channelId}/music/tracks`, { url });
}
export const removeTrack = (channelId, trackId) => api.del(`/channels/${channelId}/music/tracks/${trackId}`).catch(toastError);
/** play | pause | seek | skip | jump | clear */
export const controlMusic = (channelId, action, extra = {}) => api.post(`/channels/${channelId}/music/control`, { action, ...extra }).catch(toastError);
/** What the player tells the server while it plays ("duration", "ended"). Never shown as an error: another app will have said it too. */
export const reportMusic = (channelId, action, extra = {}) => api.post(`/channels/${channelId}/music/control`, { action, ...extra }).catch(() => {});
export const lockMusic = (channelId, locked) => api.put(`/channels/${channelId}/music/lock`, { locked }).catch(toastError);

export function setMusicVolume(v) { setLocal({ musicVolume: Math.round(v) }); }
export function setMusicOff(off) { setLocal({ musicOff: !!off }); }
