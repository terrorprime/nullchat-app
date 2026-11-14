// Voice & video engine: WebRTC mesh with "perfect negotiation", WebAudio mic processing,
// voice activity detection, push-to-talk, speaking indicators, camera and screen sharing.
// Quality: voice is sent at 64 kbps (settable) with top network priority, video starts at full size instead of climbing for half a minute,
// the voice gate looks ahead so the first syllable is not cut, and every sender's bitrate is shared out between the people it is sent to.
// Voice channels on a site with a LiveKit server ("big calls") use the same microphone processing, but send each track once to that server
// instead of to every person (see the "big calls" section and sfu.js); stages and direct-message calls always connect people directly.
import { createStore, useStoreOf } from './store.js';
import { store as appStore, displayName } from './state.js';
import { openMicrophone, listDevices, resolveDevice, outputSink, defaultInputName } from './devices.js';
import { send, request, on } from './gateway.js';
import { getLocal, onLocalChange } from './settings.js';
import { play, startRinging, stopRinging, configureSounds } from './sounds.js';
import { playVoiceSound } from './voiceSounds.js';
import { toast } from './toast.js';
import { installEnv } from './install.js';
import { withVideoStart } from './sdp.js';
import { connectSfu } from './sfu.js';

export const voiceStore = createStore({
  channelId: null,
  guildId: null,
  status: 'disconnected', // disconnected | connecting | connected | reconnecting
  selfMute: false,
  selfDeaf: false,
  video: false,
  screen: false,
  localCamera: null,
  localScreen: null,
  speaking: {},
  peers: {},        // userId -> { state, streams: { streamId: MediaStream } }
  ping: null,
  joinedAt: null,
  pttActive: false,
  noMic: false,
  inputLevel: -100,
  link: null,       // what is really being sent right now: { voiceKbps, video: { w, h, fps, kbps, limited }, loss }
});
export const useVoice = (sel) => useStoreOf(voiceStore, sel);

const peers = new Map(); // userId -> peer
let audio = null;        // { ctx, source, gain, analyser, dest, micStream }
let loopTimer = null;
let statsTimer = null;
let cameraStream = null;
let screenStream = null;
let lastVoiceAbove = 0;
let noiseFloor = -70;
let rejoinChannel = null;
let audioContainer = null;
// On a stage channel: 'speaker', 'listener', or null when I am not on a stage. Listeners send nothing (and are not asked for a microphone);
// a listener only connects to the speakers, so a stage of fifty people is fifty connections in total, not a web between all of them.
let stageRole = null;
let sfu = null;          // the connection to the LiveKit server, in a big call (people are then not connected to each other)
const STAGE_VOICE_KBPS = 32_000;   // a speaker sends the same audio to every listener, so it is kept lighter than in a normal call

const me = () => appStore.get().me?.id;
const vs = () => voiceStore.get();
const myServerState = () => appStore.get().voiceStates[me()] || {};

function ensureAudioContainer() {
  if (!audioContainer) {
    audioContainer = document.createElement('div');
    audioContainer.style.display = 'none';
    audioContainer.id = 'nullchat-voice-audio';
    document.body.appendChild(audioContainer);
  }
  return audioContainer;
}

// ---------------------------------------------------------------- quality
// Everyone sends to everyone (a mesh), so what one person uploads is shared out between all the others. Voice comes first (it gets the
// highest network priority, so a screen share can never make it crackle), and each video stream is capped so the total stays within what a
// home connection can carry: fewer people = a sharper picture, more people = a smaller share each.
export const VOICE_QUALITIES = [
  { value: 'standard', label: 'Standard (32 kbps)', bitrate: 32_000 },
  { value: 'high', label: 'High (64 kbps, recommended)', bitrate: 64_000 },
  { value: 'studio', label: 'Studio (128 kbps)', bitrate: 128_000 },
];
export const CAMERA_QUALITIES = [
  { value: 'saver', label: 'Data saver (480p)', width: 854, height: 480, fps: 30, max: 1_000_000, floor: 350_000, budget: 3_000_000 },
  { value: 'standard', label: 'Standard (720p, recommended)', width: 1280, height: 720, fps: 30, max: 2_500_000, floor: 600_000, budget: 5_000_000 },
  { value: 'high', label: 'High (1080p)', width: 1920, height: 1080, fps: 30, max: 4_500_000, floor: 900_000, budget: 8_000_000 },
];
export const voiceQualityOf = (v) => VOICE_QUALITIES.find((q) => q.value === v) || VOICE_QUALITIES[1];
export const cameraQualityOf = (v) => CAMERA_QUALITIES.find((q) => q.value === v) || CAMERA_QUALITIES[1];
const SCREEN_BUDGET = 16_000_000;   // the most a screen share may upload in total, shared out between the viewers
const SCREEN_FLOOR = 1_500_000;     // …but never less than this each
const AUDIO_OVERHEAD = 18_000;      // bits a second that carrying voice costs on top of the voice itself
const AUDIO_LOOKAHEAD = 0.05;       // seconds: the gate decides before the sound arrives, so the start of a word is not cut off
let screenState = { quality: 'standard', fps: 60 };

const viewers = () => Math.max(1, peers.size);
const shareOut = (budget, floor, max) => Math.round(Math.max(floor, Math.min(max, budget / viewers())));
/** The bitrate (kbps) we ask each sender to start video at. Left alone Chrome starts at about 300 kbps and needs 20+ seconds to climb to a sharp picture. */
export const startKbps = (people = viewers()) => Math.round(Math.max(500, Math.min(1500, 6000 / Math.max(1, people))));

/** The description to send to a peer: ours, with the start-bitrate hint. */
function outgoing(pc) {
  const d = pc.localDescription;
  return d ? { type: d.type, sdp: withVideoStart(d.sdp, startKbps()) } : d;
}

async function setEncoding(sender, patch) {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;   // not negotiated yet: this runs again when it is
    for (const [k, v] of Object.entries(patch)) p.encodings[0][k] = v;
    await sender.setParameters(p);
  } catch { /* this browser does not allow it; the default is fine */ }
}

/** Set the bitrate and priority of everything we send to one person. Runs whenever the connection settles, someone joins or leaves, or a setting changes. */
function tunePeer(peer) {
  if (!peer || !peer.pc || peer.pc.signalingState !== 'stable') return;
  const l = getLocal();
  // (the browser counts each packet's wrapping against this limit, about 18 kbps at 50 packets a second, and gives the voice
  //  codec what is left: without the allowance, "64 kbps" was really about 46)
  setEncoding(peer.senders.audio, { maxBitrate: Math.min(voiceQualityOf(l.voiceQuality).bitrate, stageRole ? STAGE_VOICE_KBPS : Infinity) + AUDIO_OVERHEAD, priority: 'high', networkPriority: 'high' });
  const cq = cameraQualityOf(l.cameraQuality);
  setEncoding(peer.senders.camera, { maxBitrate: shareOut(cq.budget, cq.floor, cq.max), maxFramerate: cq.fps, priority: 'medium' });
  setEncoding(peer.senders.screen, { maxBitrate: shareOut(SCREEN_BUDGET, SCREEN_FLOOR, QUALITY_BITRATE[screenState.quality] || QUALITY_BITRATE.standard), maxFramerate: screenState.fps, priority: 'medium' });
  setEncoding(peer.senders.screenAudio, { maxBitrate: 96_000, priority: 'high', networkPriority: 'high' });
}
function tuneAllPeers() { for (const p of peers.values()) tunePeer(p); }

/**
 * Voice protection: ask for the microphone's sound to be sent with each packet also carrying the one before it ("RED").
 * A packet lost on the way is then rebuilt from the next one instead of being a gap or a robotic blip, which is most of what
 * a poor connection sounds like. It costs about the voice bitrate again, so the Standard (data saver) quality leaves it off.
 * Both sides have to know it (Chrome, Edge, the desktop app, Safari do); where one does not, the call is as it was.
 */
function preferRedundancy(pc, sender) {
  const l = getLocal();
  if (l.voiceProtect === false || voiceQualityOf(l.voiceQuality).value === 'standard' || stageRole) return;
  try {
    const caps = (RTCRtpReceiver.getCapabilities?.('audio') || RTCRtpSender.getCapabilities?.('audio'))?.codecs || [];
    const red = caps.filter((c) => /^audio\/red$/i.test(c.mimeType)), opus = caps.filter((c) => /^audio\/opus$/i.test(c.mimeType));
    if (!red.length || !opus.length) return;
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    tr?.setCodecPreferences?.([...red, ...opus, ...caps.filter((c) => !red.includes(c) && !opus.includes(c))]);
  } catch { /* this browser decides the order itself */ }
}

// ---------------------------------------------------------------- microphone
let micWarned = '';   // the chosen microphone we last said was missing (said once, not on every retry)
let micBlocked = false;   // the person or the system refused the microphone: plugging something in does not change that
let micSig = '';     // which microphone is open: its id, or 'default:<the system default's name>'
async function getMicStream() {
  const got = await openMicrophone();
  if (got.fellBack && got.label && micWarned !== got.label) {
    micWarned = got.label;
    toast(`“${got.label}” isn’t connected or wouldn’t start, so NullChat is using your default microphone.`, 'warning', 7000);
  }
  if (!got.fellBack) micWarned = '';
  return got.stream;
}
const currentMicSig = () => { const r = resolveDevice('audioinput'); return r.id === 'default' ? `default:${defaultInputName().toLowerCase()}` : r.id; };

// Headphones plugged in, AirPods connecting, a USB microphone pulled out: the list of devices changed. Sound goes to the
// chosen speaker if it is (still, or again) there; and the microphone is opened again when the one in use went away, the
// chosen one came back, or "Default" now means a different device.
let deviceTimer = 0;
function devicesChanged() {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(async () => {
    await listDevices();
    configureSounds({ deviceId: outputSink() || 'default' });
    applyAllOutputs();
    if (!audio || micBlocked || stageRole === 'listener') return;
    const track = audio.micStream?.getAudioTracks()[0];
    const dead = !track || track.readyState === 'ended';
    if (!dead && currentMicSig() === micSig) return;
    const had = !vs().noMic;
    await attachMic({ quiet: true });
    if (!had && !vs().noMic) toast('Microphone connected. Unmute to talk.', 'success', 4000);
  }, 700);
}
try { navigator.mediaDevices?.addEventListener?.('devicechange', devicesChanged); } catch { /* no device list in this browser */ }
// (app sounds go to the chosen speaker from the start, when it is connected)
try { listDevices().then(() => configureSounds({ deviceId: outputSink() || 'default' })).catch(() => {}); } catch { /* no device list */ }

async function setupAudio({ mic = true } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { ctx = new AC(); }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const dest = ctx.createMediaStreamDestination();
  // The voice gate watches the microphone directly but what is sent goes through a short delay, so the gate has already opened when the
  // first syllable arrives. (Push-to-talk needs no delay: you press the key before you speak.)
  const delay = ctx.createDelay(0.25);
  delay.delayTime.value = lookahead();
  gain.gain.value = 0;
  delay.connect(gain);
  gain.connect(dest);
  // The voice chain (Settings → Voice & Video → Voice enhancement), between the microphone and the gate:
  //   a high-pass filter takes out what is below a voice (desk thumps, hum, breath pops);
  //   a compressor brings quiet and loud speech closer together, so nobody is whispering or shouting at the others;
  //   a little gain makes up for what the compressor took; and a fast limiter stops a laugh or a shout from distorting.
  // The gate still listens to the untouched microphone, so its sensitivity means what it always did.
  const cut = ctx.createBiquadFilter(); cut.type = 'highpass'; cut.frequency.value = 85; cut.Q.value = 0.7;
  const even = ctx.createDynamicsCompressor();
  even.threshold.value = -24; even.knee.value = 14; even.ratio.value = 3; even.attack.value = 0.005; even.release.value = 0.2;
  const lift = ctx.createGain(); lift.gain.value = 1.45;
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -2; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.06;
  const trim = ctx.createGain(); trim.gain.value = 0.9;   // (the limiter adds a little level of its own: keep the loudest moment under full scale)
  cut.connect(even); even.connect(lift); lift.connect(limit); limit.connect(trim); trim.connect(delay);
  audio = { ctx, gain, analyser, dest, delay, chain: cut, source: null, micStream: null };
  if (mic) await attachMic();
}

/** Let go of the microphone (a speaker who goes back to the audience): the browser's recording light goes out. */
function detachMic() {
  if (!audio) return;
  audio.source?.disconnect();
  audio.micStream?.getTracks().forEach((t) => t.stop());
  audio.source = null; audio.micStream = null;
}

async function attachMic({ quiet = false } = {}) {
  if (!audio) return;
  try {
    const stream = await getMicStream();
    if (!audio) { stream.getTracks().forEach((t) => t.stop()); return; }   // (the call ended while the microphone was opening)
    audio.source?.disconnect();
    audio.micStream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    audio.micStream = stream;
    audio.source = audio.ctx.createMediaStreamSource(stream);
    audio.source.connect(audio.analyser);
    audio.source.connect(getLocal().voiceEnhance !== false ? audio.chain : audio.delay);
    micBlocked = false;
    micSig = currentMicSig();
    // (a microphone that is unplugged, or a headset that disconnects, ends its track: carry on with whatever is there now)
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (audio?.micStream === stream) devicesChanged(); };
    // (a Bluetooth headset switching to its microphone can pause the sound engine for a moment)
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    voiceStore.set({ noMic: false });
  } catch (e) {
    console.warn('Microphone unavailable', e);
    micBlocked = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    audio.source?.disconnect();
    audio.micStream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    audio.source = null; audio.micStream = null; micSig = '';
    const was = vs().noMic;
    voiceStore.set({ noMic: true, selfMute: true });
    if (quiet && was) return;
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
    toast(micBlocked
      ? (mac ? 'Microphone access was blocked. Allow it for this site (or for NullChat) in System Settings → Privacy & Security → Microphone, then rejoin.' : 'Microphone access was blocked. Allow it in your browser’s site settings to talk.')
      : e.name === 'NotReadableError' ? 'Your microphone wouldn’t start (another app may be holding it). You can still listen.'
      : 'No microphone found. You can still listen.', 'warning', 8000);
  }
}

export async function reacquireMic() { if (audio) await attachMic(); }
const lookahead = () => (getLocal().inputMode === 'ptt' ? 0 : AUDIO_LOOKAHEAD);

function sendTrack() { return audio?.dest.stream.getAudioTracks()[0] || null; }

function micShouldBeOpen(levelDb) {
  const s = vs();
  const srv = myServerState();
  if (s.selfMute || s.selfDeaf || srv.mute || srv.suppress || s.noMic) return false;
  const l = getLocal();
  if (l.inputMode === 'ptt') return s.pttActive;
  const threshold = l.autoSensitivity ? Math.max(noiseFloor + 12, -62) : l.vadThreshold;
  const now = performance.now();
  if (levelDb > threshold) lastVoiceAbove = now;
  return now - lastVoiceAbove < 350;
}

function levelOf(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function startLoop() {
  stopLoop();
  const buf = new Float32Array(1024);
  let lastSpeaking = {};
  let tick = 0;
  // The gate is checked every 20 ms (it used to be 60 ms, which could cut the first syllable); everything else still runs every 60 ms.
  loopTimer = setInterval(() => {
    if (!audio) return;
    const db = audio.source ? levelOf(audio.analyser, buf) : -100;
    const slow = tick++ % 3 === 0;
    // Track a slow-moving noise floor for automatic sensitivity.
    if (slow) noiseFloor = db < noiseFloor ? noiseFloor * 0.8 + db * 0.2 : noiseFloor * 0.995 + db * 0.005;
    const open = micShouldBeOpen(db);
    const l = getLocal();
    const target = open ? l.inputVolume / 100 : 0;
    audio.gain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.008);
    if (!slow) return;
    const speaking = {};
    speaking[me()] = open && db > -70;
    for (const [uid, p] of peers) {
      let loud = false;
      for (const a of p.analysers.values()) if (levelOf(a, buf) > -55) { loud = true; break; }
      const st = appStore.get().voiceStates[uid];
      speaking[uid] = loud && !st?.selfMute && !st?.mute;
    }
    const changed = Object.keys(speaking).some((k) => speaking[k] !== lastSpeaking[k]) || Object.keys(lastSpeaking).length !== Object.keys(speaking).length;
    if (changed) { lastSpeaking = speaking; voiceStore.set({ speaking }); }
    if (tick % 4 === 1) voiceStore.set({ inputLevel: Math.round(db) });
  }, 20);
}
function stopLoop() { clearInterval(loopTimer); loopTimer = null; }

// ---------------------------------------------------------------- peers
function updatePeerUi(uid, patch) {
  const cur = vs().peers;
  voiceStore.set({ peers: { ...cur, [uid]: { ...(cur[uid] || { state: 'new', streams: {} }), ...patch } } });
}

/** Something from another person has arrived (over a direct connection, or from the big-call server): play it, or keep it for their tile. */
function addRemoteTrack(peer, key, stream, track) {
  const uid = peer.uid;
  if (track.kind === 'audio') {
    const had = peer.audioEls.get(key);
    if (had && had.srcObject !== stream) { had.srcObject = stream; peer.analysers.delete(key); }   // (the same sender came back with a new track)
    if (!had) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = stream;
      ensureAudioContainer().appendChild(el);
      peer.audioEls.set(key, el);
    }
    if (!peer.analysers.has(key)) {
      try {
        const src = audio.ctx.createMediaStreamSource(stream);
        const an = audio.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
        peer.analysers.set(key, an);
      } catch { /* ignore */ }
    }
    applyOutput(uid);
    peer.audioEls.get(key)?.play?.().catch(() => {});
  }
  peer.streams[key] = stream;
  updatePeerUi(uid, { streams: { ...peer.streams } });
}

function createPeer(uid) {
  if (sfu) return sfuPeer(uid);
  if (peers.has(uid)) return peers.get(uid);
  const pc = new RTCPeerConnection({ iceServers: appStore.get().iceServers || [] });
  const peer = { uid, pc, polite: me() > uid, makingOffer: false, ignoreOffer: false, senders: {}, audioEls: new Map(), analysers: new Map(), streams: {} };
  peers.set(uid, peer);
  updatePeerUi(uid, { state: 'connecting', streams: {} });
  pc.addEventListener('signalingstatechange', () => tunePeer(peer));   // set the bitrates as soon as the connection is settled
  tuneAllPeers();                                                      // one more person: everyone's share changes

  const t = stageRole === 'listener' ? null : sendTrack();
  if (t) { peer.senders.audio = pc.addTrack(t, audio.dest.stream); preferRedundancy(pc, peer.senders.audio); }
  if (cameraStream) peer.senders.camera = pc.addTrack(cameraStream.getVideoTracks()[0], cameraStream);
  if (screenStream) {
    peer.senders.screen = pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
    const sa = screenStream.getAudioTracks()[0];
    if (sa) peer.senders.screenAudio = pc.addTrack(sa, screenStream);
  }

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send('voice_signal', { to: uid, data: { description: outgoing(pc) } });
    } catch (e) { console.warn('negotiation failed', e); }
    finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) send('voice_signal', { to: uid, data: { candidate } }); };
  pc.onconnectionstatechange = () => {
    updatePeerUi(uid, { state: pc.connectionState });
    if (pc.connectionState === 'failed') {
      try { pc.restartIce(); } catch { /* ignore */ }
      // Said once per person: no path could be found between the two of you. Without a relay that is a setting on the server.
      peer.failures = (peer.failures || 0) + 1;
      if (peer.failures === 2 && !peer.warned) {
        peer.warned = true;
        const relay = (appStore.get().iceServers || []).some((s) => [].concat(s.urls || []).some((u) => /^turns?:/i.test(u)));
        const name = displayName(appStore.get(), uid, appStore.get().channels[vs().channelId]?.guildId) || 'someone';
        toast(relay
          ? `Still trying to connect you and ${name}. One of your networks is blocking the call.`
          : `You and ${name} can’t hear each other: your networks block direct calls, and this server has no voice relay yet. The server’s owner can turn one on with “Voice Relay Setup”.`, 'error', 12000);
      }
    }
    if (pc.connectionState === 'connected') peer.failures = 0;
  };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    addRemoteTrack(peer, stream.id, stream, ev.track);
    stream.onremovetrack = () => {
      if (stream.getTracks().length === 0) {
        delete peer.streams[stream.id];
        updatePeerUi(uid, { streams: { ...peer.streams } });
      } else updatePeerUi(uid, { streams: { ...peer.streams } });
    };
    ev.track.onunmute = () => updatePeerUi(uid, { streams: { ...peer.streams } });
  };
  return peer;
}

function closePeer(uid) {
  const p = peers.get(uid);
  if (!p) return;
  try { p.pc?.close(); } catch { /* ignore */ }
  dropBoosts(p);
  for (const el of p.audioEls.values()) { el.srcObject = null; el.remove(); }
  peers.delete(uid);
  const cur = { ...vs().peers }; delete cur[uid];
  voiceStore.set({ peers: cur });
  tuneAllPeers();   // one person fewer: everyone else's share grows
}

async function handleSignal({ from, data }) {
  if (!vs().channelId || sfu) return;   // (in a big call nobody connects directly to anybody)
  if (stageRole && !wantPeer(from)) return;   // (two listeners never talk to each other)
  const peer = peers.get(from) || createPeer(from);
  const pc = peer.pc;
  try {
    if (data.description) {
      const offerCollision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        send('voice_signal', { to: from, data: { description: outgoing(pc) } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn(e); }
    }
  } catch (e) { console.warn('signal error', e); }
}

/** Apply volume / deafen / local mute to a remote user's audio elements. */
function applyOutput(uid) {
  const p = peers.get(uid);
  if (!p) return;
  const l = getLocal();
  const s = vs();
  const srv = myServerState();
  const st = appStore.get().voiceStates[uid];
  const userVol = Math.max(0, Math.min(2, (l.userVolumes[uid] ?? 100) / 100));
  const silent = s.selfDeaf || !!srv.deaf || !!l.localMutes[uid] || !!st?.mute;
  // (the chosen speaker when it is connected, otherwise the system's: a missing one would mean silence)
  const route = (el) => { if (el.setSinkId) { const sink = outputSink(); if (el.sinkId !== sink) el.setSinkId(sink).catch(() => { el.setSinkId('').catch(() => {}); }); } };
  for (const [key, el] of p.audioEls) {
    const b = userVol > 1 ? boostFor(p, key, el) : null;
    if (!b) dropBoost(p, key);
    if (b) {
      // Louder than 100%: the person's sound is played by the boosted copy, and the plain one is silenced (not stopped: it is
      // what keeps their sound arriving).
      b.gain.gain.value = userVol;
      b.el.volume = Math.max(0, Math.min(1, l.outputVolume / 100));
      b.el.muted = silent;
      el.muted = true;
      route(b.el);
      b.el.play?.().catch(() => {});
    } else {
      el.volume = Math.max(0, Math.min(1, (l.outputVolume / 100) * userVol));
      el.muted = silent;
    }
    route(el);
  }
}

// A person turned up past 100% (up to 200%). An <audio> element cannot play louder than its sound is, so that person's sound
// goes through a gain, then a limiter (so their shout at 200% does not crackle), into a second element.
function boostFor(p, key, el) {
  if (!audio || !el.srcObject) return null;
  p.boosts = p.boosts || new Map();
  let b = p.boosts.get(key);
  if (b && b.stream !== el.srcObject) { dropBoost(p, key); b = null; }   // (the same person came back with a new track)
  if (b) return b;
  try {
    const ctx = audio.ctx;
    const src = ctx.createMediaStreamSource(el.srcObject);
    const gain = ctx.createGain();
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -3; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.08;
    const dest = ctx.createMediaStreamDestination();
    // (the limiter adds some level of its own, about a quarter; the trim takes exactly that back, so 200% is twice as loud
    //  and the loudest moment stays under full scale)
    const trim = ctx.createGain(); trim.gain.value = 0.78;
    src.connect(gain); gain.connect(limit); limit.connect(trim); trim.connect(dest);
    const out = document.createElement('audio');
    out.autoplay = true; out.srcObject = dest.stream; out.dataset.boost = p.uid;
    ensureAudioContainer().appendChild(out);
    b = { stream: el.srcObject, src, gain, limit, dest, el: out };
    p.boosts.set(key, b);
    return b;
  } catch { return null; }
}
function dropBoost(p, key) {
  const b = p.boosts?.get(key);
  if (!b) return;
  try { b.src.disconnect(); b.gain.disconnect(); b.limit.disconnect(); } catch { /* already apart */ }
  b.el.srcObject = null; b.el.remove();
  p.boosts.delete(key);
}
function dropBoosts(p) { for (const key of [...(p.boosts?.keys() || [])]) dropBoost(p, key); }
function applyAllOutputs() { for (const uid of peers.keys()) applyOutput(uid); }

let lastQualityKey = '';
onLocalChange((l) => {
  applyAllOutputs();
  if (audio) audio.delay.delayTime.value = lookahead();   // voice activity gets the look-ahead, push-to-talk does not need it
  const key = `${l.voiceQuality}|${l.cameraQuality}`;
  if (key === lastQualityKey) return;
  lastQualityKey = key;
  tuneAllPeers();
  if (sfu) { sfu.update('mic', sfuOptions('mic')); if (cameraStream) sfu.update('camera', sfuOptions('camera')); }
  const cam = cameraStream?.getVideoTracks()[0];
  if (cam) { const cq = cameraQualityOf(l.cameraQuality); cam.applyConstraints({ width: { ideal: cq.width }, height: { ideal: cq.height }, frameRate: { ideal: cq.fps } }).catch(() => { /* the camera keeps what it has */ }); }
});

// ---------------------------------------------------------------- stats / ping
const statsPrev = new Map();   // `${uid}:${stream}` -> [bytes sent, time]: for working out bits per second
function startStats() {
  clearInterval(statsTimer);
  statsPrev.clear();
  statsTimer = setInterval(async () => {
    if (sfu) {
      try {
        const st = await sfu.stats();
        voiceStore.set({ ping: st.rttMs, link: { voiceKbps: st.voiceKbps == null ? null : Math.round(st.voiceKbps), video: st.video && { ...st.video, kbps: Math.round(st.video.kbps) }, loss: st.loss == null ? null : Math.round(st.loss * 10) / 10 } });
      } catch { /* ignore */ }
      return;
    }
    const rtts = [];
    let voiceKbps = null, video = null, loss = null;
    const now = performance.now();
    for (const [uid, p] of peers) {
      try {
        const stats = await p.pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) rtts.push(r.currentRoundTripTime * 1000);
          else if (r.type === 'remote-inbound-rtp' && r.fractionLost != null) loss = Math.max(loss ?? 0, r.fractionLost * 100);
          else if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
            const key = `${uid}:${r.id}`;
            const was = statsPrev.get(key);
            statsPrev.set(key, [r.bytesSent, now]);
            const kbps = was && now > was[1] ? ((r.bytesSent - was[0]) * 8) / (now - was[1]) : null;
            if (r.kind === 'audio') { if (kbps != null) voiceKbps = Math.max(voiceKbps ?? 0, kbps); }
            else if (r.frameWidth && kbps != null && (!video || r.frameWidth * r.frameHeight >= video.w * video.h)) {
              video = { w: r.frameWidth, h: r.frameHeight, fps: Math.round(r.framesPerSecond || 0), kbps, limited: r.qualityLimitationReason && r.qualityLimitationReason !== 'none' ? r.qualityLimitationReason : null };
            }
          }
        });
      } catch { /* ignore */ }
    }
    voiceStore.set({
      ping: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
      link: peers.size ? { voiceKbps: voiceKbps == null ? null : Math.round(voiceKbps), video: video && { ...video, kbps: Math.round(video.kbps) }, loss: loss == null ? null : Math.round(loss * 10) / 10 } : null,
    });
  }, 2000);
}

// ---------------------------------------------------------------- public API
function pushState() {
  const s = vs();
  send('voice_state', {
    selfMute: s.selfMute || s.noMic, selfDeaf: s.selfDeaf, selfVideo: !!cameraStream, selfStream: !!screenStream,
    // (in a big call people find each other's pictures by these fixed names, because the browser's own stream ids differ on each side)
    cameraStreamId: cameraStream ? (sfu ? 'cam' : cameraStream.id) : null, screenStreamId: screenStream ? (sfu ? 'scr' : screenStream.id) : null,
  });
}

// ---------------------------------------------------------------- big calls (LiveKit)
// In a big call there are no connections between people: each track is sent once to the LiveKit server, which passes it on. Everyone still
// gets a "peer" entry here (without a connection) so the tiles, volumes, mutes and speaking rings work exactly as in an ordinary call.
const SFU_KEY = { mic: 'mic', camera: 'cam', screen: 'scr', screenAudio: 'scr-audio' };   // (the names pictures are found by: see pushState)

/** The send settings for a track. With one upload shared by everyone there is nothing to divide between viewers, so full quality is used. */
function sfuOptions(kind) {
  const l = getLocal();
  if (kind === 'mic') return { audioPreset: { maxBitrate: voiceQualityOf(l.voiceQuality).bitrate } };
  if (kind === 'camera') { const cq = cameraQualityOf(l.cameraQuality); return { videoEncoding: { maxBitrate: cq.max, maxFramerate: cq.fps } }; }
  if (kind === 'screen') return { screenShareEncoding: { maxBitrate: QUALITY_BITRATE[screenState.quality] || QUALITY_BITRATE.standard, maxFramerate: screenState.fps } };
  return { audioPreset: { maxBitrate: 96_000 } };
}

function sfuPeer(uid) {
  let p = peers.get(uid);
  if (!p) {
    p = { uid, pc: null, polite: false, makingOffer: false, ignoreOffer: false, senders: {}, audioEls: new Map(), analysers: new Map(), streams: {} };
    peers.set(uid, p);
    updatePeerUi(uid, { state: 'connected', streams: {} });
  }
  return p;
}

function sfuTrackIn(uid, kind, track) {
  if (!vs().channelId || !uid || uid === me() || !SFU_KEY[kind]) return;
  addRemoteTrack(sfuPeer(uid), SFU_KEY[kind], new MediaStream([track]), track);
}
function sfuTrackOut(uid, kind) {
  const peer = peers.get(uid), key = SFU_KEY[kind];
  if (!peer || !key) return;
  const el = peer.audioEls.get(key);
  dropBoost(peer, key);
  if (el) { el.srcObject = null; el.remove(); peer.audioEls.delete(key); }
  peer.analysers.delete(key);
  if (key in peer.streams) { delete peer.streams[key]; updatePeerUi(uid, { streams: { ...peer.streams } }); }
}

/** Connect to the LiveKit server and start sending what we have. False if it could not be reached. */
async function startSfu({ url, token }) {
  let conn = null;
  try {
    conn = await connectSfu({
      url, token,
      handlers: {
        onTrack: sfuTrackIn,
        onTrackGone: sfuTrackOut,
        onParticipantGone: (uid) => { for (const k of Object.keys(SFU_KEY)) sfuTrackOut(uid, k); },
        onState: (st) => { if (conn && sfu === conn && vs().channelId) voiceStore.set({ status: st === 'connected' ? 'connected' : 'reconnecting' }); },
        onDisconnected: (why) => {
          if (why === 'self' || !conn || sfu !== conn || !vs().channelId) return;
          if (why === 'lost') { toast('Lost the connection to the voice server.', 'warning'); leaveVoice(); }
          else leaveVoice({ notifyServer: false });   // (joined from another place, or removed by the server: it already knows)
        },
      },
    });
  } catch (e) {
    console.warn('[sfu] could not connect', e);
    return false;
  }
  sfu = conn;
  const mic = stageRole === 'listener' ? null : sendTrack();
  if (mic) sfu.publish('mic', mic, sfuOptions('mic'));
  if (cameraStream) sfu.publish('camera', cameraStream.getVideoTracks()[0], sfuOptions('camera'));
  if (screenStream) {
    sfu.publish('screen', screenStream.getVideoTracks()[0], sfuOptions('screen'));
    const sa = screenStream.getAudioTracks()[0];
    if (sa) sfu.publish('screenAudio', sa, sfuOptions('screenAudio'));
  }
  return true;
}
function stopSfu() {
  const c = sfu; sfu = null;
  if (c) c.disconnect();
}

// ---------------------------------------------------------------- stage channels
const onStage = () => !!vs().channelId && appStore.get().channels[vs().channelId]?.type === 13;
/** Do I need a connection with this person? On a stage: only if one of us is a speaker. `states` is who is on the stage (userId → voice state). */
function wantPeer(uid, states = appStore.get().voiceStates) {
  if (!stageRole) return true;
  const theirs = states[uid];
  return stageRole === 'speaker' || (!!theirs && !theirs.suppress);
}
/** Open the connections that are now needed and close those that are not (someone was invited to speak, or went back to the audience). */
function reconcilePeers(states = appStore.get().voiceStates) {
  if (!stageRole || vs().status !== 'connected') return;
  for (const [uid, st] of Object.entries(states)) {
    if (uid === me() || st.channelId !== vs().channelId) continue;
    const want = wantPeer(uid, states);
    if (want && !peers.has(uid)) createPeer(uid);
    else if (!want && peers.has(uid)) closePeer(uid);
  }
  for (const uid of [...peers.keys()]) if (states[uid]?.channelId !== vs().channelId) closePeer(uid);
}
async function becomeSpeaker() {
  stageRole = 'speaker';
  if (!audio) await setupAudio({ mic: false });
  if (!audio.micStream) await attachMic();
  voiceStore.set({ selfMute: true });   // (the server starts a new speaker muted: they unmute themselves when ready)
  reconcilePeers();
  const t = sendTrack();
  if (t) for (const p of peers.values()) if (!p.senders.audio) { try { p.senders.audio = p.pc.addTrack(t, audio.dest.stream); preferRedundancy(p.pc, p.senders.audio); } catch (e) { console.warn(e); } }
  tuneAllPeers();
  play('unmute');
  toast('You are on stage. Unmute when you are ready to speak.', 'info', 5000);
}
function becomeListener() {
  stageRole = 'listener';
  stopCamera(false); stopScreen(false);   // (the server already cleared them)
  for (const p of peers.values()) {
    if (!p.senders.audio) continue;
    try { p.pc.removeTrack(p.senders.audio); } catch { /* it was never sent */ }
    delete p.senders.audio;
  }
  detachMic();
  voiceStore.set({ selfMute: true, pttActive: false });
  reconcilePeers();
}
/** Ask the server to change who is speaking: { action: 'hand', raised } | 'speak' | 'audience' (with userId) | 'end'. */
export async function stageCommand(action, extra = {}) {
  const r = await request('voice_stage', { action, ...extra });
  if (r?.error) toast(r.error, 'error');
  return !r?.error;
}

export async function joinVoice(channelId) {
  const s = vs();
  if (s.channelId === channelId && s.status !== 'disconnected') return true;
  if (s.channelId) await leaveVoice({ silent: true });
  const ch = appStore.get().channels[channelId];
  const stage = ch?.type === 13;
  voiceStore.set({ channelId, guildId: ch?.guildId || null, status: 'connecting', peers: {}, speaking: {}, ping: null });
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Voice needs a secure connection (HTTPS or localhost) and a modern browser.', 'error');
    voiceStore.set({ channelId: null, status: 'disconnected' });
    return false;
  }
  // On a stage nobody is asked for a microphone until they are a speaker.
  if (!audio) await setupAudio({ mic: !stage });
  else await audio.ctx.resume().catch(() => {});
  const res = await request('voice_join', { channelId, selfMute: vs().selfMute || vs().noMic, selfDeaf: vs().selfDeaf, sfu: true });   // (sfu: this page knows how to join a big call)
  if (res.error || !res.ok) {
    toast(res.error || 'Could not connect to voice.', 'error');
    voiceStore.set({ channelId: null, guildId: null, status: 'disconnected' });
    teardownAudio();
    return false;
  }
  if (res.iceServers) appStore.set({ iceServers: res.iceServers });
  const byId = Object.fromEntries(res.participants.map((p) => [p.userId, p]));
  stageRole = stage ? (byId[me()]?.suppress === false ? 'speaker' : 'listener') : null;
  if (res.sfu && !(await startSfu(res.sfu))) {
    // (the server has us in the channel already, so it has to be told we are not coming)
    send('voice_leave', {});
    toast('Could not connect to this server’s voice system. Check your connection and try again.', 'error');
    voiceStore.set({ channelId: null, guildId: null, status: 'disconnected' });
    teardownAudio();
    return false;
  }
  if (stageRole === 'speaker' && !audio.micStream) await attachMic();
  voiceStore.set({ status: 'connected', joinedAt: Date.now(), ...(stage ? { selfMute: true } : null) });
  if (stageRole === 'speaker') toast('You are on stage. Unmute when you are ready to speak.', 'info', 5000);
  rejoinChannel = channelId;
  startLoop();
  startStats();
  for (const p of res.participants) if (p.userId !== me() && wantPeer(p.userId, byId)) createPeer(p.userId);
  playVoiceSound(me(), 'join', vs().guildId);
  return true;
}

function teardownAudio() {
  stopLoop();
  clearInterval(statsTimer);
  statsPrev.clear();
  if (audio) {
    audio.micStream?.getTracks().forEach((t) => t.stop());
    try { audio.ctx.close(); } catch { /* ignore */ }
    audio = null;
  }
}

export async function leaveVoice({ silent = false, notifyServer = true } = {}) {
  const s = vs();
  if (!s.channelId) return;
  if (notifyServer) send('voice_leave', {});
  stopSfu();
  for (const uid of [...peers.keys()]) closePeer(uid);
  stopCamera(false); stopScreen(false);
  teardownAudio();
  rejoinChannel = null;
  stopRinging();
  stageRole = null;
  voiceStore.set({ channelId: null, guildId: null, status: 'disconnected', peers: {}, speaking: {}, ping: null, video: false, screen: false, localCamera: null, localScreen: null, joinedAt: null, link: null });
  if (!silent) play('disconnect');
}

export function toggleMute() {
  const s = vs();
  if (s.noMic) { reacquireMic().then(() => { if (!vs().noMic) { voiceStore.set({ selfMute: false }); pushState(); } }); return; }
  const selfMute = !s.selfMute;
  // Unmuting while deafened also undeafens (like the original).
  const patch = { selfMute };
  if (!selfMute && s.selfDeaf) patch.selfDeaf = false;
  voiceStore.set(patch);
  play(selfMute ? 'mute' : 'unmute');
  pushState(); applyAllOutputs();
}
export function toggleDeafen() {
  const s = vs();
  const selfDeaf = !s.selfDeaf;
  voiceStore.set({ selfDeaf, selfMute: selfDeaf ? true : (s.mutedBeforeDeaf ?? false), mutedBeforeDeaf: selfDeaf ? s.selfMute : undefined });
  play(selfDeaf ? 'deafen' : 'undeafen');
  pushState(); applyAllOutputs();
}

let pttReleaseTimer = null;
export function setPushToTalk(active) {
  const l = getLocal();
  if (l.inputMode !== 'ptt') return;
  clearTimeout(pttReleaseTimer);
  const apply = () => {
    if (vs().pttActive === active) return;
    voiceStore.set({ pttActive: active });
    if (vs().channelId) play('ptt');
  };
  if (!active && l.pttReleaseDelay > 0) pttReleaseTimer = setTimeout(apply, l.pttReleaseDelay);
  else apply();
}

function addTrackToPeers(kind, track, stream) {
  if (sfu) { sfu.publish(kind, track, sfuOptions(kind)); return; }
  for (const p of peers.values()) {
    try { p.senders[kind] = p.pc.addTrack(track, stream); } catch (e) { console.warn(e); }
  }
}
function removeTrackFromPeers(kind) {
  if (sfu) { sfu.unpublish(kind); return; }
  for (const p of peers.values()) {
    if (p.senders[kind]) { try { p.pc.removeTrack(p.senders[kind]); } catch { /* ignore */ } delete p.senders[kind]; }
  }
}

export async function startCamera() {
  if (!vs().channelId) return;
  const l = getLocal();
  const cq = cameraQualityOf(l.cameraQuality);
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: l.videoDeviceId && l.videoDeviceId !== 'default' ? { exact: l.videoDeviceId } : undefined, width: { ideal: cq.width }, height: { ideal: cq.height }, frameRate: { ideal: cq.fps } },
    });
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Camera access was blocked by your browser.' : 'No camera found.', 'error');
    return;
  }
  const track = cameraStream.getVideoTracks()[0];
  try { track.contentHint = 'motion'; } catch { /* ignore */ }   // keep the frame rate smooth rather than trading it for sharpness
  track.onended = () => stopCamera();
  addTrackToPeers('camera', track, cameraStream);
  voiceStore.set({ video: true, localCamera: cameraStream });
  pushState();
}
export function stopCamera(push = true) {
  if (!cameraStream) return;
  removeTrackFromPeers('camera');
  cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  voiceStore.set({ video: false, localCamera: null });
  if (push) pushState();
}
export function toggleCamera() { return cameraStream ? stopCamera() : startCamera(); }

let screenStarting = false;
/** `from`: the window whose click asked for it (the call's pop-out window). A browser only lets the clicked window ask. */
export async function startScreen(from) {
  if (!vs().channelId || screenStream || screenStarting) return;
  screenStarting = true;
  try { await beginScreenShare(from); } finally { screenStarting = false; }
}
async function beginScreenShare(from) {
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('Screen sharing isn’t supported on this device.', 'error'); return; }
  const desktop = typeof window !== 'undefined' ? window.nullchatDesktop : null;
  let constraints;
  let desktopChoice = null;
  if (typeof desktop?.screenSources === 'function') {
    // Desktop app: pick a screen or window in NullChat's own picker, then capture exactly that.
    const { pickScreenSource, qualityOf } = await import('../components/ScreenSharePicker.jsx');
    const choice = await pickScreenSource(from);
    if (!choice) return;
    desktopChoice = choice;
    if (!vs().channelId || screenStream) return; // left the call (or started another share) meanwhile
    let res = null;
    try { res = await desktop.screenChoose(choice.id, choice.audio); } catch { /* handled below */ }
    if (!res?.ok) { toast(res?.error === 'gone' ? 'That window was closed. Pick another one.' : 'Could not start screen sharing.', 'error'); return; }
    const q = qualityOf(choice.quality);
    screenState = { quality: q.value, fps: q.fps };
    constraints = { video: { frameRate: { ideal: q.fps, max: q.fps }, width: { ideal: q.width }, height: { ideal: q.height } }, audio: !!choice.audio };
  } else {
    // Browser: the browser shows its own picker. Hint it to offer screens and windows rather than this tab.
    screenState = { quality: 'standard', fps: 60 };
    constraints = {
      video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 2560 }, height: { ideal: 1440 }, displaySurface: 'monitor' },
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include', monitorTypeSurfaces: 'include',
    };
  }
  try {
    // (asked from the window that was clicked: that is the one a browser, and the desktop app, lets ask)
    //  A desktop app from before its call window could capture (no callWindowShare) asks from the main window, as it always did.)
    const mayAsk = !desktop || !!desktop.callWindowShare;
    const theirs = (mayAsk && from && !from.closed && from.navigator?.mediaDevices?.getDisplayMedia) ? from.navigator.mediaDevices : null;
    try { screenStream = await (theirs || navigator.mediaDevices).getDisplayMedia(constraints); }
    catch (e) {
      if (!theirs || !desktop) throw e;
      // the desktop app refused the call window: hand the choice over again and let the main window ask
      if (desktopChoice) { try { await desktop.screenChoose(desktopChoice.id, desktopChoice.audio); } catch { /* handled by the next line failing */ } }
      screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    }
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Could not start screen sharing.', 'error');
    return;
  }
  const v = screenStream.getVideoTracks()[0];
  try { v.contentHint = 'detail'; } catch { /* ignore */ }
  v.onended = () => stopScreen();
  addTrackToPeers('screen', v, screenStream);
  const a = screenStream.getAudioTracks()[0];
  if (a) addTrackToPeers('screenAudio', a, screenStream);
  voiceStore.set({ screen: true, localScreen: screenStream });
  play('stream');
  pushState();
  if (!desktop && !installEnv().mobile) browserShareTip();
}

/** Once: a browser always uses its own screen picker. The desktop app has one inside NullChat. */
function browserShareTip() {
  try {
    if (localStorage.getItem('nullchat.shareTipShown')) return;
    localStorage.setItem('nullchat.shareTipShown', '1');
  } catch { return; }
  toast('Tip: in the NullChat desktop app you pick the screen or window inside NullChat itself. Get it from the download button in the server list.', 'info', 9000);
}
export function stopScreen(push = true) {
  if (!screenStream) return;
  removeTrackFromPeers('screen');
  removeTrackFromPeers('screenAudio');
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  voiceStore.set({ screen: false, localScreen: null });
  if (push) pushState();
}
export function toggleScreen(from) { return screenStream ? stopScreen() : startScreen(from); }

/** Change the quality of the screen share that is already running (no need to stop and restart it). */
const QUALITY_BITRATE = { smooth: 2_500_000, standard: 8_000_000, sharp: 12_000_000 };
export async function setScreenQuality(quality) {
  const track = screenStream?.getVideoTracks()[0];
  if (!track) return false;
  const { qualityOf } = await import('../components/ScreenSharePicker.jsx');
  const q = qualityOf(quality);
  try { await track.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } }); } catch { /* the source may not allow it; the bitrate change still helps */ }
  screenState = { quality: q.value, fps: q.fps };
  tuneAllPeers();
  if (sfu) sfu.update('screen', sfuOptions('screen'));
  try { const prefs = JSON.parse(localStorage.getItem('nullchat.screenshare') || '{}'); localStorage.setItem('nullchat.screenshare', JSON.stringify({ ...prefs, quality: q.value })); } catch { /* ignore */ }
  return true;
}

export async function switchCamera(deviceId) {
  if (!cameraStream) return;
  try {
    const cq = cameraQualityOf(getLocal().cameraQuality);
    const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined, width: { ideal: cq.width }, height: { ideal: cq.height }, frameRate: { ideal: cq.fps } } });
    const track = ns.getVideoTracks()[0];
    try { track.contentHint = 'motion'; } catch { /* ignore */ }
    if (sfu) await sfu.replace('camera', track);
    else for (const p of peers.values()) await p.senders.camera?.replaceTrack(track);
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream.removeTrack(cameraStream.getVideoTracks()[0]);
    cameraStream.addTrack(track);
    track.onended = () => stopCamera();
    voiceStore.set({ localCamera: new MediaStream(cameraStream.getTracks()) });
  } catch { toast('Could not switch camera.', 'error'); }
}

export function setUserVolume(uid, volume) {
  const l = getLocal();
  import('./settings.js').then(({ setLocal }) => setLocal({ userVolumes: { ...l.userVolumes, [uid]: volume } }));
}
export function setLocalMute(uid, muted) {
  const l = getLocal();
  import('./settings.js').then(({ setLocal }) => setLocal({ localMutes: { ...l.localMutes, [uid]: muted } }));
}

// ---------------------------------------------------------------- gateway wiring
on('VOICE_SIGNAL', handleSignal);
on('VOICE_STATE_UPDATE', (d) => {
  const s = vs();
  if (!s.channelId) return;
  if (stageRole && s.status === 'connected' && d.channelId === s.channelId) {
    // On a stage the only thing that changes who I connect to is who is a speaker.
    if (d.userId === me()) {
      const now = d.suppress ? 'listener' : 'speaker';
      if (now !== stageRole) { if (now === 'speaker') becomeSpeaker(); else becomeListener(); }
      applyAllOutputs();
    } else {
      const before = peers.has(d.userId);
      reconcilePeers();
      if (!before && peers.has(d.userId)) playVoiceSound(d.userId, 'join', s.guildId);
      applyOutput(d.userId);
    }
    return;
  }
  if (d.userId === me()) {
    if (!d.channelId && d.previousChannelId === s.channelId && s.status === 'connected') {
      // Server dropped us (e.g. joined from another tab).
      leaveVoice({ notifyServer: false });
    }
    applyAllOutputs();
    return;
  }
  if (d.channelId === s.channelId) {
    if (!peers.has(d.userId) && !d.previousChannelId) playVoiceSound(d.userId, 'join', s.guildId);
    applyOutput(d.userId);
  } else if (peers.has(d.userId)) {
    closePeer(d.userId);
    playVoiceSound(d.userId, 'leave', s.guildId);
  }
});
on('VOICE_FORCE_DISCONNECT', (d) => { toast(d.reason || 'You were disconnected from voice.', 'warning'); leaveVoice({ notifyServer: false }); });
on('VOICE_FORCE_MOVE', (d) => { joinVoice(d.channelId); });
on('DISCONNECTED', () => {
  if (!vs().channelId) return;
  stopSfu();
  for (const uid of [...peers.keys()]) closePeer(uid);
  voiceStore.set({ status: 'reconnecting' });
});
on('READY', () => {
  const ch = rejoinChannel;
  if (ch && vs().status === 'reconnecting') {
    voiceStore.set({ channelId: null, status: 'disconnected' });
    joinVoice(ch);
  }
});

// Keep output devices in sync when the user changes settings.
export function refreshOutputs() { applyAllOutputs(); }

// Ringing for calls in DMs
let ringingFor = null;
appStore.subscribe(() => {
  const s = appStore.get();
  const myId = s.me?.id;
  if (!myId) return;
  const incoming = Object.values(s.calls).find((c) => c.ringing.includes(myId) && vs().channelId !== c.channelId);
  const outgoing = vs().channelId && s.calls[vs().channelId] && s.calls[vs().channelId].ringing.length > 0 &&
    Object.values(s.voiceStates).filter((v) => v.channelId === vs().channelId).length === 1;
  const key = incoming ? `in:${incoming.channelId}` : outgoing ? `out:${vs().channelId}` : null;
  if (key !== ringingFor) {
    ringingFor = key;
    if (!key) stopRinging();
    else if (s.presences[myId]?.status !== 'dnd') startRinging(!incoming);
  }
});
