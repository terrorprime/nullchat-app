// UI sounds synthesized with WebAudio — no audio assets required.
let ctx = null;
let enabled = true;
let disabledSounds = {};
let outputDeviceId = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function configureSounds({ enabled: en, disabled, deviceId }) {
  if (en !== undefined) enabled = en;
  if (disabled) disabledSounds = disabled;
  if (deviceId !== undefined) {
    outputDeviceId = deviceId;
    const c = ac();
    if (c && c.setSinkId && deviceId) c.setSinkId(deviceId === 'default' ? '' : deviceId).catch(() => {});
  }
}

function tone(freqs, { dur = 0.12, gap = 0.02, type = 'sine', vol = 0.12, attack = 0.005 } = {}) {
  const c = ac();
  if (!c) return;
  let t = c.currentTime + 0.01;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur + gap;
  }
}

const SOUNDS = {
  message: () => tone([880, 1320], { dur: 0.09, vol: 0.08 }),
  mention: () => tone([988, 1319, 1568], { dur: 0.09, vol: 0.1 }),
  join: () => tone([523, 784], { dur: 0.12, vol: 0.1, type: 'triangle' }),
  leave: () => tone([784, 523], { dur: 0.12, vol: 0.1, type: 'triangle' }),
  mute: () => tone([660, 440], { dur: 0.07, vol: 0.08, type: 'square' }),
  unmute: () => tone([440, 660], { dur: 0.07, vol: 0.08, type: 'square' }),
  deafen: () => tone([520, 390, 260], { dur: 0.06, vol: 0.08, type: 'square' }),
  undeafen: () => tone([260, 390, 520], { dur: 0.06, vol: 0.08, type: 'square' }),
  disconnect: () => tone([600, 400, 250], { dur: 0.1, vol: 0.1, type: 'sawtooth' }),
  ptt: () => tone([700], { dur: 0.04, vol: 0.05 }),
  stream: () => tone([523, 659, 784], { dur: 0.08, vol: 0.08, type: 'triangle' }),
};

export function play(name) {
  if (!enabled || disabledSounds[name]) return;
  try { SOUNDS[name]?.(); } catch { /* ignore */ }
}

// A recorded sound (somebody's own join or leave sound). Decoded once and kept; played through the same output as the built-in
// sounds, never longer than `maxSeconds`. `name` is the built-in sound it stands in for: when that one is switched off, or the
// recording can't be fetched or decoded, the answer is the built-in sound (or silence), never an error.
const clips = new Map();   // url -> Promise<AudioBuffer>
const CLIP_VOLUME = 0.6;
function loadClip(url) {
  if (!clips.has(url)) {
    const c = ac();
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); }).then((b) => c.decodeAudioData(b));
    p.catch(() => clips.delete(url));
    clips.set(url, p);
    if (clips.size > 40) clips.delete(clips.keys().next().value);
  }
  return clips.get(url);
}
export async function playClip(url, name, { maxSeconds = 5, force = false } = {}) {
  if (!force && (!enabled || disabledSounds[name])) return false;
  const c = ac();
  if (!c || !url) { if (!force) play(name); return false; }
  try {
    const buf = await loadClip(url);
    const src = c.createBufferSource();
    const g = c.createGain();
    const len = Math.min(buf.duration, maxSeconds);
    src.buffer = buf;
    g.gain.setValueAtTime(CLIP_VOLUME, c.currentTime);
    g.gain.setValueAtTime(CLIP_VOLUME, c.currentTime + Math.max(0, len - 0.05));
    g.gain.linearRampToValueAtTime(0.0001, c.currentTime + len);
    src.connect(g).connect(c.destination);
    src.start(0, 0, len);
    return true;
  } catch {
    if (!force) play(name);
    return false;
  }
}

// Looping ringtone for incoming / outgoing calls.
let ringTimer = null;
export function startRinging(outgoing = false) {
  stopRinging();
  if (!enabled || disabledSounds.ring) return;
  const ring = () => outgoing ? tone([440, 440], { dur: 0.35, gap: 0.25, vol: 0.06 }) : tone([784, 988, 784, 988], { dur: 0.13, gap: 0.03, vol: 0.09, type: 'triangle' });
  ring();
  ringTimer = setInterval(ring, outgoing ? 2500 : 1800);
}
export function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

export function unlockAudio() { ac(); }
export { outputDeviceId };
