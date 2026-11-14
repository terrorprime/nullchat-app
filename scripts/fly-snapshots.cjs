// Used by "Deploy to Fly.io.bat": keeps Fly's automatic daily disk snapshots for 14 days
// (Fly's default is 5). Safe to run every time; if anything goes wrong it only prints a note,
// because this is a nice-to-have and must never stop a deploy.
// Usage: node scripts/fly-snapshots.cjs <app-name>
const { spawnSync } = require('node:child_process');

const app = (process.argv[2] || '').trim();
const DAYS = '14';
if (!app) process.exit(0);

function fly(args) {
  return spawnSync('fly', args, { encoding: 'utf8', shell: process.platform === 'win32' });
}

try {
  const list = fly(['volumes', 'list', '-a', app, '--json']);
  const volumes = JSON.parse(list.stdout || '[]');
  const vol = volumes.find((v) => (v.name || v.Name) === 'nullchat_data');
  const id = vol && (vol.id || vol.ID);
  if (!id) { console.log('  (Skipped snapshot setting: could not find the data disk.)'); process.exit(0); }
  const res = fly(['volumes', 'update', id, '-a', app, '--snapshot-retention', DAYS]);
  console.log(res.status === 0
    ? `  Disk snapshots are kept for ${DAYS} days.`
    : '  (Could not change snapshot retention. Fly keeps 5 days by default, which is fine.)');
} catch {
  console.log('  (Skipped snapshot setting.)');
}
