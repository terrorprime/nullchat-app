// Safe bridge between the NullChat web app / launcher / splash and the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nullchatDesktop', {
  isDesktop: true,
  callWindow: true,   // this app can open a window of its own for a call (see main.cjs, 'nullchat-pip')
  callWindowShare: true,   // that window may capture the screen itself, so Share your screen is chosen and started inside it
  callWindowOnTop: (on) => ipcRenderer.invoke('call-window:on-top', !!on),   // keep that window above other windows, or not
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  host: () => ipcRenderer.invoke('launcher:host'),
  connect: (url) => ipcRenderer.invoke('launcher:connect', url),
  switchServer: () => ipcRenderer.send('app:switch-server'),
  retry: () => ipcRenderer.invoke('app:retry'),
  setPref: (key, value) => ipcRenderer.invoke('app:set-pref', key, value),
  setKeepRunning: (v) => ipcRenderer.invoke('app:set-pref', 'keepRunning', !!v),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  // App updates: the shell reports { state, version, percent } and the page can restart into a downloaded one.
  onUpdate: (fn) => ipcRenderer.on('update:status', (_e, d) => fn(d)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openDataFolder: () => ipcRenderer.send('app:open-data'),
  // In-app screen share picker (see screenshare.cjs)
  screenSources: () => ipcRenderer.invoke('screenshare:sources'),
  screenChoose: (id, audio) => ipcRenderer.invoke('screenshare:choose', { id, audio: !!audio }),
  // Names of running programs, used only on this computer to spot a known game (see client/src/lib/activity.js).
  processList: () => ipcRenderer.invoke('activity:processes'),
  onSplash: (fn) => ipcRenderer.on('splash:status', (_e, d) => fn(d)),
});
