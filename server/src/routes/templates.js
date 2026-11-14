// Server templates: a saved copy of a server's set-up that anyone with the link can start a new server from.
//
//   · A server manager (Manage Server) makes ONE template for the server in Server Settings → Server Template and gets a link: /template/<code>.
//     It records the set-up only: roles (name, colour, permissions, "show separately", mentionable), channels and categories (name, type, topic,
//     order, slowmode, limits, forum tags) with the role permission overrides on them, the @everyone permissions, the verification level, the
//     AutoMod rules and which channel gets the "X just joined" messages.
//   · It never records messages, members, member roles, invites, emoji, bots, webhooks, the server's name or picture, or permission overrides for a
//     single person. The person who uses a template becomes the owner of a fresh server.
//   · The template is a snapshot, not a live link: a later change to the server shows as "Out of sync" until a manager presses Sync.
//   · Anyone with the code can look at the template (what it holds, who made it and from which server) and, when signed in, create a server from it.
import { z } from 'zod';
import { get, all, run, tx, parseJSON } from '../db.js';
import { bad, notFound, enforceRateLimit } from '../lib/http.js';
import { newId, randomCode } from '../lib/security.js';
import { guildAccess, guildPayloadFor, requirePerm, publicUser, getUserRow } from '../models.js';
import { sendToUser } from '../gateway.js';
import { audit } from '../services.js';
import { countFailedAddress } from './webhooks.js';
import { P, ChannelType, ALL_PERMISSIONS } from '../../../shared/permissions.js';

const NAME_MAX = 100, DESC_MAX = 120;
const CHANNEL_TYPES = [ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY, ChannelType.ANNOUNCEMENT, ChannelType.STAGE, ChannelType.FORUM];
const AUTOMOD_KEYS = ['blockedWords', 'blockInvites', 'blockLinks', 'mentionLimit', 'timeoutOnMentionSpam', 'spamFilter'];

/** What a server looks like right now, in the form a template keeps. Roles and channels point at each other by position in the lists ("r0", "c3"), never by id. */
export function buildSnapshot(guildId) {
  const g = get('SELECT * FROM guilds WHERE id = ?', guildId);
  if (!g) throw notFound('Unknown server.');
  const botRoles = new Set(all('SELECT role_id FROM bot_installs WHERE guild_id = ? AND role_id IS NOT NULL', guildId).map((b) => b.role_id));
  const everyone = get('SELECT permissions FROM roles WHERE id = ?', guildId);
  const roleRows = all('SELECT * FROM roles WHERE guild_id = ? AND id != ? ORDER BY position, id', guildId, guildId).filter((r) => !botRoles.has(r.id));
  const roleRef = new Map(roleRows.map((r, i) => [r.id, `r${i}`]));
  const roles = roleRows.map((r) => ({ name: r.name, color: r.color, permissions: r.permissions, hoist: !!r.hoist, mentionable: !!r.mentionable }));

  const rows = all(`SELECT * FROM channels WHERE guild_id = ? AND type IN (${CHANNEL_TYPES.join(',')}) ORDER BY position, id`, guildId);
  const ids = new Set(rows.map((c) => c.id));
  const top = rows.filter((c) => !c.parent_id || !ids.has(c.parent_id));
  const kids = new Map();
  for (const c of rows) if (c.parent_id && ids.has(c.parent_id)) { if (!kids.has(c.parent_id)) kids.set(c.parent_id, []); kids.get(c.parent_id).push(c); }
  const ordered = [];
  for (const c of top) { ordered.push(c); for (const k of kids.get(c.id) || []) ordered.push(k); }
  const chanRef = new Map(ordered.map((c, i) => [c.id, `c${i}`]));
  const channels = ordered.map((c) => {
    const out = { type: c.type, name: c.name, topic: c.topic || '', parent: c.parent_id && chanRef.get(c.parent_id) || null };
    if (c.nsfw) out.nsfw = true;
    if (c.rate_limit) out.rateLimit = c.rate_limit;
    if (c.user_limit) out.userLimit = c.user_limit;
    if (c.bitrate && c.bitrate !== 64000) out.bitrate = c.bitrate;
    if (c.type === ChannelType.FORUM) {
      out.tags = parseJSON(c.available_tags, []).map((t) => ({ name: t.name, emoji: t.emoji || null }));
      if (c.require_tag) out.requireTag = true;
      if (c.forum_sort) out.forumSort = c.forum_sort;
    }
    const overwrites = all('SELECT * FROM channel_overwrites WHERE channel_id = ? AND target_type = 0 ORDER BY target_id', c.id)
      .map((o) => ({ role: o.target_id === guildId ? 'everyone' : roleRef.get(o.target_id), allow: o.allow, deny: o.deny }))
      .filter((o) => o.role);
    if (overwrites.length) out.overwrites = overwrites;
    return out;
  });

  const automod = parseJSON(g.automod, {});
  const keep = {};
  for (const k of AUTOMOD_KEYS) if (automod[k] !== undefined) keep[k] = automod[k];
  if (Array.isArray(automod.exemptRoles)) keep.exemptRoles = automod.exemptRoles.map((id) => roleRef.get(id)).filter(Boolean);
  return {
    v: 1,
    verificationLevel: g.verification_level || 0,
    automod: keep,
    everyone: everyone?.permissions ?? 0,
    roles,
    channels,
    systemChannel: g.system_channel_id ? chanRef.get(g.system_channel_id) || null : null,
  };
}

/** A short description of a snapshot for the preview page: how much it holds and what the channels are called. */
export function summarize(snap) {
  const cats = snap.channels.filter((c) => c.type === ChannelType.CATEGORY);
  const label = (c) => ({ name: c.name, type: c.type });
  const tree = [];
  const byRef = new Map();
  snap.channels.forEach((c, i) => { if (c.type === ChannelType.CATEGORY) { const node = { ...label(c), channels: [] }; byRef.set(`c${i}`, node); tree.push(node); } });
  const loose = [];
  snap.channels.forEach((c) => {
    if (c.type === ChannelType.CATEGORY) return;
    const parent = c.parent && byRef.get(c.parent);
    (parent ? parent.channels : loose).push(label(c));
  });
  return {
    roleCount: snap.roles.length,
    channelCount: snap.channels.length - cats.length,
    categoryCount: cats.length,
    roles: snap.roles.map((r) => ({ name: r.name, color: r.color })),
    loose,
    categories: tree,
  };
}

/** A new server, owned by `ownerId`, set up like the snapshot. Returns its id. */
export function createGuildFromSnapshot(ownerId, name, snap) {
  const count = get('SELECT COUNT(*) AS n FROM guild_members WHERE user_id = ?', ownerId).n;
  if (count >= 200) throw bad('You can be in at most 200 servers.');
  const gid = newId();
  const now = Date.now();
  tx(() => {
    const roleId = new Map();
    snap.roles.forEach((_, i) => roleId.set(`r${i}`, newId()));
    const automod = { spamFilter: true, mentionLimit: 20, ...(snap.automod || {}) };
    automod.exemptRoles = (snap.automod?.exemptRoles || []).map((ref) => roleId.get(ref)).filter(Boolean);
    if (!automod.exemptRoles.length) delete automod.exemptRoles;
    run('INSERT INTO guilds (id, name, owner_id, created_at, verification_level, automod) VALUES (?, ?, ?, ?, ?, ?)',
      gid, name, ownerId, now, Math.max(0, Math.min(3, snap.verificationLevel | 0)), JSON.stringify(automod));
    run('INSERT INTO roles (id, guild_id, name, permissions, position) VALUES (?, ?, ?, ?, 0)', gid, gid, '@everyone', (snap.everyone | 0) & ALL_PERMISSIONS);
    snap.roles.forEach((r, i) => run('INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, mentionable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      roleId.get(`r${i}`), gid, r.name, r.color | 0, (r.permissions | 0) & ALL_PERMISSIONS, i + 1, r.hoist ? 1 : 0, r.mentionable ? 1 : 0));
    run('INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', gid, ownerId, now);

    const chanId = new Map();
    snap.channels.forEach((_, i) => chanId.set(`c${i}`, newId()));
    const nextPos = new Map();   // per parent (null = the top level): the next free position
    const place = (parent) => { const k = parent || ''; const p = nextPos.get(k) || 0; nextPos.set(k, p + 1); return p; };
    snap.channels.forEach((c, i) => {
      const id = chanId.get(`c${i}`);
      const parent = c.type === ChannelType.CATEGORY ? null : (c.parent && chanId.get(c.parent)) || null;
      const forum = c.type === ChannelType.FORUM;
      run(`INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, nsfw, rate_limit, user_limit, bitrate, available_tags, forum_sort, require_tag, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, gid, c.type, c.name, c.topic || '', place(parent), parent, c.nsfw ? 1 : 0, c.rateLimit | 0, c.userLimit | 0, c.bitrate || 64000,
      forum ? JSON.stringify((c.tags || []).map((t) => ({ id: newId(), name: t.name, emoji: t.emoji || null }))) : null, forum ? (c.forumSort | 0) : 0, forum && c.requireTag ? 1 : 0, now);
      for (const o of c.overwrites || []) {
        const target = o.role === 'everyone' ? gid : roleId.get(o.role);
        if (target) run('INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, 0, ?, ?)', id, target, (o.allow | 0) & ALL_PERMISSIONS, (o.deny | 0) & ALL_PERMISSIONS);
      }
    });
    const sys = snap.systemChannel && chanId.get(snap.systemChannel);
    if (sys) run('UPDATE guilds SET system_channel_id = ? WHERE id = ?', sys, gid);
    run("INSERT INTO guild_member_log (guild_id, kind, at) VALUES (?, 'start', ?), (?, 'join', ?)", gid, now, gid, now);
  });
  return gid;
}

const codeOf = () => randomCode(12);
const templateOf = (guildId) => get('SELECT * FROM guild_templates WHERE guild_id = ?', guildId);

/** What a manager sees in Server Settings. */
function serializeTemplate(t, { withSync = false } = {}) {
  const snap = parseJSON(t.snapshot, null);
  const creator = t.creator_id ? getUserRow(t.creator_id) : null;
  const out = {
    code: t.code, name: t.name, description: t.description || '', uses: t.uses || 0,
    createdAt: t.created_at, syncedAt: t.synced_at,
    creator: creator ? publicUser(creator) : null,
    summary: snap ? summarize(snap) : null,
  };
  if (withSync) out.outOfSync = JSON.stringify(buildSnapshot(t.guild_id)) !== t.snapshot;
  return out;
}

export default function register(r) {
  const bodySchema = z.object({
    name: z.string().trim().min(2, 'Give the template a name (at least 2 letters).').max(NAME_MAX),
    description: z.string().trim().max(DESC_MAX, `The description can be at most ${DESC_MAX} characters.`).optional(),
  });

  // ================= managing the server's template (Server Settings → Server Template) =================
  r.get('/api/guilds/:id/template', async (ctx) => {
    const { perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const t = templateOf(ctx.params.id);
    return { template: t ? serializeTemplate(t, { withSync: true }) : null };
  });

  r.post('/api/guilds/:id/template', async (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    if (templateOf(guild.id)) throw bad('This server already has a template. Sync or edit it instead.', 'template_exists');
    enforceRateLimit(`template-make:${ctx.user.id}`, 10, 3600_000, 'You are making templates too quickly. Try again later.');
    const body = bodySchema.parse(ctx.body || {});
    const now = Date.now();
    const code = codeOf();
    run('INSERT INTO guild_templates (code, guild_id, name, description, creator_id, uses, snapshot, created_at, synced_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      code, guild.id, body.name, body.description || '', ctx.user.id, JSON.stringify(buildSnapshot(guild.id)), now, now);
    audit(guild.id, ctx.user.id, 'TEMPLATE_CREATE', { targetId: code, targetType: 'template', changes: { name: body.name } });
    return { template: serializeTemplate(templateOf(guild.id), { withSync: true }) };
  });

  const own = (ctx) => {
    const { guild, perms } = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD);
    const t = templateOf(guild.id);
    if (!t) throw notFound('This server has no template.');
    return { guild, t };
  };

  r.patch('/api/guilds/:id/template', async (ctx) => {
    const { guild, t } = own(ctx);
    const body = bodySchema.partial().parse(ctx.body || {});
    const changes = {};
    if (body.name !== undefined && body.name !== t.name) { run('UPDATE guild_templates SET name = ? WHERE code = ?', body.name, t.code); changes.name = body.name; }
    if (body.description !== undefined && body.description !== t.description) { run('UPDATE guild_templates SET description = ? WHERE code = ?', body.description, t.code); changes.description = body.description; }
    if (Object.keys(changes).length) audit(guild.id, ctx.user.id, 'TEMPLATE_UPDATE', { targetId: t.code, targetType: 'template', changes: { name: changes.name ?? t.name, ...changes } });
    return { template: serializeTemplate(templateOf(guild.id), { withSync: true }) };
  });

  // Take a fresh copy of the server (the template keeps its link, name and number of uses).
  r.put('/api/guilds/:id/template', async (ctx) => {
    const { guild, t } = own(ctx);
    run('UPDATE guild_templates SET snapshot = ?, synced_at = ? WHERE code = ?', JSON.stringify(buildSnapshot(guild.id)), Date.now(), t.code);
    audit(guild.id, ctx.user.id, 'TEMPLATE_SYNC', { targetId: t.code, targetType: 'template', changes: { name: t.name } });
    return { template: serializeTemplate(templateOf(guild.id), { withSync: true }) };
  });

  r.delete('/api/guilds/:id/template', async (ctx) => {
    const { guild, t } = own(ctx);
    run('DELETE FROM guild_templates WHERE code = ?', t.code);
    audit(guild.id, ctx.user.id, 'TEMPLATE_DELETE', { targetId: t.code, targetType: 'template', changes: { name: t.name } });
    return { ok: true };
  });

  // ================= using a template =================
  // Looking one up needs no login (the link is the key), so the page can show what is in it before someone signs in.
  const byCode = (ctx) => {
    enforceRateLimit(`template-ip:${ctx.ip || 'x'}`, 120, 60_000, 'Too many requests. Slow down a little.');
    const t = get('SELECT * FROM guild_templates WHERE code = ?', String(ctx.params.code || '').slice(0, 40));
    if (!t) { countFailedAddress(ctx.ip); throw notFound('This template link doesn’t work. It may have been removed.'); }
    return t;
  };

  r.get('/api/templates/:code', { auth: false }, async (ctx) => {
    const t = byCode(ctx);
    const g = get('SELECT name, icon FROM guilds WHERE id = ?', t.guild_id);
    return { ...serializeTemplate(t), guild: { name: g?.name || '', icon: g?.icon || null } };
  });

  r.post('/api/templates/:code/guilds', async (ctx) => {
    const t = byCode(ctx);
    enforceRateLimit(`guildcreate:${ctx.user.id}`, 10, 3600 * 1000, 'You are creating servers too quickly.');
    const body = z.object({ name: z.string().trim().min(2).max(100) }).parse(ctx.body || {});
    const snap = parseJSON(t.snapshot, null);
    if (!snap) throw bad('This template can’t be used any more.');
    const gid = createGuildFromSnapshot(ctx.user.id, body.name, snap);
    run('UPDATE guild_templates SET uses = uses + 1 WHERE code = ?', t.code);
    const payload = guildPayloadFor(gid, ctx.user.id);
    sendToUser(ctx.user.id, 'GUILD_SYNC', payload);
    return payload;
  });
}
