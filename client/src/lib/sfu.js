// The browser half of "big calls": it connects to the site's LiveKit server and gives voice.js a small, library-neutral interface.
// Everything that knows about the LiveKit library lives in this file, and the library itself is only downloaded when a call really is a
// big call (it is a separate file, so ordinary calls and the rest of the app never load it).
//
// voice.js keeps its own microphone processing (noise gate, push-to-talk, look-ahead) and hands the finished tracks to publish();
// what other people send arrives through the handlers below as plain MediaStreamTracks.
//
//   const sfu = await connectSfu({ url, token, handlers });
//   await sfu.publish('mic' | 'camera' | 'screen' | 'screenAudio', track, options);
//   await sfu.unpublish(kind);   await sfu.update(kind, options);   await sfu.replace(kind, newTrack);
//   await sfu.stats();           await sfu.disconnect();
//
// handlers: onTrack(userId, kind, track), onTrackGone(userId, kind), onParticipantGone(userId), onState('connected' | 'reconnecting'),
//           onDisconnected('self' | 'duplicate' | 'removed' | 'lost')

/** What other people send is told apart by LiveKit's "source" of the track. */
const KIND_OF_SOURCE = { microphone: 'mic', camera: 'camera', screen_share: 'screen', screen_share_audio: 'screenAudio' };
const SOURCE_OF_KIND = { mic: 'microphone', camera: 'camera', screen: 'screen_share', screenAudio: 'screen_share_audio' };

/** The names we publish under (they show up in LiveKit's own dashboards and logs). */
const NAME_OF_KIND = { mic: 'mic', camera: 'camera', screen: 'screen', screenAudio: 'screen-audio' };

export async function connectSfu({ url, token, handlers = {} }) {
  const lk = await import('livekit-client');
  const { Room, RoomEvent, Track, DisconnectReason } = lk;

  const room = new Room({
    // Receiving: we draw the video ourselves (voice.js owns the <video> elements), so LiveKit can't see how big a picture is drawn and must
    // not pause pictures it thinks nobody looks at. LiveKit's server still lowers quality by itself when someone's connection is slow.
    adaptiveStream: false,
    // Sending: pause the quality levels nobody is watching, so a big call doesn't make the sender encode three pictures for no one.
    dynacast: true,
    // voice.js owns the microphone, camera and screen tracks (it stops them itself), so LiveKit must leave them running when it lets go of one.
    stopLocalTrackOnUnpublish: false,
    publishDefaults: { simulcast: true, dtx: true },
  });

  let closing = false;
  const published = new Map();   // kind -> { track (the MediaStreamTrack we were given), options, local (LiveKit's LocalTrack) }
  const prevBytes = new Map();   // kind -> [bytes, time]: for working out bits per second

  const ident = (participant) => participant?.identity;
  const kindOf = (publication, track) => KIND_OF_SOURCE[publication?.source] || (track?.kind === 'audio' ? 'mic' : 'camera');
  const mine = (participant) => participant && participant === room.localParticipant;

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (mine(participant)) return;
    try { handlers.onTrack?.(ident(participant), kindOf(publication, track), track.mediaStreamTrack); } catch (e) { console.warn('[sfu] track handler failed', e); }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (mine(participant)) return;
    try { handlers.onTrackGone?.(ident(participant), kindOf(publication, track)); } catch (e) { console.warn('[sfu] track handler failed', e); }
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    try { handlers.onParticipantGone?.(ident(participant)); } catch (e) { console.warn('[sfu] participant handler failed', e); }
  });
  room.on(RoomEvent.Reconnecting, () => handlers.onState?.('reconnecting'));
  room.on(RoomEvent.SignalReconnecting, () => handlers.onState?.('reconnecting'));
  room.on(RoomEvent.Reconnected, () => handlers.onState?.('connected'));
  room.on(RoomEvent.Disconnected, (reason) => {
    // (guard each name: comparing with a missing one would match "no reason given")
    const is = (name) => DisconnectReason && DisconnectReason[name] !== undefined && reason === DisconnectReason[name];
    const why = closing || is('CLIENT_INITIATED') ? 'self' : is('DUPLICATE_IDENTITY') ? 'duplicate' : is('PARTICIPANT_REMOVED') ? 'removed' : 'lost';
    try { handlers.onDisconnected?.(why); } catch (e) { console.warn('[sfu] disconnect handler failed', e); }
  });

  await room.connect(url, token);

  const SOURCE = { mic: Track.Source.Microphone, camera: Track.Source.Camera, screen: Track.Source.ScreenShare, screenAudio: Track.Source.ScreenShareAudio };
  const publishOptions = (kind, options = {}) => ({ source: SOURCE[kind], name: NAME_OF_KIND[kind], ...options });

  const controller = {
    room,

    /** Send a track to everyone in the room. `options` are LiveKit's publish options (audioPreset, videoEncoding, screenShareEncoding...). */
    async publish(kind, track, options = {}) {
      if (!SOURCE_OF_KIND[kind] || !track || closing) return false;
      if (published.has(kind)) await controller.unpublish(kind);
      try {
        const pub = await room.localParticipant.publishTrack(track, publishOptions(kind, options));
        published.set(kind, { track, options, local: pub?.track || null });
        return true;
      } catch (e) {
        // (most likely this person may not send that (the server's token says what they may), or they left meanwhile)
        console.warn(`[sfu] could not send ${kind}`, e);
        return false;
      }
    },

    /** Stop sending a track. The track itself is left running (voice.js stops it). */
    async unpublish(kind) {
      const p = published.get(kind);
      if (!p) return;
      published.delete(kind);
      prevBytes.delete(kind);
      try { await room.localParticipant.unpublishTrack(p.track, false); } catch { /* already gone */ }
    },

    /** Send the same track again with different settings (a quality change). */
    async update(kind, options) {
      const p = published.get(kind);
      if (!p) return false;
      return controller.publish(kind, p.track, options);
    },

    /** Send a different track in its place (switching camera). */
    async replace(kind, track) {
      const p = published.get(kind);
      if (!p) return false;
      return controller.publish(kind, track, p.options);
    },

    has: (kind) => published.has(kind),

    /** What is really being sent right now (for the call-quality panel): { rttMs, loss, voiceKbps, video: { w, h, fps, kbps, limited } }. */
    async stats() {
      const out = { rttMs: null, loss: null, voiceKbps: null, video: null };
      const rtts = [];
      const now = performance.now();
      for (const [kind, p] of published) {
        let list;
        try { list = await p.local?.getSenderStats?.(); } catch { continue; }
        for (const s of [].concat(list || [])) {
          if (!s) continue;
          if (s.roundTripTime != null) rtts.push(s.roundTripTime * 1000);
          if (s.packetsLost != null && s.packetsSent) out.loss = Math.max(out.loss ?? 0, (s.packetsLost / (s.packetsSent + s.packetsLost)) * 100);
          const key = `${kind}:${s.rid || ''}`;
          const was = prevBytes.get(key);
          prevBytes.set(key, [s.bytesSent, now]);
          const kbps = was && now > was[1] && s.bytesSent != null ? ((s.bytesSent - was[0]) * 8) / (now - was[1]) : null;
          if (s.type === 'audio') { if (kbps != null && kind === 'mic') out.voiceKbps = Math.max(out.voiceKbps ?? 0, kbps); }
          else if (s.type === 'video' && s.frameWidth && kbps != null && (!out.video || s.frameWidth * s.frameHeight >= out.video.w * out.video.h)) {
            out.video = { w: s.frameWidth, h: s.frameHeight, fps: Math.round(s.framesPerSecond || 0), kbps, limited: s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? s.qualityLimitationReason : null };
          }
        }
      }
      if (rtts.length) out.rttMs = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
      return out;
    },

    async disconnect() {
      closing = true;
      published.clear();
      try { await room.disconnect(false); } catch { /* already closed */ }
    },
  };
  return controller;
}
