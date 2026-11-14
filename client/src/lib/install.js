// "Install as an app" support (PWA) and desktop-app detection.
import { createStore, useStoreOf } from './store.js';
import { inNativeApp } from './native.js';

export const desktop = typeof window !== 'undefined' ? window.nullchatDesktop || null : null;
// (inside the NullChat phone app there is nothing left to install)
export const isStandalone = () => inNativeApp() || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const installStore = createStore({ prompt: null, installed: false });
export const useInstall = () => useStoreOf(installStore, (s) => s);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installStore.set({ prompt: e });
});
window.addEventListener('appinstalled', () => installStore.set({ prompt: null, installed: true }));

export async function promptInstall() {
  const { prompt } = installStore.get();
  if (!prompt) return false;
  prompt.prompt();
  const choice = await prompt.userChoice.catch(() => null);
  installStore.set({ prompt: null, installed: choice?.outcome === 'accepted' });
  return choice?.outcome === 'accepted';
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // Only in production builds — in development Vite serves files directly.
  if (!import.meta.env?.PROD) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// ---- what kind of device / browser is this? ----------------------------------------------------
/** { ios, android, mobile, os: 'windows'|'mac'|'linux'|'ios'|'android'|'other', browser: 'safari'|'chrome'|'samsung'|'firefox'|'edge'|'opera'|'other', inApp } */
export function installEnv() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  // Browsers built into other apps (Facebook, Instagram, TikTok...) can't install anything.
  const inApp = /FBAN|FBAV|Instagram|Snapchat|TikTok|Twitter|MicroMessenger|Line\/|GSA\/|Discord/i.test(ua) || (android && /; wv\)/.test(ua));
  let browser = 'other';
  if (ios) browser = /CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : /EdgiOS/.test(ua) ? 'edge' : /Safari/.test(ua) ? 'safari' : 'other';
  else if (android) browser = /SamsungBrowser/.test(ua) ? 'samsung' : /EdgA/.test(ua) ? 'edge' : /Firefox/.test(ua) ? 'firefox' : /Chrome/.test(ua) ? 'chrome' : 'other';
  // Computers: Chrome, Edge, Brave and Opera can install NullChat as an app, Safari (macOS 14+) can add it to the Dock,
  // Firefox cannot do either.
  else browser = /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Firefox/.test(ua) ? 'firefox' : /Chrome|Chromium/.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : 'other';
  const os = android ? 'android' : ios ? 'ios' : /Windows/i.test(ua) ? 'windows' : /Mac OS/i.test(ua) ? 'mac' : /Linux|X11|CrOS/i.test(ua) ? 'linux' : 'other';
  return { ios, android, mobile: ios || android, browser, os, inApp };
}

// ---- the "Install the app" banner can be dismissed for two weeks ------------------------------
const BANNER_KEY = 'nullchat.installBannerHidden';
export function installBannerHidden() {
  try { return Date.now() - Number(localStorage.getItem(BANNER_KEY) || 0) < 14 * 24 * 3600 * 1000; } catch { return false; }
}
export function hideInstallBanner() { try { localStorage.setItem(BANNER_KEY, String(Date.now())); } catch { /* private mode */ } }
