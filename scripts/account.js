#!/usr/bin/env node
// Account help for the server owner, for when you cannot log in and password-reset email is not set up.
// It works directly on the database, so run it where the data lives (on Fly: see SETUP-FLY.md).
//
//   node scripts/account.js list                         shows every account (name, email, created, suspended?)
//   node scripts/account.js password <name> <new pass>   sets a new password (name = username or email)
//   node scripts/account.js unsuspend <name>             lifts a suspension
//   node scripts/account.js mfa-off <name>               turns off two-step login for that account
//
// Message contents are never read or printed.
import { db, get, all, run } from '../server/src/db.js';
import { hashPassword } from '../server/src/lib/security.js';
import { DB_PATH } from '../server/src/db.js';

const [cmd, who, pass] = process.argv.slice(2);
const find = (name) => get('SELECT * FROM users WHERE email = ? OR username = ?', String(name || '').trim().toLowerCase(), String(name || '').trim().toLowerCase());
const fail = (m) => { console.error(m); process.exit(1); };

console.log(`Database: ${DB_PATH}`);
switch (cmd) {
  case 'list': {
    const rows = all('SELECT username, email, created_at, banned_at, mfa_enabled FROM users ORDER BY created_at');
    if (!rows.length) console.log('There are no accounts in this database.');
    for (const u of rows) {
      console.log(`  ${u.username.padEnd(20)} ${u.email.padEnd(32)} ${new Date(u.created_at).toISOString().slice(0, 10)}${u.banned_at ? '  SUSPENDED' : ''}${u.mfa_enabled ? '  2-step on' : ''}`);
    }
    console.log(`${rows.length} account(s).`);
    break;
  }
  case 'password': {
    if (!who || !pass) fail('Usage: node scripts/account.js password <username-or-email> <new password>');
    if (pass.length < 8 || pass.length > 128) fail('The new password must be 8 to 128 characters.');
    const u = find(who);
    if (!u) fail(`No account named "${who}". Run "node scripts/account.js list" to see the accounts.`);
    const hash = await hashPassword(pass);
    db.exec('BEGIN');
    try {
      run('UPDATE users SET password_hash = ? WHERE id = ?', hash, u.id);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`Password changed for ${u.username}. Everyone signed in as them has been signed out.`);
    break;
  }
  case 'unsuspend': {
    const u = find(who);
    if (!u) fail(`No account named "${who}".`);
    run('UPDATE users SET banned_at = NULL, banned_reason = NULL WHERE id = ?', u.id);
    console.log(`${u.username} is no longer suspended.`);
    break;
  }
  case 'mfa-off': {
    const u = find(who);
    if (!u) fail(`No account named "${who}".`);
    run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?', u.id);
    console.log(`Two-step login is off for ${u.username}.`);
    break;
  }
  default:
    console.log('Usage:\n  node scripts/account.js list\n  node scripts/account.js password <username-or-email> <new password>\n  node scripts/account.js unsuspend <username-or-email>\n  node scripts/account.js mfa-off <username-or-email>');
}
process.exit(0);
