// Creates demo accounts and a demo server so you can try NullChat immediately.
// Run with: npm run seed   (safe to run more than once)
import { get, run, tx } from './db.js';
import { hashPassword, newId, randomCode } from './lib/security.js';
import { DEFAULT_EVERYONE_PERMISSIONS, ChannelType, P } from '../../shared/permissions.js';

const PASSWORD = 'nullchat123';
const USERS = [
  { username: 'alice', displayName: 'Alice', email: 'alice@example.com', bio: 'Server owner. Loves cats and voice chats.', accent: '#7c6cff' },
  { username: 'bob', displayName: 'Bob', email: 'bob@example.com', bio: 'Here for the memes.', accent: '#22c55e' },
  { username: 'carol', displayName: 'Carol', email: 'carol@example.com', bio: 'Moderator 🛡️', accent: '#f59e0b' },
];

async function ensureUser(u) {
  const existing = get('SELECT * FROM users WHERE username = ?', u.username);
  if (existing) return existing.id;
  const id = newId();
  run(`INSERT INTO users (id, email, username, display_name, password_hash, bio, accent_color, email_verified, onboarded, created_at, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, '{}')`, id, u.email, u.username, u.displayName, await hashPassword(PASSWORD), u.bio, u.accent, Date.now() - 86400000);
  return id;
}

const ids = {};
for (const u of USERS) ids[u.username] = await ensureUser(u);

// Friendships
const friend = (a, b) => {
  run('INSERT OR REPLACE INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, 1, ?)', a, b, Date.now());
  run('INSERT OR REPLACE INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, 1, ?)', b, a, Date.now());
};
friend(ids.alice, ids.bob);
friend(ids.alice, ids.carol);

let guild = get("SELECT * FROM guilds WHERE name = 'NullChat Lounge'");
if (!guild) {
  const gid = newId();
  const now = Date.now();
  tx(() => {
    run('INSERT INTO guilds (id, name, description, owner_id, discoverable, automod, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      gid, 'NullChat Lounge', 'The official demo server. Say hi!', ids.alice, JSON.stringify({ spamFilter: true, mentionLimit: 20 }), now);
    run('INSERT INTO roles (id, guild_id, name, permissions, position) VALUES (?, ?, ?, ?, 0)', gid, gid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
    const modRole = newId();
    run('INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable) VALUES (?, ?, ?, ?, ?, 1, 1, 1)', modRole, gid, 'Moderator', 0xf59e0b,
      DEFAULT_EVERYONE_PERMISSIONS | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_MESSAGES | P.MODERATE_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS | P.VIEW_AUDIT_LOG | P.MANAGE_THREADS);
    for (const u of ['alice', 'bob', 'carol']) run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', gid, ids[u], now);
    run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', gid, ids.carol, modRole);
    const cat = (name, pos) => { const id = newId(); run('INSERT INTO channels (id, guild_id, type, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, gid, ChannelType.CATEGORY, name, pos, now); return id; };
    const chan = (name, type, parent, pos, topic = '') => { const id = newId(); run('INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, gid, type, name, topic, pos, parent, now); return id; };
    const info = cat('Information', 0);
    const welcome = chan('welcome', 0, info, 0, 'Read me first!');
    const text = cat('Text Channels', 1);
    const general = chan('general', 0, text, 0, 'General chat about anything');
    chan('memes', 0, text, 1, 'Post your best memes');
    const voice = cat('Voice Channels', 2);
    chan('Lounge', 2, voice, 0);
    chan('Gaming', 2, voice, 1);
    run('UPDATE guilds SET system_channel_id = ? WHERE id = ?', general, gid);
    const msg = (channel, author, content) => {
      const id = newId();
      run('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)', id, channel, author, content, Date.now());
      run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, channel);
    };
    msg(welcome, ids.alice, '# Welcome to **NullChat Lounge**! 👋\nBe kind, have fun, and hop into a voice channel any time.\n> Tip: press **Ctrl+K** to jump between channels.');
    msg(general, ids.alice, 'Hey everyone! This is the demo server.');
    msg(general, ids.bob, 'Hi Alice! Voice chat later? 🎮');
    msg(general, ids.carol, 'Count me in. Try `markdown`, ||spoilers|| and :) reactions too!');
    run('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)', 'lounge', gid, general, ids.alice, now);
  });
  guild = get('SELECT * FROM guilds WHERE id = ?', gid);
}
void randomCode;

console.log('\n✔ Demo data ready.');
console.log('  Accounts (password for all: ' + PASSWORD + '):');
for (const u of USERS) console.log(`   • ${u.username}  (${u.email})`);
console.log(`  Demo server: "${guild.name}" — invite link: /invite/lounge\n`);
