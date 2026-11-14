// NullChat desktop app (Electron main process).
//
// Startup works like Discord's client:
//   1. A small splash window appears ("Checking for updates…").
//   2. If a newer version is published, it downloads and installs itself, then restarts.
//   3. The main window opens straight into your NullChat server.
//
// Which server? The one baked into the build (app-config.json → serverUrl). If none was baked in,
// the first launch asks: host a server on this computer, or join an existing one.
const {
  app, BrowserWindow, ipcMain, session, shell, Menu, Tray, nativeImage, desktopCapturer, dialog, net: enet, systemPreferences, clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setupScreenShare } = require('./screenshare.cjs');
const { applyLinuxAutostart } = require('./autostart.cjs');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const PROTOCOL = 'nullchat';
app.setName('NullChat');
if (IS_WIN) app.setAppUserModelId('app.nullchat.desktop');

// Only one copy runs at a time; a second launch focuses the first (and passes nullchat:// links).
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ------------------------------------------------------------------ configuration
const userData = app.getPath('userData');
const CONFIG_FILE = path.join(userData, 'desktop.json');
const ICON = path.join(__dirname, 'build', 'icon.png');

/** Build-time settings (written by scripts/prepare.cjs from app-config.json / environment). */
const BUILD = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8')); } catch { return {}; } })();
const BAKED_SERVER = normalizeUrl(BUILD.serverUrl || '');
// A build with a server baked in is locked to it: no host-on-this-PC, no joining other servers, no "Switch Server".
// (Set "allowServerSwitch": true in desktop/app-config.json, or NULLCHAT_ALLOW_SERVER_SWITCH=1 when building, to allow it.)
const LOCKED = !!BAKED_SERVER && BUILD.allowServerSwitch !== true;

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfig() { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
const cfg = loadConfig();
const firstRun = !cfg.installedVersion;
// A server baked into the build is used automatically until the user picks something else.
if (!cfg.mode && BAKED_SERVER) { cfg.mode = 'remote'; cfg.url = BAKED_SERVER; }
// Locked builds ignore whatever an earlier install saved (host mode, another server) and always use the baked-in one.
if (LOCKED) { cfg.mode = 'remote'; cfg.url = BAKED_SERVER; }
// Discord-like defaults: open at login (minimized) and close to the tray.
// (Linux: both stay off until asked for, see below.)
if (cfg.openAtLogin === undefined) cfg.openAtLogin = process.platform !== 'linux';
// On Linux many desktops (GNOME) show no tray icon at all, and a window hidden to a tray nobody can see looks like a crash,
// so there the X button quits unless the person turns "Minimize to tray" on.
if (cfg.closeToTray === undefined) cfg.closeToTray = process.platform !== 'linux';
cfg.installedVersion = app.getVersion();
saveConfig();

function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?/.test(url) ? 'http://' : 'https://') + url;
  try { return new URL(url).origin; } catch { return ''; }
}

// Mic/camera only work on secure origins. Treat a plain-http LAN server as secure inside the app.
if (cfg.mode === 'remote' && cfg.url) {
  try { const u = new URL(cfg.url); if (u.protocol === 'http:') app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', u.origin); } catch { /* ignore */ }
}

// nullchat:// links (e.g. nullchat://invite/AbCd1234, or nullchat://invite/AbCd1234/youtube with a "joined from" label) open in the app.
if (process.defaultApp) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient(PROTOCOL);

const startHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
let pendingDeepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)) || null;

let win = null;
let splash = null;
let tray = null;
let serverPort = null;
let quitting = false;
let unread = 0;
let updateReady = false;
// What the updater is doing, mirrored into the page so it can show an "Update" bar (see client/src/lib/updates.js).
let updateState = null; // { state: 'downloading' | 'ready' | 'available', version, percent } | null
function setUpdateState(next) {
  updateState = next;
  try { if (win && !win.isDestroyed()) win.webContents.send('update:status', next); } catch { /* window not ready */ }
}
// True when the main window is showing the NullChat site (where the bar is), not the server launcher.
function pageHasUpdateBar() {
  try { return !!win && !win.isDestroyed() && /^https?:/i.test(win.webContents.getURL()); } catch { return false; }
}

// ------------------------------------------------------------------ built-in server ("host" mode)
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
function findPort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => { const any = net.createServer(); any.listen(0, () => { const p = any.address().port; any.close(() => resolve(p)); }); });
    probe.listen(preferred, '0.0.0.0', () => probe.close(() => resolve(preferred)));
  });
}
async function startServer() {
  if (serverPort) return serverPort;
  const bundle = path.join(__dirname, 'bundle');
  if (!fs.existsSync(path.join(bundle, 'server', 'src', 'index.js'))) throw new Error('The server files are missing from this build.');
  const dataDir = cfg.dataDir || path.join(userData, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(userData, 'secret.key');
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* first run */ }
  if (!secret) { secret = crypto.randomBytes(48).toString('base64url'); fs.writeFileSync(secretFile, secret, { mode: 0o600 }); }
  const port = await findPort(cfg.port || 3001);
  Object.assign(process.env, {
    NODE_ENV: 'production', APP_SECRET: secret, DATA_DIR: dataDir, PORT: String(port), HOST: '0.0.0.0',
    CLIENT_DIST: path.join(bundle, 'client', 'dist'), PUBLIC_URL: `http://localhost:${port}`,
    NULLCHAT_ENV_FILE: path.join(userData, 'nullchat.env'), // optional: SMTP, GIPHY, TURN settings
  });
  globalThis.__NULLCHAT_EMBEDDED__ = true;
  await new Promise((resolve, reject) => {
    globalThis.__NULLCHAT_ON_LISTEN__ = (p) => { serverPort = p; resolve(); };
    globalThis.__NULLCHAT_ON_ERROR__ = reject;
    import(pathToFileURL(path.join(bundle, 'server', 'src', 'index.js')).href).catch(reject);
  });
  updateTray();
  return serverPort;
}

// ------------------------------------------------------------------ splash & updates
function createSplash() {
  splash = new BrowserWindow({
    width: 300, height: 340, frame: false, resizable: false, movable: true, show: false, center: true,
    backgroundColor: '#060608', skipTaskbar: false, alwaysOnTop: false, icon: ICON, title: 'NullChat',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => { if (!startHidden) splash.show(); splashStatus({ version: app.getVersion() }); });
  splash.on('closed', () => { splash = null; });
}
function splashStatus(d) { if (splash && !splash.isDestroyed()) splash.webContents.send('splash:status', d); }

function updateFeedUrl() {
  if (BUILD.updateUrl === false) return '';
  if (BUILD.updateUrl) return String(BUILD.updateUrl).replace(/\/$/, '');
  const base = cfg.mode === 'remote' && cfg.url ? cfg.url : BAKED_SERVER;
  return base ? `${base}/downloads` : '';
}

let updater = null;
function getUpdater() {
  if (updater !== null) return updater;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    updater = autoUpdater;
  } catch { updater = false; }
  return updater;
}

/**
 * Check for an update. On Windows/Linux the update is downloaded and installed silently (like
 * Discord). macOS only auto-installs signed apps, so there we point the user at the download page.
 * Resolves to 'restarting' | 'none' | 'available'.
 */
function checkForUpdates({ duringStartup = false } = {}) {
  return new Promise((resolve) => {
    const u = getUpdater();
    const feed = updateFeedUrl();
    if (!u || !feed || !app.isPackaged) { resolve('none'); return; }
    if (updateReady && !duringStartup) { resolve('available'); return; }
    const canAutoInstall = !IS_MAC || BUILD.macSigned === true;
    u.autoDownload = canAutoInstall;
    u.setFeedURL({ provider: 'generic', url: feed });
    let done = false;
    const finish = (r) => { if (!done) { done = true; cleanup(); resolve(r); } };
    const onNone = () => finish('none');
    const onError = () => { if (updateState?.state === 'downloading') setUpdateState(null); finish('none'); };
    let pendingVersion = '';
    const onAvailable = (info) => {
      pendingVersion = info.version;
      if (!canAutoInstall) {
        finish('available');
        setUpdateState({ state: 'available', version: info.version });
        if (!pageHasUpdateBar()) {
          dialog.showMessageBox({ type: 'info', title: 'Update available', message: `NullChat ${info.version} is available`, detail: 'Download the new version and replace the app in your Applications folder.', buttons: ['Download', 'Later'] })
            .then(({ response }) => { if (response === 0) shell.openExternal(cfg.url || BAKED_SERVER || feed); });
        }
        return;
      }
      setUpdateState({ state: 'downloading', version: info.version, percent: 0 });
      splashStatus({ text: `Downloading update ${info.version}…`, progress: 0 });
      clearTimeout(checkTimer); // downloads may take a while
    };
    const onProgress = (p) => {
      setUpdateState({ state: 'downloading', version: pendingVersion, percent: p.percent });
      splashStatus({ text: 'Downloading update…', progress: p.percent });
    };
    const onDownloaded = (info) => {
      updateReady = true;
      if (duringStartup) {
        splashStatus({ text: 'Installing update…', progress: 100 });
        finish('restarting');
        setTimeout(() => { quitting = true; u.quitAndInstall(true, true); }, 600);
      } else {
        finish('available');
        setUpdateState({ state: 'ready', version: info.version });
        // The "Restart to update" bar shows in the app. Only pop a dialog when the app page isn't showing.
        if (!pageHasUpdateBar()) {
          dialog.showMessageBox(win, { type: 'info', title: 'Update ready', message: `NullChat ${info.version} is ready to install`, detail: 'Restart NullChat now to finish updating?', buttons: ['Restart Now', 'Later'], defaultId: 0 })
            .then(({ response }) => { if (response === 0) { quitting = true; u.quitAndInstall(true, true); } });
        }
      }
    };
    function cleanup() {
      u.off('update-not-available', onNone); u.off('error', onError); u.off('update-available', onAvailable);
      u.off('download-progress', onProgress); u.off('update-downloaded', onDownloaded); clearTimeout(checkTimer);
    }
    u.on('update-not-available', onNone); u.on('error', onError); u.on('update-available', onAvailable);
    u.on('download-progress', onProgress); u.on('update-downloaded', onDownloaded);
    const checkTimer = setTimeout(() => finish('none'), duringStartup ? 8000 : 30000);
    u.checkForUpdates().catch(() => finish('none'));
  });
}

// Accounts live on one server. If this app is pointed somewhere other than the server built into it (for example
// "Host on this computer", which starts with no accounts), an account made in the browser can't log in here.
// Ask once per version, with a clear default, instead of leaving the person to find File → Switch Server.
async function offerBakedServer() {
  if (!BAKED_SERVER || LOCKED || startHidden || cfg.serverPromptVersion === app.getVersion()) return;
  if (!cfg.mode || (cfg.mode === 'remote' && cfg.url === BAKED_SERVER)) return;
  cfg.serverPromptVersion = app.getVersion(); saveConfig();
  const host = BAKED_SERVER.replace(/^https?:\/\//, '');
  const where = cfg.mode === 'host' ? 'a server running on this computer' : cfg.url.replace(/^https?:\/\//, '');
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'Which NullChat server?', message: `This app is using ${where}.`,
    detail: `Accounts are separate on every server. An account you made in your browser on ${host} won’t be found on ${where}.\n\nSwitch this app to ${host}? You can change it again any time from File → Switch Server.`,
    buttons: [`Use ${host}`, 'Keep what I have'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 0) { cfg.mode = 'remote'; cfg.url = BAKED_SERVER; saveConfig(); }
}

async function startup() {
  createSplash();
  splashStatus({ text: 'Checking for updates…' });
  const result = await checkForUpdates({ duringStartup: true });
  if (result === 'restarting') return;
  await offerBakedServer();
  splashStatus({ text: 'Starting…' });
  createWindow();
  // Keep checking in the background every 4 hours.
  setInterval(() => { if (!updateReady) checkForUpdates(); }, 4 * 3600 * 1000).unref?.();
}

// ------------------------------------------------------------------ main window
function appOrigin() {
  if (cfg.mode === 'host' && serverPort) return `http://localhost:${serverPort}`;
  if (cfg.mode === 'remote' && cfg.url) { try { return new URL(cfg.url).origin; } catch { return null; } }
  return null;
}
function isAppUrl(url) {
  if (url.startsWith('file://')) return true;
  const o = appOrigin();
  return !!o && url.startsWith(o);
}
function showLauncher(error) {
  win.loadFile(path.join(__dirname, 'launcher.html'), { query: error ? { error: String(error) } : {} });
}

async function openApp() {
  if (cfg.mode === 'host') {
    try { const port = await startServer(); await win.loadURL(`http://localhost:${port}/channels/@me`); }
    catch (e) { showLauncher(`Couldn’t start the built-in server: ${e.message}`); }
  } else if (cfg.mode === 'remote' && cfg.url) {
    win.loadURL(cfg.url).catch(() => {});
  } else showLauncher();
}

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 800, x: b.x, y: b.y, minWidth: 940, minHeight: 560,
    title: 'NullChat', icon: ICON, backgroundColor: '#040405', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  if (b.maximized) win.maximize();

  let shown = false;
  const reveal = () => {
    if (shown) return; shown = true;
    if (splash && !splash.isDestroyed()) splash.close();
    if (!startHidden) win.show();
    if (pendingDeepLink) { handleDeepLink(pendingDeepLink); pendingDeepLink = null; }
  };
  win.webContents.once('did-finish-load', reveal);
  win.webContents.once('did-fail-load', reveal);
  setTimeout(reveal, 15000);

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The popped-out call: the app asks for one empty window by this name and draws the call into it (client: components/CallPopout.jsx).
    // It is an ordinary window of its own: it has a title bar, shows in the taskbar, can be resized, maximised, made full screen
    // and snapped into the system's window layouts. "Keep on top" is a button in the window (see 'call-window:on-top' below).
    if (frameName === 'nullchat-pip' && (!url || url === 'about:blank')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960, height: 600, minWidth: 280, minHeight: 200, title: 'NullChat call', icon: ICON, backgroundColor: '#000000',
          frame: true, resizable: true, minimizable: true, maximizable: true, fullscreenable: true, alwaysOnTop: false, skipTaskbar: false,
          autoHideMenuBar: true, show: true,
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    try { child.setMenuBarVisibility(false); } catch { /* the window is still usable without it */ }
    callWindow = child;
    child.once('closed', () => { if (callWindow === child) callWindow = null; });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (e) => e.preventDefault());
    const closeChild = () => { if (!child.isDestroyed()) child.close(); };
    win.once('closed', closeChild);
    child.once('closed', () => { if (win && !win.isDestroyed()) win.removeListener('closed', closeChild); });
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (isMain && cfg.mode === 'remote' && code !== -3) showLauncher(`Couldn’t reach ${cfg.url} (${desc}). Check your internet connection${LOCKED ? ' and try again.' : ', or choose another server.'}`);
  });
  win.webContents.on('page-title-updated', (_e, title) => { const m = /^\((\d+)\)/.exec(title); setUnread(m ? Number(m[1]) : 0); });

  const remember = () => { if (!win || win.isMinimized()) return; cfg.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() }; saveConfig(); };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('focus', () => win.flashFrame(false));

  // Like Discord: the X button hides to the tray (or the Dock on Mac); quit from the tray / ⌘Q.
  win.on('close', (e) => {
    if (quitting) return;
    if (IS_MAC || (cfg.closeToTray && tray)) {
      e.preventDefault();
      win.hide();
      if (IS_WIN && !cfg.trayHintShown) {
        tray.displayBalloon({ title: 'NullChat is still running', content: 'NullChat keeps running in the system tray. Right-click the tray icon to quit.', iconType: 'info' });
        cfg.trayHintShown = true; saveConfig();
      }
    }
  });
  openApp();
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function handleDeepLink(link) {
  try {
    const u = new URL(link);
    const parts = [u.hostname, ...u.pathname.split('/')].filter(Boolean); // nullchat://invite/CODE
    showWindow();
    const origin = appOrigin();
    if (!origin) return;
    if (parts[0] === 'invite' && parts[1]) win.loadURL(`${origin}/invite/${encodeURIComponent(parts[1])}${parts[2] ? `/${encodeURIComponent(parts[2])}` : ''}`);   // (a third part is the "joined from" label)
    else if (parts[0] === 'channels') win.loadURL(`${origin}/${parts.join('/')}`);
  } catch { /* ignore malformed links */ }
}

// ------------------------------------------------------------------ unread badge
function setUnread(n) {
  if (n === unread) return;
  const increased = n > unread;
  unread = n;
  if (!IS_WIN) app.setBadgeCount(n);
  if (win && IS_WIN) {
    win.setOverlayIcon(n ? nativeImage.createFromPath(path.join(__dirname, 'build', 'badges', `${n > 9 ? 'many' : n}.png`)) : null, n ? `${n} unread` : '');
    if (increased && !win.isFocused()) win.flashFrame(true);
  }
  updateTray();
}

// ------------------------------------------------------------------ tray & menus
function updateTray() {
  if (!tray) return;
  const items = [{ label: 'Open NullChat', click: showWindow }, { type: 'separator' }];
  if (cfg.mode === 'host' && serverPort) {
    items.push({ label: `Hosting a server on port ${serverPort}`, enabled: false });
    for (const ip of lanAddresses()) items.push({ label: `Copy invite address  http://${ip}:${serverPort}`, click: () => clipboard.writeText(`http://${ip}:${serverPort}`) });
    items.push({ label: 'Open Data Folder', click: () => shell.openPath(cfg.dataDir || path.join(userData, 'data')) }, { type: 'separator' });
  }
  items.push({ label: 'Check for Updates…', click: async () => { const r = await checkForUpdates(); if (r === 'none') dialog.showMessageBox({ type: 'info', title: 'NullChat', message: `You’re on the latest version (${app.getVersion()}).` }); } });
  if (!LOCKED) items.push({ label: 'Switch Server…', click: () => { showWindow(); showLauncher(); } });
  items.push({ type: 'separator' }, { label: 'Quit NullChat', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(unread ? `NullChat — ${unread} unread` : 'NullChat');
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      ...(LOCKED ? [] : [{ label: 'Switch Server…', click: () => { showWindow(); showLauncher(); } }]),
      { label: 'Check for Updates…', click: () => checkForUpdates() },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'About NullChat', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About NullChat', message: `NullChat ${app.getVersion()}`, detail: `Electron ${process.versions.electron} · Node ${process.versions.node}\nData: ${userData}` }) }] },
  ]));
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  if (process.platform === 'linux') { applyLinuxAutostart({ enabled: !!cfg.openAtLogin, exec: process.env.APPIMAGE || process.execPath }); return; }
  app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin, openAsHidden: true, args: ['--hidden'] });
}

// ------------------------------------------------------------------ permissions & screen sharing
async function macPrivacyHint(what) {
  const pane = { Camera: 'Privacy_Camera', Microphone: 'Privacy_Microphone', 'Screen Recording': 'Privacy_ScreenCapture' }[what];
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', title: `${what} access needed`, message: `NullChat needs ${what} access`,
    detail: `Open System Settings → Privacy & Security → ${what}, turn on NullChat, then restart NullChat.`,
    buttons: ['Open System Settings', 'Not Now'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
}

function setupSession() {
  const allowed = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    // (the call's own window is an empty page the app draws into, so it has no address of its own: it is known by being that window.
    //  It asks for screen capture when Share your screen is clicked in it, and for full screen.)
    const isCallWindow = !!callWindow && !callWindow.isDestroyed() && callWindow.webContents === wc;
    if (!allowed.has(permission) || !(isAppUrl(wc.getURL()) || isCallWindow)) { callback(false); return; }
    if (IS_MAC && permission === 'media') {
      const types = details?.mediaTypes?.length ? details.mediaTypes : ['audio'];
      let ok = true;
      for (const t of types) {
        const kind = t === 'video' ? 'camera' : 'microphone';
        if (systemPreferences.getMediaAccessStatus(kind) !== 'granted') ok = (await systemPreferences.askForMediaAccess(kind)) && ok;
      }
      if (!ok) macPrivacyHint(types.includes('video') ? 'Camera' : 'Microphone');
      callback(ok);
      return;
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Screen sharing: the picker lives inside the NullChat window (see screenshare.cjs).
  setupScreenShare({
    ipcMain, session: session.defaultSession, desktopCapturer, systemPreferences, dialog, platform: process.platform,
    getWindow: () => win, isAppUrl, onMacPermission: () => macPrivacyHint('Screen Recording'),
  });
}

// ------------------------------------------------------------------ IPC
// The popped-out call window (one at a time), and its "keep on top" button.
let callWindow = null;
ipcMain.handle('call-window:on-top', (_e, on) => {
  if (!callWindow || callWindow.isDestroyed()) return false;
  try { callWindow.setAlwaysOnTop(!!on, 'floating'); } catch { return false; }
  return callWindow.isAlwaysOnTop();
});

ipcMain.handle('app:info', () => ({
  desktop: true, version: app.getVersion(), mode: cfg.mode || null, url: cfg.url || '', bakedServer: BAKED_SERVER, locked: LOCKED, port: serverPort,
  lan: lanAddresses(), dataDir: cfg.dataDir || path.join(userData, 'data'),
  keepRunning: !!cfg.closeToTray, closeToTray: !!cfg.closeToTray, openAtLogin: !!cfg.openAtLogin, updates: !!updateFeedUrl(), update: updateState,
}));
ipcMain.handle('app:set-pref', (_e, key, value) => {
  if (key === 'keepRunning' || key === 'closeToTray') cfg.closeToTray = !!value;
  else if (key === 'openAtLogin') { cfg.openAtLogin = !!value; applyLoginItem(); }
  else return false;
  saveConfig();
  return true;
});
ipcMain.handle('app:check-updates', () => checkForUpdates());
// The page's "Restart to update" button (or "Get it" on a Mac build that can't install by itself).
ipcMain.handle('update:install', () => {
  const u = getUpdater();
  if (updateState?.state === 'ready' && u) { quitting = true; u.quitAndInstall(true, true); return true; }
  if (updateState?.state === 'available') { shell.openExternal(cfg.url || BAKED_SERVER || updateFeedUrl()); return true; }
  return false;
});
// Running program names (lowercase, no ".exe"). The web app matches these against its game list locally
// and sends the server only the name of the matched game.
ipcMain.handle('activity:processes', () => new Promise((resolve) => {
  const { execFile } = require('node:child_process');
  const done = (out) => {
    const names = new Set();
    for (const line of String(out || '').split(/\r?\n/)) {
      const raw = process.platform === 'win32' ? (/^"([^"]+)"/.exec(line)?.[1] || '') : path.basename(line.trim());
      const n = raw.toLowerCase().replace(/\.exe$/, '');
      if (n) names.add(n);
      if (names.size >= 3000) break;
    }
    resolve([...names]);
  };
  if (process.platform === 'win32') execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => done(out));
  else execFile('ps', ['-A', '-o', 'comm='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => done(out));
}));
const LOCKED_MSG = () => ({ ok: false, error: `This app is set up for ${BAKED_SERVER.replace(/^https?:\/\//, '')} only.` });
ipcMain.handle('launcher:host', async () => {
  if (LOCKED) return LOCKED_MSG();
  cfg.mode = 'host'; saveConfig();
  try { const port = await startServer(); win.loadURL(`http://localhost:${port}/channels/@me`); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('launcher:connect', async (_e, raw) => {
  if (LOCKED) return LOCKED_MSG();
  const origin = normalizeUrl(raw);
  if (!origin) return { ok: false, error: 'Enter a valid server address.' };
  try {
    const res = await enet.fetch(`${origin}/api/health`, { cache: 'no-store' });
    const data = await res.json();
    if (!data?.ok) throw new Error('not a NullChat server');
  } catch (e) { return { ok: false, error: `Couldn’t reach a NullChat server at ${origin}. (${e.message})` }; }
  const prev = cfg.url;
  cfg.mode = 'remote'; cfg.url = origin; saveConfig();
  if (origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) && prev !== origin) {
    app.relaunch(); quitting = true; app.exit(0); // restart so voice/video work on this LAN address
    return { ok: true };
  }
  win.loadURL(origin);
  return { ok: true };
});
ipcMain.on('app:switch-server', () => { if (!LOCKED) showLauncher(); });
ipcMain.handle('app:retry', () => { openApp(); return true; });
ipcMain.on('app:open-data', () => shell.openPath(cfg.dataDir || path.join(userData, 'data')));

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (link) handleDeepLink(link); else showWindow();
});
app.on('open-url', (e, link) => { e.preventDefault(); if (win) handleDeepLink(link); else pendingDeepLink = link; }); // macOS
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => { if (win) showWindow(); });

app.whenReady().then(() => {
  buildMenu();
  setupSession();
  if (firstRun) applyLoginItem();
  const trayIcon = IS_MAC ? nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png')) : nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  if (IS_MAC) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.on('click', showWindow);
  updateTray();
  startup();
});
