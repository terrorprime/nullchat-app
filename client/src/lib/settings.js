// User settings: defaults, synced (server) settings and per-device (local) settings.
import { store } from './state.js';
import { api } from './api.js';
import { setFormatOptions } from './utils.js';
import { configureSounds } from './sounds.js';
import { DEFAULT_CUSTOM_THEME, sanitizeCustomTheme, buildTheme } from './themes.js';
import { isHex, luminance } from './perks.js';
import { applyCustomCss, toggleCustomCssSuppressed } from './customCss.js';
import { toast } from './toast.js';
import { effectiveZoom } from './zoom.js';

export const DEFAULT_KEYBINDS = {
  toggleMute: 'Ctrl+Shift+M',
  toggleDeafen: 'Ctrl+Shift+D',
  pushToTalk: '',
  quickSwitcher: 'Ctrl+K',
  search: 'Ctrl+F',
  markChannelRead: 'Escape',
  markServerRead: 'Shift+Escape',
  prevChannel: 'Alt+ArrowUp',
  nextChannel: 'Alt+ArrowDown',
  prevUnread: 'Alt+Shift+ArrowUp',
  nextUnread: 'Alt+Shift+ArrowDown',
  toggleMembers: 'Ctrl+U',
  toggleCamera: 'Ctrl+Shift+V',
  answerCall: 'Ctrl+Enter',
  declineCall: 'Ctrl+Shift+Backspace',
  openSettings: 'Ctrl+,',
  showShortcuts: 'Ctrl+/',
  createServer: 'Ctrl+Shift+N',
  uploadFile: 'Ctrl+Shift+U',
};

export const KEYBIND_LABELS = {
  toggleMute: 'Toggle Mute', toggleDeafen: 'Toggle Deafen', pushToTalk: 'Push to Talk (hold)', quickSwitcher: 'Quick Switcher',
  search: 'Search', markChannelRead: 'Mark Channel Read & Jump to Present', markServerRead: 'Mark Server Read', prevChannel: 'Previous Channel',
  nextChannel: 'Next Channel', prevUnread: 'Previous Unread Channel', nextUnread: 'Next Unread Channel', toggleMembers: 'Toggle Member List',
  toggleCamera: 'Toggle Camera', answerCall: 'Answer Incoming Call', declineCall: 'Decline Incoming Call', openSettings: 'Open User Settings',
  showShortcuts: 'Show Keyboard Shortcuts', createServer: 'Create or Join a Server', uploadFile: 'Upload a File',
};

export const DEFAULTS = {
  theme: 'dark',
  customTheme: DEFAULT_CUSTOM_THEME,
  accentColor: '#c2ff3d',
  fontSize: 16,
  zoom: 100,
  messageDisplay: 'cozy',
  groupSpacing: 16,
  locale: 'en',
  hour24: false,
  developerMode: false,
  guildOrder: [],
  guildFolders: [],
  accessibility: { reducedMotion: 'system', saturation: 100, roleColors: 'on', underlineLinks: false, highContrast: false, dyslexicFont: false, nameStyles: true, profileEffects: true },
  chat: { inlineMedia: true, linkPreviews: true, animateEmoji: true, convertEmoticons: true, spellcheck: true, showSendButton: false, compactAttachments: false, keepComposerFocus: true, catchUp: true, streaks: true },
  notifications: { desktop: true, sounds: true, disabledSounds: {}, unreadBadge: true, flashTitle: true, dmsAlways: true, closeFriendsBreakDnd: false },
  closeFriends: [],   // the friends you starred (lib/closeFriends.js)
  privacy: { suggestMe: true, hideLeaderboard: false, hideLevel: false, shareActivity: true, allowDMsFromServerMembers: true, friendRequests: { everyone: true, mutualFriends: true, mutualServers: true }, blurMediaFromNonFriends: false },
  customCss: { on: true, css: '' },   // your own styles on top of NullChat's (Appearance → Custom CSS)
  keybinds: DEFAULT_KEYBINDS,
};

export function getSetting(path) {
  const s = store.get().settings || {};
  const parts = path.split('.');
  let v = s; let d = DEFAULTS;
  for (const p of parts) { v = v?.[p]; d = d?.[p]; }
  return v === undefined ? d : v;
}

export function useSettingValue(useStore, path) {
  return useStore((s) => {
    const parts = path.split('.');
    let v = s.settings; let d = DEFAULTS;
    for (const p of parts) { v = v?.[p]; d = d?.[p]; }
    return v === undefined ? d : v;
  });
}

let saveTimer = null;
let pendingPatch = {};
/** Update synced settings optimistically and persist (debounced). */
export function updateSettings(patch) {
  const cur = store.get().settings || {};
  const merged = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(cur[k] || {}), ...v } : v;
    pendingPatch[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(pendingPatch[k] || {}), ...v } : v;
  }
  store.set({ settings: merged });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const p = pendingPatch; pendingPatch = {};
    api.patch('/users/@me/settings', p).catch((e) => console.error('settings save failed', e));
  }, 400);
}

// ---- per-device settings (audio devices etc.) ----
const LOCAL_KEY = 'nullchat.device';
export const LOCAL_DEFAULTS = {
  inputDeviceId: 'default', outputDeviceId: 'default', videoDeviceId: 'default',
  inputDeviceLabel: '', outputDeviceLabel: '', videoDeviceLabel: '',   // each chosen device's name, to find it again when its id changes (lib/devices.js)
  inputVolume: 100, outputVolume: 100, inputMode: 'vad', vadThreshold: -55, autoSensitivity: true,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  voiceEnhance: true,      // even out and clean up your voice before it is sent (lib/voice.js: the voice chain)
  voiceProtect: true,      // send each bit of voice twice, so a dropped packet is not a gap (lib/voice.js: preferRedundancy)
  voiceQuality: 'high', cameraQuality: 'standard',   // how much bandwidth your voice and camera may use (see lib/voice.js)
  userVolumes: {}, localMutes: {}, mirrorCamera: true, pttReleaseDelay: 200,
  memberListOpen: true, collapsedCategories: {},
  popChatOpen: false,     // whether the chat is open in the call's own window (components/CallPopout.jsx)
  voiceChatOpen: false,   // whether the chat beside a voice channel's call is open (components/Voice.jsx)
  autoPopout: true,   // picture-in-picture: let the browser pop the call out when you switch tabs (components/CallPopout.jsx)
  popoutOnTop: false,   // desktop app: whether the popped-out call window stays above other windows (components/CallPopout.jsx)
  profileSongs: true,   // whether a profile's song starts by itself when you open the profile (lib/profileSong.js)
  voiceSounds: true, plainSoundFor: {},   // people's own join and leave sounds: whether you hear them at all, and the people you'd rather hear the standard sound for (lib/voiceSounds.js)
  musicVolume: 50, musicOff: false,   // the shared music queue of a voice channel: how loud it is for you, and whether you hear it at all (lib/music.js)
  moodVolume: 35, moodOff: false,   // mood rooms: how loud a voice channel's room sound is for you, and whether you hear it at all (lib/ambience.js)
};
export function getLocal() {
  try { return { ...LOCAL_DEFAULTS, ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') }; } catch { return { ...LOCAL_DEFAULTS }; }
}
const localListeners = new Set();
export function setLocal(patch) {
  const next = { ...getLocal(), ...patch };
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  localListeners.forEach((l) => l(next));
}
export function onLocalChange(fn) { localListeners.add(fn); return () => localListeners.delete(fn); }

// ---- apply appearance to the document ----
const customVars = new Set();
/** Apply (or clear) the custom theme's colours on <html>. Returns the base theme it builds on. */
function applyCustomTheme(root, s) {
  for (const k of customVars) root.style.removeProperty(k);
  customVars.clear();
  root.style.removeProperty('--theme-grad');
  root.classList.remove('has-theme-gradient');
  if (s.theme !== 'custom') return null;
  const ct = sanitizeCustomTheme(s.customTheme) || sanitizeCustomTheme(DEFAULT_CUSTOM_THEME);
  const t = buildTheme(ct);
  for (const [k, v] of Object.entries(t.vars)) { root.style.setProperty(k, v); customVars.add(k); }
  if (t.gradient) { root.style.setProperty('--theme-grad', t.gradient); root.classList.add('has-theme-gradient'); }
  return t.mode;
}

function resolvedTheme(theme) {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return theme;
}

/** The Zoom setting: CSS zoom on <html>, held back when the window is too narrow for it (lib/zoom.js). --zoom lets styles.css correct its vw/vh/dvh lengths. */
let appliedZoom = null;
function applyZoom(percent) {
  const eff = effectiveZoom(percent);
  if (eff === appliedZoom) return;
  appliedZoom = eff;
  const root = document.documentElement;
  root.style.zoom = eff !== 100 ? `${eff}%` : '';
  root.style.setProperty('--zoom', String(eff / 100));
}
window.addEventListener('resize', () => applyZoom((store.get().settings || {}).zoom ?? DEFAULTS.zoom));

export function applySettings(settings) {
  const s = { ...DEFAULTS, ...settings, accessibility: { ...DEFAULTS.accessibility, ...(settings?.accessibility || {}) } };
  const root = document.documentElement;
  const customBase = applyCustomTheme(root, s);
  root.dataset.theme = customBase || resolvedTheme(s.theme === 'custom' ? 'dark' : s.theme);
  const accent = isHex(s.accentColor) ? s.accentColor : DEFAULTS.accentColor;
  root.style.setProperty('--accent', accent);
  // Text on accent-coloured buttons: dark on light accents (mint, sky blue, ...) so it stays readable.
  root.style.setProperty('--on-accent', luminance(accent) > 0.4 ? '#111318' : '#ffffff');
  // Colour the phone's status bar / browser chrome to match.
  try { document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg-tertiary').trim() || '#1b1d24'); } catch { /* ignore */ }
  root.style.setProperty('--font-size', `${s.fontSize}px`);
  root.style.setProperty('--group-spacing', `${s.groupSpacing}px`);
  root.style.setProperty('--saturation', `${s.accessibility.saturation / 100}`);
  applyZoom(s.zoom);
  const reduce = s.accessibility.reducedMotion === 'on' || (s.accessibility.reducedMotion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  root.classList.toggle('reduce-motion', reduce);
  root.classList.toggle('underline-links', !!s.accessibility.underlineLinks);
  root.classList.toggle('high-contrast', !!s.accessibility.highContrast);
  root.classList.toggle('dyslexic-font', !!s.accessibility.dyslexicFont);
  root.classList.toggle('plain-names', s.accessibility.nameStyles === false);   // Text Readability → Display name styles
  root.classList.toggle('no-profile-fx', s.accessibility.profileEffects === false);   // Reduced Motion → Profile effects
  root.classList.toggle('compact', s.messageDisplay === 'compact');
  applyCustomCss(s.customCss);
  root.lang = s.locale || 'en';
  setFormatOptions({ locale: s.locale || 'en', hour24: !!s.hour24 });
  const n = { ...DEFAULTS.notifications, ...(settings?.notifications || {}) };
  configureSounds({ enabled: n.sounds, disabled: n.disabledSounds || {} });
}

// Ctrl+Alt+Shift+C: the way out when custom CSS has made the app unusable (also ?nocss in the address). Not rebindable on purpose.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.altKey && e.shiftKey && (e.code === 'KeyC' || e.key === 'C' || e.key === 'c'))) return;
  e.preventDefault();
  const off = toggleCustomCssSuppressed();
  applyCustomCss((store.get().settings || {}).customCss);
  toast(off ? 'Custom CSS is switched off on this device. Press Ctrl+Alt+Shift+C again to turn it back on.' : 'Custom CSS is back on.', 'info', 5000);
}, true);

window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applySettings(store.get().settings || {}));
