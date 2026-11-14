// A Discord-compatible REST API for bots: /api/v10/... (also v6 to v9) with Discord's paths, JSON shapes and error codes.
//
// Nothing here does the work itself. Each call is translated into the call NullChat's own bot API already has, run with the bot's own
// permissions, and the answer is translated back; so a Discord-style bot can do exactly what a NullChat-style bot can, no more.
// The live half (events) is in discordGateway.js. What is covered and what is not: docs/DISCORD_BOTS.md.
import { ZodError } from 'zod';
import { get, all, run } from '../db.js';
import { config } from '../config.js';
import { HttpError, Router, bad, forbidden, notFound, enforceRateLimit, readJsonBody, sendJson, formatError } from '../lib/http.js';
import { botFromToken } from '../lib/auth.js';
import {
  getUserRow, publicUser, getGuildCore, getMember, getChannelRow, channelAccess, serializeMessages, getGuildEmojis,
} from '../models.js';
import { computeBasePermissions } from '../../../shared/permissions.js';
import { sendToChannel } from '../gateway.js';
import { announceBotCommands, botGuildIds, installOf, installCount } from '../lib/bots.js';
import {
  commandSchema, commandListSchema, commandRows, commandRateLimit, replaceBotCommands, saveBotCommand, deleteBotCommandById,
  findInteractionBy, findInteractionByToken, answerInteraction, editInteractionOriginal, interactionFollowup, deleteInteractionOriginal, interactionOriginal,
  callbackSchema, replySchema,
} from './bots.js';
import { findWebhook, publicInfo as webhookInfo, runWebhook, getWebhookMessage, editWebhookMessage, deleteWebhookMessage } from './webhooks.js';
import {
  DISCORD_GATEWAY_PATH, toUser, userById, toMember, toRole, toChannel, toEmoji, toGuild, toMessage, toMessages, toApplicationCommand, fromApplicationCommand,
  toDiscordPermissions, originOfRequest, UNKNOWN,
} from '../lib/discord.js';

const NO_CONTENT = Symbol('no content');
class Reply { constructor(status, body) { this.status = status; this.body = body; } }
const enc = encodeURIComponent;

// ---- errors in Discord's shape ---------------------------------------------------------------------------------------------------------------
function discordError(err, opts = {}) {
  if (err instanceof ZodError) {
    const { body } = formatError(err);
    return { status: 400, body: { message: body.message, code: 50035, errors: { _errors: [{ code: 'INVALID', message: body.message }] } } };
  }
  if (err instanceof HttpError) {
    const s = err.status;
    if (s === 401) return { status: 401, body: { message: '401: Unauthorized', code: 0 } };
    if (s === 403) return { status: 403, body: { message: err.message, code: 50013 } };
    if (s === 404) return { status: 404, body: { message: err.message, code: UNKNOWN[opts.unknown] ?? 0 } };
    if (s === 400) return { status: 400, body: { message: err.message, code: /empty/i.test(err.message) ? 50006 : 50035 } };
    if (s === 429) return { status: 429, body: { message: 'You are being rate limited.', retry_after: err.extra?.retryAfter ?? 1, global: false, detail: err.message } };
    return { status: s, body: { message: err.message, code: 0 } };
  }
  console.error('[discord api] unexpected error:', err);
  return { status: 500, body: { message: 'Internal error', code: 0 } };
}

/** Which bot is calling ("Authorization: Bot <token>"). */
function authBot(req) {
  const h = String(req.headers.authorization || '');
  if (!/^Bot\s+\S/i.test(h)) return null;
  const found = botFromToken(h);
  return found ? { user: found.user, bot: found.bot } : null;
}

export default function createDiscordApi({ router, botMayCall }) {
  const routes = new Router();
  const add = (method, pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    routes.add(method, pattern, { opts, handler });
  };

  /** Run one of NullChat's own bot calls as this bot (only calls a bot may make anyway). */
  async function native(ctx, method, path, { body = {}, query = {}, user } = {}) {
    const match = router.match(method, path);
    if (!match || match.badPath || match.methodNotAllowed) throw notFound('Unknown endpoint.');
    if (!botMayCall(method, match.route.pattern)) throw forbidden('Bots can’t use this endpoint.');
    const { handler } = match.route.handlers[0];
    return handler({ req: ctx.req, res: ctx.res, ip: ctx.ip, params: match.params, query, user: user || ctx.user, session: null, body });
  }
  const reasonOf = (ctx) => { const r = ctx.req.headers['x-audit-log-reason']; if (!r) return undefined; try { return decodeURIComponent(String(r)).slice(0, 512); } catch { return String(r).slice(0, 512); } };
  const botOf = (ctx) => get('SELECT * FROM bots WHERE id = ?', ctx.user.id);
  const msgOpts = (ctx, guildId) => ({ viewerId: ctx.user.id, origin: ctx.origin, guildId });
  const guildOfChannel = (id) => getChannelRow(id)?.guild_id || null;
  const withUsers = (members) => {
    if (!members.length) return [];
    const ids = [...new Set(members.map((m) => m.userId))];
    const users = new Map(all(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((u) => [u.id, toUser(publicUser(u))]));
    return members.map((m) => toMember(m, users.get(m.userId))).filter((m) => m.user);
  };
  const guildMembers = async (ctx, gid) => native(ctx, 'GET', `/api/guilds/${enc(gid)}/members`);

  // ================= gateway =================
  const wsUrl = (req) => originOfRequest(req, config.publicUrl).replace(/^http/, 'ws') + DISCORD_GATEWAY_PATH;
  add('GET', '/gateway', { auth: false }, async (ctx) => ({ url: wsUrl(ctx.req) }));
  add('GET', '/gateway/bot', async (ctx) => ({
    url: wsUrl(ctx.req), shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 },
  }));

  // ================= the bot itself, and the application it belongs to =================
  const selfUser = (ctx) => ({ ...toUser(publicUser(ctx.user)), verified: true, mfa_enabled: false, flags: 0, locale: 'en-US', email: null });
  add('GET', '/users/@me', async (ctx) => selfUser(ctx));
  add('PATCH', '/users/@me', async () => { throw bad('A bot can’t rename itself here. Change its name in Server Settings → Integrations → Bots.'); });
  add('GET', '/users/@me/guilds', async (ctx) => {
    return botGuildIds(ctx.user.id).map((gid) => {
      const core = getGuildCore(gid);
      const me = core && getMember(core.id, ctx.user.id);
      return core && me ? { id: core.id, name: core.name, icon: toGuild(core).icon, owner: false, permissions: toDiscordPermissions(computeBasePermissions(core, me)), features: [] } : null;
    }).filter(Boolean);
  });
  add('DELETE', '/users/@me/guilds/:guildId', async () => { throw bad('A bot leaves a server when it is removed in Server Settings → Integrations → Bots.'); });
  add('POST', '/users/@me/channels', async () => { throw bad('Bots can’t send or receive direct messages here.'); });
  add('GET', '/users/:userId', { unknown: 'user' }, async (ctx) => {
    const bot = botOf(ctx);
    const row = getUserRow(ctx.params.userId);
    // a bot can look up the people in its servers, like its member list shows them
    if (!bot || !row || !get('SELECT 1 FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id WHERE a.user_id = ? AND b.user_id = ?', bot.id, row.id)) throw notFound('Unknown user.');
    return toUser(publicUser(row));
  });
  const application = (ctx) => {
    const bot = botOf(ctx);
    const owner = bot && userById(bot.owner_id);
    return {
      id: ctx.user.id, name: ctx.user.display_name || ctx.user.username, icon: null, description: bot?.description || '', bot_public: bot?.visibility !== 'private', bot_require_code_grant: false,
      verify_key: '', flags: 0, ...(owner ? { owner } : {}), team: null, approximate_guild_count: bot ? installCount(bot.id) : 0,
    };
  };
  add('GET', '/applications/@me', async (ctx) => application(ctx));
  add('GET', '/oauth2/applications/@me', async (ctx) => application(ctx));

  // ================= slash commands =================
  // An app's commands work in every server it is in, so its "global" commands and its "server" commands are the same list.
  const appCheck = (ctx) => {
    const a = ctx.params.applicationId;
    if (a !== '@me' && a !== ctx.user.id) throw notFound('Unknown Application');
    const bot = botOf(ctx);
    if (!bot) throw notFound('Unknown Application');
    if (ctx.params.guildId && !installOf(bot.id, ctx.params.guildId)) throw forbidden('Missing Access');
    return bot;
  };
  const theCommand = (ctx, bot) => {
    const row = get('SELECT * FROM bot_commands WHERE id = ? AND bot_id = ?', ctx.params.commandId, bot.id);
    if (!row) throw notFound('Unknown application command');
    return row;
  };
  const toDef = (body) => commandSchema.parse(fromApplicationCommand(body));
  for (const base of ['/applications/:applicationId/commands', '/applications/:applicationId/guilds/:guildId/commands']) {
    const gid = (bot, ctx) => ctx.params.guildId || null;
    add('GET', base, { unknown: 'application' }, async (ctx) => { const bot = appCheck(ctx); return commandRows(bot.id).map((r) => toApplicationCommand(r, gid(bot, ctx))); });
    add('PUT', base, { unknown: 'application' }, async (ctx) => {
      const bot = appCheck(ctx);
      if (!Array.isArray(ctx.body)) throw bad('Send the whole list of commands as a JSON array.');
      const list = commandListSchema.parse(ctx.body.map(fromApplicationCommand));
      commandRateLimit(bot.id);
      return replaceBotCommands(bot, list).map((r) => toApplicationCommand(r, gid(bot, ctx)));
    });
    add('POST', base, { unknown: 'application' }, async (ctx) => {
      const bot = appCheck(ctx);
      const def = toDef(ctx.body);
      commandRateLimit(bot.id);
      const { row, created } = saveBotCommand(bot, def);
      return new Reply(created ? 201 : 200, toApplicationCommand(row, gid(bot, ctx)));
    });
    add('GET', `${base}/:commandId`, { unknown: 'command' }, async (ctx) => { const bot = appCheck(ctx); return toApplicationCommand(theCommand(ctx, bot), gid(bot, ctx)); });
    add('PATCH', `${base}/:commandId`, { unknown: 'command' }, async (ctx) => {
      const bot = appCheck(ctx);
      const row = theCommand(ctx, bot);
      const have = toApplicationCommand(row);
      const def = toDef({ name: have.name, description: have.description, options: have.options, ...ctx.body, type: 1 });
      commandRateLimit(bot.id);
      if (def.name !== row.name && get('SELECT 1 FROM bot_commands WHERE bot_id = ? AND name = ? AND id != ?', bot.id, def.name, row.id)) throw bad('Another command already has that name.');
      run('UPDATE bot_commands SET name = ?, description = ?, options = ? WHERE id = ?', def.name, def.description, JSON.stringify(def.options), row.id);
      announceBotCommands(bot.id);
      return toApplicationCommand(get('SELECT * FROM bot_commands WHERE id = ?', row.id), gid(bot, ctx));
    });
    add('DELETE', `${base}/:commandId`, { unknown: 'command' }, async (ctx) => {
      const bot = appCheck(ctx);
      theCommand(ctx, bot);
      deleteBotCommandById(bot, ctx.params.commandId);
      return NO_CONTENT;
    });
  }

  // ================= running a command: the bot answers =================
  // Discord's interaction callback carries the id and token of the interaction; the webhook addresses carry the application and the token.
  const messageOf = (ctx, it, r) => {
    const eph = r?.ephemeralMsg || (it.ephemeralMsg && r?.messageId === it.ephemeralMsg.id ? it.ephemeralMsg : null);
    if (eph) return toMessage(eph, msgOpts({ ...ctx, user: { id: it.botId } }, it.guildId));
    const id = r?.messageId;
    const row = id && get('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw notFound('Unknown Message');
    return toMessage(serializeMessages([row])[0], msgOpts({ ...ctx, user: { id: it.botId } }, it.guildId));
  };
  const contentOf = (b) => {
    const out = {};
    if (typeof b?.content === 'string') out.content = b.content;
    if (Array.isArray(b?.embeds)) out.embeds = b.embeds;
    if (Array.isArray(b?.components)) out.components = b.components;   // (buttons and menus: checked, in either spelling, when the message is made)
    return out;
  };
  const isEphemeral = (b) => (Number(b?.flags) & 64) !== 0;

  add('POST', '/interactions/:interactionId/:token/callback', { auth: false, unknown: 'interaction' }, async (ctx) => {
    const it = findInteractionBy(ctx.params.interactionId, ctx.params.token);
    const type = Number(ctx.body?.type);
    const data = ctx.body?.data || {};
    if (type === 1) return NO_CONTENT;                                       // PONG
    if (type === 8) throw bad('Autocomplete is not supported.');
    if (type === 10) throw bad('Premium-required answers are not supported.');
    if (![4, 5, 6, 7, 9].includes(type)) throw bad(`Unknown interaction callback type ${ctx.body?.type}.`);
    const ephemeral = isEphemeral(data);
    const pick = { 4: { type: 'message', ephemeral, ...contentOf(data) }, 5: { type: 'defer', ephemeral }, 6: { type: 'defer_update' }, 7: { type: 'update', ...contentOf(data) }, 9: { type: 'modal', modal: data } }[type];
    const r = await answerInteraction(it, callbackSchema.parse(pick));
    if (ctx.query.with_response !== 'true') return NO_CONTENT;
    const message = r.messageId ? messageOf(ctx, it, r) : null;
    return { interaction: { id: it.id, type: it.kind === 'component' ? 3 : it.kind === 'modal' ? 5 : 2, response_message_id: r.messageId || null, response_message_loading: type === 5, response_message_ephemeral: ephemeral }, resource: { type, ...(message ? { message } : {}) } };
  });

  const itOf = (ctx) => findInteractionByToken(ctx.params.applicationId, ctx.params.token);
  // The same addresses are also an incoming webhook's (a webhook's id and token, as on Discord): those are answered first; anything else is a bot's interaction.
  const hookOf = (ctx) => findWebhook(ctx.params.applicationId, ctx.params.token);
  const hookMessage = (ctx, hook, m) => toMessage(m, { viewerId: null, origin: ctx.origin, guildId: hook.guild_id });
  add('GET', '/webhooks/:applicationId/:token', { auth: false, unknown: 'webhook' }, async (ctx) => {
    const hook = hookOf(ctx);
    if (!hook) throw notFound('Unknown Webhook');
    const info = webhookInfo(hook);
    return { id: info.id, type: 1, guild_id: info.guildId, channel_id: info.channelId, name: info.name, avatar: null, application_id: null, url: `${ctx.origin}/api/v10/webhooks/${info.id}/${ctx.params.token}` };
  });
  add('POST', '/webhooks/:applicationId/:token', { auth: false, unknown: 'webhook' }, async (ctx) => {
    const hook = hookOf(ctx);
    if (hook) {
      const m = await runWebhook(hook, ctx.body, ctx.query);
      return ctx.query.wait === 'true' ? hookMessage(ctx, hook, m) : NO_CONTENT;
    }
    const it = itOf(ctx);
    const parsed = replySchema.parse({ ...contentOf(ctx.body), ephemeral: isEphemeral(ctx.body) });
    // After "thinking…" the first follow-up is the answer itself (it replaces the placeholder), as on Discord.
    if (it.state === 'deferred' && !it.finished) return messageOf(ctx, it, await editInteractionOriginal(it, contentOf(ctx.body)));
    return messageOf(ctx, it, await interactionFollowup(it, parsed));
  });
  const original = (ctx) => ctx.params.messageId === '@original';
  add('GET', '/webhooks/:applicationId/:token/messages/:messageId', { auth: false, unknown: 'message' }, async (ctx) => {
    const hook = hookOf(ctx);
    if (hook) return hookMessage(ctx, hook, getWebhookMessage(hook, ctx.params.messageId));
    const it = itOf(ctx);
    if (!original(ctx)) return messageOf(ctx, it, { messageId: ctx.params.messageId });
    const o = interactionOriginal(it);
    if (!o) throw notFound('Unknown Message');
    return messageOf(ctx, it, o);
  });
  add('PATCH', '/webhooks/:applicationId/:token/messages/:messageId', { auth: false, unknown: 'message' }, async (ctx) => {
    const hook = hookOf(ctx);
    if (hook) return hookMessage(ctx, hook, await editWebhookMessage(hook, ctx.params.messageId, ctx.body));
    const it = itOf(ctx);
    if (original(ctx)) return messageOf(ctx, it, await editInteractionOriginal(it, contentOf(ctx.body)));
    const botRow = getUserRow(it.botId);
    const msg = await native(ctx, 'PATCH', `/api/channels/${enc(it.channelId)}/messages/${enc(ctx.params.messageId)}`, { body: contentOf(ctx.body), user: botRow });
    return toMessage(msg, msgOpts({ ...ctx, user: { id: it.botId } }, it.guildId));
  });
  add('DELETE', '/webhooks/:applicationId/:token/messages/:messageId', { auth: false, unknown: 'message' }, async (ctx) => {
    const hook = hookOf(ctx);
    if (hook) { await deleteWebhookMessage(hook, ctx.params.messageId); return NO_CONTENT; }
    const it = itOf(ctx);
    if (original(ctx)) await deleteInteractionOriginal(it);
    else await native(ctx, 'DELETE', `/api/channels/${enc(it.channelId)}/messages/${enc(ctx.params.messageId)}`, { user: getUserRow(it.botId) });
    return NO_CONTENT;
  });

  // ================= channels and messages =================
  add('GET', '/channels/:channelId', { unknown: 'channel' }, async (ctx) => {
    const c = await native(ctx, 'GET', `/api/channels/${enc(ctx.params.channelId)}`);
    if (!c.guildId) throw notFound('Unknown Channel');
    return toChannel(c);
  });

  add('GET', '/channels/:channelId/messages', { unknown: 'channel' }, async (ctx) => {
    const query = {};
    for (const k of ['limit', 'before', 'after', 'around']) if (ctx.query[k] !== undefined) query[k] = ctx.query[k];
    const list = await native(ctx, 'GET', `/api/channels/${enc(ctx.params.channelId)}/messages`, { query });
    return toMessages(list, msgOpts(ctx, guildOfChannel(ctx.params.channelId)));
  });
  add('GET', '/channels/:channelId/messages/:messageId', { unknown: 'message' }, async (ctx) => {
    const m = await native(ctx, 'GET', `/api/channels/${enc(ctx.params.channelId)}/messages/${enc(ctx.params.messageId)}`);
    return toMessage(m, msgOpts(ctx, guildOfChannel(ctx.params.channelId)));
  });

  add('POST', '/channels/:channelId/messages', { unknown: 'channel' }, async (ctx) => {
    const b = ctx.body || {};
    const body = contentOf(b);
    if (b.message_reference?.message_id) body.replyTo = String(b.message_reference.message_id);
    if (b.nonce !== undefined && b.nonce !== null) body.nonce = String(b.nonce).slice(0, 64);
    const am = b.allowed_mentions;
    const noPings = (Number(b.flags) & 4096) !== 0 || (am && Array.isArray(am.parse) && !am.parse.length && !am.users?.length && !am.roles?.length);
    if (noPings) body.silent = true;
    if (am?.replied_user === false) body.mentionReplied = false;
    const m = await native(ctx, 'POST', `/api/channels/${enc(ctx.params.channelId)}/messages`, { body });
    return toMessage(m, msgOpts(ctx, m.guildId));
  });
  add('PATCH', '/channels/:channelId/messages/:messageId', { unknown: 'message' }, async (ctx) => {
    const body = contentOf(ctx.body);
    if ((Number(ctx.body?.flags) & 4) !== 0) body.suppressEmbeds = true;
    const m = await native(ctx, 'PATCH', `/api/channels/${enc(ctx.params.channelId)}/messages/${enc(ctx.params.messageId)}`, { body });
    return toMessage(m, msgOpts(ctx, m.guildId));
  });
  add('DELETE', '/channels/:channelId/messages/:messageId', { unknown: 'message' }, async (ctx) => {
    await native(ctx, 'DELETE', `/api/channels/${enc(ctx.params.channelId)}/messages/${enc(ctx.params.messageId)}`);
    return NO_CONTENT;
  });
  add('POST', '/channels/:channelId/messages/bulk-delete', { unknown: 'channel' }, async (ctx) => {
    const ids = Array.isArray(ctx.body?.messages) ? ctx.body.messages.map(String) : [];
    if (ids.length < 2 || ids.length > 100) throw bad('Send between 2 and 100 message ids to delete.');
    await native(ctx, 'POST', `/api/channels/${enc(ctx.params.channelId)}/messages/bulk-delete`, { body: { ids } });
    return NO_CONTENT;
  });

  // reactions
  const reactionPath = (ctx) => `/api/channels/${enc(ctx.params.channelId)}/messages/${enc(ctx.params.messageId)}/reactions`;
  add('PUT', '/channels/:channelId/messages/:messageId/reactions/:emoji/:who', { unknown: 'message' }, async (ctx) => {
    if (ctx.params.who !== '@me') throw bad('A bot can only add its own reactions.');
    await native(ctx, 'PUT', `${reactionPath(ctx)}/${enc(ctx.params.emoji)}`);
    return NO_CONTENT;
  });
  add('DELETE', '/channels/:channelId/messages/:messageId/reactions/:emoji/:who', { unknown: 'message' }, async (ctx) => {
    await native(ctx, 'DELETE', `${reactionPath(ctx)}/${enc(ctx.params.emoji)}/${enc(ctx.params.who)}`);
    return NO_CONTENT;
  });
  add('DELETE', '/channels/:channelId/messages/:messageId/reactions/:emoji', { unknown: 'message' }, async () => {
    throw bad('Removing one emoji for everybody is not supported. Remove each person’s reaction (…/reactions/{emoji}/{user id}) or all reactions at once.');
  });
  add('DELETE', '/channels/:channelId/messages/:messageId/reactions', { unknown: 'message' }, async (ctx) => {
    await native(ctx, 'DELETE', reactionPath(ctx));
    return NO_CONTENT;
  });
  add('GET', '/channels/:channelId/messages/:messageId/reactions/:emoji', { unknown: 'message' }, async (ctx) => {
    const m = await native(ctx, 'GET', `/api/channels/${enc(ctx.params.channelId)}/messages/${enc(ctx.params.messageId)}`);
    const hit = (m.reactions || []).find((r) => r.emoji === ctx.params.emoji);
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 25, 1), 100);
    return (hit?.users || []).filter((id) => !ctx.query.after || id > String(ctx.query.after)).slice(0, limit).map(userById).filter(Boolean);
  });

  // pins
  add('GET', '/channels/:channelId/pins', { unknown: 'channel' }, async (ctx) => {
    const list = await native(ctx, 'GET', `/api/channels/${enc(ctx.params.channelId)}/pins`);
    return toMessages(list, msgOpts(ctx, guildOfChannel(ctx.params.channelId)));
  });
  add('PUT', '/channels/:channelId/pins/:messageId', { unknown: 'message' }, async (ctx) => {
    await native(ctx, 'PUT', `/api/channels/${enc(ctx.params.channelId)}/pins/${enc(ctx.params.messageId)}`);
    return NO_CONTENT;
  });
  add('DELETE', '/channels/:channelId/pins/:messageId', { unknown: 'message' }, async (ctx) => {
    await native(ctx, 'DELETE', `/api/channels/${enc(ctx.params.channelId)}/pins/${enc(ctx.params.messageId)}`);
    return NO_CONTENT;
  });

  // "is typing…" (a bot does this over the gateway on NullChat; same rules)
  add('POST', '/channels/:channelId/typing', { unknown: 'channel' }, async (ctx) => {
    if (enforceRateLimitQuiet(`typing:${ctx.user.id}`)) return NO_CONTENT;
    const { channel, member } = channelAccess(ctx.params.channelId, ctx.user.id);
    if (!channel.guild_id) throw notFound('Unknown Channel');
    sendToChannel(channel, 'TYPING_START', { channelId: channel.id, userId: ctx.user.id, guildId: channel.guild_id, member, at: Date.now() }, ctx.user.id);
    return NO_CONTENT;
  });

  // ================= servers =================
  const guildPayload = (ctx) => native(ctx, 'GET', `/api/guilds/${enc(ctx.params.guildId)}`);
  add('GET', '/guilds/:guildId', { unknown: 'guild' }, async (ctx) => toGuild(await guildPayload(ctx), { counts: ctx.query.with_counts === 'true' }));
  add('GET', '/guilds/:guildId/channels', { unknown: 'guild' }, async (ctx) => (await guildPayload(ctx)).channels.map(toChannel));
  add('GET', '/guilds/:guildId/roles', { unknown: 'guild' }, async (ctx) => (await guildPayload(ctx)).roles.map(toRole));
  add('GET', '/guilds/:guildId/emojis', { unknown: 'guild' }, async (ctx) => { await guildPayload(ctx); return getGuildEmojis(ctx.params.guildId).map(toEmoji); });
  add('GET', '/guilds/:guildId/emojis/:emojiId', { unknown: 'emoji' }, async (ctx) => {
    await guildPayload(ctx);
    const e = getGuildEmojis(ctx.params.guildId).find((x) => x.id === ctx.params.emojiId);
    if (!e) throw notFound('Unknown Emoji');
    return toEmoji(e);
  });

  add('GET', '/guilds/:guildId/members/search', { unknown: 'guild' }, async (ctx) => {
    const q = String(ctx.query.query || '').toLowerCase();
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 1, 1), 1000);
    const all_ = withUsers(await guildMembers(ctx, ctx.params.guildId));
    return all_.filter((m) => m.user.username.toLowerCase().startsWith(q) || (m.nick || '').toLowerCase().startsWith(q) || (m.user.global_name || '').toLowerCase().startsWith(q)).slice(0, limit);
  });
  add('GET', '/guilds/:guildId/members/:userId', { unknown: 'member' }, async (ctx) => {
    const m = (await guildMembers(ctx, ctx.params.guildId)).find((x) => x.userId === ctx.params.userId);
    if (!m) throw notFound('Unknown Member');
    return withUsers([m])[0];
  });
  add('GET', '/guilds/:guildId/members', { unknown: 'guild' }, async (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 1, 1), 1000);
    const after = String(ctx.query.after || '0');
    const list = (await guildMembers(ctx, ctx.params.guildId)).filter((m) => m.userId > after).sort((a, b) => (a.userId < b.userId ? -1 : 1)).slice(0, limit);
    return withUsers(list);
  });
  add('PATCH', '/guilds/:guildId/members/:userId', { unknown: 'member' }, async (ctx) => {
    const b = ctx.body || {};
    const body = { reason: reasonOf(ctx) };
    if (b.nick !== undefined) body.nick = b.nick === null ? null : String(b.nick);
    if (Array.isArray(b.roles)) body.roles = b.roles.map(String);
    if (b.communication_disabled_until !== undefined) body.timeoutUntil = b.communication_disabled_until === null ? null : Date.parse(b.communication_disabled_until) || null;
    if (typeof b.mute === 'boolean') body.mute = b.mute;
    if (typeof b.deaf === 'boolean') body.deaf = b.deaf;
    if (b.channel_id === null) body.disconnect = true; else if (b.channel_id) body.channelId = String(b.channel_id);
    const m = await native(ctx, 'PATCH', `/api/guilds/${enc(ctx.params.guildId)}/members/${enc(ctx.params.userId)}`, { body });
    return withUsers([m])[0];
  });
  for (const method of ['PUT', 'DELETE']) {
    add(method, '/guilds/:guildId/members/:userId/roles/:roleId', { unknown: 'member' }, async (ctx) => {
      const gid = ctx.params.guildId, uid = ctx.params.userId, rid = ctx.params.roleId;
      const current = (await guildMembers(ctx, gid)).find((x) => x.userId === (uid === '@me' ? ctx.user.id : uid));
      if (!current) throw notFound('Unknown Member');
      const roles = new Set(current.roles);
      if (method === 'PUT') roles.add(rid); else roles.delete(rid);
      await native(ctx, 'PATCH', `/api/guilds/${enc(gid)}/members/${enc(uid)}`, { body: { roles: [...roles], reason: reasonOf(ctx) } });
      return NO_CONTENT;
    });
  }
  add('DELETE', '/guilds/:guildId/members/:userId', { unknown: 'member' }, async (ctx) => {
    await native(ctx, 'DELETE', `/api/guilds/${enc(ctx.params.guildId)}/members/${enc(ctx.params.userId)}`, { body: { reason: reasonOf(ctx) } });
    return NO_CONTENT;
  });

  const banList = async (ctx) => (await native(ctx, 'GET', `/api/guilds/${enc(ctx.params.guildId)}/bans`)).map((b) => ({ reason: b.reason || null, user: toUser(b.user) }));
  add('GET', '/guilds/:guildId/bans', { unknown: 'guild' }, async (ctx) => banList(ctx));
  add('GET', '/guilds/:guildId/bans/:userId', { unknown: 'ban' }, async (ctx) => {
    const b = (await banList(ctx)).find((x) => x.user.id === ctx.params.userId);
    if (!b) throw notFound('Unknown Ban');
    return b;
  });
  add('PUT', '/guilds/:guildId/bans/:userId', { unknown: 'user' }, async (ctx) => {
    const b = ctx.body || {};
    const secs = Number(b.delete_message_seconds) || (Number(b.delete_message_days) || 0) * 86400;
    await native(ctx, 'PUT', `/api/guilds/${enc(ctx.params.guildId)}/bans/${enc(ctx.params.userId)}`, { body: { reason: reasonOf(ctx), deleteMessageSeconds: Math.min(Math.max(Math.floor(secs), 0), 7 * 86400) } });
    return NO_CONTENT;
  });
  add('DELETE', '/guilds/:guildId/bans/:userId', { unknown: 'ban' }, async (ctx) => {
    await native(ctx, 'DELETE', `/api/guilds/${enc(ctx.params.guildId)}/bans/${enc(ctx.params.userId)}`);
    return NO_CONTENT;
  });

  // ---- the front door ----
  async function handle(req, res, url) {
    let opts = {};
    try {
      const sub = url.pathname.replace(/^\/api\/v\d{1,2}/, '') || '/';
      const match = routes.match(req.method, sub);
      if (!match || match.methodNotAllowed) return sendJson(res, match ? 405 : 404, { message: match ? '405: Method Not Allowed' : '404: Not Found', code: 0 });
      if (match.badPath) return sendJson(res, 400, { message: 'That web address is not valid.', code: 0 });
      const route = match.route.handlers[0];
      opts = route.opts;
      let authed = null;
      if (opts.auth !== false) {
        authed = authBot(req);
        if (!authed) throw new HttpError(401, 'Unauthorized', 'unauthorized');
        enforceRateLimit(`botreq:${authed.user.id}`, 600, 60_000, 'Your bot is sending requests too quickly.');
      } else {
        enforceRateLimit(`discordanon:${req.ip}`, 300, 60_000);
      }
      const ctx = {
        req, res, ip: req.ip, params: match.params, query: Object.fromEntries(url.searchParams), user: authed?.user || null, session: null, body: {},
        origin: originOfRequest(req, config.publicUrl),
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) { req.resume(); throw bad('Sending files is not supported through the Discord-compatible API yet. Send the message without files (embeds with a picture link work).'); }
        ctx.body = await readJsonBody(req);
      }
      const result = await route.handler(ctx);
      if (res.headersSent) return undefined;
      if (result === NO_CONTENT || result === undefined) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      if (result instanceof Reply) return sendJson(res, result.status, result.body);
      return sendJson(res, 200, result);
    } catch (err) {
      if (!req.complete) req.resume();
      const { status, body } = discordError(err, opts);
      if (!res.headersSent) {
        if (status === 429) res.setHeader('Retry-After', String(body.retry_after));
        sendJson(res, status, body);
      }
    }
    return undefined;
  }
  return { handle };
}

const quiet = new Map();
/** (typing: a call that comes too often is quietly ignored instead of being an error) */
function enforceRateLimitQuiet(key) {
  const now = Date.now();
  const hits = (quiet.get(key) || []).filter((t) => now - t < 10_000);
  hits.push(now);
  quiet.set(key, hits);
  return hits.length > 15;
}

// ---- pictures: Discord libraries build their links as <cdn>/avatars/<id>/<hash>.png, so these send people to the real uploaded file ----------------------
export function cdnRoutes(r) {
  const go = (ctx, url) => {
    if (!url) { ctx.res.writeHead(404, { 'Content-Type': 'application/json' }); ctx.res.end('{"message":"Not found."}'); return; }
    ctx.res.writeHead(302, { Location: url, 'Cache-Control': 'public, max-age=300' });
    ctx.res.end();
  };
  r.get('/api/cdn/avatars/:userId/:file', { auth: false }, async (ctx) => go(ctx, get('SELECT avatar FROM users WHERE id = ?', ctx.params.userId)?.avatar));
  r.get('/api/cdn/icons/:guildId/:file', { auth: false }, async (ctx) => go(ctx, get('SELECT icon FROM guilds WHERE id = ?', ctx.params.guildId)?.icon));
  r.get('/api/cdn/emojis/:file', { auth: false }, async (ctx) => {
    const e = get('SELECT stored_name FROM emojis WHERE id = ?', String(ctx.params.file).replace(/\..*$/, ''));
    go(ctx, e && `/uploads/emojis/${e.stored_name}`);
  });
}

