// Server tags (see lib/servertag.js for the rules).
//   PUT    /api/guilds/:id/tag/badge   upload a badge picture (people who manage the server)
//   PUT    /api/guilds/:id/tag         set the tag: text, badge, colour (people who manage the server)
//   DELETE /api/guilds/:id/tag         remove it (everyone who wore it stops wearing it)
//   PUT    /api/users/@me/tag          wear the tag of one of my servers, or none
//   GET    /api/guilds/:id/tag-card    what a click on a tag shows: the server and, when it is public or I am in it, a little more
import { z } from 'zod';
import { get, run } from '../db.js';
import { bad, forbidden, notFound, HttpError, enforceRateLimit } from '../lib/http.js';
import { guildAccess, requirePerm, getMember, privateUser, getUserRow } from '../models.js';
import { P } from '../../../shared/permissions.js';
import { receiveImage } from '../lib/uploads.js';
import { audit } from '../services.js';
import { syncGuild, sendToUsers, onlineUserIds, broadcastUserUpdate } from '../gateway.js';
import { forget, tagOfGuild, badgeToStored, removeBadgeFile, badgeFileExists, wearerCount } from '../lib/servertag.js';
import {
  TAG_ICONS, TAG_COLORS, TAG_BADGE_MAX_BYTES, TAG_BADGE_URL, normalizeTagText, validTagText, isReservedTag, TAG_MIN, TAG_MAX,
} from '../../../shared/tags.js';

/** Everyone online hears that a server's tag changed (one message each), and patches the people they have on screen who wear it. */
const announce = (guildId, tag) => sendToUsers(onlineUserIds(), 'TAG_UPDATE', { guildId, tag });

export default function register(r) {
  r.put('/api/guilds/:id/tag/badge', { raw: true }, async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    enforceRateLimit(`tagbadge:${ctx.user.id}`, 20, 3600 * 1000, 'You are uploading badges too quickly. Try again in a little while.');
    const tooBig = () => new HttpError(413, `That picture is too big for a badge. The limit is ${TAG_BADGE_MAX_BYTES / 1024} KB.`, 'too_large');
    if (Number(ctx.req.headers['content-length'] || 0) > TAG_BADGE_MAX_BYTES) { ctx.req.resume(); throw tooBig(); }
    let img;
    try { img = await receiveImage(ctx.req, 'tagbadges', TAG_BADGE_MAX_BYTES); }
    catch (e) { throw e?.code === 'too_large' ? tooBig() : e; }
    return { url: `/uploads/tagbadges/${img.storedName}`, badge: { kind: 'image', url: `/uploads/tagbadges/${img.storedName}` } };
  });

  r.put('/api/guilds/:id/tag', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const body = z.object({
      text: z.string().max(40),
      color: z.enum(TAG_COLORS),
      badge: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('icon'), name: z.string().max(20) }),
        z.object({ kind: z.literal('image'), url: z.string().max(200) }),
      ]),
    }).parse(ctx.body);
    const text = normalizeTagText(body.text);
    if (!validTagText(text)) throw bad(`A tag is ${TAG_MIN} to ${TAG_MAX} letters or numbers (A to Z and 0 to 9).`, 'bad_tag', { errors: { text: `Use ${TAG_MIN} to ${TAG_MAX} letters or numbers, with no spaces or symbols.` } });
    if (isReservedTag(text)) throw bad('That tag is kept for the people who run NullChat. Pick another.', 'tag_reserved', { errors: { text: 'That tag is reserved. Pick another.' } });
    if (body.badge.kind === 'icon' && !TAG_ICONS[body.badge.name]) throw bad('Unknown badge.', 'bad_badge');
    if (body.badge.kind === 'image' && !(TAG_BADGE_URL.test(body.badge.url) && badgeFileExists(body.badge.url))) throw bad('That badge picture is gone. Upload it again.', 'bad_badge');
    const taken = get('SELECT id FROM guilds WHERE LOWER(tag) = ? AND id != ?', text.toLowerCase(), guild.id);
    if (taken) throw new HttpError(409, 'Another server already uses that tag.', 'tag_taken', { errors: { text: 'Another server already uses that tag.' } });

    const before = get('SELECT tag, tag_badge, tag_color FROM guilds WHERE id = ?', guild.id);
    const stored = badgeToStored(body.badge);
    // Saving what is already there is free; actual changes are limited (everyone online hears about each one).
    if (before.tag !== text || before.tag_badge !== stored || before.tag_color !== body.color) enforceRateLimit(`tagset:${guild.id}`, 10, 3600 * 1000, 'This server’s tag was changed a lot just now. Try again in an hour.');
    try { run('UPDATE guilds SET tag = ?, tag_badge = ?, tag_color = ? WHERE id = ?', text, stored, body.color, guild.id); }
    catch (e) { if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Another server already uses that tag.', 'tag_taken', { errors: { text: 'Another server already uses that tag.' } }); throw e; }
    if (before.tag_badge && before.tag_badge !== stored) removeBadgeFile(before.tag_badge);
    forget(guild.id);
    const changes = {};
    if (before.tag !== text) changes.tag = text;
    if (before.tag_badge !== stored) changes.tagBadge = body.badge.kind === 'image' ? 'picture' : body.badge.name;
    if (before.tag_color !== body.color) changes.tagColor = body.color;
    if (Object.keys(changes).length) audit(guild.id, ctx.user.id, 'GUILD_TAG', { targetId: guild.id, targetType: 'guild', changes });
    const tag = tagOfGuild(guild.id);
    announce(guild.id, tag);
    syncGuild(guild.id);
    return { tag };
  });

  r.delete('/api/guilds/:id/tag', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const before = get('SELECT tag, tag_badge FROM guilds WHERE id = ?', guild.id);
    if (!before?.tag) return { ok: true };
    removeServerTag(guild.id);
    audit(guild.id, ctx.user.id, 'GUILD_TAG', { targetId: guild.id, targetType: 'guild', changes: { tag: null } });
    syncGuild(guild.id);
    return { ok: true };
  });

  r.put('/api/users/@me/tag', async (ctx) => {
    if (ctx.user.bot) throw forbidden('A bot can’t wear a server tag.');
    enforceRateLimit(`wear:${ctx.user.id}`, 30, 3600 * 1000, 'You are changing your tag too quickly.');
    const { guildId } = z.object({ guildId: z.string().max(40).nullable() }).parse(ctx.body);
    if (guildId === null) run('UPDATE users SET tag_guild_id = NULL WHERE id = ?', ctx.user.id);
    else {
      if (!getMember(guildId, ctx.user.id)) throw notFound('You are not in that server.');
      if (!tagOfGuild(guildId)) throw bad('That server has no tag.', 'no_tag');
      run('UPDATE users SET tag_guild_id = ? WHERE id = ?', guildId, ctx.user.id);
    }
    broadcastUserUpdate(ctx.user.id);
    return privateUser(getUserRow(ctx.user.id));
  });

  r.get('/api/guilds/:id/tag-card', async (ctx) => {
    enforceRateLimit(`tagcard:${ctx.user.id}`, 120, 60 * 1000);
    const g = get('SELECT id, name, icon, description, discoverable, tag FROM guilds WHERE id = ?', ctx.params.id);
    if (!g?.tag) throw notFound('That server has no tag any more.');
    const member = !!getMember(g.id, ctx.user.id);
    const open = !!g.discoverable;
    // The name and picture are already public (the person chose to wear the tag); the rest only for people who are in, or could join anyway.
    return {
      id: g.id, name: g.name, icon: g.icon, tag: tagOfGuild(g.id), isMember: member, discoverable: open,
      ...(member || open ? {
        description: g.description || '',
        memberCount: get('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?', g.id).n,
        wearing: wearerCount(g.id),
      } : {}),
    };
  });
}

/** Take a server's tag away: its text, badge picture, and everyone's wearing of it. Used by the server's managers and by the site admin. */
export function removeServerTag(guildId) {
  const before = get('SELECT tag_badge FROM guilds WHERE id = ?', guildId);
  run('UPDATE users SET tag_guild_id = NULL WHERE tag_guild_id = ?', guildId);
  run('UPDATE guilds SET tag = NULL, tag_badge = NULL, tag_color = NULL WHERE id = ?', guildId);
  if (before?.tag_badge) removeBadgeFile(before.tag_badge);
  forget(guildId);
  announce(guildId, null);
}
