'use strict';
// Run by "Deploy to Fly.io.bat" so a broken installer never goes online unnoticed.
//   node scripts/check-downloads.cjs                  before the upload: is downloads\NullChatSetup.exe whole?
//   node scripts/check-downloads.cjs --live <url>     after the upload: does the server hold the same file as this folder?
// Exit code: 0 = fine (or nothing to check), 1 = no installer in downloads\ (a note, deploy goes on),
//            2 = the installer is damaged (do not deploy it), 3 = the server's copy is not this folder's copy.
const fs = require('node:fs');
const path = require('node:path');
const { inspectFile } = require('../server/src/lib/installer-check.cjs');

const DIR = path.join(__dirname, '..', 'downloads');
const installers = () => { try { return fs.readdirSync(DIR).filter((n) => /\.(exe|msi)$/i.test(n)); } catch { return []; } };

async function before() {
  const list = installers();
  if (!list.length) {
    console.log('   Note: there is no Windows installer in the "downloads" folder, so the Get the app window will say it is not');
    console.log('   available yet. To add it: double-click "Build Installer.bat", wait for it to finish, then run "Deploy to Fly.io.bat" again.');
    return 1;
  }
  let bad = 0;
  for (const name of list) {
    const r = await inspectFile(path.join(DIR, name));
    if (r.problem) { bad++; console.log(`   PROBLEM: downloads\\${name} is damaged. ${r.problem}`); }
    else console.log(`   Installer checked: ${name} is whole.`);
  }
  if (bad) {
    console.log('');
    console.log('   Nothing was uploaded. Double-click "Build Installer.bat" and wait until it says Done (do not run both at the');
    console.log('   same time), then run "Deploy to Fly.io.bat" again.');
    return 2;
  }
  return 0;
}

async function live(base) {
  const list = installers();
  if (!list.length) return 0;
  const url = String(base).replace(/\/+$/, '') + '/api/downloads';
  for (let attempt = 1; attempt <= 4; attempt++) {
    let served;
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      served = await res.json();
    } catch {
      if (attempt < 4) { await new Promise((r) => setTimeout(r, 4000)); continue; }
      console.log('   (Could not reach the server to double-check the installer. Open the site and try "Get the app" yourself.)');
      return 0;
    }
    let bad = 0;
    for (const name of list) {
      const mine = await inspectFile(path.join(DIR, name));
      const theirs = served.find((f) => f.name === name);
      if (!theirs) { bad++; console.log(`   PROBLEM: the server does not offer ${name}.`); }
      else if (theirs.damaged) { bad++; console.log(`   PROBLEM: the server says its copy of ${name} is damaged: ${theirs.damaged}`); }
      else if (theirs.sha256 !== mine.sha256) { bad++; console.log(`   PROBLEM: the server's copy of ${name} is not the same file as the one in "downloads".`); }
      else console.log(`   Installer on the server checked: ${name} matches your copy.`);
    }
    if (bad) { console.log('   Run "Deploy to Fly.io.bat" again, and leave "Build Installer.bat" closed while it uploads.'); return 3; }
    return 0;
  }
  return 0;
}

(async () => {
  const i = process.argv.indexOf('--live');
  process.exitCode = i > -1 ? await live(process.argv[i + 1] || '') : await before();
})().catch((e) => { console.log('   (Installer check skipped: ' + (e && e.message) + ')'); process.exitCode = 0; });
