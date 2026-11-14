// Community tools.
//   GET    /api/guilds/:id/members/activity        when each member last posted (for choosing who to remove)
//   POST   /api/guilds/:id/members/bulk            kick or ban many members at once
//   PUT    /api/guilds/:id/vanity                  give the server its own invite link, /invite/<name>
//   DELETE /api/guilds/:id/vanity                  take it away again
//   PUT    /api/guilds/:id/members/@me/avatar      a picture only this server sees
//   DELETE /api/guilds/:id/members/:userId/avatar  remove it (your own, or someone else's when you manage nicknames)
//   POST   /api/channels/:id/messages/:messageId/publish   send an announcement to every server that follows its channel
//   GET    /api/channels/:id/follows               who follows this announcement channel / which ones this channel follows
//   POST   /api/channels/:id/follows               follow an announcement channel into one of your own text channels
//   DELETE /api/follows/:followId                  stop following (either side can)
//   GET    /api/guilds/:id/join-sources            how many people joined through each "joined from" label (/invite/<code>/<label>)
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, tx } from '../db.js';
import { bad, forbidden, notFound, HttpError, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { receiveImage, removeUpload, storedNameFromUrl, duplicateUpload } from '../lib/uploads.js';
import { UPLOAD_DIR } from '../config.js';
import {
  guildAccess, channelAccess, getChannelRow, getMember, requirePerm, serializeMessages,
} from '../models.js';
import { sendToGuild, sendToChannel, syncGuild } from '../gateway.js';
import { audit } from '../services.js';
import { pushForMessage } from '../lib/push.js';
import { isBotId } from '../lib/bots.js';
import { getPoll } from '../lib/polls.js';
import { kickMember, banMember, whyNotActOn } from './guilds.js';
import { P, has, ChannelType, isTextLike } from '../../../shared/permissions.js';
import {
  normalizeVanity, validVanity, isReservedVanity, VANITY_MIN, VANITY_MAX, BULK_MAX, FOLLOWERS_MAX, FOLLOWING_MAX,
} from '../../../shared/community.js';

const drain = (ctx) => { try { ctx.req.resume(); } catch { /* already gone */ } };

/** The text channel a server's own invite lands people in: the system channel, else the first text channel. */
function landingChannel(guildId) {
  const g = get('SELECT system_channel_id FROM guilds WHERE id = ?', guildId);
  if (g?.system_channel_id && get('SELECT 1 FROM channels WHERE id = ?', g.system_channel_id)) return g.system_channel_id;
  return get('SELECT id FROM channels WHERE guild_id = ? AND type = ? ORDER BY position, created_at LIMIT 1', guildId, ChannelType.TEXT)?.id || null;
}

/** Take the pings out of an announcement before it is copied into another server: nobody there is mentioned, and nothing points at ids from the other server. */
export function neutralizeMentions(content, sourceGuild) {
  const roleName = (id) => sourceGuild?.roles?.find((r) => r.id === id)?.name || 'role';
  return String(content || '')
    .replace(/<@&(\d+)>/g, (_, id) => `@${roleName(id)}`)
    .replace(/<#(\d+)>/g, (_, id) => { const c = getChannelRow(id); return c ? `#${c.name}` : '#channel'; })
    .replace(/@(everyone|here)\b/g, '@​$1');
}

const serializeFollow = (f) => {
  const sg = get('SELECT id, name, icon FROM guilds WHERE id = ?', f.source_guild_id);
  const tg = get('SELECT id, name, icon FROM guilds WHERE id = ?', f.target_guild_id);
  const sc = get('SELECT id, name FROM channels WHERE id = ?', f.source_channel_id);
  const tc = get('SELECT id, name FROM channels WHERE id = ?', f.target_channel_id);
  return {
    id: f.id, createdAt: f.created_at,
    source: { guildId: sg?.id, guildName: sg?.name, guildIcon: sg?.icon || null, channelId: sc?.id, channelName: sc?.name },
    target: { guildId: tg?.id, guildName: tg?.name, guildIcon: tg?.icon || null, channelId: tc?.id, channelName: tc?.name },
  };
};

export default function register(r) {
  // ================================================================ bulk kick and ban
  r.get('/api/guilds/:id/members/activity', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    if (!has(perms, P.KICK_MEMBERS) && !has(perms, P.BAN_MEMBERS)) throw forbidden('You need permission to kick or ban members.');
    enforceRateLimit(`activity:${ctx.user.id}`, 20, 10 * 60 * 1000);
    const rows = all(`SELECT m.author_id AS uid, MAX(m.created_at) AS at FROM messages m JOIN channels c ON c.id = m.channel_id
                      WHERE c.guild_id = ? AND m.author_id IS NOT NULL AND m.type IN (0, 19) AND m.crosspost IS NULL GROUP BY m.author_id`, ctx.params.id);
    return { lastPostAt: Object.fromEntries(rows.map((x) => [x.uid, x.at])), now: Date.now() };
  });

  r.post('/api/guilds/:id/members/bulk', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    const body = z.object({
      action: z.enum(['kick', 'ban']),
      userIds: z.array(z.string().max(40)).min(1).max(BULK_MAX),
      reason: z.string().max(512).optional(),
      deleteMessageSeconds: z.number().int().min(0).max(7 * 86400).default(0),
    }).parse(ctx.body);
    requirePerm(perms, body.action === 'kick' ? P.KICK_MEMBERS : P.BAN_MEMBERS);
    enforceRateLimit(`bulk:${ctx.user.id}`, 6, 10 * 60 * 1000, 'You removed a lot of people just now. Wait a few minutes and try again.');
    const ids = [...new Set(body.userIds)];
    const done = []; const skipped = [];
    for (const id of ids) {
      if (id === ctx.user.id) { skipped.push({ userId: id, reason: 'That is you.' }); continue; }
      if (isBotId(id)) { skipped.push({ userId: id, reason: 'Bots are removed from the Bots tab.' }); continue; }
      const why = whyNotActOn(guild, actor, id);
      if (why) { skipped.push({ userId: id, reason: why }); continue; }
      try {
        if (body.action === 'kick') kickMember(guild, ctx.user.id, id, body.reason, { bulk: true });
        else banMember(guild, ctx.user.id, id, { reason: body.reason, deleteMessageSeconds: body.deleteMessageSeconds }, { bulk: true });
        done.push(id);
      } catch (e) { skipped.push({ userId: id, reason: 'Something went wrong.' }); console.error('[bulk]', e.message); }
    }
    return { action: body.action, done, skipped };
  });

  // ================================================================ where new members joined from
  // Counts only: the member log has no names, so a server sees "14 from YouTube", never who.
  r.get('/api/guilds/:id/join-sources', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    enforceRateLimit(`joinsources:${ctx.user.id}`, 60, 10 * 60 * 1000);
    const days = [7, 30, 90, 365].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30;
    const since = Date.now() - days * 86_400_000;
    // (a server's first "join" is its owner creating it, written with the very same timestamp as the server: that is not somebody arriving)
    const rows = all(`SELECT l.source AS source, COUNT(*) AS n FROM guild_member_log l JOIN guilds g ON g.id = l.guild_id
                      WHERE l.guild_id = ? AND l.kind = 'join' AND l.at >= ? AND l.at <> g.created_at
                      GROUP BY l.source ORDER BY n DESC, l.source LIMIT 40`, ctx.params.id, since);
    const total = get(`SELECT COUNT(*) AS n FROM guild_member_log l JOIN guilds g ON g.id = l.guild_id
                       WHERE l.guild_id = ? AND l.kind = 'join' AND l.at >= ? AND l.at <> g.created_at`, ctx.params.id, since).n;
    const listed = rows.reduce((a, x) => a + x.n, 0);
    return { days, total, sources: rows.map((x) => ({ source: x.source || null, count: x.n })), more: total - listed };
  });

  // ================================================================ a server's own invite link
  r.put('/api/guilds/:id/vanity', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const raw = z.object({ code: z.string().max(80) }).parse(ctx.body).code;
    const code = normalizeVanity(raw);
    const fail = (message) => { throw bad(message, 'bad_vanity', { errors: { code: message } }); };
    if (code.length < VANITY_MIN || code.length > VANITY_MAX) fail(`Use ${VANITY_MIN} to ${VANITY_MAX} characters.`);
    if (!validVanity(code)) fail('Use only letters, numbers and single hyphens, starting and ending with a letter or number.');
    if (isReservedVanity(code)) fail('That name is kept for NullChat itself. Pick another.');
    const current = get('SELECT vanity_code FROM guilds WHERE id = ?', guild.id)?.vanity_code || null;
    if (current === code) return { code, uses: get('SELECT uses FROM invites WHERE code = ?', code)?.uses || 0 };
    const taken = get('SELECT 1 FROM guilds WHERE LOWER(vanity_code) = ? AND id != ?', code, guild.id)
      || get('SELECT 1 FROM invites WHERE LOWER(code) = ?', code);
    if (taken) throw new HttpError(409, 'That name is already taken. Pick another.', 'vanity_taken', { errors: { code: 'That name is already taken. Pick another.' } });
    enforceRateLimit(`vanity:${guild.id}`, 10, 3600 * 1000, 'The invite link was changed a lot just now. Try again in an hour.');
    tx(() => {
      if (current) run('DELETE FROM invites WHERE code = ? AND guild_id = ?', current, guild.id);
      run('INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, 0, NULL, ?)',
        code, guild.id, landingChannel(guild.id), ctx.user.id, Date.now());
      run('UPDATE guilds SET vanity_code = ? WHERE id = ?', code, guild.id);
    });
    audit(guild.id, ctx.user.id, 'GUILD_VANITY', { targetId: code, targetType: 'invite', changes: { vanity: code, was: current } });
    syncGuild(guild.id);
    return { code, uses: 0 };
  });

  r.delete('/api/guilds/:id/vanity', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const current = get('SELECT vanity_code FROM guilds WHERE id = ?', guild.id)?.vanity_code;
    if (!current) return { ok: true };
    tx(() => {
      run('DELETE FROM invites WHERE code = ? AND guild_id = ?', current, guild.id);
      run('UPDATE guilds SET vanity_code = NULL WHERE id = ?', guild.id);
    });
    audit(guild.id, ctx.user.id, 'GUILD_VANITY', { targetId: current, targetType: 'invite', changes: { vanity: null, was: current } });
    syncGuild(guild.id);
    return { ok: true };
  });

  // ================================================================ a picture for one server only
  r.put('/api/guilds/:id/members/@me/avatar', { raw: true }, async (ctx) => {
    let access;
    try { access = guildAccess(ctx.params.id, ctx.user.id); } catch (e) { drain(ctx); throw e; }
    if (ctx.user.bot) { drain(ctx); throw forbidden('A bot can’t do that.'); }
    if (!has(access.perms, P.CHANGE_NICKNAME)) { drain(ctx); throw forbidden('You can’t change your profile in this server.'); }
    enforceRateLimit(`memberavatar:${ctx.user.id}`, 10, 10 * 60 * 1000, 'You are changing your picture too quickly. Try again in a few minutes.');
    const img = await receiveImage(ctx.req, 'memberavatars', 8 * 1024 * 1024);
    const before = get('SELECT avatar FROM guild_members WHERE guild_id = ? AND user_id = ?', access.guild.id, ctx.user.id)?.avatar;
    run('UPDATE guild_members SET avatar = ? WHERE guild_id = ? AND user_id = ?', `/uploads/memberavatars/${img.storedName}`, access.guild.id, ctx.user.id);
    removeUpload('memberavatars', storedNameFromUrl(before));
    const member = getMember(access.guild.id, ctx.user.id);
    sendToGuild(access.guild.id, 'GUILD_MEMBER_UPDATE', { guildId: access.guild.id, member });
    return member;
  });

  r.delete('/api/guilds/:id/members/:userId/avatar', async (ctx) => {
    const { guild, member: actor, perms } = guildAccess(ctx.params.id, ctx.user.id);
    const targetId = ctx.params.userId === '@me' ? ctx.user.id : ctx.params.userId;
    const target = getMember(guild.id, targetId);
    if (!target) throw notFound('Unknown member.');
    if (targetId !== ctx.user.id) {
      requirePerm(perms, P.MANAGE_NICKNAMES);
      const why = whyNotActOn(guild, actor, targetId);
      if (why) throw forbidden(why);
    }
    const before = get('SELECT avatar FROM guild_members WHERE guild_id = ? AND user_id = ?', guild.id, targetId)?.avatar;
    if (!before) return target;
    run('UPDATE guild_members SET avatar = NULL WHERE guild_id = ? AND user_id = ?', guild.id, targetId);
    removeUpload('memberavatars', storedNameFromUrl(before));
    if (targetId !== ctx.user.id) audit(guild.id, ctx.user.id, 'MEMBER_UPDATE', { targetId, targetType: 'user', changes: { serverAvatar: null } });
    const member = getMember(guild.id, targetId);
    sendToGuild(guild.id, 'GUILD_MEMBER_UPDATE', { guildId: guild.id, member });
    return member;
  });

  // ================================================================ announcement channels
  r.post('/api/channels/:id/messages/:messageId/publish', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { channel, perms, guild } = access;
    if (channel.type !== ChannelType.ANNOUNCEMENT) throw bad('Only posts in an announcement channel can be published.');
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, channel.id);
    if (!row) throw notFound('That message is gone.');
    if (row.author_id === ctx.user.id) requirePerm(perms, P.SEND_MESSAGES, 'You can’t post in this channel.');
    else requirePerm(perms, P.MANAGE_MESSAGES, 'You can publish your own posts. To publish someone else’s you need permission to manage messages.');
    if (row.type !== 0 && row.type !== 19) throw bad('That kind of message can’t be published.');
    if (row.crosspost) throw bad('That is already a published announcement from another server.');
    if (getPoll(row.id)) throw bad('Polls can’t be published.');
    if (row.published_at) throw new HttpError(409, 'That post was already published.', 'already_published');
    enforceRateLimit(`publish:${channel.id}`, 10, 3600 * 1000, 'This channel published a lot just now. Try again in a little while.');

    const follows = all('SELECT * FROM channel_follows WHERE source_channel_id = ?', channel.id);
    const atts = all('SELECT * FROM attachments WHERE message_id = ?', row.id);
    const content = neutralizeMentions(row.content, guild);
    const g = get('SELECT name, icon FROM guilds WHERE id = ?', guild.id);
    const origin = { guildId: guild.id, guildName: g.name, guildIcon: g.icon || null, channelId: channel.id, channelName: channel.name, messageId: row.id };
    let delivered = 0;
    for (const f of follows) {
      const target = getChannelRow(f.target_channel_id);
      if (!target || !isTextLike(target.type)) continue;
      const id = newId();
      const copies = [];
      try {
        for (const a of atts) {
          try { copies.push({ ...a, id: newId(), stored_name: duplicateUpload('attachments', a.stored_name) }); } catch { /* the file is gone: the post goes without it */ }
        }
        tx(() => {
          run('INSERT INTO messages (id, channel_id, author_id, content, type, created_at, embeds, crosspost) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
            id, target.id, row.author_id, content, Date.now(), row.embeds || '[]', JSON.stringify(origin));
          for (const c of copies) {
            run('INSERT INTO attachments (id, message_id, uploader_id, filename, stored_name, size, content_type, spoiler, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              c.id, id, c.uploader_id, c.filename, c.stored_name, c.size, c.content_type, c.spoiler, c.description, Date.now());
          }
          run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, target.id);
        });
      } catch (e) {
        copies.forEach((c) => removeUpload('attachments', c.stored_name));
        console.error('[publish]', e.message);
        continue;
      }
      delivered++;
      const copy = { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', id)])[0], guildId: target.guild_id };
      sendToChannel(target, 'MESSAGE_CREATE', copy);
      // Phones where NullChat is closed: people who asked for every message get the announcement too (it pings nobody by itself).
      pushForMessage({ channel: target, isDM: false, msg: copy, authorId: row.author_id, notified: [], onlyEveryone: new Set() });
    }
    run('UPDATE messages SET published_at = ? WHERE id = ?', Date.now(), row.id);
    audit(guild.id, ctx.user.id, 'MESSAGE_PUBLISH', { targetId: row.id, targetType: 'message', changes: { servers: delivered } });
    sendToChannel(channel, 'MESSAGE_UPDATE', { ...serializeMessages([get('SELECT * FROM messages WHERE id = ?', row.id)])[0], guildId: channel.guild_id });
    return { delivered };
  });

  r.get('/api/channels/:id/follows', async (ctx) => {
    const { channel, perms } = channelAccess(ctx.params.id, ctx.user.id);
    if (!channel.guild_id) throw bad('Direct messages can’t be followed.');
    requirePerm(perms, P.MANAGE_CHANNELS);
    return {
      followers: all('SELECT * FROM channel_follows WHERE source_channel_id = ? ORDER BY created_at', channel.id).map(serializeFollow),
      following: all('SELECT * FROM channel_follows WHERE target_channel_id = ? ORDER BY created_at', channel.id).map(serializeFollow),
    };
  });

  r.post('/api/channels/:id/follows', async (ctx) => {
    const src = channelAccess(ctx.params.id, ctx.user.id);
    if (src.channel.type !== ChannelType.ANNOUNCEMENT) throw bad('Only announcement channels can be followed.');
    const { targetChannelId } = z.object({ targetChannelId: z.string().max(40) }).parse(ctx.body);
    let dst;
    try { dst = channelAccess(targetChannelId, ctx.user.id); } catch { throw notFound('Pick one of your own text channels.'); }
    if (!dst.channel.guild_id || dst.channel.type !== ChannelType.TEXT) throw bad('Announcements can only be sent to a text channel.');
    if (dst.channel.guild_id === src.channel.guild_id) throw bad('Pick a channel in a different server. Everyone in this server can already read the announcements.');
    requirePerm(dst.perms, P.MANAGE_CHANNELS, 'You need permission to manage channels in that server.');
    enforceRateLimit(`follow:${ctx.user.id}`, 20, 3600 * 1000);
    if (get('SELECT 1 FROM channel_follows WHERE source_channel_id = ? AND target_channel_id = ?', src.channel.id, dst.channel.id)) throw new HttpError(409, 'That channel already follows this one.', 'already_following');
    if (get('SELECT COUNT(*) AS n FROM channel_follows WHERE source_channel_id = ?', src.channel.id).n >= FOLLOWERS_MAX) throw bad(`This channel already has the most followers it can have (${FOLLOWERS_MAX}).`);
    if (get('SELECT COUNT(*) AS n FROM channel_follows WHERE target_channel_id = ?', dst.channel.id).n >= FOLLOWING_MAX) throw bad(`That channel already follows ${FOLLOWING_MAX} announcement channels. Pick another.`);
    const id = newId();
    run('INSERT INTO channel_follows (id, source_channel_id, source_guild_id, target_channel_id, target_guild_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, src.channel.id, src.channel.guild_id, dst.channel.id, dst.channel.guild_id, ctx.user.id, Date.now());
    const f = get('SELECT * FROM channel_follows WHERE id = ?', id);
    const s = serializeFollow(f);
    audit(dst.channel.guild_id, ctx.user.id, 'CHANNEL_FOLLOW', { targetId: dst.channel.id, targetType: 'channel', changes: { follows: `${s.source.guildName} #${s.source.channelName}` } });
    audit(src.channel.guild_id, ctx.user.id, 'CHANNEL_FOLLOWED', { targetId: src.channel.id, targetType: 'channel', changes: { by: `${s.target.guildName} #${s.target.channelName}` } });
    return s;
  });

  r.delete('/api/follows/:followId', async (ctx) => {
    const f = get('SELECT * FROM channel_follows WHERE id = ?', ctx.params.followId);
    if (!f) throw notFound('That follow is gone.');
    const mayTarget = (() => { try { return has(guildAccess(f.target_guild_id, ctx.user.id).perms, P.MANAGE_CHANNELS); } catch { return false; } })();
    const maySource = (() => { try { return has(guildAccess(f.source_guild_id, ctx.user.id).perms, P.MANAGE_CHANNELS); } catch { return false; } })();
    if (!mayTarget && !maySource) throw forbidden('You need permission to manage channels in one of the two servers.');
    run('DELETE FROM channel_follows WHERE id = ?', f.id);
    const s = serializeFollow(f);
    audit(f.target_guild_id, ctx.user.id, 'CHANNEL_UNFOLLOW', { targetId: f.target_channel_id, targetType: 'channel', changes: { stopped: `${s.source.guildName} #${s.source.channelName}` } });
    audit(f.source_guild_id, ctx.user.id, 'CHANNEL_UNFOLLOWED', { targetId: f.source_channel_id, targetType: 'channel', changes: { by: `${s.target.guildName} #${s.target.channelName}` } });
    return { ok: true };
  });
}

/** Per-server pictures nobody uses any more (the person left, was removed, or the server was deleted): removed after an hour. Run hourly. */
export function sweepMemberAvatars() {
  const dir = path.join(UPLOAD_DIR, 'memberavatars');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const used = new Set(all("SELECT avatar FROM guild_members WHERE avatar LIKE '/uploads/memberavatars/%'").map((x) => path.basename(x.avatar)));
  const old = Date.now() - 3600 * 1000;
  for (const n of names) {
    if (used.has(n)) continue;
    try { if (fs.statSync(path.join(dir, n)).mtimeMs < old) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* next time */ }
  }
}

