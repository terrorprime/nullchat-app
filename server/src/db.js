import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { applyPendingRestore } from './lib/restore.js';

export const DB_PATH = path.join(config.dataDir, 'nullchat.db');

// Use Node's built-in SQLite when available (Node 22.13+). Inside the desktop app (Electron),
// fall back to better-sqlite3, which exposes the same prepare/get/all/run/exec API.
// DB_DRIVER can force one of them ('node:sqlite' or 'better-sqlite3'): the way out if a future Node changes the built-in one.
export const DB_INFO = { driver: 'node:sqlite', sqlite: '' };
const TESTED_NODE_MAJOR = 22;

async function openDatabase(file) {
  const wanted = config.dbDriver;
  const builtin = async () => { const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(file); };
  const external = () => { const require = createRequire(import.meta.url); const Database = require('better-sqlite3'); return new Database(file); };
  if (wanted === 'better-sqlite3') { DB_INFO.driver = 'better-sqlite3'; return external(); }
  if (wanted === 'node:sqlite') return builtin();
  try {
    return await builtin();
  } catch (builtinErr) {
    try {
      const d = external();
      DB_INFO.driver = 'better-sqlite3';
      return d;
    } catch {
      throw new Error(`No SQLite driver available. Use Node.js 22.13+ (built-in node:sqlite) or install better-sqlite3. (${builtinErr.message})`);
    }
  }
}

// The GIF table. It is also re-checked every time the server starts (the db.exec(GIFS_SQL) right after migrate()), because a database can be
// on a later schema version than the build that first created this table.
const GIFS_SQL = `
  CREATE TABLE IF NOT EXISTS gifs (
    id TEXT PRIMARY KEY,
    uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    stored_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gifs_popular ON gifs(removed, uses DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gifs_user ON gifs(uploader_id, created_at DESC);
  `;

// Notifications while the app is closed (Web Push): one row per browser or phone that turned them on. Like the GIF table
// this is also checked on every start, and the column added later is added to a table an earlier build may have left.
const PUSH_SQL = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    preview INTEGER NOT NULL DEFAULT 1,
    mentions_only INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_success_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `;

// Notifications for the phone apps (lib/nativePush.js): one row per phone, with the token Firebase (Android) or Apple (iPhone) gave it.
// Checked on every start like the push table above, so it appears on a database made by an older version.
const NATIVE_PUSH_SQL = `
  CREATE TABLE IF NOT EXISTS native_push_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    preview INTEGER NOT NULL DEFAULT 1,
    mentions_only INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_success_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_native_push_user ON native_push_tokens(user_id);
  `;

// Message reports. A report keeps a snapshot of the message, so it still makes sense after the message is edited or deleted.
// target 'guild' = a message in a server (its moderators AND the site staff can handle it); 'site' = the site admin and mods only (reports from DMs, and about a server's owner).
// Like the other newer tables this is also checked on every start.
const REPORTS_SQL = `
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    guild_id TEXT REFERENCES guilds(id) ON DELETE SET NULL,
    channel_id TEXT,
    message_id TEXT NOT NULL,
    reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    target TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_once ON reports(reporter_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_reports_guild ON reports(guild_id, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_site ON reports(target, status, created_at DESC);
  `;

// Favorite GIFs: the star in the GIF picker. A favorite is private to its owner and follows them across devices.
// source 'library' = a GIF uploaded to this server (ref is its id; the GIF itself is read live, so a rename shows up and a removed one drops out);
// source 'giphy' = one from GIPHY (ref is GIPHY's id; there is nothing of ours to look it up in, so the link, preview and size are kept here).
// Like the other newer tables this is also checked on every start.
const GIF_FAVORITES_SQL = `
  CREATE TABLE IF NOT EXISTS gif_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    preview TEXT,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_gif_favorites_user ON gif_favorites(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gif_favorites_ref ON gif_favorites(source, ref);
  `;

// Stickers: pictures a server uploads that members send as a message of their own. Like the newer tables above this is also checked on every start.
// (a message that carries one keeps [{ id, name }] in messages.stickers; the picture is looked up when the message is shown)
const STICKERS_SQL = `
  CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    stored_name TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    creator_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stickers_guild ON stickers(guild_id, name);
  `;

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    avatar TEXT, banner TEXT, bio TEXT DEFAULT '', pronouns TEXT DEFAULT '',
    accent_color TEXT,
    status TEXT NOT NULL DEFAULT 'online',
    custom_status TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_backup_codes TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    onboarded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT, ip TEXT,
    created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE relationships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type INTEGER NOT NULL, -- 1 friend, 2 blocked, 3 incoming request, 4 outgoing request
    nickname TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, other_id)
  );

  CREATE TABLE guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT, banner TEXT, description TEXT DEFAULT '',
    owner_id TEXT NOT NULL REFERENCES users(id),
    discoverable INTEGER NOT NULL DEFAULT 0,
    verification_level INTEGER NOT NULL DEFAULT 0,
    system_channel_id TEXT,
    automod TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE guild_members (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nick TEXT,
    joined_at INTEGER NOT NULL,
    timeout_until INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX idx_members_user ON guild_members(user_id);

  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    hoist INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_roles_guild ON roles(guild_id);

  CREATE TABLE member_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
    type INTEGER NOT NULL,
    name TEXT,
    topic TEXT DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    nsfw INTEGER NOT NULL DEFAULT 0,
    rate_limit INTEGER NOT NULL DEFAULT 0,
    user_limit INTEGER NOT NULL DEFAULT 0,
    bitrate INTEGER NOT NULL DEFAULT 64000,
    owner_id TEXT,
    icon TEXT,
    last_message_id TEXT,
    message_id TEXT,         -- thread: message the thread was started from
    archived INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_channels_guild ON channels(guild_id);
  CREATE INDEX idx_channels_parent ON channels(parent_id);

  CREATE TABLE channel_overwrites (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL,
    target_type INTEGER NOT NULL, -- 0 role, 1 member
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_id)
  );

  CREATE TABLE channel_recipients (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX idx_recipients_user ON channel_recipients(user_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL DEFAULT '',
    type INTEGER NOT NULL DEFAULT 0,
    reply_to_id TEXT,
    mentions TEXT NOT NULL DEFAULT '[]',
    mention_roles TEXT NOT NULL DEFAULT '[]',
    mention_everyone INTEGER NOT NULL DEFAULT 0,
    embeds TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id);
  CREATE INDEX idx_messages_author ON messages(author_id);

  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    spoiler INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments(message_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE read_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT,
    mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    inviter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    max_uses INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE bans (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT, moderator_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    target_type TEXT,
    changes TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_guild ON audit_logs(guild_id, id);

  CREATE TABLE emojis (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    creator_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE user_guild_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL, -- '@me' for direct messages
    muted INTEGER NOT NULL DEFAULT 0,
    notifications INTEGER NOT NULL DEFAULT 0, -- 0 all, 1 mentions, 2 nothing
    suppress_everyone INTEGER NOT NULL DEFAULT 0,
    channel_overrides TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, guild_id)
  );
  `,
  // v2 — profile extras: gradient profile theme, styled display name, avatar decoration
  `
  ALTER TABLE users ADD COLUMN profile_theme TEXT;
  ALTER TABLE users ADD COLUMN name_style TEXT;
  ALTER TABLE users ADD COLUMN avatar_decoration TEXT;
  `,
  // v3 — email verification removed: everyone counts as verified, old verification links are dropped
  `
  UPDATE users SET email_verified = 1 WHERE email_verified = 0;
  DELETE FROM email_tokens WHERE type = 'verify';
  UPDATE guilds SET verification_level = 0 WHERE verification_level = 1;
  `,
  // v4 — site admin tools: account suspension and an action log
  `
  ALTER TABLE users ADD COLUMN banned_at INTEGER;
  ALTER TABLE users ADD COLUMN banned_reason TEXT;
  CREATE TABLE IF NOT EXISTS admin_log (
    id TEXT PRIMARY KEY,
    admin_id TEXT,
    admin_name TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_log_time ON admin_log(created_at);
  `,
  // v5 — Yapin'-style extras: levels (xp), game activity, server boosts
  `
  ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN activity TEXT;
  CREATE TABLE guild_xp (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    xp INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    last_award INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX idx_guild_xp_rank ON guild_xp(guild_id, xp DESC);
  CREATE TABLE guild_boosts (
    guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX idx_boosts_user ON guild_boosts(user_id);
  `,
  // v6 — reserved (an earlier build used this number for an experiment; it is kept as a no-op so databases
  // that already ran it and fresh ones end up in the same place)
  'SELECT 1;',
  // v7 — polls and saved messages (with optional reminders)
  `
  DROP TABLE IF EXISTS push_subscriptions;
  DELETE FROM _meta WHERE key = 'vapid';

  CREATE TABLE IF NOT EXISTS polls (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    multi INTEGER NOT NULL DEFAULT 0,
    ends_at INTEGER,
    closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_poll_options_msg ON poll_options(message_id, position);
  CREATE TABLE IF NOT EXISTS poll_votes (
    message_id TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (option_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes_msg ON poll_votes(message_id);

  CREATE TABLE IF NOT EXISTS saved_messages (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    remind_at INTEGER,
    reminded_at INTEGER,
    PRIMARY KEY (user_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_messages(user_id, saved_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saved_due ON saved_messages(remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL;
  `,
  // v8 — scheduled ("send later") messages
  `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    reply_to_id TEXT,
    silent INTEGER NOT NULL DEFAULT 0,
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sched_user ON scheduled_messages(user_id, send_at);
  CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_messages(send_at) WHERE error IS NULL;
  `,

  // v9 — reserved (an earlier build used this number for bots and webhooks, and some servers already ran it; it is kept
  // as a no-op so they and fresh databases end up in the same place. Those servers still hold its unused tables.)
  'SELECT 1;',
  // v10 — GIFs people upload and search for, shared by everyone on the server
  GIFS_SQL,
  // v11 — notifications while the app is closed
  PUSH_SQL,
  // v12 — message reports (the forwarded-message column is added at start, below)
  REPORTS_SQL,
  // v13 — favorite GIFs
  GIF_FAVORITES_SQL,
  // v14 — site moderators: a flag on the account (below the admin), and who did each logged action (admin or mod).
  // (a function, so it can look before it adds: a database that already has the columns, however it got there, is left alone)
  (d) => {
    if (!d.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_mod'").get()) d.exec('ALTER TABLE users ADD COLUMN is_mod INTEGER NOT NULL DEFAULT 0');
    if (!d.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_devjr'").get()) d.exec('ALTER TABLE users ADD COLUMN is_devjr INTEGER NOT NULL DEFAULT 0');
    if (!d.prepare("SELECT 1 FROM pragma_table_info('admin_log') WHERE name = 'role'").get()) d.exec('ALTER TABLE admin_log ADD COLUMN role TEXT');
  },
  // v15 — image descriptions (alt text), appeals of suspensions, a server-join guard, a member join/leave log (for insights),
  // forum channels (tags) and bots (accounts + slash commands).
  // A function that looks before it adds, like v14. That matters for bots: an earlier build ran a "v9" with these same bot tables and columns on some
  // servers (kept there as a no-op now), and on those the columns and tables are simply left as they are, bots and tokens included.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    const addCol = (table, col, ddl) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
    addCol('attachments', 'description', 'TEXT');
    addCol('users', 'bot', 'INTEGER NOT NULL DEFAULT 0');             // 0 = a person, 1 = a bot account (2 was an incoming webhook in the earlier build)
    addCol('messages', 'interaction', 'TEXT');                         // JSON: the slash command a bot's message answers { name, userId, pending }
    addCol('guilds', 'invites_paused', 'INTEGER NOT NULL DEFAULT 0');
    addCol('guilds', 'raid_until', 'INTEGER NOT NULL DEFAULT 0');
    addCol('guilds', 'raid_guard', 'INTEGER NOT NULL DEFAULT 0');
    addCol('guilds', 'raid_threshold', 'INTEGER NOT NULL DEFAULT 10');
    addCol('channels', 'available_tags', 'TEXT');
    addCol('channels', 'applied_tags', 'TEXT');
    addCol('channels', 'forum_sort', 'INTEGER NOT NULL DEFAULT 0');
    addCol('channels', 'require_tag', 'INTEGER NOT NULL DEFAULT 0');
    d.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        role_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS bot_commands (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        UNIQUE (bot_id, name)
      );
      CREATE TABLE IF NOT EXISTS appeals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',          -- open | approved | denied
        suspension_reason TEXT,                       -- what the person was told when it was filed
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,                              -- the staff member's name at the time
        note TEXT                                     -- shown to the person when it is denied
      );
      CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id, created_at);
      CREATE TABLE IF NOT EXISTS guild_member_log (
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                           -- join | leave
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_member_log ON guild_member_log(guild_id, at);
    `);
    // (only while "bots" still has its server column: v20 rebuilds the table without it, and a database that already has the new shape must not trip on this)
    if (has('bots', 'guild_id')) d.exec('CREATE INDEX IF NOT EXISTS idx_bots_guild ON bots(guild_id)');
    // every server that exists now is tracked from this moment on (insights says so, and counts earlier days from who is still a member)
    d.prepare("INSERT INTO guild_member_log (guild_id, kind, at) SELECT g.id, 'start', ? FROM guilds g WHERE NOT EXISTS (SELECT 1 FROM guild_member_log l WHERE l.guild_id = g.id AND l.kind = 'start')").run(Date.now());
  },
  // v16 — server tags: a server's tag (text, badge, colour) and the server whose tag a person wears.
  // Looks before it adds, like v14 and v15. The tag text is unique on the whole site, ignoring case.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    const addCol = (table, col, ddl) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
    addCol('guilds', 'tag', 'TEXT');
    addCol('guilds', 'tag_badge', 'TEXT');          // "icon:<name>" or the URL of an uploaded picture
    addCol('guilds', 'tag_color', 'TEXT');
    addCol('users', 'tag_guild_id', 'TEXT');        // the server whose tag this person wears (NULL = none)
    d.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_tag ON guilds(LOWER(tag)) WHERE tag IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_users_tag_guild ON users(tag_guild_id) WHERE tag_guild_id IS NOT NULL;
    `);
  },
  // v17 — community tools: a server's own invite link (/invite/<name>), a different picture per server, announcement channels
  // (other servers follow them; a published post is copied into each follower) and stage channels (no table: they are voice channels of type 13).
  // Looks before it adds, like v14 to v16.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    const addCol = (table, col, ddl) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
    addCol('guilds', 'vanity_code', 'TEXT');          // the code of this server's own invite (also a row in invites, so joining works the usual way)
    addCol('guild_members', 'avatar', 'TEXT');        // the picture this person uses in this server only (NULL = their normal one)
    addCol('messages', 'crosspost', 'TEXT');          // JSON: where a copy of a published announcement came from { guildId, guildName, guildIcon, channelId, channelName, messageId }
    addCol('messages', 'published_at', 'INTEGER');    // when an announcement was published to the servers that follow its channel
    d.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_vanity ON guilds(LOWER(vanity_code)) WHERE vanity_code IS NOT NULL;
      CREATE TABLE IF NOT EXISTS channel_follows (
        id TEXT PRIMARY KEY,
        source_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        source_guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        target_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        target_guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (source_channel_id, target_channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_follows_source ON channel_follows(source_channel_id);
      CREATE INDEX IF NOT EXISTS idx_follows_target ON channel_follows(target_channel_id);
    `);
  },
  // v18 — "joined from": a join in the member log can say which labelled invite link (/invite/<code>/youtube) it came through. Counts only, no person.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    if (!has('guild_member_log', 'source')) d.exec('ALTER TABLE guild_member_log ADD COLUMN source TEXT');   // NULL = no label (a plain link, or a join from before labels existed)
  },
  // v19 — pinned forum posts (a post carries the time it was pinned), and the other tools for running a server: incoming webhooks, bot buttons /
  // select menus / forms (a message can carry "components"; a webhook message may carry its own name and picture) and server templates.
  // Looks before it adds, like v14 to v18.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    const addCol = (table, col, ddl) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
    addCol('channels', 'pinned_at', 'INTEGER');       // a pinned forum post: when it was pinned (NULL = not pinned)
    addCol('messages', 'webhook', 'TEXT');            // a message sent through a webhook: the name and picture it was sent with (JSON, NULL = a normal message)
    addCol('messages', 'components', 'TEXT');         // a bot's buttons and menus (JSON, NULL = none)
    // An incoming webhook: a web address that anything able to send a request can post to. It has its own hidden sender account
    // (users.bot = 2, never a member of the server), so the messages keep an author after the webhook is gone.
    d.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_guild ON webhooks(guild_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
      -- A server template: a saved copy of a server's set-up (roles, channels, permissions, a few settings: never messages or people) that
      -- anyone with the link can start a new server from. One per server.
      CREATE TABLE IF NOT EXISTS guild_templates (
        code TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL UNIQUE REFERENCES guilds(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL
      );
    `);
  },
  // v20 — apps: a bot is no longer tied to one server. It exists on its own (owned by whoever made it, private, link-only or listed in the App Directory)
  // and is *installed* into servers; each install has its own member entry and role in that server (bot_installs).
  // "bots" is rebuilt without its server and role columns. The commands are copied aside first, because dropping the old table would
  // delete them (they hang off it), and put back after. A function that looks before it changes things, like v14 and v15.
  (d) => {
    const has = (table, col) => !!d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
    if (has('bots', 'guild_id')) {
      d.exec(`
        CREATE TABLE _bots_v19 AS SELECT id, guild_id, owner_id, role_id, description, token_hash, token_hint, created_at, last_seen_at FROM bots;
        CREATE TABLE _bot_commands_v19 AS SELECT id, bot_id, name, description, options, created_at FROM bot_commands;
        DROP TABLE bots;
        CREATE TABLE bots (
          id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          description TEXT NOT NULL DEFAULT '',
          token_hash TEXT NOT NULL UNIQUE,
          token_hint TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          visibility TEXT NOT NULL DEFAULT 'private',      -- private (only its owner can add it) | link (anyone with its link) | listed (also in the App Directory)
          perm_preset TEXT NOT NULL DEFAULT 'basic',       -- the permissions its role gets in a server it is added to: basic | moderator | admin
          hidden INTEGER NOT NULL DEFAULT 0                -- 1: staff took it out of the App Directory
        );
        INSERT INTO bots (id, owner_id, description, token_hash, token_hint, created_at, last_seen_at)
          SELECT id, owner_id, description, token_hash, token_hint, created_at, last_seen_at FROM _bots_v19;
        INSERT INTO bot_commands (id, bot_id, name, description, options, created_at)
          SELECT id, bot_id, name, description, options, created_at FROM _bot_commands_v19;
        CREATE TABLE IF NOT EXISTS bot_installs (
          bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
          role_id TEXT,
          installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          installed_at INTEGER NOT NULL,
          PRIMARY KEY (bot_id, guild_id)
        );
        INSERT INTO bot_installs (bot_id, guild_id, role_id, installed_by, installed_at)
          SELECT id, guild_id, role_id, owner_id, created_at FROM _bots_v19;
        DROP TABLE _bots_v19;
        DROP TABLE _bot_commands_v19;
      `);
    } else {
      // (already in the new shape: a database that came from another build)
      if (!has('bots', 'visibility')) d.exec("ALTER TABLE bots ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      if (!has('bots', 'perm_preset')) d.exec("ALTER TABLE bots ADD COLUMN perm_preset TEXT NOT NULL DEFAULT 'basic'");
      if (!has('bots', 'hidden')) d.exec('ALTER TABLE bots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
      d.exec(`CREATE TABLE IF NOT EXISTS bot_installs (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        role_id TEXT,
        installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        installed_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, guild_id)
      )`);
    }
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_bot_installs_guild ON bot_installs(guild_id);
      CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
      CREATE INDEX IF NOT EXISTS idx_bots_directory ON bots(visibility, hidden);
    `);
  },
  // v21 — a server's own moderation file on a member: warnings (the member is told; `seen_at` is when they read it) and notes
  // (only the server's moderators see them). Both stay when the member leaves, so a returning troublemaker still has a history,
  // and go with the server or the account. Looks before it adds, like v14 on.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS member_warnings (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        seen_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_warnings_member ON member_warnings(guild_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_warnings_unseen ON member_warnings(user_id) WHERE seen_at IS NULL;
      CREATE TABLE IF NOT EXISTS member_notes (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_member ON member_notes(guild_id, user_id, created_at);
    `);
  },
];

// The database is opened here (after the migration list exists) so that an uploaded backup can be checked against
// the schema version this build understands and swapped in first. See lib/restore.js.
await applyPendingRestore({ dataDir: config.dataDir, dbPath: DB_PATH, open: openDatabase, maxVersion: MIGRATIONS.length });
export const db = await openDatabase(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
`);
try { DB_INFO.sqlite = db.prepare('SELECT sqlite_version() AS v').get().v; } catch { /* only for the log line */ }
console.log(`[db] ${DB_INFO.driver}, SQLite ${DB_INFO.sqlite || '?'}, Node ${process.versions.node}`);
if (DB_INFO.driver === 'node:sqlite' && Number(process.versions.node.split('.')[0]) !== TESTED_NODE_MAJOR) {
  console.warn(`[db] NullChat is tested on Node ${TESTED_NODE_MAJOR}; this is Node ${process.versions.node}. Node still calls its built-in SQLite experimental, so after a Node upgrade check that everything works (a copy of the database is saved before every upgrade of its structure). Set DB_DRIVER=better-sqlite3 to use that driver instead.`);
}

/** Before the database's structure is changed by a newer build, keep a plain copy of how it was: the way back if the new build has to be rolled back. The newest two are kept. */
function copyBeforeMigrating(fromVersion) {
  try {
    const dir = path.join(config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `before-upgrade-v${fromVersion}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(dir).filter((f) => /^before-upgrade-v\d+-\d+\.db$/.test(f)).sort((a, b) => Number(a.split('-').pop().slice(0, -3)) - Number(b.split('-').pop().slice(0, -3)));
    for (const f of old.slice(0, Math.max(0, old.length - 2))) fs.rmSync(path.join(dir, f), { force: true });
    console.log(`[db] saved a copy of the database before upgrading it from schema v${fromVersion}: ${path.basename(out)}`);
  } catch (e) {
    console.error('[db] could not save a copy before upgrading (carrying on; the upgrade itself is all-or-nothing):', e.message);   // a full disk must not stop the server from starting
  }
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  if (version > 0 && version < MIGRATIONS.length) copyBeforeMigrating(version);
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      const step = MIGRATIONS[version];
      if (typeof step === 'function') step(db); else db.exec(step);
      version++;
      db.prepare("INSERT INTO _meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
      db.exec('COMMIT');
      console.log(`[db] migrated to schema v${version}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrate();
db.exec(GIFS_SQL);   // harmless when the table exists; creates it on a database whose schema number already passed the step that adds it
db.exec(PUSH_SQL);   // same for the push table
db.exec(NATIVE_PUSH_SQL);   // and the phone-app tokens (lib/nativePush.js)
if (!db.prepare("SELECT 1 FROM pragma_table_info('push_subscriptions') WHERE name = 'mentions_only'").get()) db.exec('ALTER TABLE push_subscriptions ADD COLUMN mentions_only INTEGER NOT NULL DEFAULT 1');
db.exec(REPORTS_SQL);   // same for the reports table
db.exec(GIF_FAVORITES_SQL);   // and the favorite GIFs
db.exec(STICKERS_SQL);   // and the servers' stickers
// (the moderator columns are also checked here, so a database that arrives from another build still gets them)
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_mod'").get()) db.exec('ALTER TABLE users ADD COLUMN is_mod INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_devjr'").get()) db.exec('ALTER TABLE users ADD COLUMN is_devjr INTEGER NOT NULL DEFAULT 0');   // (Dev Jr: a level between mod and admin)
if (!db.prepare("SELECT 1 FROM pragma_table_info('admin_log') WHERE name = 'role'").get()) db.exec('ALTER TABLE admin_log ADD COLUMN role TEXT');
// A profile effect (the animated overlay on someone's profile card) is just an id. Adding a plain nullable column is safe to do here
// (like the moderator columns above), so it needs no numbered step: an old database, a restored backup or one from another build all get it.
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'profile_effect'").get()) db.exec('ALTER TABLE users ADD COLUMN profile_effect TEXT');
// A forwarded message keeps who wrote the original, when, its text and link previews (JSON); its files are ordinary attachments of the new message.
if (!db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'forward'").get()) db.exec('ALTER TABLE messages ADD COLUMN forward TEXT');
if (!db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'stickers'").get()) db.exec('ALTER TABLE messages ADD COLUMN stickers TEXT');   // [{ id, name }] of the sticker sent with the message
// Mood rooms: the background sound a voice channel has (an id from shared/moods.js), and whether only channel managers may change it.
if (!db.prepare("SELECT 1 FROM pragma_table_info('channels') WHERE name = 'mood'").get()) db.exec('ALTER TABLE channels ADD COLUMN mood TEXT');
if (!db.prepare("SELECT 1 FROM pragma_table_info('channels') WHERE name = 'mood_locked'").get()) db.exec('ALTER TABLE channels ADD COLUMN mood_locked INTEGER NOT NULL DEFAULT 0');

// ---- tiny helpers -------------------------------------------------------
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) { txDepth++; try { return fn(); } finally { txDepth--; } }
  db.exec('BEGIN');
  txDepth = 1;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth = 0;
  }
}

export function parseJSON(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
