#!/usr/bin/env node
// Gives your server the keys it needs to send notifications to the NullChat phone apps (docs/PHONE_APPS.md).
// It reads the key files you downloaded from Firebase and Apple, checks they are the right ones, and runs `fly secrets set` for you,
// so there is nothing to copy, quote or encode by hand.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELP = `
Usage:
  node scripts/phone-notification-keys.cjs --android <firebase-service-account.json>
  node scripts/phone-notification-keys.cjs --ios <AuthKey_XXXXXXXXXX.p8> --team-id <TEAMID> [--key-id <KEYID>] [--bundle-id <id>] [--sandbox]
  (both at once is fine: give all of the above)

  --android <file>   The Firebase "service account" key (Firebase > Project settings > Service accounts > Generate new private key).
                     NOT google-services.json: that one goes into the app, not the server.
  --ios <file>       The Apple Push Notifications key (.p8) from developer.apple.com > Keys.
  --key-id <id>      That key's 10-character Key ID. Left out, it is read from the file name (AuthKey_XXXXXXXXXX.p8).
  --team-id <id>     Your 10-character Apple Team ID (developer.apple.com > Membership details).
  --bundle-id <id>   The iPhone app's bundle id. Left out, the appId in mobile/nullchat-app.json is used.
  --sandbox          Only for apps run from Xcode on your own phone. TestFlight and App Store builds must NOT use it.
  --app <name>       The Fly.io app name, if this folder's fly.toml isn't the one you want.
  --dry-run          Check everything and show what would be set, without setting anything.
  --env              Print NAME=value lines for a .env file instead of using Fly.io (for NullChat running somewhere else).
`;

function parse(argv) {
  const o = { sandbox: false, dryRun: false, env: false };
  const takes = { '--android': 'android', '--ios': 'ios', '--key-id': 'keyId', '--team-id': 'teamId', '--bundle-id': 'bundleId', '--app': 'app' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sandbox') o.sandbox = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--env') o.env = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (takes[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value after it.`);
      o[takes[a]] = v;
    } else throw new Error(`I don't know "${a}". Run it with --help to see what it understands.`);
  }
  return o;
}

function readFile(file, what) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new Error(`I can't find ${what}: ${p}`);
  return fs.readFileSync(p);
}

function androidSecrets(file) {
  const buf = readFile(file, 'the Firebase key file');
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`${file} isn't a JSON file. Use the key file Firebase downloads when you click "Generate new private key".`); }
  if (j && Array.isArray(j.client) && j.project_info) {
    throw new Error(`${file} is google-services.json: that file goes into the app (as the GOOGLE_SERVICES_JSON secret on GitHub), not onto the server.\nThe server needs the other one: Firebase > Project settings > Service accounts > Generate new private key.`);
  }
  const missing = ['project_id', 'client_email', 'private_key'].filter((k) => !j || !j[k]);
  if (missing.length) throw new Error(`${file} is missing ${missing.join(', ')}, so it isn't a Firebase service account key. Download it again from Firebase > Project settings > Service accounts > Generate new private key.`);
  return { FCM_SERVICE_ACCOUNT_B64: buf.toString('base64') };
}

function iosSecrets(o, mobileDir) {
  const buf = readFile(o.ios, 'the Apple .p8 key file');
  if (!/-----BEGIN PRIVATE KEY-----/.test(buf.toString('utf8'))) throw new Error(`${o.ios} isn't an Apple .p8 key (it should start with -----BEGIN PRIVATE KEY-----).`);
  const keyId = (o.keyId || (/^AuthKey_([A-Z0-9]{10})\.p8$/i.exec(path.basename(o.ios)) || [])[1] || '').toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error('I need the key\'s 10-character Key ID: add --key-id XXXXXXXXXX (it is shown next to the key on developer.apple.com, and is part of the file name AuthKey_XXXXXXXXXX.p8).');
  const teamId = (o.teamId || '').toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('I need your 10-character Apple Team ID: add --team-id XXXXXXXXXX (developer.apple.com > Membership details).');
  let bundleId = o.bundleId || '';
  if (!bundleId) {
    try { bundleId = JSON.parse(fs.readFileSync(path.join(mobileDir, 'nullchat-app.json'), 'utf8')).appId || ''; } catch { /* no mobile folder: ask below */ }
  }
  if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(bundleId)) throw new Error('I need the iPhone app\'s bundle id: add --bundle-id chat.nullchat.app (the appId in mobile/nullchat-app.json).');
  return { APNS_KEY_B64: buf.toString('base64'), APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId, APNS_SANDBOX: o.sandbox ? 'true' : 'false' };
}

const mask = (k, v) => (/_B64$/.test(k) ? `<${v.length} characters, hidden>` : v);

function main(argv, { mobileDir = path.join(__dirname, '..', 'mobile'), out = console.log, err = console.error } = {}) {
  let o;
  try {
    o = parse(argv);
    if (o.help || (!o.android && !o.ios)) { out(HELP); return o.help ? 0 : 1; }
    if (o.sandbox && !o.ios) throw new Error('--sandbox only means something together with --ios.');
    const secrets = { ...(o.android ? androidSecrets(o.android) : {}), ...(o.ios ? iosSecrets(o, mobileDir) : {}) };
    const names = Object.keys(secrets);

    if (o.env) { for (const k of names) out(`${k}=${secrets[k]}`); return 0; }
    if (o.dryRun) {
      out('Checked. This is what would be set on your server (nothing was changed):');
      for (const k of names) out(`  ${k}=${mask(k, secrets[k])}`);
      return 0;
    }
    const args = ['secrets', 'set', ...names.map((k) => `${k}=${secrets[k]}`), ...(o.app ? ['--app', o.app] : [])];
    const r = spawnSync('fly', args, { stdio: 'inherit' });
    if (r.error && r.error.code === 'ENOENT') throw new Error('The Fly.io tool ("fly") isn\'t installed, or isn\'t on this window\'s PATH. Run "Deploy to Fly.io.bat" once (it installs it), then try again. Not on Fly.io? Add --env to get lines for your .env file instead.');
    if (r.status !== 0) { err('\nFly.io did not accept that (see its message above). Nothing else was changed.'); return r.status || 1; }
    out(`\nDone. Your server restarts by itself and now sends notifications to ${[o.android && 'Android', o.ios && 'iPhone'].filter(Boolean).join(' and ')} phones.`);
    out('Check Admin Panel > Overview: it lists "Phone app notifications" once they are on.');
    return 0;
  } catch (e) {
    err('\n' + e.message + '\n');
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, parse };
