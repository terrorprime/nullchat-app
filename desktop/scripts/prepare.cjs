// Copies the NullChat server, shared code and the built web client into desktop/bundle so they are
// packaged inside the desktop app, and writes app-config.json (which server the app opens, and
// where it checks for updates).
//
//   NULLCHAT_SERVER_URL   – the server the app connects to automatically (e.g. https://chat.example.com).
//                           Leave empty and the app asks on first launch (host on this PC, or join a server).
//   NULLCHAT_UPDATE_URL   – where to look for updates (default: <server>/downloads).
//   NULLCHAT_ALLOW_SERVER_SWITCH – set to 1 to let people switch servers. By default an app with a server
//                           baked in is locked to it.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const desktop = path.resolve(__dirname, '..');
const out = path.join(desktop, 'bundle');
const dist = path.join(root, 'client', 'dist', 'index.html');

if (!fs.existsSync(dist)) {
  console.error('\n✖ The web client has not been built yet.');
  console.error('  From the project root run:  npm run build\n  (or use "npm run desktop:win", which does it for you)\n');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
copy('server/src', 'server/src');
copy('server/package.json', 'server/package.json');
copy('shared', 'shared');
copy('client/dist', 'client/dist');
fs.rmSync(path.join(out, 'server', 'src', 'seed.js'), { force: true });

// app-config.json: environment variables win over the checked-in file.
const cfgFile = path.join(desktop, 'app-config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new file */ }
if (process.env.NULLCHAT_SERVER_URL !== undefined) cfg.serverUrl = process.env.NULLCHAT_SERVER_URL.trim();
if (process.env.NULLCHAT_UPDATE_URL !== undefined) cfg.updateUrl = process.env.NULLCHAT_UPDATE_URL.trim();
if (process.env.NULLCHAT_ALLOW_SERVER_SWITCH !== undefined) cfg.allowServerSwitch = /^(1|true|yes)$/i.test(process.env.NULLCHAT_ALLOW_SERVER_SWITCH.trim());
if (process.env.CSC_LINK) cfg.macSigned = true;
cfg = { serverUrl: '', updateUrl: '', allowServerSwitch: false, macSigned: false, ...cfg };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

// The Linux .deb package needs a homepage; point it at the server this app belongs to.
if (/^https?:\/\/[^\s"\\]+$/.test(cfg.serverUrl)) {
  const pkgFile = path.join(desktop, 'package.json');
  const src = fs.readFileSync(pkgFile, 'utf8');
  const next = src.replace(/("homepage":\s*")[^"]*(")/, `$1${cfg.serverUrl}$2`);
  if (next !== src) fs.writeFileSync(pkgFile, next);
}

console.log('✔ Desktop bundle prepared in desktop/bundle');
console.log(cfg.serverUrl
  ? `  The app will connect to ${cfg.serverUrl}${cfg.allowServerSwitch ? '' : ' and is locked to it (people cannot switch servers)'} and check ${cfg.updateUrl || cfg.serverUrl + '/downloads'} for updates.`
  : '  No server set — on first launch the app asks to host on this PC or join a server.');
