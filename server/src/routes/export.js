// "Download my data": a copy of everything NullChat holds about you, as one JSON file.
// Profile, settings, friends and blocks, the servers you are in, saved and scheduled messages, favorite GIFs, and every message you wrote.
// Not included: other people's messages (except ones you saved for later), and the uploaded files themselves (the file list names them). Nothing secret is
// included either: no password hash, no two-factor secret or backup codes, no login tokens.
import { z } from 'zod';
import { get, all } from '../db.js';
import { bad, forbidden, enforceRateLimit } from '../lib/http.js';
import { randomToken, verifyPassword } from '../lib/security.js';

const tickets = new Map(); // token -> { userId, expires }   (one use, one minute)
const BATCH = 500;

const json = (v) => JSON.stringify(v);
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const day = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** Writes a chunk and waits if the connection can't keep up, so a big export never piles up in memory. */
function write(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { res.off('drain', onDrain); res.off('close', onClose); resolve(ok); };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    res.once('drain', onDrain); res.once('close', onClose);
  });
}

function collect(userId) {
  const u = get('SELECT * FROM users WHERE id = ?', userId);
  const name = (id) => { const x = id && get('SELECT username, display_name FROM users WHERE id = ?', id); return x ? { username: x.username, displayName: x.display_name || null } : null; };
  const kind = { 1: 'friend', 2: 'blocked', 3: 'incoming request', 4: 'outgoing request' };
  return {
    account: {
      id: u.id, username: u.username, displayName: u.display_name || null, email: u.email, emailVerified: !!u.email_verified,
      createdAt: new Date(u.created_at).toISOString(), bio: u.bio || '', pronouns: u.pronouns || '', status: u.status, customStatus: u.custom_status || null,
      accentColor: u.accent_color || null, twoFactorEnabled: !!u.mfa_enabled, avatarFile: u.avatar || null, bannerFile: u.banner || null, xp: u.xp || 0,
      joinSoundFile: (() => { try { return JSON.parse(u.voice_sounds)?.join || null; } catch { return null; } })(), leaveSoundFile: (() => { try { return JSON.parse(u.voice_sounds)?.leave || null; } catch { return null; } })(),
      birthday: (() => { try { const b = JSON.parse(u.birthday); return b ? { month: b.month, day: b.day, announcedInServers: !!b.announce, shownOnProfile: !!b.profile } : null; } catch { return null; } })(),
    },
    settings: parse(u.settings, {}),
    relationships: all('SELECT * FROM relationships WHERE user_id = ? ORDER BY created_at', userId)
      .map((r) => ({ type: kind[r.type] || String(r.type), user: name(r.other_id), nickname: r.nickname || null, since: new Date(r.created_at).toISOString() })),
    servers: all('SELECT m.*, g.name, g.owner_id FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ? ORDER BY m.joined_at', userId)
      .map((m) => ({ id: m.guild_id, name: m.name, joinedAt: new Date(m.joined_at).toISOString(), nickname: m.nick || null, owner: m.owner_id === userId })),
    savedMessages: all(`SELECT s.*, m.content, m.author_id FROM saved_messages s JOIN messages m ON m.id = s.message_id WHERE s.user_id = ? ORDER BY s.saved_at`, userId)
      .map((s) => ({ messageId: s.message_id, channelId: s.channel_id, savedAt: new Date(s.saved_at).toISOString(), reminderAt: s.remind_at ? new Date(s.remind_at).toISOString() : null, author: name(s.author_id), content: s.content })),
    // The quiet replies they wrote (replies only the people they picked could see: routes/quiet.js)
    quietRepliesYouSent: all('SELECT q.*, c.name AS channel_name FROM quiet_replies q LEFT JOIN channels c ON c.id = q.channel_id WHERE q.author_id = ? ORDER BY q.id', userId)
      .map((q) => ({ id: q.id, sentAt: new Date(q.created_at).toISOString(), channel: q.channel_name || null, channelId: q.channel_id, replyToMessageId: q.reply_to_id, content: q.content,
        visibleTo: all('SELECT user_id FROM quiet_viewers WHERE quiet_id = ?', q.id).map((v) => name(v.user_id)).filter(Boolean) })),
    // The GIFs they starred (newest first). An uploaded GIF is named; a GIPHY one is its link.
    favoriteGifs: all('SELECT f.*, g.name AS gif_name FROM gif_favorites f LEFT JOIN gifs g ON f.source = \'library\' AND g.id = f.ref AND g.removed = 0 WHERE f.user_id = ? AND (f.source != \'library\' OR g.id IS NOT NULL) ORDER BY f.created_at DESC', userId)
      .map((f) => (f.source === 'library' ? { from: 'this server', name: f.gif_name, starredAt: new Date(f.created_at).toISOString() } : { from: 'GIPHY', name: f.title || null, link: f.url, starredAt: new Date(f.created_at).toISOString() })),
    // Reports this person sent (their reason and words only, not a copy of someone else's message)
    reportsYouSent: all('SELECT r.*, g.name AS guild_name FROM reports r LEFT JOIN guilds g ON g.id = r.guild_id WHERE r.reporter_id = ? ORDER BY r.created_at', userId)
      .map((r) => ({ sentAt: new Date(r.created_at).toISOString(), reason: r.reason, details: r.details || '', in: r.guild_name || 'a direct message', status: r.status })),
    // Warnings servers gave this person (the reason and the server, not which moderator)
    warningsYouReceived: all('SELECT w.reason, w.created_at, g.name AS guild_name FROM member_warnings w LEFT JOIN guilds g ON g.id = w.guild_id WHERE w.user_id = ? ORDER BY w.created_at', userId)
      .map((w) => ({ in: w.guild_name || 'a server', reason: w.reason, givenAt: new Date(w.created_at).toISOString() })),
    scheduledMessages: all('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at', userId)
      .map((s) => ({ channelId: s.channel_id, content: s.content, sendAt: new Date(s.send_at).toISOString(), silent: !!s.silent, error: s.error || null })),
  };
}

/** What a forwarded message carried: who wrote the original, when, and what it said. */
function forwarded(json) {
  if (!json) return null;
  try { const f = JSON.parse(json); return { from: f.author?.name || null, writtenAt: f.createdAt ? new Date(f.createdAt).toISOString() : null, content: f.content || '' }; } catch { return null; }
}

/** The person's own messages, oldest first, a few hundred at a time. Calls `emit(item)` for each. */
async function* ownMessages(userId) {
  const channelInfo = new Map();
  const where = (id) => {
    if (channelInfo.has(id)) return channelInfo.get(id);
    const c = get('SELECT c.id, c.name, c.type, c.guild_id, g.name AS guild_name FROM channels c LEFT JOIN guilds g ON g.id = c.guild_id WHERE c.id = ?', id);
    const info = c
      ? { channel: c.name || null, server: c.guild_name || null, direct: c.guild_id ? undefined : all('SELECT u.username FROM channel_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? AND r.user_id != ?', c.id, userId).map((x) => x.username) }
      : { channel: null, server: null };
    channelInfo.set(id, info);
    return info;
  };
  // Only what the person wrote: normal messages (0) and replies (19), not the "joined the server" / pin / call notices.
  let after = '';
  for (;;) {
    const rows = all('SELECT id, channel_id, content, type, reply_to_id, pinned, edited_at, created_at, forward, stickers FROM messages WHERE author_id = ? AND type IN (0, 19) AND id > ? ORDER BY id LIMIT ?', userId, after, BATCH);
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    const files = new Map();
    for (const a of all(`SELECT message_id, filename, size, content_type, description FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      if (!files.has(a.message_id)) files.set(a.message_id, []);
      files.get(a.message_id).push({ filename: a.filename, size: a.size, type: a.content_type, ...(a.description ? { description: a.description } : {}) });
    }
    for (const r of rows) {
      const w = where(r.channel_id);
      yield {
        id: r.id, sentAt: new Date(r.created_at).toISOString(), editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        server: w.server, channel: w.channel, ...(w.direct ? { directMessageWith: w.direct } : {}), channelId: r.channel_id,
        content: r.content, replyToMessageId: r.reply_to_id || null, pinned: !!r.pinned, ...(files.has(r.id) ? { files: files.get(r.id) } : {}),
        ...(forwarded(r.forward) ? { forwarded: forwarded(r.forward) } : {}),
        ...(r.stickers ? { stickers: (parse(r.stickers, []) || []).map((x) => x.name) } : {}),
      };
    }
    after = rows.at(-1).id;
    if (rows.length < BATCH) return;
    await new Promise((r) => setImmediate(r)); // let other requests through between batches
  }
}

export default function register(r) {
  // Asking needs your password (the file holds your private messages), and gives a link that works once, for a minute.
  r.post('/api/users/@me/export', async (ctx) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(ctx.body || {});
    enforceRateLimit(`export:${ctx.user.id}`, 3, 60 * 60_000, 'You can download your data a few times an hour. Try again later.');
    if (!(await verifyPassword(password, ctx.user.password_hash))) throw bad('Incorrect password.', 'invalid_password', { errors: { password: 'Incorrect password.' } });
    const now = Date.now();
    for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
    const token = randomToken(24);
    tickets.set(token, { userId: ctx.user.id, expires: now + 60_000 });
    return { url: `/api/users/@me/export/download?ticket=${token}` };
  });

  r.get('/api/users/@me/export/download', { auth: false, raw: true }, async (ctx) => {
    const key = String(ctx.query.ticket || '');
    const t = tickets.get(key);
    tickets.delete(key);
    if (!t || t.expires < Date.now()) throw forbidden('This download link has expired. Go back to Settings and start the download again.');
    const user = get('SELECT username FROM users WHERE id = ?', t.userId);
    if (!user) throw forbidden('This account no longer exists.');
    const { res } = ctx;
    const head = { exportedAt: new Date().toISOString(), note: 'A copy of your NullChat data. It does not include other people’s messages (apart from ones you saved) or the uploaded files themselves, and it never includes passwords or login tokens.', ...collect(t.userId) };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="nullchat-data-${user.username.replace(/[^a-z0-9_.-]/gi, '_')}-${day(Date.now())}.json"`,
      'Cache-Control': 'no-store',
    });
    try {
      const text = JSON.stringify(head, null, 2);
      if (!(await write(res, text.slice(0, -2) + ',\n  "messages": ['))) return;
      let first = true; let count = 0;
      for await (const m of ownMessages(t.userId)) {
        if (!(await write(res, (first ? '\n    ' : ',\n    ') + json(m)))) return;
        first = false; count++;
      }
      await write(res, `${first ? '' : '\n  '}],\n  "messageCount": ${count}\n}\n`);
      res.end();
    } catch (e) {
      // Headers are already out, so the only honest way to say "this failed" is to cut the connection (the browser shows a failed download).
      console.error('[export]', e.message);
      res.destroy();
    }
  });
}
