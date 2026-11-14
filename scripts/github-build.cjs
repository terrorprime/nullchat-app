'use strict';
// Run by "Build Mac App.bat" (or: node scripts/github-build.cjs). Gets the real Mac app (and the Linux one) built for you when
// you only have a Windows PC. A Mac app can only be built on a Mac, so this borrows GitHub's: it puts a private copy of this
// folder on your GitHub account, starts the "Build desktop apps" workflow there, waits for it, and brings the finished files
// back into the "downloads" folder. After that, "Deploy to Fly.io.bat" puts them online.
//
//   node scripts/github-build.cjs              Mac and Linux apps
//   node scripts/github-build.cjs --mac-only   only the Mac app
//   node scripts/github-build.cjs --all        Windows too (you normally build that one with "Build Installer.bat")
//
// It needs two free tools, Git and the GitHub CLI ("gh"), and offers to install them on Windows. Your accounts, messages,
// uploads, passwords and the big installer files never leave this computer: .gitignore keeps them out of the copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const TARGETS = args.includes('--all') ? 'all' : args.includes('--mac-only') ? 'mac' : 'mac-linux';
const YES = args.includes('--yes');
const REPO_NAME = 'nullchat-app';
const WORKFLOW = 'desktop.yml';

const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n[${n}/6] ${s}`);
const fail = (s) => { say(''); say('  ' + s.split('\n').join('\n  ')); say(''); process.exit(1); };
const ask = (q) => new Promise((res) => {
  if (YES) { res('y'); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find a program: on the PATH, or where its Windows installer puts it (a fresh install is not on this window's PATH yet). */
function find(name, places) {
  const ok = (cmd) => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0; };
  if (ok(name)) return name;
  for (const p of places) if (p && fs.existsSync(p) && ok(p)) return p;
  return null;
}
const env = process.env;
const findGit = () => find('git', WIN ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'), path.join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe')] : []);
const findGh = () => find('gh', WIN ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'), path.join(env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')] : []);

let GIT = null, GH = null;
/** Run a program. `show`: let it talk to the person directly. Returns { ok, out }. */
function run(cmd, a, { show = false, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8', stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
const git = (a, o) => run(GIT, a, o);
const gh = (a, o) => run(GH, a, o);

async function tools() {
  step(1, 'Checking for Git and the GitHub tool...');
  GIT = findGit(); GH = findGh();
  const missing = [!GIT && ['Git', 'Git.Git', 'https://git-scm.com/download/win'], !GH && ['the GitHub tool (gh)', 'GitHub.cli', 'https://cli.github.com']].filter(Boolean);
  if (!missing.length) { say('  Both are installed.'); return; }
  const names = missing.map((m) => m[0]).join(' and ');
  const haveWinget = WIN && !spawnSync('winget', ['--version'], { encoding: 'utf8' }).error;
  if (!haveWinget) fail(`${names} ${missing.length > 1 ? 'are' : 'is'} not installed.\nInstall from:\n${missing.map((m) => '  ' + m[2]).join('\n')}\nthen run this again.`);
  const a = await ask(`  ${names} ${missing.length > 1 ? 'are' : 'is'} not installed. Install now? (free, from Microsoft's winget) [Y/n] `);
  if (/^n/i.test(a)) fail('Nothing was installed. Run this again when you are ready.');
  for (const m of missing) {
    say(`\n  Installing ${m[0]}... (Windows may ask for permission)`);
    spawnSync('winget', ['install', '--id', m[1], '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit' });
  }
  GIT = findGit(); GH = findGh();
  if (!GIT || !GH) fail(`The install finished but ${!GIT ? 'Git' : 'the GitHub tool'} still can not be found.\nClose this window and double-click the file again (a new window sees newly installed programs).`);
}

async function login() {
  step(2, 'Signing in to GitHub...');
  if (!gh(['auth', 'status', '--hostname', 'github.com']).ok) {
    say('  You need a free GitHub account (github.com). A browser window opens: sign in (or sign up) there');
    say('  and type the code shown below when it asks.');
    say('');
    const r = gh(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'repo,workflow'], { show: true });
    if (!r.ok || !gh(['auth', 'status', '--hostname', 'github.com']).ok) fail('Signing in did not finish. Run this again to retry.');
  }
  const who = gh(['api', 'user', '--jq', '.login']);
  if (!who.ok || !who.out) fail('Could not read your GitHub account name.\n' + who.out);
  gh(['auth', 'setup-git', '--hostname', 'github.com']);   // lets Git upload with the same sign-in
  say(`  Signed in as ${who.out.split('\n').pop().trim()}.`);
  return who.out.split('\n').pop().trim();
}

// Things that must never go into the copy, added to .gitignore if they are not there.
const KEEP_OUT = ['node_modules/', 'data/', '.env', '.env.*', '!.env.example', 'desktop/release/', 'desktop/bundle/', 'downloads/*', '!downloads/README.txt', '*.pem', '*.p12', '*.keystore', '*.jks', '*.log'];
function guardIgnore() {
  const file = path.join(ROOT, '.gitignore');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = KEEP_OUT.filter((l) => !have.has(l));
  if (add.length) fs.writeFileSync(file, cur.replace(/\s*$/, '\n') + '\n# Added by scripts/github-build.cjs: private or huge files that stay on this computer.\n' + add.join('\n') + '\n');
}

async function upload(user) {
  step(3, 'Putting a private copy of this folder on your GitHub account...');
  guardIgnore();
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    if (!git(['init', '-b', 'main']).ok) { git(['init']); git(['checkout', '-b', 'main']); }
    git(['config', 'nullchat.buildrepo', 'true']);   // (this script made the repository, so it may overwrite its online copy)
  }
  git(['config', 'core.autocrlf', 'false']);   // (keep files byte for byte: the Mac build scripts must not get Windows line endings)
  git(['config', 'core.longpaths', 'true']);
  const add = git(['add', '-A']);
  if (!add.ok) fail('Git could not read this folder.\n' + add.out);
  // A last look at what is about to be uploaded: nothing private, nothing GitHub refuses.
  const staged = git(['ls-files', '-z']).out.split('\0').filter(Boolean);
  const bad = staged.filter((f) => (/^data\//.test(f) || /(^|\/)node_modules\//.test(f) || /(^|\/)\.env($|\.)/.test(f)) && !/\.env\.example$/.test(f));
  if (bad.length) fail(`Stopped: these private files would have been uploaded:\n${bad.slice(0, 10).join('\n')}\nNothing was uploaded.`);
  const huge = staged.filter((f) => { try { return fs.statSync(path.join(ROOT, f)).size > 95 * 1024 * 1024; } catch { return false; } });
  if (huge.length) fail(`Stopped: GitHub refuses files over 100 MB, and this folder has:\n${huge.join('\n')}\nMove ${huge.length > 1 ? 'them' : 'it'} out of the folder and run this again.`);
  if (git(['status', '--porcelain']).out || !git(['rev-parse', '--verify', 'HEAD']).ok) {
    const c = git(['-c', `user.name=${user}`, '-c', `user.email=${user}@users.noreply.github.com`, 'commit', '-m', `NullChat ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
    if (!c.ok && !/nothing to commit/i.test(c.out)) fail('Git could not save the copy.\n' + c.out.slice(-800));
  }
  let slug = '';
  const origin = git(['config', '--get', 'remote.origin.url']);
  if (origin.ok) {
    slug = (origin.out.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/) || [])[1] || '';
    if (!slug) fail(`This folder is already linked to something that is not GitHub:\n${origin.out}`);
  } else {
    slug = `${user}/${REPO_NAME}`;
    if (!gh(['repo', 'view', slug, '--json', 'name']).ok) {
      const c = gh(['repo', 'create', slug, '--private', '--description', 'NullChat (private copy, used to build the desktop apps)']);
      if (!c.ok) fail('GitHub would not create the private repository.\n' + c.out.slice(-600));
      say(`  Created the private repository ${slug}.`);
    }
    git(['remote', 'add', 'origin', `https://github.com/${slug}.git`]);
  }
  const mine = git(['config', '--get', 'nullchat.buildrepo']).out === 'true';
  const doPush = () => git(['push', ...(mine ? ['--force'] : []), '-u', 'origin', 'HEAD:main']);
  let push = doPush();
  if (!push.ok && /workflow/i.test(push.out)) {   // (an older sign-in may not be allowed to upload the build recipe)
    say('  GitHub needs one more permission to accept the build recipe. Follow the prompt:');
    gh(['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow'], { show: true });
    push = doPush();
  }
  if (!push.ok) fail('The upload to GitHub failed.\n' + push.out.slice(-800) + '\nCheck your internet connection and run this again.');
  gh(['repo', 'edit', slug, '--default-branch', 'main']);
  say(`  Uploaded to github.com/${slug} (private: only you can see it).`);
  return slug;
}

function serverUrl() {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'app-config.json'), 'utf8')).serverUrl || '').trim(); } catch { return ''; }
}

async function build(slug) {
  step(4, 'Starting the build on GitHub...');
  const url = serverUrl();
  if (url) {
    const v = gh(['variable', 'set', 'NULLCHAT_SERVER_URL', '--repo', slug, '--body', url]);
    if (!v.ok) fail('Could not tell GitHub your server address.\n' + v.out.slice(-400));
    say(`  The apps will open ${url}.`);
  } else say('  No server address is set (desktop/app-config.json), so the apps will ask for one when first opened.');
  const since = Date.now() - 90 * 1000;
  let started = null;
  for (let i = 0; i < 6 && !started; i++) {   // (a brand-new repository takes a moment to notice its workflow)
    const r = gh(['workflow', 'run', WORKFLOW, '--repo', slug, '--ref', 'main', '-f', `targets=${TARGETS}`]);
    if (r.ok) started = true; else { if (i === 5) fail('GitHub would not start the build.\n' + r.out.slice(-600)); await sleep(5000); }
  }
  let id = null;
  for (let i = 0; i < 30 && !id; i++) {
    await sleep(4000);
    const l = gh(['run', 'list', '--repo', slug, '--workflow', WORKFLOW, '--event', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt']);
    try { id = (JSON.parse(l.out).filter((x) => Date.parse(x.createdAt) >= since).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || {}).databaseId || null; } catch { /* not listed yet */ }
  }
  if (!id) fail(`The build was started but could not be found. Look at github.com/${slug}/actions`);
  say(`  Started. You can also watch it at github.com/${slug}/actions/runs/${id}`);
  step(5, 'Waiting for GitHub to build the apps (about 10 to 15 minutes; leave this window open)...');
  gh(['run', 'watch', String(id), '--repo', slug, '--interval', '30'], { show: true });
  const done = gh(['run', 'view', String(id), '--repo', slug, '--json', 'conclusion', '--jq', '.conclusion']);
  if (done.out.split('\n').pop().trim() !== 'success') {
    // Keep GitHub's own account of what went wrong next to this script, so it can be read (or sent to whoever is helping).
    const file = path.join(ROOT, 'mac-build-error.log');
    const log = gh(['run', 'view', String(id), '--repo', slug, '--log-failed']);
    let saved = false;
    if (log.out) { try { fs.writeFileSync(file, log.out + '\n'); saved = true; } catch { /* the folder is read-only */ } }
    const lines = log.out.split(/\r?\n/).map((l) => l.replace(/^[^\t]*\t[^\t]*\t(\S+Z )?/, '').trimEnd()).filter(Boolean);
    const worst = lines.filter((l) => /error|⨯|failed|not a file|cannot|ERR!/i.test(l) && !/^npm warn/i.test(l)).slice(-12);
    fail(`The build did not finish (${done.out.split('\n').pop().trim() || 'unknown'}).\n${worst.length ? 'What GitHub said:\n' + worst.map((l) => '  ' + l.slice(0, 300)).join('\n') + '\n' : ''}${saved ? 'The full report was saved as mac-build-error.log in this folder.\n' : ''}See it online at github.com/${slug}/actions/runs/${id}\nNothing in your downloads folder was changed.`);
  }
  return id;
}

// where built Mac and Linux apps are kept between updates (see scripts/need-installer.cjs)
const KEEP = path.join(os.homedir(), '.nullchat', 'built-apps');
const WANTED = /\.(dmg|appimage|deb)$|-mac-[^/\\]*\.zip$|^latest-(mac|linux)[^/\\]*\.yml$/i;
function collect(slug, id) {
  step(6, 'Bringing the finished apps into the "downloads" folder...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nullchat-build-'));
  const names = TARGETS === 'mac' ? ['NullChat-macOS'] : TARGETS === 'all' ? ['NullChat-macOS', 'NullChat-Linux', 'NullChat-Windows'] : ['NullChat-macOS', 'NullChat-Linux'];
  const got = [];
  for (const n of names) {
    const dir = path.join(tmp, n);
    const d = gh(['run', 'download', String(id), '--repo', slug, '--name', n, '--dir', dir]);
    if (!d.ok) { say(`  Could not download ${n}: ${d.out.slice(-200)}`); continue; }
    const walk = (p) => fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
    for (const f of walk(dir)) {
      const base = path.basename(f);
      if (!(WANTED.test(base) || (TARGETS === 'all' && /\.(exe|blockmap)$|^latest\.yml$/i.test(base)))) continue;
      for (const out of [path.join(ROOT, 'downloads'), path.join(ROOT, 'data', 'downloads')]) {
        if (out.includes(path.join('data', 'downloads')) && !fs.existsSync(path.join(ROOT, 'data'))) continue;
        fs.mkdirSync(out, { recursive: true });
        // an older version of the same kind of file would otherwise sit next to the new one
        const kind = base.replace(/\d+\.\d+\.\d+/, '*');
        for (const old of fs.readdirSync(out)) if (old !== base && old.replace(/\d+\.\d+\.\d+/, '*') === kind && !/launcher/i.test(old)) fs.rmSync(path.join(out, old), { force: true });
        fs.copyFileSync(f, path.join(out, base));
      }
      // A copy is also kept outside this folder. Unzipping a NullChat update into a fresh folder empties "downloads"; the
      // deploy script puts these back from the copy, so the Mac and Linux apps stay online without building them again.
      try {
        fs.mkdirSync(KEEP, { recursive: true });
        const kind = base.replace(/\d+\.\d+\.\d+/, '*');
        for (const old of fs.readdirSync(KEEP)) if (old !== base && old.replace(/\d+\.\d+\.\d+/, '*') === kind) fs.rmSync(path.join(KEEP, old), { force: true });
        fs.copyFileSync(f, path.join(KEEP, base));
      } catch { /* the copy is a convenience: the build still counts */ }
      got.push(base);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!got.some((g) => /\.dmg$/i.test(g))) fail('The build finished but the Mac app was not in it. Nothing else was changed.');
  return got;
}

(async () => {
  say('');
  say('  =====================================================');
  say(`     NullChat  -  build the Mac ${TARGETS === 'mac' ? 'app' : 'and Linux apps'} (on GitHub)`);
  say('  =====================================================');
  say('');
  say('  A Mac app can only be built on a Mac, so this uses GitHub\'s, for free:');
  say('  it uploads a PRIVATE copy of this folder to your GitHub account, GitHub builds');
  say('  the apps, and the finished files come back into the "downloads" folder.');
  say('  Your messages, accounts, uploads and passwords are NOT uploaded.');
  say('');
  await tools();
  const user = await login();
  const slug = await upload(user);
  const id = await build(slug);
  const got = collect(slug, id);
  say('');
  say('  Done! New in the "downloads" folder:');
  for (const g of [...new Set(got)].sort()) say('    ' + g);
  say('');
  say('  Now double-click "Deploy to Fly.io.bat". After that, Mac users get the real NullChat app from');
  say('  Download Apps (the down-arrow at the bottom of the server bar), and it no longer needs Chrome.');
  say('  The first time they open it, macOS says it can not verify the developer: they choose');
  say('  System Settings > Privacy & Security > Open Anyway, once.');
  say('');
})().catch((e) => fail('Something went wrong: ' + (e && e.message ? e.message : e)));
