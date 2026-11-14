// The shared music queue of a voice channel. Everyone in the room adds links (YouTube, or a link straight to an audio file) to
// one list, and everyone hears the same thing at the same moment.
//
// The server never touches the music itself. It keeps the list and a clock ("track 1 has been playing for 83 seconds"); each
// person's app plays the track for itself and keeps to that clock. Nothing is mixed into anyone's microphone, and each person
// has their own volume.
//
// The queue lives in memory: it belongs to the people in the room, and is gone when the last of them leaves.
//
// Who can do what: anyone in the room can add a track and take their own back. Pausing, skipping, seeking and removing other
// people's tracks is for anyone in the room too, unless the channel is set so that only people who can manage it may.
import { z } from 'zod';
import { db, run } from '../db.js';
import { bad, forbidden, enforceRateLimit } from '../lib/http.js';
import { config } from '../config.js';
import { channelAccess, getChannelRow, serializeChannel } from '../models.js';
import { sendToChannel, voiceStates } from '../gateway.js';
import { newId } from '../lib/security.js';
import { youtubeId } from '../lib/unfurl.js';
import { safeGet, readText } from '../lib/safeHttp.js';
import { P, has, ChannelType } from '../../../shared/permissions.js';

if (!db.prepare("SELECT 1 FROM pragma_table_info('channels') WHERE name = 'music_locked'").get()) db.exec('ALTER TABLE channels ADD COLUMN music_locked INTEGER NOT NULL DEFAULT 0');

export const MAX_TRACKS = 50;
const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|weba)$/i;
const MAX_DURATION = 12 * 3600;       // seconds
const END_SLACK_MS = 4000;            // "it ended" is believed this close to the end
const ADVANCE_GRACE_MS = 1500;        // the server moves on by itself this long after the end, if nobody said so

const rooms = new Map();   // channel id -> { tracks: [{ id, kind, url, videoId, title, by, thumb, duration, addedBy }], playing, posMs, at, timer }

const positionOf = (room, now = Date.now()) => (room.playing && room.tracks.length ? room.posMs + (now - room.at) : room.posMs);

function publicState(channelRow, room, extra = {}) {
  return {
    channelId: channelRow.id,
    guildId: channelRow.guild_id,
    tracks: (room?.tracks || []).map(({ id, kind, url, videoId, title, by, thumb, duration, addedBy }) => ({ id, kind, url, videoId, title, by, thumb, duration, addedBy })),
    playing: !!room?.playing && !!room.tracks.length,
    positionMs: room ? Math.max(0, Math.round(positionOf(room))) : 0,
    locked: !!channelRow.music_locked,
    ...extra,
  };
}

function schedule(channelId) {
  const room = rooms.get(channelId);
  if (!room) return;
  clearTimeout(room.timer); room.timer = null;
  const cur = room.tracks[0];
  if (!cur || !room.playing || !cur.duration) return;
  const left = cur.duration * 1000 - positionOf(room) + ADVANCE_GRACE_MS;
  room.timer = setTimeout(() => {
    const r = rooms.get(channelId);
    if (!r || r.tracks[0]?.id !== cur.id) return;
    next(r);
    publish(channelId, { action: 'ended' });
  }, Math.max(0, left));
  room.timer.unref?.();
}

/** The current track is over (played out, skipped or removed): the one after it starts from the beginning. */
function next(room) {
  room.tracks.shift();
  room.posMs = 0; room.at = Date.now(); room.playing = room.tracks.length > 0;
}

function publish(channelId, extra = {}) {
  const row = getChannelRow(channelId);
  const room = rooms.get(channelId);
  if (room && !room.tracks.length) { clearTimeout(room.timer); rooms.delete(channelId); }
  else schedule(channelId);
  if (!row) return null;
  const state = publicState(row, rooms.get(channelId), extra);
  sendToChannel(row, 'VOICE_MUSIC', state);
  return state;
}

/** Forget the queues of rooms nobody is in any more. */
export function sweepMusic() {
  if (!rooms.size) return;
  const occupied = new Set([...voiceStates.values()].map((v) => v.channelId));
  for (const [channelId, room] of rooms) {
    if (occupied.has(channelId)) continue;
    clearTimeout(room.timer); room.tracks = [];
    publish(channelId, { action: 'empty' });
  }
}

/** For the tests. */
export function musicRoomCount() { return rooms.size; }

// ---- what a link is --------------------------------------------------------------------------------------------------------
const siteOrigin = () => { try { return new URL(config.publicUrl).origin; } catch { return null; } };

/** Work out what a pasted link is: { kind: 'youtube', videoId } or { kind: 'audio', url }, or null when it is neither. */
export function classifyTrackUrl(input) {
  let u;
  try { u = new URL(String(input).trim(), siteOrigin() || undefined); } catch { return null; }
  if (u.username || u.password) return null;
  const mine = siteOrigin() && u.origin === siteOrigin();
  if (u.protocol !== 'https:' && !(mine && u.protocol === 'http:')) return null;
  const yt = youtubeId(u.toString());
  if (yt && /^[\w-]{6,20}$/.test(yt)) return { kind: 'youtube', videoId: yt, url: `https://www.youtube.com/watch?v=${yt}` };
  if (/(^|\.)music\.youtube\.com$/.test(u.hostname) && u.pathname === '/watch' && /^[\w-]{6,20}$/.test(u.searchParams.get('v') || '')) {
    const id = u.searchParams.get('v');
    return { kind: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  // A file on this site is kept as a path, so it plays whatever address the person reached the site by.
  if (AUDIO_EXT.test(u.pathname)) return { kind: 'audio', url: mine ? u.pathname + u.search : u.toString() };
  return null;
}

let lookupTitle = async (videoId) => {
  const { status, stream, done } = await safeGet(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { timeoutMs: 4000 });
  try {
    if (status !== 200) return null;
    const j = JSON.parse(await readText(stream, { limit: 64 * 1024 }));
    return { title: String(j.title || '').slice(0, 200) || null, by: String(j.author_name || '').slice(0, 100) || null };
  } finally { done(); }
};
/** For the tests: answer title lookups without the internet. */
export function setTitleLookup(fn) { lookupTitle = fn; }

function fileTitle(url) {
  try {
    const name = decodeURIComponent(new URL(url, 'http://local.invalid').pathname.split('/').pop() || '').replace(AUDIO_EXT, '').replace(/[_-]+/g, ' ').trim();
    return name.slice(0, 200) || 'Audio file';
  } catch { return 'Audio file'; }
}

// ---- routes ----------------------------------------------------------------------------------------------------------------
function roomAccess(ctx) {
  const { channel, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
  if (isDM || channel.type !== ChannelType.VOICE) throw bad('Only voice channels have a music queue.');
  const manager = has(perms, P.MANAGE_CHANNELS);
  const inRoom = voiceStates.get(ctx.user.id)?.channelId === channel.id;
  return { channel, manager, inRoom, mayControl: manager || (inRoom && !channel.music_locked) };
}

export default function register(r) {
  r.get('/api/channels/:id/music', async (ctx) => {
    const { channel } = roomAccess(ctx);
    return publicState(channel, rooms.get(channel.id));
  });

  // Add a track to the end of the queue. If nothing is playing, it starts.
  r.post('/api/channels/:id/music/tracks', async (ctx) => {
    const { channel, inRoom } = roomAccess(ctx);
    if (!inRoom) throw forbidden('Join the voice channel to add music to it.');
    const { url } = z.object({ url: z.string().trim().min(1).max(2000) }).parse(ctx.body || {});
    const what = classifyTrackUrl(url);
    if (!what) throw bad('Paste a YouTube link, or a link that ends in an audio file (.mp3, .ogg, .wav, .m4a, .flac).');
    enforceRateLimit(`music-add:${ctx.user.id}`, 12, 60_000, 'You are adding tracks too quickly.');
    if ((rooms.get(channel.id)?.tracks.length || 0) >= MAX_TRACKS) throw bad(`The queue is full (${MAX_TRACKS} tracks).`);
    let meta = null;
    if (what.kind === 'youtube') { try { meta = await lookupTitle(what.videoId); } catch { /* the title is a nicety */ } }
    // (the lookup took a moment: look at the room again)
    if (voiceStates.get(ctx.user.id)?.channelId !== channel.id) throw forbidden('Join the voice channel to add music to it.');
    let room = rooms.get(channel.id);
    if (!room) { room = { tracks: [], playing: false, posMs: 0, at: Date.now(), timer: null }; rooms.set(channel.id, room); }
    if (room.tracks.length >= MAX_TRACKS) throw bad(`The queue is full (${MAX_TRACKS} tracks).`);
    const track = {
      id: newId(), kind: what.kind, url: what.url, videoId: what.videoId || null,
      title: meta?.title || (what.kind === 'youtube' ? 'YouTube video' : fileTitle(what.url)), by: meta?.by || null,
      thumb: what.kind === 'youtube' ? `https://i.ytimg.com/vi/${what.videoId}/mqdefault.jpg` : null,
      duration: null, addedBy: ctx.user.id,
    };
    room.tracks.push(track);
    if (room.tracks.length === 1) { room.playing = true; room.posMs = 0; room.at = Date.now(); }
    return publish(channel.id, { action: 'add', userId: ctx.user.id, trackId: track.id });
  });

  r.delete('/api/channels/:id/music/tracks/:trackId', async (ctx) => {
    const { channel, inRoom, mayControl } = roomAccess(ctx);
    const room = rooms.get(channel.id);
    const i = room ? room.tracks.findIndex((t) => t.id === ctx.params.trackId) : -1;
    if (i < 0) return publicState(channel, room);   // (already gone)
    if (!mayControl && !(inRoom && room.tracks[i].addedBy === ctx.user.id)) throw forbidden(inRoom ? 'Only people who can manage this channel can remove other people’s tracks.' : 'Join the voice channel to change its music.');
    if (i === 0) next(room); else room.tracks.splice(i, 1);
    return publish(channel.id, { action: i === 0 ? 'skip' : 'remove', userId: ctx.user.id });
  });

  // play / pause / seek / skip / jump (to a track further down) / clear, and three reports the apps make while playing:
  // "duration" (how long the current track is, once the player knows), "ended" (it played to the end) and "failed" (it will not play here).
  r.post('/api/channels/:id/music/control', async (ctx) => {
    const { channel, inRoom, manager, mayControl } = roomAccess(ctx);
    const body = z.object({
      action: z.enum(['play', 'pause', 'seek', 'skip', 'jump', 'clear', 'duration', 'ended', 'failed']),
      trackId: z.string().max(40).optional(),
      positionMs: z.number().min(0).max(MAX_DURATION * 1000).optional(),
      duration: z.number().min(0).max(MAX_DURATION).optional(),
    }).parse(ctx.body || {});
    const room = rooms.get(channel.id);
    const cur = room?.tracks[0];
    const report = body.action === 'duration' || body.action === 'ended' || body.action === 'failed';
    if (report ? !inRoom : !mayControl) throw forbidden(inRoom || manager ? 'Only people who can manage this channel can control its music.' : 'Join the voice channel to control its music.');
    if (!cur) return publicState(channel, room);
    // Anything about "the current track" says which one it means, so a click that arrives late never hits the next track.
    if (body.trackId && body.action !== 'jump' && body.trackId !== cur.id) return publicState(channel, room);
    const now = Date.now();
    if (!report) enforceRateLimit(`music-ctl:${ctx.user.id}`, 40, 60_000, 'You are changing the music too quickly.');
    switch (body.action) {
      case 'duration':
        if (!body.trackId || cur.duration || !(body.duration >= 0.5)) return publicState(channel, room);
        cur.duration = Math.round(body.duration * 10) / 10;
        return publish(channel.id, { action: 'duration' });
      case 'ended':
        if (!body.trackId) return publicState(channel, room);
        if (cur.duration && positionOf(room, now) < cur.duration * 1000 - END_SLACK_MS) return publicState(channel, room);   // (not yet, by the room's clock)
        next(room);
        return publish(channel.id, { action: 'ended' });
      case 'failed': {
        // "It will not play for me" (a removed video, one that may not be shown outside YouTube, a broken file). When that is so for
        // at least half the room, the room moves on; one person's bad connection does not skip a track for everyone.
        if (!body.trackId) return publicState(channel, room);
        (cur.failed ||= new Set()).add(ctx.user.id);
        const here = new Set([...voiceStates.values()].filter((v) => v.channelId === channel.id).map((v) => v.userId));
        const failedHere = [...cur.failed].filter((id) => here.has(id)).length;
        if (failedHere * 2 < here.size) return publicState(channel, room);
        next(room);
        return publish(channel.id, { action: 'failed' });
      }
      case 'play':
        if (!room.playing) { room.playing = true; room.at = now; }
        break;
      case 'pause':
        if (room.playing) { room.posMs = positionOf(room, now); room.playing = false; }
        break;
      case 'seek': {
        if (body.positionMs === undefined) throw bad('Seek to where?');
        const max = cur.duration ? Math.max(0, cur.duration * 1000 - 1000) : body.positionMs;
        room.posMs = Math.min(body.positionMs, max); room.at = now;
        break;
      }
      case 'skip':
        next(room);
        break;
      case 'jump': {
        const i = room.tracks.findIndex((t) => t.id === body.trackId);
        if (i < 1) return publicState(channel, room);
        room.tracks.unshift(room.tracks.splice(i, 1)[0]);   // it moves to the front ...
        room.tracks.splice(1, 1);                           // ... and what was playing is over
        room.posMs = 0; room.at = now; room.playing = true;
        break;
      }
      case 'clear':
        room.tracks = [];
        break;
    }
    return publish(channel.id, { action: body.action, userId: ctx.user.id });
  });

  // Whether only channel managers may control the music.
  r.put('/api/channels/:id/music/lock', async (ctx) => {
    const { channel, manager } = roomAccess(ctx);
    if (!manager) throw forbidden('Only people who can manage this channel can change who controls its music.');
    const { locked } = z.object({ locked: z.boolean() }).parse(ctx.body || {});
    run('UPDATE channels SET music_locked = ? WHERE id = ?', locked ? 1 : 0, channel.id);
    const row = getChannelRow(channel.id);
    sendToChannel(row, 'CHANNEL_UPDATE', serializeChannel(row));
    sendToChannel(row, 'VOICE_MUSIC', publicState(row, rooms.get(row.id), { action: 'lock', userId: ctx.user.id }));
    return publicState(row, rooms.get(row.id));
  });

  setInterval(() => { try { sweepMusic(); } catch (e) { console.error('[music]', e.message); } }, 15_000).unref();
}
