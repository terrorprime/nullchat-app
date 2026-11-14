'use strict';
// Run by "Deploy to Fly.io.bat": is the Windows desktop app in the "downloads" folder the one this version of NullChat ships?
//   exit 0 = yes (NullChatSetup.exe is there and its latest.yml names the version in desktop/package.json)
//   exit 1 = no  (missing, or an older version): the deploy script then builds it before uploading, so the people who have the
//                app installed get the update and the "Download Apps" window has something to offer.
// The folder is emptied whenever a new NullChat zip is unzipped into a fresh folder, which is why this cannot be left to memory.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'downloads');
let want = '';
try { want = String(JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8')).version || ''); } catch { /* no desktop folder: nothing to build */ }
if (!want) process.exit(0);
// The Mac and Linux apps built by "Build Mac App.bat" are kept in a folder of their own outside this one, because unzipping a
// NullChat update into a fresh folder leaves "downloads" without them. Put back whatever is missing, so they stay online.
try {
  const keep = path.join(require('node:os').homedir(), '.nullchat', 'built-apps');
  const kept = fs.existsSync(keep) ? fs.readdirSync(keep).filter((f) => /\.(dmg|appimage|deb)$|-mac-[^/\\]*\.zip$|^latest-(mac|linux)[^/\\]*\.yml$/i.test(f)) : [];
  const here = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const kindOf = (f) => f.replace(/\d+\.\d+\.\d+/, '*');
  const back = kept.filter((f) => !here.some((h) => !/launcher/i.test(h) && kindOf(h) === kindOf(f)));
  if (back.length) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of back) fs.copyFileSync(path.join(keep, f), path.join(dir, f));
    const mac = back.find((f) => /\.dmg$/i.test(f));
    const v = mac && (mac.match(/\d+\.\d+\.\d+/) || [])[0];
    console.log(`   Put the ${mac ? 'Mac' : 'Linux'}${mac && back.some((f) => /appimage|\.deb$/i.test(f)) ? ' and Linux' : ''} app${back.length > 1 ? 's' : ''} you built earlier back into the downloads folder (${back.length} file${back.length > 1 ? 's' : ''}).`);
    if (v && want && v !== want) console.log(`   (That Mac app is version ${v}; this NullChat ships ${want}. Run "Build Mac App.bat" when you want it updated.)`);
  } else if (!here.some((h) => /\.dmg$/i.test(h))) {
    console.log('   No Mac app has been built yet: Mac users get the version that opens through Chrome. Run "Build Mac App.bat" to make the real one.');
  }
} catch (e) { console.log('   (Could not look for the Mac app built earlier: ' + (e && e.message ? e.message : e) + ')'); }

let have = '';
try { have = (fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8').match(/^version:\s*['"]?([^\s'"]+)/m) || [])[1] || ''; } catch { /* none */ }
let size = 0;
try { size = fs.statSync(path.join(dir, 'NullChatSetup.exe')).size; } catch { /* none */ }
if (size > 1024 * 1024 && have === want) { console.log(`   Desktop app ${want} is in the downloads folder.`); process.exit(0); }
console.log(size ? `   The desktop app in the downloads folder is version ${have || 'unknown'}; this NullChat ships ${want}.` : '   There is no desktop app in the downloads folder yet.');
process.exit(1);
