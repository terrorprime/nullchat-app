// Screen sharing for the NullChat desktop app.
//
// Instead of a system dialog (a plain list of buttons) the app shows its own picker inside the NullChat
// window: every screen and window with a live preview. How it works:
//
//   1. The web app asks for the list      -> ipc "screenshare:sources"
//   2. The person picks one in the app    -> ipc "screenshare:choose"  (remembered here for a few seconds)
//   3. The web app calls getDisplayMedia  -> the handler below answers with exactly that source,
//                                            with no further dialog.
//
// If a web page asks for a screen without going through the picker (for example an older web client served
// by a server that has not been updated yet), the handler falls back to a simple system dialog so sharing
// still works.
'use strict';

const THUMB = { width: 320, height: 180 };
const ICON = { width: 24, height: 24 };
const CHOICE_TTL_MS = 20_000;
const MAX_SOURCES = 60;
const SOURCE_ID = /^(screen|window):[\w:.-]{1,64}$/;

/**
 * deps: { ipcMain, session, desktopCapturer, systemPreferences, dialog, platform,
 *         getWindow(), isAppUrl(url), onMacPermission() }
 * (everything is injected so the logic can be tested without Electron)
 */
function setupScreenShare(deps) {
  const { ipcMain, session, desktopCapturer, systemPreferences, dialog, platform, getWindow, isAppUrl, onMacPermission } = deps;
  const IS_MAC = platform === 'darwin';
  const IS_WIN = platform === 'win32';
  let pending = null; // { source, audio, at }

  const fromApp = (event) => {
    try { return isAppUrl(event.senderFrame?.url || event.sender?.getURL?.() || ''); } catch { return false; }
  };

  const ownSourceId = () => { try { return getWindow()?.getMediaSourceId?.() || null; } catch { return null; } };

  /** All shareable screens and windows, except the NullChat window itself. */
  async function rawSources(preview) {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: preview ? THUMB : { width: 0, height: 0 },
      fetchWindowIcons: !!preview,
    });
    const own = ownSourceId();
    return list.filter((s) => s && s.id && s.id !== own && String(s.name || '').trim());
  }

  const typeOf = (s) => (String(s.id).startsWith('screen:') ? 'screen' : 'window');
  const picture = (img, fmt) => {
    try {
      if (!img || img.isEmpty()) return null;
      return fmt === 'jpeg' ? `data:image/jpeg;base64,${img.toJPEG(72).toString('base64')}` : img.resize(ICON).toDataURL();
    } catch { return null; }
  };

  ipcMain.handle('screenshare:sources', async (event) => {
    if (!fromApp(event)) return { ok: false, error: 'denied' };
    try {
      if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        // Asking for sources makes macOS show its permission prompt the first time.
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
        if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') { if (onMacPermission) onMacPermission(); return { ok: false, error: 'permission' }; }
      }
      const list = await rawSources(true);
      const sources = list
        .map((s) => ({ id: s.id, name: String(s.name).slice(0, 120), type: typeOf(s), thumb: picture(s.thumbnail, 'jpeg'), icon: picture(s.appIcon, 'png') }))
        .sort((a, b) => (a.type === b.type ? (a.type === 'screen' ? 0 : a.name.localeCompare(b.name)) : a.type === 'screen' ? -1 : 1))
        .slice(0, MAX_SOURCES);
      return { ok: true, sources, audio: IS_WIN };
    } catch (e) {
      return { ok: false, error: 'failed', message: String(e && e.message || e) };
    }
  });

  ipcMain.handle('screenshare:choose', async (event, req) => {
    if (!fromApp(event)) return { ok: false, error: 'denied' };
    const id = req && typeof req.id === 'string' ? req.id : '';
    if (!SOURCE_ID.test(id)) return { ok: false, error: 'invalid' };
    try {
      const source = (await rawSources(false)).find((s) => s.id === id);
      if (!source) return { ok: false, error: 'gone' };
      pending = { source, audio: !!req.audio && IS_WIN, at: Date.now() };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'failed', message: String(e && e.message || e) };
    }
  });

  session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const choice = pending && Date.now() - pending.at < CHOICE_TTL_MS ? pending : null;
      pending = null;
      if (choice) {
        callback({ video: choice.source, audio: choice.audio && request?.audioRequested !== false ? 'loopback' : undefined });
        return;
      }
      // Fallback: the page did not use the in-app picker.
      if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
        if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') { if (onMacPermission) onMacPermission(); callback({}); return; }
      }
      const list = (await rawSources(false)).slice(0, 12);
      if (!list.length) { callback({}); return; }
      const { response } = await dialog.showMessageBox(getWindow(), {
        type: 'question', title: 'Share your screen', message: 'What would you like to share?',
        buttons: [...list.map((s) => (typeOf(s) === 'screen' ? `🖥  ${s.name}` : String(s.name).slice(0, 60))), 'Cancel'],
        cancelId: list.length, noLink: true,
      });
      if (response >= list.length) { callback({}); return; }
      callback({ video: list[response], audio: IS_WIN && request?.audioRequested ? 'loopback' : undefined });
    } catch {
      callback({});
    }
  });
}

module.exports = { setupScreenShare, CHOICE_TTL_MS };
