'use strict';
// Run by "Voice Relay Setup.bat" (or: node scripts/voice-relay.cjs). Turns on the voice relay for your online server, so calls
// connect for everyone, not only for people whose networks let each other in.
//
// Calls go directly between people. When someone's network blocks that (a phone on mobile data, school or work Wi-Fi, some
// home routers), those two people cannot hear each other at all. Discord never has this problem because it relays every call
// through its own servers. This borrows Cloudflare's relay for the same job: free for the first 1,000 GB, which is thousands
// of hours of voice. You make a key on Cloudflare's website once; this checks it and gives it to your server.
//
//   node scripts/voice-relay.cjs          set it up
//   node scripts/voice-relay.cjs --off    turn it off again
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const API = (process.env.CLOUDFLARE_TURN_API || 'https://rtc.live.cloudflare.com').replace(/\/+$/, '');
const OFF = process.argv.includes('--off');
const say = (s = '') => console.log(s);
const fail = (s) => { say(''); say('  ' + s.split('\n').join('\n  ')); say(''); process.exit(1); };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// (lines are queued as they arrive, so answers that were pasted or piped in ahead of the question are not lost)
const lines = []; const waiting = []; let ended = false;
rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(null); });
const ask = async (q) => {
  process.stdout.write(q);
  const l = lines.length ? lines.shift() : ended ? null : await new Promise((res) => waiting.push(res));
  if (l === null) { say(''); fail('No answer was given. Run this again when you have the two values.'); }
  return l.trim().replace(/^["']|["']$/g, '');
};

function appName() {
  try { return (fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8').match(/^app\s*=\s*"?([A-Za-z0-9-]+)"?/m) || [])[1] || ''; } catch { return ''; }
}
function findFly() {
  const ok = (cmd) => { const r = spawnSync(cmd, ['version'], { encoding: 'utf8' }); return !r.error && r.status === 0; };
  for (const c of ['fly', 'flyctl', path.join(os.homedir(), '.fly', 'bin', process.platform === 'win32' ? 'fly.exe' : 'fly'), path.join(os.homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl')]) if (ok(c)) return c;
  return null;
}
/** Ask Cloudflare for a relay login with this key: the only real proof the two values are right. */
async function check(keyId, token) {
  let r;
  try {
    r = await fetch(`${API}/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 120 }), signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { ok: false, why: `Could not reach Cloudflare (${e && e.name === 'TimeoutError' ? 'no answer' : (e && e.message) || e}). Check your internet connection.` }; }
  if (!r.ok) return { ok: false, why: r.status === 401 || r.status === 403 || r.status === 404 ? 'Cloudflare did not accept those two values. Copy them again: the first is the short "Turn Token ID", the second the long "API Token".' : `Cloudflare answered with an error (HTTP ${r.status}). Try again in a minute.` };
  let d = null; try { d = await r.json(); } catch { /* not JSON */ }
  const list = [].concat((d && d.iceServers) || []);
  if (!list.some((s) => s && s.username && [].concat(s.urls || []).some((u) => /^turns?:/.test(u)))) return { ok: false, why: 'Cloudflare answered, but without a relay. Make sure the key was made under Realtime > TURN Server.' };
  return { ok: true };
}

(async () => {
  say('');
  say('  ===============================================');
  say('     NullChat  -  voice relay setup');
  say('  ===============================================');
  say('');
  const app = appName();
  if (!app) fail('This must be run from your NullChat folder (the one with fly.toml in it).');
  const fly = findFly();
  if (!fly) fail('The Fly.io tool is not installed yet. Run "Deploy to Fly.io.bat" once first, then run this again.');
  if (spawnSync(fly, ['auth', 'whoami'], { encoding: 'utf8' }).status !== 0) {
    say('  You are not logged in to Fly.io. A browser window will open.');
    if (spawnSync(fly, ['auth', 'login'], { stdio: 'inherit' }).status !== 0) fail('Logging in to Fly.io did not finish. Run this again to retry.');
  }
  say(`  Server: ${app}  (https://${app}.fly.dev)`);
  say('');
  if (OFF) {
    const r = spawnSync(fly, ['secrets', 'unset', 'CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN', '-a', app], { stdio: 'inherit' });
    rl.close();
    if (r.status !== 0) fail('Fly.io would not change the setting (scroll up to see why).');
    say('\n  The voice relay is off. Calls go directly between people again.\n');
    return;
  }
  say('  Why: calls go straight from one person to another. When someone\'s network blocks');
  say('  that (mobile data, school or work Wi-Fi, some routers), they can\'t hear or be heard.');
  say('  A relay fixes it for everyone. This uses Cloudflare\'s: the first 1,000 GB are free,');
  say('  which is thousands of hours of voice.');
  say('');
  say('  Make the key (about 3 minutes, once):');
  say('    1. Go to  https://dash.cloudflare.com  and sign up or log in (free).');
  say('    2. In the left menu open  Media  >  Realtime  >  TURN Server.');
  say('       (It may be listed as "Realtime" or "Calls". Cloudflare may ask you to add a');
  say('        payment card before it lets you use Realtime; nothing is charged in the free amount.)');
  say('    3. Click  Create , give it any name (for example "nullchat"), and create it.');
  say('    4. It shows two values. Keep that page open and paste them below.');
  say('');
  let done = false;
  for (let i = 0; i < 5 && !done; i++) {
    const keyId = await ask('  Paste the Turn Token ID (the short one): ');
    const token = await ask('  Paste the API Token (the long one):      ');
    if (!keyId || !token) { say('\n  Both values are needed.\n'); continue; }
    say('\n  Checking them with Cloudflare...');
    const res = await check(keyId, token);
    if (!res.ok) { say('  ' + res.why + '\n'); continue; }
    say('  They work. Giving them to your server (it restarts; chats reconnect by themselves in a few seconds)...\n');
    const r = spawnSync(fly, ['secrets', 'set', `CLOUDFLARE_TURN_KEY_ID=${keyId}`, `CLOUDFLARE_TURN_API_TOKEN=${token}`, '-a', app], { stdio: 'inherit' });
    if (r.status !== 0) { rl.close(); fail('Fly.io would not save the setting (scroll up to see why). Nothing was changed.'); }
    done = true;
  }
  rl.close();
  if (!done) fail('The key was not accepted. Run this again when you have the two values.');
  say('');
  say('  Done! The voice relay is on.');
  say('  Everyone should leave the call and join again (or reload NullChat) once.');
  say('  To check: Settings > Voice & Video > Connection > "Check my connection" should say');
  say('  "The relay server works".');
  say('');
})().catch((e) => { try { rl.close(); } catch { /* closed */ } fail('Something went wrong: ' + (e && e.message ? e.message : e)); });
