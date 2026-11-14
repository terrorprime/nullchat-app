// Helper for "Deploy to Fly.io.bat" and "Build Installer.bat".
//   node scripts/fly-rename.cjs <app-name>   set the Fly app name in fly.toml and point the desktop app at it
//   node scripts/fly-rename.cjs --print-name    print the app name currently in fly.toml
//   node scripts/fly-rename.cjs --print-region  print primary_region from fly.toml
//   node scripts/fly-rename.cjs --print-url     print the server address baked into the desktop app
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tomlFile = path.join(root, 'fly.toml');
const cfgFile = path.join(root, 'desktop', 'app-config.json');
const arg = (process.argv[2] || '').trim();

const readToml = () => fs.readFileSync(tomlFile, 'utf8');
const pick = (re) => { const m = readToml().match(re); return m ? m[1] : ''; };

if (arg === '--print-name') { console.log(pick(/^app = "(.*)"$/m)); process.exit(0); }
if (arg === '--print-region') { console.log(pick(/^primary_region = "([^"]*)"/m) || 'ord'); process.exit(0); }
if (arg === '--print-url') {
  try { console.log(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).serverUrl || ''); } catch { console.log(''); }
  process.exit(0);
}

const name = arg.toLowerCase();
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
  console.error('  App names can only use lowercase letters, numbers and dashes (3-63 characters, no spaces).');
  process.exit(1);
}
const url = `https://${name}.fly.dev`;

const toml = readToml()
  .replace(/^app = ".*"$/m, `app = "${name}"`)
  .replace(/^(\s*PUBLIC_URL = )".*"$/m, `$1"${url}"`);
fs.writeFileSync(tomlFile, toml);

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new file */ }
cfg.serverUrl = url;
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

console.log(`  Using ${url}`);
