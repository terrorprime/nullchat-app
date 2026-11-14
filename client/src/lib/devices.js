// Microphones, speakers and cameras: finding the one that was chosen, and opening a microphone that actually works.
//
// A saved choice is an id the browser made up, and it does not always survive: Safari hands out new ids on every visit, a
// Bluetooth headset can come back with a different one, and a USB microphone simply may not be plugged in today. So the
// device's name is saved next to its id and used to find it again; when it really is not there, the default device is used
// (the choice is kept, so it comes back when the device does).
//
// Opening is tried several ways, because not every microphone accepts every request. Audio interfaces with many inputs,
// "aggregate" and virtual devices on a Mac, and some Bluetooth headsets refuse the extras NullChat asks for (one channel,
// 48 kHz, low delay) or the browser's echo cancelling; asked plainly, they open.
import { getLocal, setLocal } from './settings.js';

const KEYS = {
  audioinput: ['inputDeviceId', 'inputDeviceLabel'],
  audiooutput: ['outputDeviceId', 'outputDeviceLabel'],
  videoinput: ['videoDeviceId', 'videoDeviceLabel'],
};
let known = [];   // what the browser listed last

export async function listDevices() {
  try { known = (await navigator.mediaDevices.enumerateDevices()) || []; } catch { known = []; }
  return known;
}
export const knownDevices = () => known;
const real = (d) => !!d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
/** A device's name without what changes between listings ("Default - " in front, a USB id or "(Bluetooth)" behind). */
export const deviceName = (label) => String(label || '').replace(/^(default|communications)\s*-\s*/i, '').replace(/\s*\((?:[0-9a-f]{4}:[0-9a-f]{4}|bluetooth|built-in|usb|virtual)\)\s*$/i, '').trim();
const same = (a, b) => !!deviceName(a) && deviceName(a).toLowerCase() === deviceName(b).toLowerCase();

/** Whether this browser can send sound to a chosen speaker at all (Safari and older Firefox always use the system's). */
export const canChooseOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/**
 * Which device to use for a saved choice: { id, present, label }.
 *   id        'default', or the id to open now (found again by name when its id changed)
 *   present   true: it is connected · false: it is not (id is 'default') · null: cannot tell yet (no permission to see names)
 */
export function resolveDevice(kind, list = known) {
  const [idKey, labelKey] = KEYS[kind];
  const l = getLocal();
  const id = l[idKey];
  if (!id || id === 'default') return { id: 'default', present: true, label: '' };
  const of = list.filter((d) => d.kind === kind);
  const exact = of.find((d) => d.deviceId === id);
  if (exact) {
    if (exact.label && !same(exact.label, l[labelKey]) ) setLocal({ [labelKey]: deviceName(exact.label) });
    return { id, present: true, label: deviceName(exact.label) || l[labelKey] || '' };
  }
  const byName = l[labelKey] ? of.find((d) => real(d) && same(d.label, l[labelKey])) : null;
  if (byName) { setLocal({ [idKey]: byName.deviceId }); return { id: byName.deviceId, present: true, label: l[labelKey] }; }
  // (before permission is given the browser lists devices without names or ids: the saved id is the best there is)
  if (!of.length || of.every((d) => !d.label)) return { id, present: null, label: l[labelKey] || '' };
  return { id: 'default', present: false, label: l[labelKey] || '' };
}

/** Save a choice made in a menu: the id, and the name to find it by later. */
export function chooseDevice(kind, id, list = known) {
  const [idKey, labelKey] = KEYS[kind];
  const d = list.find((x) => x.kind === kind && x.deviceId === id);
  setLocal({ [idKey]: id || 'default', [labelKey]: id && id !== 'default' ? deviceName(d?.label) || getLocal()[labelKey] || '' : '' });
}

/** The speaker to hand to setSinkId ('' is the system's default). */
export function outputSink() {
  const r = resolveDevice('audiooutput');
  return r.id === 'default' ? '' : r.id;
}

/** What the system's own default microphone is called right now, where the browser says (Chrome, Edge, the desktop app). */
export function defaultInputName(list = known) {
  return deviceName(list.find((d) => d.kind === 'audioinput' && d.deviceId === 'default')?.label);
}

/**
 * Open the microphone. Resolves to { stream, fellBack, label, plain }:
 *   fellBack  the chosen microphone could not be used and the default one was opened instead
 *   label     the chosen one's name (for telling the person)
 *   plain     it only opened without NullChat's extras
 * Rejects only when no microphone opens at all, or the person or system said no (NotAllowedError).
 */
export async function openMicrophone({ gum = (c) => navigator.mediaDevices.getUserMedia(c) } = {}) {
  const l = getLocal();
  const r = resolveDevice('audioinput', await listDevices());
  const proc = { echoCancellation: !!l.echoCancellation, noiseSuppression: !!l.noiseSuppression, autoGainControl: !!l.autoGainControl };
  // (one channel at the voice codec's own rate, with as little delay as the device allows)
  // (voiceIsolation: where the system has its own voice clean-up (recent macOS, Windows, ChromeOS) the browser uses it;
  //  browsers that do not know the word ignore it)
  const full = { ...proc, voiceIsolation: { ideal: !!l.noiseSuppression }, channelCount: 1, sampleRate: { ideal: 48000 }, latency: { ideal: 0.01 } };
  const tries = [];
  if (r.id !== 'default') for (const c of [full, proc, {}]) tries.push({ chosen: true, plain: c !== full, audio: { deviceId: { exact: r.id }, ...c } });
  for (const c of [full, proc, null]) tries.push({ chosen: false, plain: c !== full, audio: c || true });
  let last = null;
  for (const t of tries) {
    try {
      const stream = await gum({ audio: t.audio, video: false });
      if (!stream?.getAudioTracks?.().length) { stream?.getTracks?.().forEach((x) => x.stop()); throw Object.assign(new Error('no audio track'), { name: 'NotFoundError' }); }
      listDevices().then(() => resolveDevice('audioinput')).catch(() => {});   // (names are readable once a microphone has been opened)
      return { stream, fellBack: (r.id !== 'default' && !t.chosen) || r.present === false, label: r.label, plain: t.plain };
    } catch (e) {
      last = e;
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e;   // (asking again a different way would only ask the person again)
    }
  }
  throw last || Object.assign(new Error('no microphone'), { name: 'NotFoundError' });
}
