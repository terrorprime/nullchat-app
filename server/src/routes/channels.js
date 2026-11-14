import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, tx } from '../db.js';
import { bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { receiveUpload, receiveImage, removeUpload, safeFilename, sniffImage, storedNameFromUrl } from '../lib/uploads.js';
import { config, UPLOAD_DIR } from '../config.js';
import {
  channelAccess, serializeChannel, serializePrivateChannel, getChannelRow, requirePerm, getUserRow, relationshipType, serializeMessages,
} from '../models.js';
import { syncGuild, sendToUser, sendToChannel, endCallsForChannel, revalidateVoice, revalidateGuildVoice as guildMembersOnlineRevalidate } from '../gateway.js';
import { audit, createSystemMessage } from '../services.js';
import { normalizeChannelName } from './guilds.js';
import { cleanTagList, checkAppliedTags, tagsOf, appliedOf, MAX_PINNED_POSTS } from '../lib/forum.js';
import { runAutomod } from './messages.js';
import { P, ChannelType, ALL_PERMISSIONS } from '../../../shared/permissions.js';

/** A file's description (alt text): trimmed, one blank run at most, 1000 characters, or nothing. */
export function cleanDescription(v) {
  const t = String(v ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);
  return t || null;
}

export default function register(r) {
  r.get('/api/channels/:id', async (ctx) => {
    const { channel, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    return isDM ? serializePrivateChannel(channel, ctx.user.id) : serializeChannel(channel);
  });

  r.patch('/api/channels/:id', async (ctx) => {
    const access = channelAccess(ctx.params.id, ctx.user.id);
    const { channel, perms, isDM } = access;
    if (isDM) {
      if (channel.type !== ChannelType.GROUP_DM) throw bad('You can’t edit a direct message.');
      const body = z.object({ name: z.string().trim().max(100).nullable().optional(), icon: z.null().optional() }).parse(ctx.body);
      if (body.name !== undefined) run('UPDATE channels SET name = ? WHERE id = ?', body.name || null, channel.id);
      if (body.icon === null) { removeUpload('icons', storedNameFromUrl(channel.icon)); run('UPDATE channels SET icon = NULL WHERE id = ?', channel.id); }
      const row = getChannelRow(channel.id);
      for (const rec of all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id)) sendToUser(rec.user_id, 'CHANNEL_UPDATE', serializePrivateChannel(row, rec.user_id));
      if (body.name !== undefined) createSystemMessage(row, ctx.user.id, 4, body.name || '');
      return serializePrivateChannel(row, ctx.user.id);
    }
    if (channel.type === ChannelType.THREAD) {
      const body = z.object({ name: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional(), locked: z.boolean().optional(), pinned: z.boolean().optional(), appliedTags: z.array(z.string().max(40)).max(20).optional() }).parse(ctx.body);
      const canManage = (perms & P.MANAGE_THREADS) === P.MANAGE_THREADS;
      if (!canManage && channel.owner_id !== ctx.user.id) throw forbidden();
      if (body.locked !== undefined && !canManage) throw forbidden('Only moderators can lock threads.');
      if (body.pinned !== undefined && !canManage) throw forbidden('Only moderators can pin posts.');
      if (channel.locked && !canManage) throw forbidden('This thread is locked.');
      if (body.name) runAutomod(access, ctx.user.id, body.name, !!ctx.user.bot);   // (a new title is read by AutoMod like a message)
      const sets = []; const vals = [];
      if (body.appliedTags !== undefined) {
        const forum = getChannelRow(channel.parent_id);
        if (forum?.type !== ChannelType.FORUM) throw bad('Only posts in a forum have tags.');
        sets.push('applied_tags = ?'); vals.push(JSON.stringify(checkAppliedTags(forum, body.appliedTags)));
      }
      if (body.name) { sets.push('name = ?'); vals.push(body.name); }
      // Pinning: a moderator keeps up to MAX_PINNED_POSTS open posts at the top of a forum. A closed post is taken off the top again.
      let pinChange = null;
      if (body.pinned !== undefined || body.archived === true) {
        const forum = getChannelRow(channel.parent_id);
        const isForumPost = forum?.type === ChannelType.FORUM;
        if (body.pinned === true) {
          if (!isForumPost) throw bad('Only posts in a forum can be pinned.', 'not_a_post');
          if (channel.archived && body.archived !== false) throw bad('Reopen this post before pinning it.', 'post_closed');
          if (!channel.pinned_at) {
            const n = get('SELECT COUNT(*) AS n FROM channels WHERE parent_id = ? AND type = ? AND pinned_at IS NOT NULL AND archived = 0', channel.parent_id, ChannelType.THREAD).n;
            if (n >= MAX_PINNED_POSTS) throw bad(`A forum can have at most ${MAX_PINNED_POSTS} pinned posts. Unpin one first.`, 'too_many_pinned');
            sets.push('pinned_at = ?'); vals.push(Date.now()); pinChange = 'THREAD_PIN';
          }
        } else if (channel.pinned_at && (body.pinned === false || body.archived === true)) {
          sets.push('pinned_at = NULL'); pinChange = 'THREAD_UNPIN';
        }
      }
      if (body.archived !== undefined) { sets.push('archived = ?'); vals.push(body.archived ? 1 : 0); }
      if (body.locked !== undefined) { sets.push('locked = ?'); vals.push(body.locked ? 1 : 0); }
      if (sets.length) run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, ...vals, channel.id);
      const row = getChannelRow(channel.id);
      if (pinChange) audit(channel.guild_id, ctx.user.id, pinChange, { targetId: channel.id, targetType: 'channel', changes: { name: channel.name, forumId: channel.parent_id } });
      sendToChannel(row, 'THREAD_UPDATE', serializeChannel(row, []));
      return serializeChannel(row, []);
    }
    requirePerm(perms, P.MANAGE_CHANNELS);
    const body = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      nsfw: z.boolean().optional(),
      rateLimit: z.number().int().min(0).max(21600).optional(),
      availableTags: z.array(z.object({ id: z.string().max(40).optional(), name: z.string().max(60), emoji: z.string().max(16).nullable().optional() })).max(20).optional(),
      forumSort: z.union([z.literal(0), z.literal(1)]).optional(),
      requireTag: z.boolean().optional(),
      userLimit: z.number().int().min(0).max(99).optional(),
      announcement: z.boolean().optional(),   // turn a text channel into an announcement channel (other servers can follow it) or back
      bitrate: z.number().int().min(8000).max(384000).optional(),
      parentId: z.string().nullable().optional(),
      syncPermissions: z.boolean().optional(),
    }).parse(ctx.body);
    const sets = []; const vals = []; const changes = {};
    const set = (col, val, key) => { sets.push(`${col} = ?`); vals.push(val); changes[key] = val; };
    if (body.name !== undefined) { const n = normalizeChannelName(body.name, channel.type); if (!n) throw bad('Invalid name.'); set('name', n, 'name'); }
    if (body.topic !== undefined) set('topic', body.topic, 'topic');
    if (body.nsfw !== undefined) set('nsfw', body.nsfw ? 1 : 0, 'nsfw');
    if (body.rateLimit !== undefined) set('rate_limit', body.rateLimit, 'rateLimit');
    if (body.userLimit !== undefined) set('user_limit', body.userLimit, 'userLimit');
    if (body.bitrate !== undefined) set('bitrate', body.bitrate, 'bitrate');
    let unfollowed = 0;
    if (body.announcement !== undefined) {
      if (channel.type !== ChannelType.TEXT && channel.type !== ChannelType.ANNOUNCEMENT) throw bad('Only text channels can be announcement channels.');
      const to = body.announcement ? ChannelType.ANNOUNCEMENT : ChannelType.TEXT;
      if (to !== channel.type) {
        set('type', to, 'announcement');
        changes.announcement = body.announcement;
        if (to === ChannelType.TEXT) unfollowed = get('SELECT COUNT(*) AS n FROM channel_follows WHERE source_channel_id = ?', channel.id).n;   // (servers following it stop; see below)
      }
    }
    let removedTags = [];
    if (channel.type === ChannelType.FORUM) {
      if (body.availableTags !== undefined) {
        const before = tagsOf(channel);
        const next = cleanTagList(body.availableTags, before);
        removedTags = before.filter((t) => !next.some((n) => n.id === t.id)).map((t) => t.id);
        set('available_tags', JSON.stringify(next), 'tags');
      }
      if (body.forumSort !== undefined) set('forum_sort', body.forumSort, 'forumSort');
      if (body.requireTag !== undefined) set('require_tag', body.requireTag ? 1 : 0, 'requireTag');
    } else if (body.availableTags !== undefined || body.forumSort !== undefined || body.requireTag !== undefined) {
      throw bad('Only forum channels have tags.');
    }
    if (body.parentId !== undefined && channel.type !== ChannelType.CATEGORY) {
      if (body.parentId) {
        const p = getChannelRow(body.parentId);
        if (!p || p.guild_id !== channel.guild_id || p.type !== ChannelType.CATEGORY) throw bad('Unknown category.');
      }
      set('parent_id', body.parentId, 'parentId');
    }
    tx(() => {
      if (sets.length) run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, ...vals, channel.id);
      if (unfollowed) run('DELETE FROM channel_follows WHERE source_channel_id = ?', channel.id);
      if (removedTags.length) {   // a tag that was deleted leaves the posts that carried it
        for (const post of all('SELECT id, applied_tags FROM channels WHERE parent_id = ? AND type = ?', channel.id, ChannelType.THREAD)) {
          const had = appliedOf(post);
          if (had.some((x) => removedTags.includes(x))) run('UPDATE channels SET applied_tags = ? WHERE id = ?', JSON.stringify(had.filter((x) => !removedTags.includes(x))), post.id);
        }
      }
      if (body.syncPermissions && channel.parent_id) {
        run('DELETE FROM channel_overwrites WHERE channel_id = ?', channel.id);
        for (const o of all('SELECT * FROM channel_overwrites WHERE channel_id = ?', channel.parent_id)) {
          run('INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, ?, ?, ?)', channel.id, o.target_id, o.target_type, o.allow, o.deny);
        }
        changes.syncPermissions = true;
      }
    });
    if (Object.keys(changes).length) audit(channel.guild_id, ctx.user.id, 'CHANNEL_UPDATE', { targetId: channel.id, targetType: 'channel', changes });
    syncGuild(channel.guild_id);
    if (body.syncPermissions) guildMembersOnlineRevalidate(channel.guild_id);
    return serializeChannel(getChannelRow(channel.id));
  });

  r.put('/api/channels/:id/icon', { raw: true }, async (ctx) => {
    const { channel } = channelAccess(ctx.params.id, ctx.user.id);
    if (channel.type !== ChannelType.GROUP_DM) { ctx.req.resume(); throw bad('Only group DMs have icons.'); }
    const img = await receiveImage(ctx.req, 'icons', 8 * 1024 * 1024);
    removeUpload('icons', storedNameFromUrl(channel.icon));
    run('UPDATE channels SET icon = ? WHERE id = ?', `/uploads/icons/${img.storedName}`, channel.id);
    const row = getChannelRow(channel.id);
    for (const rec of all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id)) sendToUser(rec.user_id, 'CHANNEL_UPDATE', serializePrivateChannel(row, rec.user_id));
    return serializePrivateChannel(row, ctx.user.id);
  });

  r.delete('/api/channels/:id', async (ctx) => {
    const { channel, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM) {
      if (channel.type === ChannelType.DM) {
        run('UPDATE channel_recipients SET closed = 1 WHERE channel_id = ? AND user_id = ?', channel.id, ctx.user.id);
        sendToUser(ctx.user.id, 'CHANNEL_DELETE', { id: channel.id });
        return { ok: true };
      }
      // Leave group DM.
      run('DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?', channel.id, ctx.user.id);
      sendToUser(ctx.user.id, 'CHANNEL_DELETE', { id: channel.id });
      const remaining = all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id);
      if (!remaining.length) { endCallsForChannel(channel.id); run('DELETE FROM channels WHERE id = ?', channel.id); return { ok: true }; }
      if (channel.owner_id === ctx.user.id) run('UPDATE channels SET owner_id = ? WHERE id = ?', remaining[0].user_id, channel.id);
      const row = getChannelRow(channel.id);
      for (const rec of remaining) sendToUser(rec.user_id, 'CHANNEL_UPDATE', serializePrivateChannel(row, rec.user_id));
      createSystemMessage(row, ctx.user.id, 2, '');
      revalidateVoice(ctx.user.id);
      return { ok: true };
    }
    if (channel.type === ChannelType.THREAD) {
      // (whoever started a post in a forum may delete it; every other thread needs Manage Threads)
      const ownPost = channel.owner_id === ctx.user.id && getChannelRow(channel.parent_id)?.type === ChannelType.FORUM;
      if (!ownPost && (perms & P.MANAGE_THREADS) !== P.MANAGE_THREADS) throw forbidden();
    } else requirePerm(perms, P.MANAGE_CHANNELS);
    const viewers = channel; // capture before delete for fan-out
    endCallsForChannel(channel.id);
    const atts = all('SELECT a.stored_name FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ? OR m.channel_id IN (SELECT id FROM channels WHERE parent_id = ? AND type = ?)', channel.id, channel.id, ChannelType.THREAD);
    tx(() => {
      if (channel.type === ChannelType.CATEGORY) run('UPDATE channels SET parent_id = NULL WHERE parent_id = ?', channel.id);
      run('DELETE FROM channels WHERE parent_id = ? AND type = ?', channel.id, ChannelType.THREAD);
      run('DELETE FROM channels WHERE id = ?', channel.id);
      run('UPDATE guilds SET system_channel_id = NULL WHERE system_channel_id = ?', channel.id);
    });
    atts.forEach((a) => removeUpload('attachments', a.stored_name));
    audit(channel.guild_id, ctx.user.id, channel.type === ChannelType.THREAD ? 'THREAD_DELETE' : 'CHANNEL_DELETE', { targetId: channel.id, targetType: 'channel', changes: { name: channel.name } });
    if (channel.type === ChannelType.THREAD) {
      const parent = getChannelRow(channel.parent_id);
      if (parent) sendToChannel(parent, 'THREAD_DELETE', { id: channel.id, parentId: channel.parent_id, guildId: channel.guild_id });
    }
    void viewers;
    syncGuild(channel.guild_id);
    return { ok: true };
  });

  // ---- permission overwrites ----
  r.put('/api/channels/:id/permissions/:targetId', async (ctx) => {
    const { channel, guild, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM || channel.type === ChannelType.THREAD) throw bad('This channel has no permission overwrites.');
    requirePerm(perms, P.MANAGE_ROLES, 'You need Manage Roles (or Manage Permissions) to edit channel permissions.');
    const body = z.object({ type: z.union([z.literal(0), z.literal(1)]), allow: z.number().int().min(0).max(ALL_PERMISSIONS), deny: z.number().int().min(0).max(ALL_PERMISSIONS) }).parse(ctx.body);
    if (body.type === 0 && !guild.roles.some((x) => x.id === ctx.params.targetId)) throw notFound('Unknown role.');
    if (body.type === 1 && !get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', guild.id, ctx.params.targetId)) throw notFound('Unknown member.');
    // Can only allow/deny permissions the actor holds in this channel.
    if (((body.allow | body.deny) & ~perms) !== 0 && guild.ownerId !== ctx.user.id) throw forbidden('You can only change permissions you have yourself.');
    run(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny, target_type = excluded.target_type`,
    channel.id, ctx.params.targetId, body.type, body.allow & ~body.deny, body.deny);
    audit(guild.id, ctx.user.id, 'CHANNEL_OVERWRITE_UPDATE', { targetId: channel.id, targetType: 'channel', changes: { target: ctx.params.targetId, allow: body.allow, deny: body.deny } });
    syncGuild(guild.id);
    guildMembersOnlineRevalidate(guild.id);
    return serializeChannel(getChannelRow(channel.id));
  });
  r.delete('/api/channels/:id/permissions/:targetId', async (ctx) => {
    const { channel, guild, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM) throw bad('This channel has no permission overwrites.');
    requirePerm(perms, P.MANAGE_ROLES);
    run('DELETE FROM channel_overwrites WHERE channel_id = ? AND target_id = ?', channel.id, ctx.params.targetId);
    audit(guild.id, ctx.user.id, 'CHANNEL_OVERWRITE_DELETE', { targetId: channel.id, targetType: 'channel', changes: { target: ctx.params.targetId } });
    syncGuild(guild.id);
    guildMembersOnlineRevalidate(guild.id);
    return serializeChannel(getChannelRow(channel.id));
  });

  // ---- group DM recipients ----
  r.put('/api/channels/:id/recipients/:userId', async (ctx) => {
    const { channel } = channelAccess(ctx.params.id, ctx.user.id);
    if (channel.type !== ChannelType.GROUP_DM) throw bad('Not a group DM.');
    const uid = ctx.params.userId;
    if (relationshipType(ctx.user.id, uid) !== 1) throw bad('You can only add friends to a group DM.');
    const count = get('SELECT COUNT(*) AS n FROM channel_recipients WHERE channel_id = ?', channel.id).n;
    if (count >= 10) throw bad('Group DMs can have at most 10 members.');
    run('INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)', channel.id, uid);
    const row = getChannelRow(channel.id);
    for (const rec of all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id)) {
      sendToUser(rec.user_id, rec.user_id === uid ? 'CHANNEL_CREATE' : 'CHANNEL_UPDATE', serializePrivateChannel(row, rec.user_id));
    }
    createSystemMessage(row, ctx.user.id, 1, '', {});
    run('UPDATE messages SET mentions = ? WHERE id = ?', JSON.stringify([uid]), row.last_message_id);
    return serializePrivateChannel(row, ctx.user.id);
  });
  r.delete('/api/channels/:id/recipients/:userId', async (ctx) => {
    const { channel } = channelAccess(ctx.params.id, ctx.user.id);
    if (channel.type !== ChannelType.GROUP_DM) throw bad('Not a group DM.');
    if (channel.owner_id !== ctx.user.id) throw forbidden('Only the group owner can remove members.');
    const uid = ctx.params.userId;
    run('DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?', channel.id, uid);
    sendToUser(uid, 'CHANNEL_DELETE', { id: channel.id });
    revalidateVoice(uid);
    const row = getChannelRow(channel.id);
    for (const rec of all('SELECT user_id FROM channel_recipients WHERE channel_id = ?', channel.id)) sendToUser(rec.user_id, 'CHANNEL_UPDATE', serializePrivateChannel(row, rec.user_id));
    createSystemMessage(row, ctx.user.id, 2, '');
    run('UPDATE messages SET mentions = ? WHERE id = ?', JSON.stringify([uid]), getChannelRow(channel.id).last_message_id);
    return { ok: true };
  });

  // ---- attachments (uploaded before the message is sent) ----
  r.post('/api/attachments', { raw: true }, async (ctx) => {
    enforceRateLimit(`upload:${ctx.user.id}`, 30, 60_000, 'You are uploading too quickly.');
    const filename = safeFilename(ctx.query.filename);
    const up = await receiveUpload(ctx.req, 'attachments', config.maxUploadMb * 1024 * 1024);
    let ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const sig = sniffImage(up.head);
    let contentType = String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (sig) { contentType = sig.type; ext = sig.ext; }
    else if (contentType.startsWith('image/')) contentType = 'application/octet-stream'; // claimed image but isn't one
    if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType)) contentType = 'application/octet-stream';
    const storedName = up.storedName + ext;
    fs.renameSync(up.filePath, path.join(UPLOAD_DIR, 'attachments', storedName));
    const id = newId();
    const description = cleanDescription(ctx.query.description);
    run('INSERT INTO attachments (id, uploader_id, filename, stored_name, size, content_type, spoiler, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ctx.user.id, filename, storedName, up.size, contentType, ctx.query.spoiler === 'true' ? 1 : 0, description, Date.now());
    return { id, filename, size: up.size, contentType, description, url: `/uploads/attachments/${storedName}` };
  });

  // Add, change or remove the description (alt text) of a file you uploaded: before the message is sent, or after (it then updates for everyone who can see it).
  r.patch('/api/attachments/:id', async (ctx) => {
    const { description } = z.object({ description: z.string().max(2000).nullable() }).parse(ctx.body);
    const a = get('SELECT * FROM attachments WHERE id = ?', ctx.params.id);
    if (!a || a.uploader_id !== ctx.user.id) throw notFound('Unknown file.');
    enforceRateLimit(`altedit:${ctx.user.id}`, 60, 60_000);
    const clean = cleanDescription(description);
    run('UPDATE attachments SET description = ? WHERE id = ?', clean, a.id);
    if (a.message_id) {
      const m = get('SELECT * FROM messages WHERE id = ?', a.message_id);
      const channel = m && getChannelRow(m.channel_id);
      if (channel) sendToChannel(channel, 'MESSAGE_UPDATE', { ...serializeMessages([m])[0], guildId: channel.guild_id });
    }
    return { id: a.id, description: clean };
  });

  void getUserRow;
}
