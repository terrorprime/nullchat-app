// Mood rooms: the background sound of a voice channel, made here with WebAudio (no sound files). The server only says WHICH
// sound a room has (shared/moods.js); every person's app plays it for itself, quietly, under the conversation. Nothing goes into
// anyone's microphone, and each person has their own volume and off switch (kept on this device).
//
// Each sound is built from noise (white / pink / brown), a few filters and slow changes over time, plus small events placed at
// random (raindrops, crackles, cricket chirps). `startAmbience` wires one up and returns how to stop it.
import { store as appStore } from './state.js';
import { voiceStore } from './voice.js';
import { getLocal, setLocal, onLocalChange } from './settings.js';
import { createStore } from './store.js';
import { outputSink } from './devices.js';
import { MOOD_IDS } from '../../../shared/moods.js';

export const ambienceStore = createStore({ playing: null });   // the sound that is playing on this device right now (an id), or null

let ctx = null;
let master = null;        // everything goes through this (the person's volume)
let current = null;       // { id, out, stop }
const buffers = {};

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Four seconds of noise that loops without a click. kind: white | pink | brown */
function noiseBuffer(kind) {
  if (buffers[kind]) return buffers[kind];
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'pink') {   // (Paul Kellet's filter)
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
  }
  // the end is blended into the start, so the loop point cannot be heard
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) { const t = i / fade; d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t; }
  buffers[kind] = buf;
  return buf;
}

/** The parts every sound is made from. Everything made through `kit` is stopped together. */
function makeKit(out) {
  const nodes = [];
  const timers = [];
  const kit = {
    noise(kind, gain = 1) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(kind); src.loop = true;
      src.loopStart = 0; src.loopEnd = src.buffer.duration - 0.05;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(g); src.start(ctx.currentTime, Math.random() * 3);
      nodes.push(src);
      return g;
    },
    filter(type, freq, q = 0.7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; },
    gain(v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; },
    osc(type, freq) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.start(); nodes.push(o); return o; },
    /** A slow wobble added to a parameter: `param` moves by ±depth around where it is, once every `seconds`. */
    lfo(param, seconds, depth) { const o = kit.osc('sine', 1 / seconds); const g = kit.gain(depth); o.connect(g); g.connect(param); return o; },
    chain(...list) { for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]); return list[list.length - 1]; },
    /** Calls `place(when)` for moments spread at random, about `perSecond` of them. Placed a little ahead, so a background tab keeps going. */
    scatter(perSecond, place) {
      let next = ctx.currentTime + 0.2;
      const tick = () => {
        const until = ctx.currentTime + 1.6;
        if (next < ctx.currentTime) next = ctx.currentTime + 0.05;   // (the tab slept: do not make up for lost time in one burst)
        let n = 0;
        while (next < until && n++ < 60) { place(next); next += -Math.log(1 - Math.random()) / perSecond; }
      };
      tick();
      timers.push(setInterval(tick, 500));
    },
    /** A short burst of noise through a filter: a raindrop, a crackle. */
    burst(when, { kind = 'white', dur = 0.03, type = 'bandpass', freq = 3000, q = 1, vol = 0.2 }) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(kind);
      const f = kit.filter(type, freq, q);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(vol, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(when, Math.random() * 3, dur + 0.02);
    },
    out,
    stop() { timers.forEach(clearInterval); nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } try { n.disconnect(); } catch { /* ignore */ } }); },
  };
  return kit;
}

const BUILD = {
  rain(k) {
    k.chain(k.noise('pink', 0.55), k.filter('highpass', 500), k.filter('lowpass', 7500), k.out);          // the wash of rain
    k.chain(k.noise('brown', 0.35), k.filter('lowpass', 320), k.out);                                      // the low rumble under it
    k.scatter(14, (t) => k.burst(t, { dur: 0.015 + Math.random() * 0.03, freq: 2200 + Math.random() * 4200, q: 2.5, vol: 0.03 + Math.random() * 0.07 }));   // drops on glass
  },
  fireplace(k) {
    const roar = k.chain(k.noise('brown', 0.75), k.filter('lowpass', 280), k.gain(0.8));
    roar.connect(k.out); k.lfo(roar.gain, 5.3, 0.18); k.lfo(roar.gain, 1.7, 0.08);                         // the fire breathing
    k.chain(k.noise('pink', 0.12), k.filter('bandpass', 900, 0.6), k.out);
    k.scatter(7, (t) => k.burst(t, { dur: 0.004 + Math.random() * 0.012, type: 'highpass', freq: 1400 + Math.random() * 2500, vol: 0.05 + Math.random() * 0.16 }));   // crackles
    k.scatter(0.35, (t) => k.burst(t, { kind: 'brown', dur: 0.05 + Math.random() * 0.05, type: 'bandpass', freq: 380 + Math.random() * 300, q: 1.5, vol: 0.45 }));    // a log popping
  },
  ocean(k) {
    const wave = k.chain(k.noise('pink', 0.9), k.filter('lowpass', 900), k.gain(0.5));
    wave.connect(k.out); k.lfo(wave.gain, 9.5, 0.36); k.lfo(wave.gain, 23, 0.1);                          // waves coming in and going out
    const foam = k.chain(k.noise('white', 0.25), k.filter('highpass', 2600), k.gain(0.22));
    foam.connect(k.out); k.lfo(foam.gain, 9.5, 0.2);                                                       // the hiss as one runs up the sand
    k.chain(k.noise('brown', 0.4), k.filter('lowpass', 160), k.out);
  },
  wind(k) {
    const band = k.filter('bandpass', 520, 1.1);
    const g = k.chain(k.noise('pink', 1), band, k.gain(0.55));
    g.connect(k.out);
    k.lfo(band.frequency, 11, 240); k.lfo(band.frequency, 4.3, 110);                                       // gusts: the pitch of the wind moves
    k.lfo(g.gain, 7.1, 0.25); k.lfo(g.gain, 17, 0.15);
    k.chain(k.noise('brown', 0.3), k.filter('lowpass', 200), k.out);
  },
  night(k) {
    k.chain(k.noise('brown', 0.16), k.filter('lowpass', 500), k.out);                                      // still air
    k.chain(k.noise('pink', 0.035), k.filter('highpass', 3000), k.out);
    // crickets: each is a high tone switched on in quick groups of three; a few of them, each with its own pitch and rhythm
    for (const [freq, every, pan] of [[4300, 0.62, -0.6], [4750, 0.81, 0.5], [3950, 1.13, 0.1]]) {
      const o = k.osc('sine', freq);
      const g = k.gain(0);
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : k.gain(1);
      if (p.pan) p.pan.value = pan;
      k.chain(o, g, p, k.out);
      let next = ctx.currentTime + Math.random();
      k.scatter(1 / every, () => {
        const t = Math.max(next, ctx.currentTime + 0.05); next = t + every * (0.9 + Math.random() * 0.25);
        for (let i = 0; i < 3; i++) {
          const a = t + i * 0.042;
          g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(0.045, a + 0.006); g.gain.linearRampToValueAtTime(0, a + 0.028);
        }
      });
    }
  },
  space(k) {
    for (const [f, v, wob] of [[55, 0.22, 13], [55.6, 0.2, 17], [82.4, 0.1, 9], [110.3, 0.06, 21]]) {
      const g = k.chain(k.osc('sine', f), k.gain(v));
      g.connect(k.out); k.lfo(g.gain, wob, v * 0.5);                                                       // tones that slowly swell against each other
    }
    k.chain(k.noise('brown', 0.3), k.filter('lowpass', 140), k.out);
  },
};

// How much each sound is turned up or down so that they are all about as loud as each other (measured at the output).
const TRIM = { rain: 1, fireplace: 0.8, ocean: 0.9, wind: 1.6, night: 2, space: 0.4 };

function stopCurrent(fade = 1.2) {
  if (!current) return;
  const c = current; current = null;
  const now = ctx.currentTime;
  c.out.gain.cancelScheduledValues(now);
  c.out.gain.setValueAtTime(c.out.gain.value, now);
  c.out.gain.linearRampToValueAtTime(0, now + fade);
  setTimeout(() => { c.kit.stop(); try { c.out.disconnect(); } catch { /* ignore */ } }, fade * 1000 + 100);
}

/** Play this sound (fading from whatever played before), or stop with null. */
export function playAmbience(id) {
  if ((current?.id || null) === (id || null)) return;
  if (!id || !MOOD_IDS.includes(id) || !BUILD[id]) { if (ctx) stopCurrent(); ambienceStore.set({ playing: null }); return; }
  if (!audio()) return;
  stopCurrent();
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(master);
  const kit = makeKit(out);
  try { BUILD[id](kit); } catch { kit.stop(); return; }
  out.gain.setValueAtTime(0, ctx.currentTime);
  out.gain.linearRampToValueAtTime(TRIM[id] || 1, ctx.currentTime + 2.5);
  current = { id, out, kit };
  ambienceStore.set({ playing: id });
}

/** The person's own volume (0–100) and whether they are deafened: applied smoothly. */
function applyVolume(volume, silent) {
  if (!ctx) return;
  const target = silent ? 0 : Math.max(0, Math.min(1, volume / 100)) * 0.6;   // (even at 100% it stays under people's voices)
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(target, ctx.currentTime, 0.15);
}

export function setMoodVolume(v) { setLocal({ moodVolume: Math.round(v) }); }
export function setMoodOff(off) { setLocal({ moodOff: !!off }); }

/** Keeps the sound in step with where the person is: connected to a voice channel that has a sound, not deafened, not switched off. */
function sync() {
  const v = voiceStore.get();
  const l = getLocal();
  const ch = v.channelId && v.status !== 'disconnected' ? appStore.get().channels[v.channelId] : null;
  const want = ch && ch.mood && !l.moodOff && v.status === 'connected' ? ch.mood : null;
  if (want || ctx) playAmbience(want);
  if (ctx) {
    applyVolume(l.moodVolume ?? 35, !!v.selfDeaf);
    const sink = outputSink();   // (the chosen speaker when it is connected, otherwise the system's)
    if (ctx.setSinkId && sync.sink !== sink) { sync.sink = sink; ctx.setSinkId(sink).catch(() => {}); }
  }
}

let started = false;
export function startAmbience() {
  if (started) return;
  started = true;
  let lastMood; let lastKey;
  voiceStore.subscribe(() => { const v = voiceStore.get(); const key = `${v.channelId}|${v.status}|${v.selfDeaf}`; if (key !== lastKey) { lastKey = key; sync(); } });
  appStore.subscribe(() => { const id = voiceStore.get().channelId; const mood = id ? appStore.get().channels[id]?.mood || null : null; if (mood !== lastMood) { lastMood = mood; sync(); } });
  onLocalChange(sync);
}

/** How loud the room sound is right now on this device (0 = silent), measured at the output. For checking that a sound really plays. */
let meter = null;
export function ambienceLevel() {
  if (!ctx) return 0;
  if (!meter) { meter = ctx.createAnalyser(); meter.fftSize = 2048; master.connect(meter); }
  const d = new Float32Array(meter.fftSize);
  meter.getFloatTimeDomainData(d);
  let sum = 0, peak = 0;
  for (const x of d) { sum += x * x; if (Math.abs(x) > peak) peak = Math.abs(x); }
  return { rms: Math.sqrt(sum / d.length), peak };
}
if (typeof window !== 'undefined') window.nullchatAmbienceLevel = ambienceLevel;
