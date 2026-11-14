// Incoming webhooks.
//
//   · A server manager (Manage Server) creates a webhook for one channel in Server Settings → Integrations → Webhooks and gets an address:
//       POST /api/webhooks/<id>/<token>      { "content": "…", "username": "…", "avatar_url": "https://…", "embeds": [ … ] }
//     Anything that can send a web request (a monitoring tool, a CI job, a script, a form) can post there. The address is the proof, so there
//     is no login. Discord-style senders work unchanged: the same body, and the same address under /api/v10/webhooks/<id>/<token>.
//   · A webhook has its own hidden sender account (users.bot = 2, never a member of the server), so the messages it sent keep an author after
//     the webhook is deleted. Its messages go through the normal send path (routes/messages.js) with a webhook's powers: no channel send rule,
//     no slowmode or AutoMod (like a bot, a manager added it), no @everyone, only roles that are set to be mentionable.
//   · The token is kept as it is (not as a hash) so a manager can copy the address again later. Anyone who can read the database can read it,
//     which is the same trust as the rest of the server's data; "Reset address" makes the old one stop working at once.
import crypto from 'node:crypto';
import { z } from 'zod';
import { get, all, run, tx } from '../db.js';
import { bad, notFound, enforceRateLimit } from '../lib/http.js';
import { newId, randomToken, sha256 } from '../lib/security.js';
import { receiveImage, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import { embedsSchema } from '../lib/embeds.js';
import { getUserRow, guildAccess, requirePerm, getChannelRow, serializeMessages } from '../models.js';
import { audit } from '../services.js';
import { sendMessageAs, editMessageAs, deleteMessageAs, MAX_CONTENT } from './messages.js';
import { insertBotUser, managedGuilds } from './bots.js';
import { P, ChannelType, isTextLike } from '../../../shared/permissions.js';

export const MAX_WEBHOOKS_PER_SERVER = 25;
const nameSchema = z.string().trim().min(1, 'must not be empty').max(32, 'must be at most 32 characters');

const isHttpUrl = (v) => { try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };
const sameToken = (a, b) => crypto.timingSafeEqual(Buffer.from(sha256(String(a))), Buffer.from(sha256(String(b))));

/** The webhook a (id, token) pair belongs to, or null. A wrong token never says whether the id exists. */
export function findWebhook(id, token) {
  const hook = get('SELECT * FROM webhooks WHERE id = ?', String(id));
  return hook && sameToken(hook.token, token) ? hook : null;
}
/** Someone sent a webhook address that matched nothing: count it, so guessing addresses gets nowhere. */
export function countFailedAddress(ip) {
  enforceRateLimit(`whfail:${ip || 'x'}`, 30, 60_000, 'Too many wrong webhook addresses. Wait a minute.');
}

/** What a manager sees (and the public address check shows less of: see publicInfo). */
export function serializeWebhook(hook) {
  const u = getUserRow(hook.id);
  return {
    id: hook.id, guildId: hook.guild_id, channelId: hook.channel_id, name: u?.display_name || 'Webhook', avatar: u?.avatar || null,
    createdBy: hook.created_by, createdAt: hook.created_at, lastUsedAt: hook.last_used_at || null, uses: hook.uses || 0, token: hook.token,
  };
}
export function publicInfo(hook) {
  const u = getUserRow(hook.id);
  return { id: hook.id, guildId: hook.guild_id, channelId: hook.channel_id, name: u?.display_name || 'Webhook', avatar: u?.avatar || null };
}

// ---- sending through a webhook ----------------------------------------------------------------------------------------------------------------
const executeSchema = z.object({
  content: z.string().max(MAX_CONTENT, `Messages can be at most ${MAX_CONTENT} characters.`).nullish(),
  username: z.string().max(200).nullish(),
  avatar_url: z.string().max(2000).nullish(),
  embeds: embedsSchema.nullish(),
  components: z.array(z.any()).max(5).nullish(),   // link buttons only (checked when the message is sent)
  thread_id: z.string().max(40).nullish(),
});

/** Where a webhook's message may go: its channel, or a thread inside it. */
function targetChannel(hook, threadId) {
  const ch = getChannelRow(hook.channel_id);
  if (!ch || !isTextLike(ch.type)) throw notFound('Unknown channel.');
  if (!threadId) return ch.id;
  const t = getChannelRow(String(threadId));
  if (!t || t.type !== ChannelType.THREAD || t.parent_id !== ch.id) throw notFound('Unknown thread.');
  return t.id;
}

/** Post a message through a webhook. `input` is the request's JSON (Discord's field names), `query` its ?thread_id. Returns the message. */
export async function runWebhook(hook, input, query = {}) {
  const body = executeSchema.parse(input && typeof input === 'object' ? input : {});
  const channelId = targetChannel(hook, query.thread_id || body.thread_id);
  const sender = getUserRow(hook.id);
  if (!sender) throw notFound('Unknown webhook.');
  const as = {};
  const name = (body.username || '').replace(/\s+/g, ' ').trim();
  if (name) as.name = name.slice(0, 80);
  if (body.avatar_url && isHttpUrl(body.avatar_url)) as.avatar = body.avatar_url;   // (a bad picture address only means no picture: it isn't worth failing the message over)
  const msg = await sendMessageAs(sender, channelId, {
    content: body.content || '',
    ...(body.embeds?.length ? { embeds: body.embeds } : {}),
    ...(body.components?.length ? { components: body.components } : {}),
  }, { webhook: as });
  run('UPDATE webhooks SET last_used_at = ?, uses = uses + 1 WHERE id = ?', Date.now(), hook.id);
  return msg;
}

/** A message this webhook sent (not anyone else's), in its channel or a thread of it. */
function ownMessage(hook, messageId) {
  const row = get('SELECT * FROM messages WHERE id = ? AND author_id = ?', String(messageId), hook.id);
  const ch = row && getChannelRow(row.channel_id);
  if (!row || !ch || (ch.id !== hook.channel_id && ch.parent_id !== hook.channel_id)) throw notFound('Unknown message.');
  return row;
}
export const getWebhookMessage = (hook, messageId) => serializeMessages([ownMessage(hook, messageId)])[0];
export async function editWebhookMessage(hook, messageId, input) {
  const row = ownMessage(hook, messageId);
  const body = z.object({ content: z.string().max(MAX_CONTENT).nullish(), embeds: embedsSchema.nullish(), components: z.array(z.any()).max(5).nullish() }).parse(input && typeof input === 'object' ? input : {});
  return editMessageAs(getUserRow(hook.id), row.channel_id, row.id, {
    ...(body.content !== undefined && body.content !== null ? { content: body.content } : {}),
    ...(body.embeds ? { embeds: body.embeds } : {}),
    ...(body.components !== undefined ? { components: body.components || [] } : {}),
  }, { webhook: {} });
}
export async function deleteWebhookMessage(hook, messageId) {
  const row = ownMessage(hook, messageId);
  await deleteMessageAs(getUserRow(hook.id), row.channel_id, row.id, { webhook: {} });
}

/** Hourly clean-up: sender accounts of deleted webhooks that never sent anything (the ones that did stay, they are those messages' author). */
export function sweepWebhookUsers() {
  for (const u of all(`SELECT id, avatar FROM users WHERE bot = 2 AND id NOT IN (SELECT id FROM webhooks)
                         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_id = users.id)`)) {
    removeUpload('avatars', storedNameFromUrl(u.avatar));
    run('DELETE FROM users WHERE id = ?', u.id);
  }
}

export default function register(r) {
  // ================= managing webhooks (Server Settings → Integrations) =================
  const manageGuild = (ctx) => {
    const access = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(access.perms, P.MANAGE_GUILD, 'You need the Manage Server permission to do that.');
    return access;
  };
  const hookOf = (ctx) => {
    const hook = get('SELECT * FROM webhooks WHERE id = ? AND guild_id = ?', ctx.params.hookId, ctx.params.id);
    if (!hook) throw notFound('Unknown webhook.');
    return hook;
  };
  /** A webhook posts into a text or announcement channel of this server. */
  const channelOf = (guildId, channelId) => {
    const ch = getChannelRow(String(channelId));
    if (!ch || ch.guild_id !== guildId || !isTextLike(ch.type)) throw bad('Pick a text or announcement channel in this server.');
    return ch;
  };

  // Developer Portal: the webhooks of every server this person manages.
  r.get('/api/developer/webhooks', async (ctx) => {
    const out = [];
    for (const { guild } of managedGuilds(ctx.user.id)) {
      for (const h of all('SELECT * FROM webhooks WHERE guild_id = ? ORDER BY created_at', guild.id)) out.push({ ...serializeWebhook(h), guild: { id: guild.id, name: guild.name, icon: guild.icon || null } });
    }
    return out.sort((a, b) => a.guild.name.localeCompare(b.guild.name) || (a.createdAt - b.createdAt));
  });

  r.get('/api/guilds/:id/webhooks', async (ctx) => {
    manageGuild(ctx);
    return all('SELECT * FROM webhooks WHERE guild_id = ? ORDER BY created_at', ctx.params.id).map(serializeWebhook);
  });

  r.post('/api/guilds/:id/webhooks', async (ctx) => {
    const { guild } = manageGuild(ctx);
    enforceRateLimit(`hookcreate:${ctx.user.id}`, 60, 60 * 60 * 1000, 'You are adding webhooks too quickly. Try again later.');
    const body = z.object({ name: nameSchema, channelId: z.string().max(40) }).parse(ctx.body);
    if (get('SELECT COUNT(*) AS n FROM webhooks WHERE guild_id = ?', guild.id).n >= MAX_WEBHOOKS_PER_SERVER) throw bad(`A server can have at most ${MAX_WEBHOOKS_PER_SERVER} webhooks.`);
    const ch = channelOf(guild.id, body.channelId);
    const id = newId();
    const token = randomToken(48);
    tx(() => {
      insertBotUser(id, body.name, 2, 'hook');
      run('INSERT INTO webhooks (id, guild_id, channel_id, created_by, token, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, guild.id, ch.id, ctx.user.id, token, Date.now());
    });
    audit(guild.id, ctx.user.id, 'WEBHOOK_CREATE', { targetId: id, targetType: 'webhook', changes: { name: body.name, channelId: ch.id } });
    return serializeWebhook(get('SELECT * FROM webhooks WHERE id = ?', id));
  });

  r.patch('/api/guilds/:id/webhooks/:hookId', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const hook = hookOf(ctx);
    const body = z.object({ name: nameSchema.optional(), channelId: z.string().max(40).optional() }).parse(ctx.body);
    const changes = {};
    if (body.channelId !== undefined && body.channelId !== hook.channel_id) {
      const ch = channelOf(guild.id, body.channelId);
      run('UPDATE webhooks SET channel_id = ? WHERE id = ?', ch.id, hook.id);
      changes.channelId = ch.id;
    }
    if (body.name !== undefined && body.name !== getUserRow(hook.id)?.display_name) {
      run('UPDATE users SET display_name = ? WHERE id = ?', body.name, hook.id);
      changes.name = body.name;
    }
    if (Object.keys(changes).length) audit(guild.id, ctx.user.id, 'WEBHOOK_UPDATE', { targetId: hook.id, targetType: 'webhook', changes: { name: getUserRow(hook.id)?.display_name, ...changes } });
    return serializeWebhook(get('SELECT * FROM webhooks WHERE id = ?', hook.id));
  });

  r.put('/api/guilds/:id/webhooks/:hookId/avatar', { raw: true }, async (ctx) => {
    manageGuild(ctx);
    const hook = hookOf(ctx);
    enforceRateLimit(`avatar:${hook.id}`, 10, 10 * 60 * 1000);
    const img = await receiveImage(ctx.req, 'avatars', 10 * 1024 * 1024);
    const u = getUserRow(hook.id);
    removeUpload('avatars', storedNameFromUrl(u?.avatar));
    run('UPDATE users SET avatar = ? WHERE id = ?', `/uploads/avatars/${img.storedName}`, hook.id);
    return serializeWebhook(hook);
  });

  // A new address: the old one stops working at once.
  r.post('/api/guilds/:id/webhooks/:hookId/token', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const hook = hookOf(ctx);
    enforceRateLimit(`hooktoken:${ctx.user.id}`, 20, 60 * 60 * 1000);
    run('UPDATE webhooks SET token = ? WHERE id = ?', randomToken(48), hook.id);
    audit(guild.id, ctx.user.id, 'WEBHOOK_TOKEN_RESET', { targetId: hook.id, targetType: 'webhook', changes: { name: getUserRow(hook.id)?.display_name } });
    return serializeWebhook(get('SELECT * FROM webhooks WHERE id = ?', hook.id));
  });

  r.delete('/api/guilds/:id/webhooks/:hookId', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const hook = hookOf(ctx);
    const u = getUserRow(hook.id);
    run('DELETE FROM webhooks WHERE id = ?', hook.id);
    audit(guild.id, ctx.user.id, 'WEBHOOK_DELETE', { targetId: hook.id, targetType: 'webhook', changes: { name: u?.display_name, channelId: hook.channel_id } });
    sweepWebhookUsers();   // (the sender account goes too, unless messages still name it as their author)
    return { ok: true };
  });

  // ================= the address itself (no login: the id and token are the proof) =================
  const addressOf = (ctx) => {
    enforceRateLimit(`webhook-ip:${ctx.ip || 'x'}`, 240, 60_000, 'Too many requests. Slow down a little.');
    const hook = findWebhook(ctx.params.id, ctx.params.token);
    if (!hook) { countFailedAddress(ctx.ip); throw notFound('Unknown webhook.'); }
    return hook;
  };

  r.get('/api/webhooks/:id/:token', { auth: false }, async (ctx) => publicInfo(addressOf(ctx)));

  r.post('/api/webhooks/:id/:token', { auth: false }, async (ctx) => {
    const hook = addressOf(ctx);
    const msg = await runWebhook(hook, ctx.body, ctx.query);
    if (ctx.query.wait === 'true') return msg;
    ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });   // (like Discord: nothing to say back unless asked for the message)
    ctx.res.end();
    return undefined;
  });

  r.get('/api/webhooks/:id/:token/messages/:messageId', { auth: false }, async (ctx) => getWebhookMessage(addressOf(ctx), ctx.params.messageId));
  r.patch('/api/webhooks/:id/:token/messages/:messageId', { auth: false }, async (ctx) => editWebhookMessage(addressOf(ctx), ctx.params.messageId, ctx.body));
  r.delete('/api/webhooks/:id/:token/messages/:messageId', { auth: false }, async (ctx) => {
    await deleteWebhookMessage(addressOf(ctx), ctx.params.messageId);
    ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });
    ctx.res.end();
    return undefined;
  });
}
