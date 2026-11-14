// Apps (bots) and slash commands.
//
//   · An app is made in Server Settings → Integrations (and added to that server) or in the Developer Portal (on its own). It gets a token.
//     Its program connects to /gateway with the token to receive events and calls the REST API with "Authorization: Bot <token>" to act.
//     Bots only get the small set of endpoints in BOT_ROUTES below.
//   · An app is added ("installed") to servers by people who manage them: each install is a member of that server with a role of its own.
//     Its owner chooses who may add it: only themselves (private), anyone with its link, or anyone who finds it in the App Directory.
//   · A bot registers slash commands (PUT /api/bot/commands). When someone runs one, the server sends the bot an
//     INTERACTION_CREATE event and the bot answers through /api/interactions/:id/:token/… (the token in the URL is the proof).
import crypto from 'node:crypto';
import { z } from 'zod';
import { get, all, run, tx, parseJSON } from '../db.js';
import { config } from '../config.js';
import { HttpError, bad, forbidden, notFound, enforceRateLimit } from '../lib/http.js';
import { newId, sha256, randomToken } from '../lib/security.js';
import { newBotToken } from '../lib/auth.js';
import { receiveImage, removeUpload, storedNameFromUrl } from '../lib/uploads.js';
import { embedsSchema, cleanEmbeds } from '../lib/embeds.js';
import { findComponent, checkSelection, cleanModal, readModalValues } from '../lib/components.js';
import { isPicker, resolvePick, componentTypeName } from '../lib/pickers.js';
import {
  publicUser, getUserRow, guildAccess, channelAccess, requirePerm, getGuildCore, getMember, serializeChannel, getChannelRow, serializeMessages,
} from '../models.js';
import { sendToGuild, sendToUser, isOnline, broadcastUserUpdate, syncGuild, disconnectUser, sendToNewestConnection } from '../gateway.js';
import { audit } from '../services.js';
import { sendMessageAs, editMessageAs, deleteMessageAs, MAX_CONTENT } from './messages.js';
import {
  serializeCommand, commandsForGuild, announceCommands, announceBotCommands, getBot, installsOf, installOf, installBot, uninstallBot, deleteBot, installCount, botsInGuild,
  canManageBot, appAccess, appsOwnedBy, BOT_PRESETS, presetPermissions, MAX_BOTS_PER_SERVER, MAX_APPS_PER_USER, VISIBILITIES,
} from '../lib/bots.js';
import { logDelivered, logOffline, logAnswered, logFailed, logTimeout, botActivity } from '../lib/botlog.js';
import { P, has, ChannelType, computeChannelPermissions } from '../../../shared/permissions.js';

// ---- what a bot token may call ----------------------------------------------------------------------------------------------
// Everything not listed is refused for bots: they can't touch accounts, friends, DMs, settings, other servers, invites, voice…
// What they can do inside a server is still limited by the permissions of their role, exactly like a person's.
const BOT_ROUTES = new Set([
  'GET /api/users/@me',
  'PATCH /api/users/@me/presence',
  'GET /api/guilds/:id',
  'GET /api/guilds/:id/members',
  'PATCH /api/guilds/:id/members/:userId',
  'DELETE /api/guilds/:id/members/:userId',
  'GET /api/guilds/:id/bans',
  'PUT /api/guilds/:id/bans/:userId',
  'DELETE /api/guilds/:id/bans/:userId',
  'GET /api/channels/:id',
  'GET /api/channels/:id/messages',
  'GET /api/channels/:id/messages/:messageId',
  'POST /api/channels/:id/messages',
  'PATCH /api/channels/:id/messages/:messageId',
  'DELETE /api/channels/:id/messages/:messageId',
  'POST /api/channels/:id/messages/bulk-delete',
  'PUT /api/channels/:id/messages/:messageId/reactions/:emoji',
  'DELETE /api/channels/:id/messages/:messageId/reactions/:emoji/:userId',
  'DELETE /api/channels/:id/messages/:messageId/reactions',
  'GET /api/channels/:id/pins',
  'PUT /api/channels/:id/pins/:messageId',
  'DELETE /api/channels/:id/pins/:messageId',
  'GET /api/channels/:id/threads',
  'POST /api/channels/:id/threads',
  'POST /api/attachments',
  'GET /api/bot/commands',
  'PUT /api/bot/commands',
  'DELETE /api/bot/commands/:name',
]);
export function botMayCall(method, pattern) {
  return BOT_ROUTES.has(`${method} ${pattern}`);
}

export { BOT_PRESETS };   // (the permission presets: lib/bots.js)

const MAX_COMMANDS = 50;

// ---- slash-command definitions ------------------------------------------------------------------------------------------------
const OPTION_TYPES = ['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role'];
const optionSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/, 'must be 1-32 lowercase letters, numbers, - or _'),
  description: z.string().trim().min(1).max(100),
  type: z.enum(OPTION_TYPES).default('string'),
  required: z.boolean().default(false),
  choices: z.array(z.object({ name: z.string().trim().min(1).max(100), value: z.union([z.string().max(100), z.number()]) })).max(25).optional(),
});
export const commandSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/, 'must be 1-32 lowercase letters, numbers, - or _'),
  description: z.string().trim().min(1).max(100),
  options: z.array(optionSchema).max(10).default([]),
}).superRefine((c, ctx) => {
  const names = c.options.map((o) => o.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'option names must be different', path: ['options'] });
  const firstOptional = c.options.findIndex((o) => !o.required);
  if (firstOptional >= 0 && c.options.slice(firstOptional).some((o) => o.required)) ctx.addIssue({ code: 'custom', message: 'required options must come before optional ones', path: ['options'] });
});

export const commandListSchema = z.array(commandSchema).max(MAX_COMMANDS);

// ---- saving a bot's commands (the same rules for the native API and for the Discord-compatible one) ----------------------------------
export const commandRows = (botId) => all('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name', botId);
export function commandRateLimit(botId) {
  enforceRateLimit(`botcmds:${botId}`, 20, 60 * 60 * 1000, 'You are updating commands too often. Try again in a while.');
}
/** Replace the bot's whole command list. Same name = same command, so people's recent commands keep working. */
export function replaceBotCommands(bot, list) {
  const names = list.map((c) => c.name);
  if (new Set(names).size !== names.length) throw bad('Two commands have the same name.');
  tx(() => {
    const keep = names.length ? `AND name NOT IN (${names.map(() => '?').join(',')})` : '';
    run(`DELETE FROM bot_commands WHERE bot_id = ? ${keep}`, bot.id, ...names);
    for (const c of list) {
      const options = JSON.stringify(c.options);
      const have = get('SELECT id FROM bot_commands WHERE bot_id = ? AND name = ?', bot.id, c.name);
      if (have) run('UPDATE bot_commands SET description = ?, options = ? WHERE id = ?', c.description, options, have.id);
      else run('INSERT INTO bot_commands (id, bot_id, name, description, options, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), bot.id, c.name, c.description, options, Date.now());
    }
  });
  announceBotCommands(bot.id);
  return commandRows(bot.id);
}
/** Add one command, or change the one with the same name. Returns the stored row (and whether it is new). */
export function saveBotCommand(bot, c) {
  const have = get('SELECT * FROM bot_commands WHERE bot_id = ? AND name = ?', bot.id, c.name);
  if (!have && get('SELECT COUNT(*) AS n FROM bot_commands WHERE bot_id = ?', bot.id).n >= MAX_COMMANDS) throw bad(`A bot can have at most ${MAX_COMMANDS} commands.`);
  const options = JSON.stringify(c.options);
  let id = have?.id;
  if (have) run('UPDATE bot_commands SET description = ?, options = ? WHERE id = ?', c.description, options, have.id);
  else { id = newId(); run('INSERT INTO bot_commands (id, bot_id, name, description, options, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, bot.id, c.name, c.description, options, Date.now()); }
  announceBotCommands(bot.id);
  return { row: get('SELECT * FROM bot_commands WHERE id = ?', id), created: !have };
}
export function deleteBotCommandById(bot, id) {
  const res = run('DELETE FROM bot_commands WHERE bot_id = ? AND id = ?', bot.id, id);
  if (res.changes) announceBotCommands(bot.id);
  return !!res.changes;
}

// ---- running a slash command ----------------------------------------------------------------------------------------------------
// An "interaction" lives in memory for 15 minutes: long enough for a bot to think, short enough that nothing needs storing.
const interactions = new Map();
const INTERACTION_TTL = 15 * 60_000;
const ACK_TIMEOUT = 5_000;
const MAX_FOLLOWUPS = 5;

const displayName = (u) => u.display_name || u.username;

/** A message only the person who ran the command can see. It isn't stored; it vanishes when they reload. */
function ephemeralMessage(it, botRow, { content = '', embeds = [] }) {
  const user = getUserRow(it.userId);
  return {
    id: newId(), channelId: it.channelId, guildId: it.guildId, author: publicUser(botRow), content, type: 0, createdAt: Date.now(), editedAt: null,
    pinned: false, mentions: [], mentionRoles: [], mentionEveryone: false, embeds: cleanEmbeds(embeds), attachments: [], poll: null, reactions: [],
    replyTo: null, thread: null, interaction: user ? { name: it.name, label: it.label || null, user: publicUser(user), pending: false } : null, components: [], ephemeral: true,
  };
}
function sendEphemeral(it, botRow, payload) {
  const msg = ephemeralMessage(it, botRow, payload);
  sendToUser(it.userId, 'MESSAGE_CREATE', msg);
  return msg;
}
function tellUser(it, text) {
  const botRow = getUserRow(it.botId);
  if (botRow) sendEphemeral(it, botRow, { content: text });
}

/** The pending command with this id, if the token is right (the id and token together are the proof; no login). */
export function findInteractionBy(id, token) {
  const it = interactions.get(String(id));
  if (!it || it.expiresAt < Date.now()) throw notFound('Unknown interaction.');
  const a = Buffer.from(sha256(String(token))), b = Buffer.from(sha256(it.token));
  if (!crypto.timingSafeEqual(a, b)) throw notFound('Unknown interaction.');
  enforceRateLimit(`interaction:${it.id}`, 40, 60_000);
  return it;
}
const findInteraction = (ctx) => findInteractionBy(ctx.params.id, ctx.params.token);
/** The same, found by its token alone (Discord's webhook addresses carry the token but not the interaction's id). */
export function findInteractionByToken(botId, token) {
  const t = String(token);
  for (const it of interactions.values()) {
    if (it.botId === botId && it.token === t && it.expiresAt >= Date.now()) { enforceRateLimit(`interaction:${it.id}`, 40, 60_000); return it; }
  }
  throw notFound('Unknown interaction.');
}

// ---- answering a slash command (shared by the native API above and the Discord-compatible one) ----------------------------------------
export const replySchema = z.object({
  content: z.string().max(MAX_CONTENT).default(''),
  embeds: embedsSchema.optional(),
  components: z.array(z.any()).max(5).optional(),   // buttons and menus (checked when the message is made: lib/components.js)
  ephemeral: z.boolean().optional(),
});
//   message       a new message             defer         "thinking…", then the answer through the original-message edit
//   update        change the message the button or menu is on (only for an answer to one)      defer_update   do nothing visible (only for the same)
//   modal         open a form for the person (`modal`: { custom_id, title, components })
export const callbackSchema = z.object({
  type: z.enum(['message', 'defer', 'update', 'defer_update', 'modal']).default('message'),
  content: z.string().max(MAX_CONTENT).optional(),
  embeds: embedsSchema.optional(),
  components: z.array(z.any()).max(5).nullable().optional(),
  ephemeral: z.boolean().optional(),
  modal: z.any().optional(),
});

/** The first answer to a command: a message, or "thinking…" (defer). */
export async function answerInteraction(it, body) {
  if (it.state !== 'pending') throw bad('This command was already answered.', 'already_answered');
  if ((body.type === 'update' || body.type === 'defer_update') && !it.componentMessageId) throw bad('Only an answer to a button or menu can update its message.', 'not_a_component');
  if (body.ephemeral && body.components?.length) throw bad('Buttons and menus can’t be put in a private answer yet.');
  it.state = 'working';
  logAnswered(it, body.type);
  const botRow = getUserRow(it.botId);
  if (!botRow) { it.state = 'failed'; logFailed(it, 'The bot no longer exists.'); throw notFound('Unknown bot.'); }
  // (what the small line above the answer says: “Mika used /roll”, or “Mika used a button” when it answers a button, a menu or a form)
  const info = (it.kind || 'command') === 'command' ? { name: it.name, userId: it.userId } : { name: null, label: it.label, userId: it.userId };
  try {
    if (body.type === 'modal') {
      it.modal = cleanModal(body.modal);
      it.state = 'modal';
      sendToUser(it.userId, 'MODAL_SHOW', { id: it.id, ...it.modal, bot: publicUser(botRow) });
      return { ok: true };
    }
    if (body.type === 'defer_update') {   // the click is taken as handled; the message stays as it is (the bot may still edit it with the original-message edit)
      it.messageId = it.componentMessageId;
      it.finished = true;
      it.state = 'done';
      return { ok: true, messageId: it.messageId };
    }
    if (body.type === 'update') {
      const change = {};
      if (body.content !== undefined) change.content = body.content;
      if (body.embeds !== undefined) change.embeds = body.embeds;
      if (body.components !== undefined) change.components = body.components;
      const msg = await editMessageAs(botRow, it.channelId, it.componentMessageId, change, { keepEditedAt: true });   // (the answer to a press is not an “edit”)
      it.messageId = msg.id;
      it.finished = true;
      it.state = 'done';
      return { ok: true, messageId: msg.id };
    }
    if (body.type === 'defer') {
      it.ephemeral = !!body.ephemeral;
      if (!it.ephemeral) {
        const msg = await sendMessageAs(botRow, it.channelId, { content: '' }, { interaction: { ...info, pending: true }, allowEmpty: true });
        it.messageId = msg.id;
      }
      it.state = 'deferred';
      return { ok: true };
    }
    if (body.ephemeral) {
      it.ephemeral = true;
      it.ephemeralMsg = sendEphemeral(it, botRow, body);
      it.state = 'done';
      return { ok: true, messageId: it.ephemeralMsg.id };
    }
    const msg = await sendMessageAs(botRow, it.channelId, { content: body.content ?? '', embeds: body.embeds, components: body.components || undefined }, { interaction: info });
    it.messageId = msg.id;
    it.finished = true;
    it.state = 'done';
    return { ok: true, messageId: msg.id };
  } catch (e) {
    it.state = 'failed';
    logFailed(it, e.message);
    tellUser(it, `**${displayName(botRow)}** couldn’t reply: ${e.message || 'something went wrong'}`);
    throw e;
  }
}

/** Change the first answer (after "defer" this is what replaces "thinking…"). */
export async function editInteractionOriginal(it, body) {
  if (it.state === 'pending' || it.state === 'working' || it.state === 'timeout' || it.state === 'failed') throw bad('Answer the command first (callback), then edit the answer.', 'not_answered');
  const botRow = getUserRow(it.botId);
  if (it.messageId) {
    // (a “thinking…” placeholder is finished by this; a message that already had its say, like the one a button is on, is just changed)
    const msg = await editMessageAs(botRow, it.channelId, it.messageId, body, it.messageId !== it.componentMessageId ? { finishInteraction: true } : { keepEditedAt: true });
    it.finished = true; it.state = 'done';
    return { ok: true, messageId: msg.id };
  }
  // An answer only the person who ran the command can see: update it where they are looking at it.
  if (it.ephemeralMsg) {
    if (body.content !== undefined) it.ephemeralMsg.content = body.content;
    if (body.embeds !== undefined) it.ephemeralMsg.embeds = cleanEmbeds(body.embeds);
    it.ephemeralMsg.editedAt = Date.now();
    sendToUser(it.userId, 'MESSAGE_UPDATE', it.ephemeralMsg);
    return { ok: true, messageId: it.ephemeralMsg.id };
  }
  // Deferred and private: this is the first thing the person gets to see.
  it.ephemeralMsg = sendEphemeral(it, botRow, { content: body.content || '', embeds: body.embeds || [] });
  it.finished = true; it.state = 'done';
  return { ok: true, messageId: it.ephemeralMsg.id };
}

/** Another message after the first answer (up to 5). `ephemeralMsg` is set when it is a private one. */
export async function interactionFollowup(it, body) {
  if (it.state !== 'done' && it.state !== 'deferred') throw bad('Answer the command first (callback), then send follow-ups.', 'not_answered');
  if (it.followups >= MAX_FOLLOWUPS) throw bad(`A command can have at most ${MAX_FOLLOWUPS} follow-up messages.`);
  it.followups += 1;
  const botRow = getUserRow(it.botId);
  if (body.ephemeral) { const m = sendEphemeral(it, botRow, body); return { messageId: m.id, ephemeralMsg: m }; }
  const msg = await sendMessageAs(botRow, it.channelId, { content: body.content, embeds: body.embeds, components: body.components }, {});
  return { messageId: msg.id };
}

/** Take back the first answer. */
export async function deleteInteractionOriginal(it) {
  if (it.messageId) {
    const botRow = getUserRow(it.botId);
    await deleteMessageAs(botRow, it.channelId, it.messageId);
    it.messageId = null;
  } else if (it.ephemeralMsg) {
    sendToUser(it.userId, 'MESSAGE_DELETE', { id: it.ephemeralMsg.id, channelId: it.channelId, guildId: it.guildId });
    it.ephemeralMsg = null;
  } else throw notFound('Unknown message.');
}

/** What the answer to this command looks like right now (a stored message, or the private one only its author sees). */
export function interactionOriginal(it) {
  if (it.messageId) return { messageId: it.messageId };
  if (it.ephemeralMsg) return { ephemeralMsg: it.ephemeralMsg };
  return null;
}

/** Check and convert what the person typed for each option of a command. */
function readOptions(def, given, guild, guildId) {
  const out = {};
  const src = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  for (const o of parseJSON(def.options, [])) {
    let v = src[o.name];
    if (v === undefined || v === null || v === '') {
      if (o.required) throw bad(`“${o.name}” is required.`);
      continue;
    }
    switch (o.type) {
      case 'integer': v = Number(v); if (!Number.isSafeInteger(v)) throw bad(`“${o.name}” must be a whole number.`); break;
      case 'number': v = Number(v); if (!Number.isFinite(v)) throw bad(`“${o.name}” must be a number.`); break;
      case 'boolean':
        if (v === 'true') v = true; else if (v === 'false') v = false;
        if (typeof v !== 'boolean') throw bad(`“${o.name}” must be true or false.`);
        break;
      case 'user':
        v = String(v);
        if (!get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, v)) throw bad(`“${o.name}” must be a member of this server.`);
        break;
      case 'channel':
        v = String(v);
        if (!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ?', v, guildId)) throw bad(`“${o.name}” must be a channel in this server.`);
        break;
      case 'role':
        v = String(v);
        if (!guild.roles.some((r) => r.id === v)) throw bad(`“${o.name}” must be a role in this server.`);
        break;
      default: v = String(v).slice(0, 2000);
    }
    if (o.choices?.length) {
      const hit = o.choices.find((c) => String(c.value) === String(v));
      if (!hit) throw bad(`“${o.name}” must be one of: ${o.choices.map((c) => c.name).join(', ')}.`);
      v = hit.value;
    }
    out[o.name] = v;
  }
  return out;
}

// ---- helpers for the settings screens ----------------------------------------------------------------------------------------------------
export function uniqueUsername(name, prefix) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9_.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 20) || prefix;
  for (let i = 0; i < 30; i++) {
    const candidate = `${base}_${prefix}${i === 0 ? '' : Math.floor(Math.random() * 9000 + 1000)}`;
    if (!get('SELECT 1 FROM users WHERE username = ?', candidate)) return candidate;
  }
  return `${prefix}_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

export function insertBotUser(id, name, kind, usernamePrefix) {
  const username = uniqueUsername(name, usernamePrefix);
  // No password and a private, unguessable address: these accounts can't log in or be reached by the password-reset flow.
  const email = `${usernamePrefix}-${randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, 'x')}@bots.invalid`;
  run(`INSERT INTO users (id, email, username, display_name, password_hash, email_verified, bot, status, settings, onboarded, created_at)
       VALUES (?, ?, ?, ?, '!', 1, ?, 'online', '{}', 1, ?)`, id, email, username, name, kind, Date.now());
}

const ownerOf = (b) => {
  const u = b.owner_id && getUserRow(b.owner_id);
  return u ? { id: u.id, username: u.username, displayName: u.display_name || u.username, avatar: u.avatar || null } : null;
};

/** An app as its managers see it. With `guildId`: how it is installed in that server (its role there, who added it). */
function serializeBot(b, { viewerId = null, guildId = null } = {}) {
  const u = getUserRow(b.id);
  const canManage = !!viewerId && canManageBot(viewerId, b);
  const inst = guildId ? installOf(b.id, guildId) : null;
  return {
    id: b.id, ownerId: b.owner_id, description: b.description, tokenHint: canManage ? b.token_hint : null,
    createdAt: b.created_at, lastSeenAt: b.last_seen_at, online: isOnline(b.id),
    commandCount: get('SELECT COUNT(*) AS n FROM bot_commands WHERE bot_id = ?', b.id).n,
    visibility: b.visibility, permPreset: b.perm_preset, hidden: !!b.hidden, installCount: installCount(b.id), canManage,
    ...(guildId ? { guildId, roleId: inst?.role_id || null, installedAt: inst?.installed_at || null, installedBy: inst?.installed_by || null } : {}),
    user: publicUser(u),
  };
}

/** An app as anyone sees it in the App Directory: what it is and who made it, nothing about its token. */
function serializeAppCard(b) {
  const u = getUserRow(b.id);
  return {
    id: b.id, name: u?.display_name || u?.username || 'App', description: b.description, owner: ownerOf(b), installCount: installCount(b.id),
    commandCount: get('SELECT COUNT(*) AS n FROM bot_commands WHERE bot_id = ?', b.id).n, online: isOnline(b.id), permPreset: b.perm_preset,
    visibility: b.visibility, createdAt: b.created_at, user: publicUser(u),
  };
}

const canGrant = (guild, actor, perms, wanted) => guild.ownerId === actor.userId || has(perms, P.ADMINISTRATOR) || (wanted & ~perms) === 0;
function assertCanGrant(guild, actor, perms, wanted) {
  if (!canGrant(guild, actor, perms, wanted)) throw forbidden('You can’t give a bot permissions you don’t have yourself.');
}

const nameSchema = z.string().trim().min(2, 'must be at least 2 characters').max(32, 'must be at most 32 characters');
const PRESET_NAMES = Object.keys(BOT_PRESETS);

/** The servers this person can manage (Manage Server), with their access. */
export function managedGuilds(userId) {
  const out = [];
  for (const row of all('SELECT guild_id FROM guild_members WHERE user_id = ?', userId)) {
    try {
      const a = guildAccess(row.guild_id, userId);
      if (has(a.perms, P.MANAGE_GUILD)) out.push(a);
    } catch { /* gone */ }
  }
  return out;
}

/** Make an app: its account and its row (token included). It is not in any server yet. */
function createApp(ownerId, { name, description, preset, visibility = 'private' }) {
  const botId = newId();
  const token = newBotToken();
  tx(() => {
    insertBotUser(botId, name, 1, 'bot');
    run('INSERT INTO bots (id, owner_id, description, token_hash, token_hint, created_at, visibility, perm_preset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      botId, ownerId, description, sha256(token), token.slice(-4), Date.now(), visibility, preset);
  });
  return { bot: getBot(botId), token };
}

const requireManage = (user, bot) => {
  if (!canManageBot(user.id, bot)) throw forbidden('Only the person who made this app can change it. You can remove it from your server instead.');
};

/** Put the audit entry in the server when the app is that server's own bot (one server, nobody else can add it); an app in many servers belongs to no single log. */
function auditApp(user, bot, action, extra = {}) {
  const installs = installsOf(bot.id);
  if (installs.length !== 1) return;
  try { if (has(guildAccess(installs[0].guild_id, user.id).perms, P.MANAGE_GUILD)) audit(installs[0].guild_id, user.id, action, { targetId: bot.id, targetType: 'user', ...extra }); } catch { /* not a member */ }
}

const botPatchSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().max(200).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  permPreset: z.enum(PRESET_NAMES).optional(),
  preset: z.enum(PRESET_NAMES).optional(),
});

/** Change an app. The name, description and picture are for whoever manages it; who may add it and with which permissions are for its owner. */
function updateApp(user, bot, raw) {
  const body = botPatchSchema.parse(raw);
  const preset = body.permPreset ?? body.preset;
  if ((body.visibility !== undefined || preset !== undefined) && bot.owner_id !== user.id) throw forbidden('Only the person who made this app can change who may add it.');
  const before = getUserRow(bot.id);
  const nextDescription = body.description !== undefined ? body.description : bot.description;
  const nextVisibility = body.visibility ?? bot.visibility;
  if (nextVisibility === 'listed' && nextDescription.trim().length < 10) throw bad('Write a description (at least 10 characters) before listing the app, so people know what it does.');
  const renamed = body.name !== undefined && body.name !== before.display_name;
  tx(() => {
    if (renamed) {
      run('UPDATE users SET display_name = ? WHERE id = ?', body.name, bot.id);
      run('UPDATE roles SET name = ? WHERE name = ? AND id IN (SELECT role_id FROM bot_installs WHERE bot_id = ?)', body.name, before.display_name, bot.id);   // (a role someone renamed on purpose is left alone)
    }
    if (body.description !== undefined) run('UPDATE bots SET description = ? WHERE id = ?', body.description, bot.id);
    if (body.visibility !== undefined) run('UPDATE bots SET visibility = ? WHERE id = ?', body.visibility, bot.id);
    if (preset !== undefined) run('UPDATE bots SET perm_preset = ? WHERE id = ?', preset, bot.id);
  });
  if (renamed) {
    broadcastUserUpdate(bot.id);
    for (const i of installsOf(bot.id).slice(0, 20)) syncGuild(i.guild_id);   // (the role's new name; a very widely used app's other servers pick it up the next time they load)
  }
  return getBot(bot.id);
}

async function updateAvatar(ctx, bot) {
  enforceRateLimit(`avatar:${bot.id}`, 10, 10 * 60 * 1000);
  const img = await receiveImage(ctx.req, 'avatars', 10 * 1024 * 1024);
  const u = getUserRow(bot.id);
  removeUpload('avatars', storedNameFromUrl(u.avatar));
  run('UPDATE users SET avatar = ? WHERE id = ?', `/uploads/avatars/${img.storedName}`, bot.id);
  broadcastUserUpdate(bot.id);
}

/** A new token: the old one stops working at once and the app is disconnected. */
function resetToken(user, bot) {
  enforceRateLimit(`bottoken:${user.id}`, 20, 60 * 60 * 1000);
  const token = newBotToken();
  run('UPDATE bots SET token_hash = ?, token_hint = ? WHERE id = ?', sha256(token), token.slice(-4), bot.id);
  disconnectUser(bot.id, 'Token regenerated');
  return token;
}

export default function register(r) {
  // ================= managing apps in a server (Server Settings → Integrations) =================
  const manageGuild = (ctx) => {
    const access = guildAccess(ctx.params.id, ctx.user.id);
    requirePerm(access.perms, P.MANAGE_GUILD, 'You need the Manage Server permission to do that.');
    return access;
  };
  /** An app that is in this server. */
  const botOf = (ctx) => {
    const bot = installOf(ctx.params.botId, ctx.params.id) && getBot(ctx.params.botId);
    if (!bot) throw notFound('Unknown bot.');
    return bot;
  };

  r.get('/api/guilds/:id/bots', async (ctx) => {
    manageGuild(ctx);
    return botsInGuild(ctx.params.id).map((b) => serializeBot(b, { viewerId: ctx.user.id, guildId: ctx.params.id }));
  });

  // Make a new app and put it in this server.
  r.post('/api/guilds/:id/bots', async (ctx) => {
    const { guild, member: actor, perms } = manageGuild(ctx);
    enforceRateLimit(`botcreate:${ctx.user.id}`, 10, 60 * 60 * 1000, 'You are adding bots too quickly. Try again later.');
    const body = z.object({
      name: nameSchema,
      description: z.string().trim().max(200).default(''),
      preset: z.enum(PRESET_NAMES).default('basic'),
    }).parse(ctx.body);
    if (appsOwnedBy(ctx.user.id) >= MAX_APPS_PER_USER) throw bad(`You already have ${MAX_APPS_PER_USER} apps. Delete one in the Developer Portal to make another.`);
    if (botsInGuild(guild.id).length >= MAX_BOTS_PER_SERVER) throw bad(`A server can have at most ${MAX_BOTS_PER_SERVER} bots.`);
    if (guild.roles.length >= 250) throw bad('This server has the maximum number of roles.');
    assertCanGrant(guild, actor, perms, BOT_PRESETS[body.preset]);
    const { bot, token } = createApp(ctx.user.id, { name: body.name, description: body.description, preset: body.preset });
    try { installBot(bot, guild, { installedBy: ctx.user.id }); } catch (e) { deleteBot(bot.id); throw e; }
    audit(guild.id, ctx.user.id, 'BOT_ADD', { targetId: bot.id, targetType: 'user', changes: { name: body.name, preset: body.preset } });
    return { bot: serializeBot(botsInGuild(guild.id).find((x) => x.id === bot.id), { viewerId: ctx.user.id, guildId: guild.id }), token };
  });

  r.patch('/api/guilds/:id/bots/:botId', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const bot = botOf(ctx);
    requireManage(ctx.user, bot);
    const updated = updateApp(ctx.user, bot, ctx.body);
    audit(guild.id, ctx.user.id, 'BOT_UPDATE', { targetId: bot.id, targetType: 'user', changes: ctx.body });
    syncGuild(guild.id);
    return serializeBot(updated, { viewerId: ctx.user.id, guildId: guild.id });
  });

  r.put('/api/guilds/:id/bots/:botId/avatar', { raw: true }, async (ctx) => {
    manageGuild(ctx);
    const bot = botOf(ctx);
    requireManage(ctx.user, bot);
    await updateAvatar(ctx, bot);
    return serializeBot(getBot(bot.id), { viewerId: ctx.user.id, guildId: ctx.params.id });
  });

  r.post('/api/guilds/:id/bots/:botId/token', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const bot = botOf(ctx);
    requireManage(ctx.user, bot);
    const token = resetToken(ctx.user, bot);
    audit(guild.id, ctx.user.id, 'BOT_TOKEN_RESET', { targetId: bot.id, targetType: 'user' });
    return { token, bot: serializeBot(getBot(bot.id), { viewerId: ctx.user.id, guildId: guild.id }) };
  });

  // Take it out of this server. The app itself (and its token) stays with whoever made it, in the Developer Portal; other servers keep it.
  r.delete('/api/guilds/:id/bots/:botId', async (ctx) => {
    const { guild } = manageGuild(ctx);
    const bot = botOf(ctx);
    const u = getUserRow(bot.id);
    uninstallBot(bot.id, guild.id);
    audit(guild.id, ctx.user.id, 'BOT_REMOVE', { targetId: bot.id, targetType: 'user', changes: { name: u?.display_name } });
    return { ok: true };
  });

  // ================= Developer Portal (User Settings → Developer Portal) =================
  // Everything a person builds for NullChat in one place: their apps (in any server, or none), what each one has registered and what it has been
  // asked to do lately, and who may add it.
  const portalBot = (ctx) => {
    const bot = getBot(ctx.params.botId);
    if (!bot || !canManageBot(ctx.user.id, bot)) throw notFound('Unknown bot.');
    return bot;
  };

  /** The servers an app is in that this person manages (and so may take it out of); the rest are only counted. */
  const installsFor = (bot, userId, managed) => installsOf(bot.id)
    .filter((i) => managed.has(i.guild_id))
    .map((i) => { const g = managed.get(i.guild_id).guild; return { guildId: i.guild_id, guild: { id: g.id, name: g.name, icon: g.icon || null }, roleId: i.role_id, installedAt: i.installed_at }; });

  r.get('/api/developer/bots', async (ctx) => {
    const managed = new Map(managedGuilds(ctx.user.id).map((a) => [a.guild.id, a]));
    const seen = new Map();
    for (const b of all('SELECT * FROM bots WHERE owner_id = ?', ctx.user.id)) seen.set(b.id, b);
    for (const gid of managed.keys()) for (const b of botsInGuild(gid)) if (!seen.has(b.id) && canManageBot(ctx.user.id, b)) seen.set(b.id, b);
    const out = [...seen.values()].map((b) => {
      const installs = installsFor(b, ctx.user.id, managed);
      return { ...serializeBot(b, { viewerId: ctx.user.id }), mine: b.owner_id === ctx.user.id, installs, guild: installs[0]?.guild || null, guildId: installs[0]?.guildId || null, roleId: installs[0]?.roleId || null };
    });
    // the ones you made first, then the newest
    out.sort((a, b) => (Number(b.mine) - Number(a.mine)) || (b.createdAt - a.createdAt));
    return out;
  });

  // Make an app that is in no server yet.
  r.post('/api/developer/bots', async (ctx) => {
    enforceRateLimit(`botcreate:${ctx.user.id}`, 10, 60 * 60 * 1000, 'You are adding bots too quickly. Try again later.');
    const body = z.object({
      name: nameSchema,
      description: z.string().trim().max(200).default(''),
      preset: z.enum(PRESET_NAMES).default('basic'),
    }).parse(ctx.body);
    if (appsOwnedBy(ctx.user.id) >= MAX_APPS_PER_USER) throw bad(`You already have ${MAX_APPS_PER_USER} apps. Delete one to make another.`);
    const { bot, token } = createApp(ctx.user.id, body);
    return { bot: { ...serializeBot(bot, { viewerId: ctx.user.id }), mine: true, installs: [], guild: null, guildId: null, roleId: null }, token };
  });

  r.patch('/api/developer/bots/:botId', async (ctx) => {
    const bot = portalBot(ctx);
    const updated = updateApp(ctx.user, bot, ctx.body);
    auditApp(ctx.user, bot, 'BOT_UPDATE', { changes: ctx.body });
    return serializeBot(updated, { viewerId: ctx.user.id });
  });

  r.put('/api/developer/bots/:botId/avatar', { raw: true }, async (ctx) => {
    const bot = portalBot(ctx);
    await updateAvatar(ctx, bot);
    return serializeBot(getBot(bot.id), { viewerId: ctx.user.id });
  });

  r.post('/api/developer/bots/:botId/token', async (ctx) => {
    const bot = portalBot(ctx);
    const token = resetToken(ctx.user, bot);
    auditApp(ctx.user, bot, 'BOT_TOKEN_RESET');
    return { token, bot: serializeBot(getBot(bot.id), { viewerId: ctx.user.id }) };
  });

  // Delete the app: it leaves every server it is in and its token stops working.
  r.delete('/api/developer/bots/:botId', async (ctx) => {
    const bot = portalBot(ctx);
    const u = getUserRow(bot.id);
    auditApp(ctx.user, bot, 'BOT_REMOVE', { changes: { name: u?.display_name } });
    deleteBot(bot.id);
    return { ok: true };
  });

  r.get('/api/developer/bots/:botId/commands', async (ctx) => {
    const bot = portalBot(ctx);
    return all('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name', bot.id).map(serializeCommand);
  });

  r.delete('/api/developer/bots/:botId/commands/:name', async (ctx) => {
    const bot = portalBot(ctx);
    const name = String(ctx.params.name);
    if (!get('SELECT 1 FROM bot_commands WHERE bot_id = ? AND name = ?', bot.id, name)) throw notFound('Unknown command.');
    run('DELETE FROM bot_commands WHERE bot_id = ? AND name = ?', bot.id, name);
    announceBotCommands(bot.id);
    auditApp(ctx.user, bot, 'BOT_COMMAND_DELETE', { changes: { command: name } });
    return { ok: true };
  });

  r.get('/api/developer/bots/:botId/activity', async (ctx) => {
    const bot = portalBot(ctx);
    return { online: isOnline(bot.id), lastSeenAt: get('SELECT last_seen_at FROM bots WHERE id = ?', bot.id)?.last_seen_at || null, entries: botActivity(bot.id) };
  });

  // ================= the App Directory =================
  // Apps whose owners chose to list them, and the way anyone who manages a server adds one: to each server they manage, with the permissions
  // the app asks for (shown first; they can't give it more than they have themselves).
  const DIRECTORY_PAGE = 24;
  r.get('/api/apps', async (ctx) => {
    const q = String(ctx.query?.q || '').trim().slice(0, 60).toLowerCase();
    const sort = ['popular', 'new', 'name'].includes(ctx.query?.sort) ? ctx.query.sort : 'popular';
    const offset = Math.max(0, Math.min(5000, Number.parseInt(ctx.query?.offset, 10) || 0));
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = all(`SELECT b.*, (SELECT COUNT(*) FROM bot_installs i WHERE i.bot_id = b.id) AS installs, lower(u.display_name) AS lname
                        FROM bots b JOIN users u ON u.id = b.id
                       WHERE b.visibility = 'listed' AND b.hidden = 0 ${q ? "AND (lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(b.description) LIKE ? ESCAPE '\\')" : ''}
                       ORDER BY ${sort === 'new' ? 'b.created_at DESC' : sort === 'name' ? 'lname ASC' : 'installs DESC, b.created_at DESC'}, b.id
                       LIMIT ? OFFSET ?`, ...(q ? [like, like] : []), DIRECTORY_PAGE + 1, offset);
    return { apps: rows.slice(0, DIRECTORY_PAGE).map(serializeAppCard), hasMore: rows.length > DIRECTORY_PAGE, offset, sort, q };
  });

  /** An app this person is allowed to see (listed, or reached by its link, or theirs). */
  const visibleApp = (ctx) => {
    const bot = getBot(ctx.params.botId);
    const access = appAccess(ctx.user.id, bot);
    if (!access) throw notFound('That app doesn’t exist, or it isn’t available.');
    return { bot, access };
  };

  r.get('/api/apps/:botId', async (ctx) => {
    const { bot, access } = visibleApp(ctx);
    const wanted = presetPermissions(bot.perm_preset);
    const servers = managedGuilds(ctx.user.id).map(({ guild, member, perms }) => {
      let blocked = null;
      if (installOf(bot.id, guild.id)) blocked = 'installed';
      else if (botsInGuild(guild.id).length >= MAX_BOTS_PER_SERVER) blocked = 'full';
      else if (guild.roles.length >= 250) blocked = 'roles';
      else if (!canGrant(guild, member, perms, wanted)) blocked = 'permissions';
      return { id: guild.id, name: guild.name, icon: guild.icon || null, blocked };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...serializeAppCard(bot),
      access, permissions: wanted, servers,
      commands: all('SELECT name, description FROM bot_commands WHERE bot_id = ? ORDER BY name', bot.id),
      ...(access === 'manage' ? { hidden: !!bot.hidden } : {}),
    };
  });

  // Add an app to a server you manage.
  r.post('/api/apps/:botId/install', async (ctx) => {
    enforceRateLimit(`appinstall:${ctx.user.id}`, 20, 60 * 60 * 1000, 'You are adding apps too quickly. Try again later.');
    const { guildId } = z.object({ guildId: z.string().min(1).max(40) }).parse(ctx.body);
    const { bot } = visibleApp(ctx);
    const { guild, member, perms } = guildAccess(guildId, ctx.user.id);
    requirePerm(perms, P.MANAGE_GUILD, 'You need the Manage Server permission to add an app to that server.');
    assertCanGrant(guild, member, perms, presetPermissions(bot.perm_preset));
    const { roleId } = installBot(bot, guild, { installedBy: ctx.user.id });
    audit(guild.id, ctx.user.id, 'BOT_ADD', { targetId: bot.id, targetType: 'user', changes: { name: getUserRow(bot.id)?.display_name, preset: bot.perm_preset, via: 'app directory' } });
    return { ok: true, guildId: guild.id, roleId, bot: serializeBot(botsInGuild(guild.id).find((x) => x.id === bot.id), { viewerId: ctx.user.id, guildId: guild.id }) };
  });

  // ================= slash commands =================
  // What the message box offers: every member can see the commands of the bots in the server.
  r.get('/api/guilds/:id/commands', async (ctx) => {
    guildAccess(ctx.params.id, ctx.user.id);
    return commandsForGuild(ctx.params.id);
  });

  // The bot's own commands (requires a bot token).
  r.get('/api/bot/commands', async (ctx) => {
    return all('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY name', ctx.user.id).map(serializeCommand);
  });
  const botOnly = (ctx) => {
    const bot = ctx.user && get('SELECT * FROM bots WHERE id = ?', ctx.user.id);
    if (!bot) throw forbidden('Only a bot can do that.');
    return bot;
  };
  // Replace the bot's whole command list in one go (what a bot does on start-up).
  r.put('/api/bot/commands', async (ctx) => {
    const bot = botOnly(ctx);
    commandRateLimit(bot.id);
    const list = commandListSchema.parse(Array.isArray(ctx.body) ? ctx.body : ctx.body?.commands);
    return replaceBotCommands(bot, list).map(serializeCommand);
  });
  r.delete('/api/bot/commands/:name', async (ctx) => {
    const bot = botOnly(ctx);
    run('DELETE FROM bot_commands WHERE bot_id = ? AND name = ?', bot.id, ctx.params.name);
    announceBotCommands(bot.id);
    return { ok: true };
  });

  // ---- someone runs a slash command ----
  r.post('/api/channels/:id/interactions', async (ctx) => {
    enforceRateLimit(`interact:${ctx.user.id}`, 10, 10_000, 'You are using commands too quickly.');
    const body = z.object({ commandId: z.string().max(40), options: z.record(z.string(), z.any()).optional() }).parse(ctx.body);
    const { channel, guild, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM) throw bad('Slash commands only work in servers.');
    if (channel.type === ChannelType.CATEGORY || channel.type === ChannelType.VOICE || channel.type === ChannelType.STAGE) throw bad('You can’t use commands here.');
    requirePerm(perms, channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES, 'You do not have permission to use commands in this channel.');
    const cmd = get('SELECT * FROM bot_commands WHERE id = ?', body.commandId);
    if (!cmd || !installOf(cmd.bot_id, channel.guild_id)) throw notFound('Unknown command.');
    const botRow = getUserRow(cmd.bot_id);
    const botName = displayName(botRow);

    // The bot has to be able to answer here.
    const permChannel = channel.type === ChannelType.THREAD ? (getChannelRow(channel.parent_id) || channel) : channel;
    const botPerms = computeChannelPermissions(guild, getMember(guild.id, cmd.bot_id), serializeChannel(permChannel));
    if (!has(botPerms, P.VIEW_CHANNEL) || !has(botPerms, P.SEND_MESSAGES)) throw bad(`${botName} can’t send messages in this channel. Give its role access to the channel first.`, 'bot_no_access');
    const asker = { userId: ctx.user.id, userName: displayName(ctx.user), channelId: channel.id, guildId: guild.id };
    if (!isOnline(cmd.bot_id)) { logOffline(cmd.bot_id, 'command', `/${cmd.name}`, asker); throw new HttpError(409, `${botName} is offline right now.`, 'bot_offline'); }

    const options = readOptions(cmd, body.options, guild, guild.id);
    const it = {
      id: newId(), token: randomToken(24), botId: cmd.bot_id, userId: ctx.user.id, guildId: guild.id, channelId: channel.id,
      name: cmd.name, state: 'pending', followups: 0, messageId: null, ephemeral: false, ephemeralMsg: null, finished: false,
      expiresAt: Date.now() + INTERACTION_TTL,
    };
    interactions.set(it.id, it);
    const delivered = sendToNewestConnection(cmd.bot_id, 'INTERACTION_CREATE', {
      id: it.id, token: it.token, type: 'command', commandId: cmd.id, commandName: cmd.name, options,
      channelId: channel.id, guildId: guild.id, user: publicUser(ctx.user), member: getMember(guild.id, ctx.user.id), createdAt: Date.now(),
    });
    if (!delivered) { interactions.delete(it.id); logOffline(cmd.bot_id, 'command', `/${cmd.name}`, asker); throw new HttpError(409, `${botName} is offline right now.`, 'bot_offline'); }
    logDelivered(it, 'command', `/${cmd.name}`, asker.userName);
    const timer = setTimeout(() => {
      if (it.state === 'pending') { it.state = 'timeout'; logTimeout(it); tellUser(it, `**${botName}** didn’t respond in time. It may be offline or having trouble.`); }
    }, ACK_TIMEOUT);
    timer.unref?.();
    return { id: it.id };
  });

  // ---- someone presses a button or picks from a menu on a bot's message ----
  /** Send an interaction to its bot and start the clock for its first answer. */
  function deliverInteraction(it, extra) {
    const botRow = getUserRow(it.botId);
    const botName = botRow ? displayName(botRow) : 'The bot';
    const user = getUserRow(it.userId);
    interactions.set(it.id, it);
    const delivered = sendToNewestConnection(it.botId, 'INTERACTION_CREATE', {
      id: it.id, token: it.token, channelId: it.channelId, guildId: it.guildId, user: publicUser(user), member: getMember(it.guildId, it.userId), createdAt: Date.now(), ...extra,
    });
    const kind = extra.type === 'modal' ? 'form' : /select$/.test(extra.componentType || '') ? 'menu' : 'button';
    const who = { userId: it.userId, userName: user ? displayName(user) : '', channelId: it.channelId, guildId: it.guildId };
    if (!delivered) { interactions.delete(it.id); logOffline(it.botId, kind, extra.customId || '', who); throw new HttpError(409, `${botName} is offline right now.`, 'bot_offline'); }
    logDelivered(it, kind, extra.customId || '', who.userName);
    const timer = setTimeout(() => {
      if (it.state === 'pending') { it.state = 'timeout'; logTimeout(it); tellUser(it, `**${botName}** didn’t respond in time. It may be offline or having trouble.`); }
    }, ACK_TIMEOUT);
    timer.unref?.();
  }
  const newInteraction = (over) => ({
    id: newId(), token: randomToken(24), state: 'pending', followups: 0, messageId: null, ephemeral: false, ephemeralMsg: null, finished: false, name: null,
    componentMessageId: null, expiresAt: Date.now() + INTERACTION_TTL, ...over,
  });

  r.post('/api/channels/:id/messages/:messageId/components', async (ctx) => {
    enforceRateLimit(`click:${ctx.user.id}`, 20, 10_000, 'You are pressing buttons too quickly.');
    const body = z.object({ customId: z.string().min(1).max(100), values: z.array(z.string().max(100)).max(25).optional() }).parse(ctx.body);
    const { channel, guild, perms, isDM } = channelAccess(ctx.params.id, ctx.user.id);
    if (isDM) throw bad('Buttons and menus only work in servers.');
    if (!has(perms, P.READ_MESSAGE_HISTORY)) throw forbidden('You can’t use this here.');
    const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.messageId, channel.id);
    if (!row) throw notFound('Unknown message.');
    const bot = row.author_id && installOf(row.author_id, channel.guild_id) && getBot(row.author_id);
    if (!bot) throw bad('The bot that sent this was removed, so its buttons and menus don’t work any more.', 'bot_gone');
    const comp = findComponent(parseJSON(row.components, []), body.customId);
    if (!comp || comp.url) throw notFound('That button or menu is no longer there.');
    if (comp.disabled) throw bad('That is turned off.', 'disabled');
    let values = null, resolved = null;
    if (comp.type === 3) values = checkSelection(comp, body.values);
    else if (isPicker(comp)) ({ values, resolved } = resolvePick(comp, body.values, { guild, userId: ctx.user.id }));
    else if (body.values?.length) throw bad('A button doesn’t take a choice.');
    const botName = displayName(getUserRow(bot.id));
    const isMenu = comp.type !== 2;
    if (!isOnline(bot.id)) {
      logOffline(bot.id, isMenu ? 'menu' : 'button', comp.customId, { userId: ctx.user.id, userName: displayName(ctx.user), channelId: channel.id, guildId: channel.guild_id });
      throw new HttpError(409, `${botName} is offline right now.`, 'bot_offline');
    }
    const it = newInteraction({
      botId: bot.id, userId: ctx.user.id, guildId: channel.guild_id, channelId: channel.id, kind: 'component', label: isMenu ? 'a menu' : 'a button',
      componentMessageId: row.id, customId: comp.customId,
    });
    const message = { ...serializeMessages([row])[0], guildId: channel.guild_id };
    deliverInteraction(it, { type: 'component', componentType: componentTypeName(comp), customId: comp.customId, ...(values ? { values } : {}), ...(resolved ? { resolved } : {}), message });
    return { id: it.id };
  });

  // The person fills in and sends a form the bot opened (their own login is the proof: it has to be the person it was opened for).
  r.post('/api/interactions/:id/modal', async (ctx) => {
    enforceRateLimit(`modal:${ctx.user.id}`, 10, 10_000, 'You are sending forms too quickly.');
    const it = interactions.get(String(ctx.params.id));
    if (!it || it.userId !== ctx.user.id || it.state !== 'modal' || !it.modal || it.expiresAt < Date.now()) throw notFound('This form has expired. Start again from the message.');
    const { values } = z.object({ values: z.record(z.string(), z.string().max(4000)) }).parse(ctx.body);
    const typed = readModalValues(it.modal, values);
    const next = newInteraction({
      botId: it.botId, userId: it.userId, guildId: it.guildId, channelId: it.channelId, kind: 'modal', label: 'a form', name: it.name,
      componentMessageId: it.componentMessageId, customId: it.modal.customId,
    });
    const row = it.componentMessageId && get('SELECT * FROM messages WHERE id = ?', it.componentMessageId);
    deliverInteraction(next, { type: 'modal', customId: it.modal.customId, values: typed, message: row ? { ...serializeMessages([row])[0], guildId: it.guildId } : null });
    it.state = 'done'; it.finished = true;
    sendToUser(it.userId, 'MODAL_CLOSE', { id: it.id });
    return { ok: true, id: next.id };
  });

  // ---- the bot answers (no login: the id and token in the URL are the proof) ----
  r.post('/api/interactions/:id/:token/callback', { auth: false }, async (ctx) => {
    const it = findInteraction(ctx);
    return answerInteraction(it, callbackSchema.parse(ctx.body));
  });

  // Finish (or change) the first answer. After "defer" this turns "thinking…" into the real message.
  r.patch('/api/interactions/:id/:token/original', { auth: false }, async (ctx) => {
    const it = findInteraction(ctx);
    return editInteractionOriginal(it, z.object({ content: z.string().max(MAX_CONTENT).optional(), embeds: embedsSchema.optional(), components: z.array(z.any()).max(5).nullable().optional() }).parse(ctx.body));
  });

  // More messages after the first answer (up to 5).
  r.post('/api/interactions/:id/:token/followup', { auth: false }, async (ctx) => {
    const it = findInteraction(ctx);
    const { messageId } = await interactionFollowup(it, replySchema.parse(ctx.body));
    return { ok: true, messageId };
  });

  // Housekeeping: forget old interactions; a command whose bot never finished "thinking…" says so instead of spinning forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const it of [...interactions.values()]) {
      if (it.expiresAt > now) continue;
      interactions.delete(it.id);
      if (it.messageId && !it.finished) {
        const botRow = getUserRow(it.botId);
        if (botRow) editMessageAs(botRow, it.channelId, it.messageId, { content: '*This command didn’t finish.*' }, { finishInteraction: true }).catch(() => {});
      }
    }
  }, 60_000);
  sweep.unref?.();
}
