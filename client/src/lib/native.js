// The NullChat phone apps (Android and iPhone, built from the mobile/ folder) are this same website shown inside Capacitor's native
// shell. The shell puts a small `Capacitor` object on the page before anything else runs, and on it a ready-made entry for each native
// feature the app was built with (`Capacitor.Plugins.PushNotifications` ...). This file is the one place that asks it things.
// In a normal browser, the desktop app or an installed web app there is no such object and everything here answers "no".

/** Is this page running inside the NullChat phone app? */
export function inNativeApp() {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch { return false; }
}

/** 'android' | 'ios' inside the phone app, otherwise null. */
export function nativePlatform() {
  if (!inNativeApp()) return null;
  try { const p = window.Capacitor.getPlatform(); return p === 'android' || p === 'ios' ? p : null; } catch { return null; }
}

/** One of the app's native features ('PushNotifications'...) to call from the page, or null when this isn't the phone app or it was built without it. */
export function nativePlugin(name) {
  if (!inNativeApp()) return null;
  try { return window.Capacitor.Plugins?.[name] || null; } catch { return null; }
}
