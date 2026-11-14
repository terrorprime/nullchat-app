// Optional "big calls" voice: a LiveKit server carries the audio and video of a voice channel instead of everybody connecting to
// everybody. It is only used when the three LIVEKIT_* settings are present; without them nothing here runs and calls work as before.
//
// What this file does (the browser's media never passes through NullChat itself):
//   * hands a person a short-lived LiveKit join token when they join a voice channel (see mintJoinToken),
//   * tells LiveKit to drop a person from the room when NullChat drops them (they left, were disconnected by a moderator, lost
//     access to the channel...), so a join token can't be used to keep listening after that.
//
// The token format follows livekit-server-sdk's AccessToken (HS256 JWT: iss = API key, sub = identity, a `video` grant with the room),
// and the removal call is the same Twirp request livekit-server-sdk's RoomServiceClient.removeParticipant makes. No extra package is needed.
import crypto from 'node:crypto';
import { config } from '../config.js';

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Sign a LiveKit-style JWT (HS256) with the API secret. */
function signJwt(claims, secret) {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export const sfuEnabled = () => !!config.sfu;

/** The LiveKit room for a voice channel. Channel ids are unique across the whole site, so this never collides. */
export const roomName = (channelId) => `nc-${channelId}`;

/**
 * A token that lets one person join one channel's room.
 *   canSpeak  may send a microphone     (Speak permission, and not timed out)
 *   canStream may send a camera/screen  (Video / Stream permission)
 * Everyone may listen and watch. Data messages are not used, so they are not allowed.
 * The token is only needed to connect (LiveKit keeps a connected person connected and renews things itself), so it is short-lived.
 */
export function mintJoinToken({ userId, name, channelId, canSpeak, canStream, ttlSec = 120, now = Date.now() }) {
  if (!config.sfu) throw new Error('LiveKit is not configured');
  const sources = [];
  if (canSpeak) sources.push('microphone');
  if (canStream) sources.push('camera', 'screen_share', 'screen_share_audio');
  const t = Math.floor(now / 1000);
  return signJwt({
    iss: config.sfu.apiKey,
    sub: String(userId),
    name: String(name || '').slice(0, 100),
    nbf: t - 10,   // (a little tolerance for clocks that differ by a few seconds)
    exp: t + ttlSec,
    video: {
      room: roomName(channelId),
      roomJoin: true,
      canPublish: sources.length > 0,
      canPublishSources: sources,
      canSubscribe: true,
      canPublishData: false,
    },
  }, config.sfu.secret);
}

/** The token NullChat itself uses to give LiveKit an order (it is allowed to administer one room only, for one minute). */
function adminToken(room, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return signJwt({ iss: config.sfu.apiKey, nbf: t - 10, exp: t + 60, video: { room, roomAdmin: true } }, config.sfu.secret);
}

const apiBase = () => config.sfu.url.replace(/^ws/i, 'http');   // wss://x → https://x
let lastWarn = 0;
const warn = (msg) => { if (Date.now() - lastWarn > 60_000) { lastWarn = Date.now(); console.warn(`[sfu] ${msg}`); } };

/**
 * Drop a person from a channel's room. Never throws and never waits for LiveKit: if it is unreachable, or the person is not in the room
 * (they left on their own already, which is the usual case), nothing more is done.
 */
export function removeParticipant(channelId, userId) {
  if (!config.sfu) return Promise.resolve(false);
  const room = roomName(channelId);
  return fetch(`${apiBase()}/twirp/livekit.RoomService/RemoveParticipant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8', authorization: `Bearer ${adminToken(room)}` },
    body: JSON.stringify({ room, identity: String(userId) }),
    signal: AbortSignal.timeout(5000),
  }).then((res) => {
    if (!res.ok && res.status !== 404) warn(`LiveKit answered ${res.status} when removing someone from a room`);
    return res.ok;
  }).catch((e) => { warn(`could not reach LiveKit to remove someone from a room (${e.cause?.code || e.message})`); return false; });
}

/** What the admin overview shows. */
export const sfuStatus = () => (config.sfu ? { enabled: true, host: new URL(config.sfu.url).host } : { enabled: false });
