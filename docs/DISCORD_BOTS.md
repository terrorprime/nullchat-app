# Discord-compatible bots

A bot written with a Discord library (`discord.js`, `discord.py`, JDA, DSharpPlus, Serenity…) can connect to NullChat by changing **two web addresses and the token**. NullChat answers the same REST calls and the same gateway protocol those libraries use, and turns them into NullChat messages, members and slash commands.

This sits next to NullChat's own bot API (see [BOTS.md](BOTS.md)). The two are not alternatives you have to choose between: they use the same bot, the same token and the same slash commands. A bot sees the same server whichever way it connects.

> **Tested how?** The layer is checked by an automated test of about 160 steps that speaks Discord's wire format by hand: the REST calls, the gateway handshake, intents, every event listed below, slash commands, replies and compressed streams. **It has not yet been run against the real `discord.js` or `discord.py`**, because the machine this was built on cannot download them. Everything below is what the protocol tests prove; the library settings in "Pointing a library at NullChat" are the documented way to do it, but give them a quick try with your own bot before you rely on it, and tell me what breaks.

---

## Quick start

1. In your server: **Server Settings → Integrations → Bots → Add Bot**, or make an app first in **User Settings → Developer Portal → New App** and use **Add to Server** (its page can also be shared so others can add it; see [BOTS.md](BOTS.md)). Pick a permission level and copy the token (`nb_…`). It is shown once; **Reset Token** makes a new one.
2. Point your library at your NullChat address (here `https://nullchat.fly.dev`):

### discord.js (v14)

```js
import { Client, GatewayIntentBits } from 'discord.js';

const HOST = 'https://nullchat.fly.dev';
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { api: `${HOST}/api`, cdn: `${HOST}/api/cdn`, version: '10' },
});

client.once('clientReady', () => console.log('Logged in as', client.user.tag));   // 'ready' in older v14 releases
client.on('messageCreate', (m) => { if (m.content === '!ping' && !m.author.bot) m.reply('pong'); });
client.on('interactionCreate', async (i) => {
  if (i.isChatInputCommand() && i.commandName === 'echo') await i.reply(i.options.getString('text'));
});
client.login(process.env.NULLCHAT_BOT_TOKEN);
```

The gateway address is not set separately: the library asks `GET /api/v10/gateway/bot` and gets `wss://nullchat.fly.dev/discord-gateway`.

### discord.py (v2)

```python
import discord
from discord.http import Route

HOST = "https://nullchat.fly.dev"
Route.BASE = f"{HOST}/api/v10"          # before the client is created

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_message(m):
    if m.content == "!ping" and not m.author.bot:
        await m.reply("pong")

client.run(os.environ["NULLCHAT_BOT_TOKEN"])
```

For other libraries: set the REST base to `https://HOST/api/v10` (or just `https://HOST/api`) and, if the library lets you, leave the gateway address to `GET /gateway/bot`.

### Slash commands

Register them the way you always do (`PUT /applications/:id/commands`, `client.application.commands.set(...)`, `tree.sync()`). The application id is the bot's own id; `@me` works too. People see the commands when they type `/` in any channel the bot can see, the same as for NullChat-native bots.

---

## What works

**Servers and people**: `GET` a server (with counts), its channels, roles, members (list, page with `after`, search by name), one member, one user, bans, emojis, and the bot's own user, servers and application. A member's `roles`, `nick`, `joined_at`, timeout (`communication_disabled_until`) and the usual user fields are filled in; pictures are links that go through `/api/cdn`.

**Messages**: send (text, embeds, replies with `message_reference`, `allowed_mentions`, `nonce`), read (newest first, `before` / `after` / `limit`), read one, edit your own, delete (your own, or anyone's with Manage Messages), bulk delete, pins, typing, reactions (add, remove your own, list who reacted, remove everything). Embeds go in and come out in Discord's shape.

**Moderation**: nickname, timeout, add and remove roles, kick, ban (with `delete_message_days` and the reason header `X-Audit-Log-Reason`), unban, list bans. NullChat's permission and role-order rules apply exactly as for a person: a bot cannot hand out a role above its own highest role, and a Chat-only bot cannot kick. A refusal comes back as Discord's `50013 Missing Permissions` with the reason in the message.

**Slash commands**: register (bulk overwrite, create, update, delete, get) with string, integer, number, boolean, user, channel and role options, `choices` and `required`. (`min_value`, `max_value`, `min_length` and `max_length` are accepted but not enforced by NullChat, so check them in your bot.) When someone runs one, the bot gets `INTERACTION_CREATE` with `data.options`, and a `resolved` section with the users, members, roles and channels it mentions, which is what libraries use to build `getUser()` and friends.

**Answering**: `POST /interactions/:id/:token/callback` with type 4 (message), 5 (“thinking…”), 1 (ping), 6 (acknowledge a button press without changing anything), 7 (update the message the button is on) or 9 (open a form), then `@original` read / edit / delete and follow-ups on the webhook address (`/webhooks/:app/:token`), up to 5 follow-ups, `flags: 64` for answers only the asker sees. As on Discord, after “thinking…” the first follow-up becomes the answer.

**Buttons, select menus and forms**: messages can carry `components` in Discord's shape (action rows of buttons with styles 1–5, `custom_id`, `emoji`, `url` and `disabled`, or one select menu: a string menu with `options`, or a user, role, mentionable or channel menu (types 5–8, with `default_values` and `channel_types`), each with `min_values` and `max_values`), and they come back the same way when read. A press arrives as `INTERACTION_CREATE` type 3 with `data.custom_id`, `data.component_type` (2 button, 3 string select, 5 user, 6 role, 7 mentionable, 8 channel), `data.values` and, for types 5–8, `data.resolved` (`users`, `members`, `roles`, `channels`, as Discord sends them), plus the `message` it was on; a sent form arrives as type 5 with `data.components` holding each text input's `value`. In discord.js that is `isButton()`, `isStringSelectMenu()`, `isUserSelectMenu()`, `isRoleSelectMenu()`, `isMentionableSelectMenu()`, `isChannelSelectMenu()`, `showModal()` and `isModalSubmit()`, and in discord.py `discord.ui.View`, `Button`, `Select`, `UserSelect`, `RoleSelect`, `MentionableSelect`, `ChannelSelect` and `Modal`. Limits are Discord's (5 rows, 5 buttons or 1 menu per row, 25 options, 5 text inputs in a form, 100-character `custom_id`s). Not supported: the newer layout components, buttons in an `ephemeral` answer, and `components` in a webhook's message other than link buttons.

**Webhooks**: the webhooks that people create in Server Settings → Integrations answer on `/webhooks/:id/:token` in Discord's shape (execute with `content`, `username`, `avatar_url`, `embeds`, `?wait=true`, `?thread_id=`, and edit, read or delete the messages it sent), so any tool with a “Discord webhook” setting can post to NullChat by changing the address. Tools that add `/github` or `/slack` to the address are not supported.

**Gateway** (`/discord-gateway`, JSON, with or without `compress=zlib-stream`):

| | |
|---|---|
| Handshake | `HELLO`, `IDENTIFY`, heartbeats and acks, `READY`, `GUILD_CREATE`, `REQUEST_GUILD_MEMBERS` (with `nonce`), presence updates (status and playing / custom status show in NullChat's member list) |
| Messages | `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `CHANNEL_PINS_UPDATE`, `TYPING_START` |
| Structure | `GUILD_UPDATE`, `CHANNEL_CREATE / UPDATE / DELETE`, `GUILD_ROLE_CREATE / UPDATE / DELETE`, `GUILD_EMOJIS_UPDATE` |
| People | `GUILD_MEMBER_ADD`, `GUILD_MEMBER_UPDATE`, `GUILD_MEMBER_REMOVE`, `PRESENCE_UPDATE` |
| Commands | `INTERACTION_CREATE` |

Intents are honoured: without `GUILD_MEMBERS` a bot gets no member events, without `GUILD_MESSAGES` no messages, and so on. Unlike Discord, the *privileged* intents are not locked behind an approval step. A bot that asks for `MESSAGE_CONTENT` simply gets message content, and a bot that doesn't ask for it gets it too. Closing codes follow Discord's: `4004` for a bad or reset token, `4013` for a missing `intents` value, `4000` for an encoding or compression NullChat doesn't speak.

---

## What does not work (yet)

Be aware of these before porting a bot that depends on them.

* **Autocomplete** and the **newer layout components** (sections, containers, text displays). Registering or sending one is refused with a message saying so, so nothing half-works silently.
* **Subcommands and subcommand groups**, **mentionable** and **attachment** options, and **context-menu** (user / message) commands. Registering one of these is refused with a message that says which part is unsupported, so nothing half-works silently.
* **Uploading files.** `multipart/form-data` messages are refused. Link to an image in an embed instead.
* **Threads, voice, stage events, scheduled events, stickers, auto-moderation, audit-log reads, creating webhooks through the API (people create them in Server Settings), invites and the other management endpoints** that are not in the list above. They answer `404` or `501` in Discord's error shape.
* **Resuming a dropped connection.** The server keeps no replay buffer. When a library sends `RESUME`, it gets `INVALID_SESSION` (not resumable) and starts again with `IDENTIFY`, which libraries already handle. Events that happened during the drop are lost.
* **Sharding.** One connection per bot; `shard: [0, 1]`.
* **Commands are one list per bot.** A NullChat bot can be in many servers, but its slash commands are one list shown in all of them, so *global* and *server* commands are the same list. `GET /users/@me/guilds` has one entry per server it is in. When it is added to another server while connected it receives `GUILD_CREATE` for it (with every member, as Discord does), and `GUILD_DELETE` when it is removed.
* **A bot cannot rename itself, open DMs, leave a server or edit its own avatar through the API.** Do those in Server Settings → Integrations → Bots (or **Remove from Server**), or the Developer Portal.
* **Removing one emoji's reactions for everybody** (`DELETE …/reactions/:emoji`). Remove all reactions, or each person's, instead.
* **Ban events** (`GUILD_BAN_ADD / REMOVE`) are not sent. A banned member shows up as `GUILD_MEMBER_REMOVE`.
* **Slash command changes are limited to 20 per hour** per bot, so `tree.sync()` in a loop will be refused with a `429`.
* **Permission numbers** are translated to Discord's bit positions, so `PermissionFlagsBits` checks in a library behave. NullChat has some permissions Discord doesn't (and the other way round), and those have no equivalent number.
* **Rate limits** are NullChat's: 600 requests a minute and 8 messages per 5 seconds per bot. They arrive as `429` with `retry_after`.

---

## Which Discord bots can I run?

Your **own**, or open-source ones you can host yourself, once pointed at NullChat as above. **MEE6, Dyno, Carl-bot and other bots that Discord-hosted companies run cannot join**: their programs only connect to Discord's servers, and nothing you do in NullChat changes that. The same is true of anything that needs the unsupported features above, so a bot that relies on layout components will mostly not work.

## If something does not work

Run the bot with the library's debug logging on and look for the first request or gateway message that is refused. Because every refusal names what is unsupported (rather than doing nothing), the cause is usually in the first error. The NullChat server log shows `[discord gateway]` lines for gateway problems.
