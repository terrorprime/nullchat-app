# Bots and slash commands

NullChat has its own bot system. You add a bot to a server, it gets a token, and a program you run (on your PC, a Raspberry Pi, a free host, anywhere) uses that token to read messages, answer **slash commands** and post messages and rich cards.

> **Can I add MEE6, Dyno, Carl-bot or other Discord bots?**
> No. Those bots are programs that Discord's own company runs, and they only speak to Discord's servers. Nothing you do in NullChat can make them join. But a bot **you** run, or an open-source one you host yourself, written with `discord.js`, `discord.py` or a similar library, can connect to NullChat by changing its web addresses and token. See [DISCORD_BOTS.md](DISCORD_BOTS.md) for how, and what is not supported.

This page describes NullChat's own bot API, which is simpler and needs no library. Both ways use the same bot, token and slash commands.

Also on this page: **buttons, menus and forms** a bot can put in its messages, **webhooks** (an address that posts into one channel without any bot at all), the **Developer Portal**, one page in your settings for everything you have built, and the **App Directory**, where a bot you share can be added to other people's servers.

---

## Quick start

1. Open a server you manage and go to **Server Settings → Integrations → Bots → Add Bot**.
2. Give it a name and pick what it may do (**Chat only**, **Moderator** or **Administrator**). Copy the token that appears. **It is shown once.** If you lose it, use **Reset Token**. (You can also make it first in **User Settings → Developer Portal → New App**, with no server, and add it to servers afterwards. See [Apps in many servers](#apps-in-many-servers-and-the-app-directory).)
3. Run the example bot (needs only Node.js 22):

   ```bash
   cd examples/example-bot
   NULLCHAT_URL=https://nullchat.fly.dev NULLCHAT_BOT_TOKEN=nb_yourtoken node bot.mjs
   ```

   On Windows PowerShell:

   ```powershell
   cd examples\example-bot
   $env:NULLCHAT_URL = "https://nullchat.fly.dev"
   $env:NULLCHAT_BOT_TOKEN = "nb_yourtoken"
   node bot.mjs
   ```

4. In any channel the bot can see, type `/`: its commands show up in the list. The bot must be running to answer; when it is not, people get "*Bot* is offline right now".

`examples/example-bot/bot.mjs` is a single short file and shows commands, choices, a rich card, a private reply, a slow ("thinking…") reply and reading plain messages. Start by copying it.

---

## How bots work here

* In every server it is in, a bot is a **member** with its **own role** there (shown in Roles, named after the bot). Change that role to change what it can do in that server, exactly like a person's. A bot can be in many servers at once; see [Apps in many servers](#apps-in-many-servers-and-the-app-directory).
* The permission presets give the role: *Chat only* (read, send, react, attach, embed), *Moderator* (plus delete messages, manage threads, time out, kick, ban, manage nicknames) or *Administrator*. You can't give a bot permissions you don't have yourself.
* Channel permission overrides apply to bots too: to keep a bot out of a channel, deny **View Channel** to its role there.
* Bots are marked **BOT** everywhere. They can't log in, send or receive DMs, have friends or own a server. Messages from bots are not touched by AutoMod, slowmode or verification, and bots don't earn XP.
* **Removing** a bot from a server (**Remove from Server**, or kicking / banning it) takes it out of that server and deletes its role there. The app itself, its token and its other servers are not touched, and the messages it already sent stay. To get rid of the app altogether, **Delete App** in the Developer Portal.
* A server can have up to **25 bots**, and one person can make up to **25 apps**.

---

## Apps in many servers, and the App Directory

An **app** is a bot together with its token, its description and a setting for who may add it. Making one does not put it anywhere: you add it to servers, as many as you like, and each server gives it its own member and role. One program with one token serves all of them. Events from every server it is in arrive on the same live connection (each carries its `guildId`), and the slash commands it registers with `PUT /api/bot/commands` appear in every server it is in.

**Who may add it** is set by the person who made it, under **Developer Portal → Edit** (or Server Settings → Integrations → Edit for the owner):

| Setting | Meaning |
|---|---|
| **Private** (the default) | Only you can add it to servers. |
| **Anyone with the link** | Not in the directory, but anyone you give `/apps/<id>` to can open its page and add it to a server they manage. |
| **Listed in the App Directory** | It also shows up under **Discover → Apps**, where anyone can search it (by name or description), sort by *Most added*, *Newest* or *A to Z*, and add it. Needs a description of at least 10 characters, so people know what it does. |

**Adding an app to a server.** On an app's page (or from the Developer Portal) press **Add to Server**. You see every server where you have *Manage Server*, the ones that can't take it are greyed out with the reason (*Already added*, *This server already has 25 bots*, *Needs a permission you don't have here*), and the list of permissions its role will get, before anything happens. An app that asks for **Administrator** gets a red warning, and only a server's owner or an administrator can give it that. You can never give an app more than you have yourself. Once added, give its role access to the channels it should use under Server Settings → Roles; the server's audit log says who added it.

**What the owner's permission setting means.** *Permissions for servers that add it* (Chat only, Moderator or Administrator) is what the role gets in a server that adds the app **from now on**. Servers that already have it keep the role they have, and their managers can change that role like any other.

**Who can change what.** The owner can do everything. A server's managers can **Remove** the app from their server but not rename it, reset its token or see its token hint. The one exception keeps the old behaviour: a **private** app that is in exactly one server can also be changed by that server's managers, because it is that server's own bot. Only the owner can change who may add it.

**Staff.** The site admin has an **Admin Panel → Apps** list of every listed or link-only app. **Hide** takes an app out of the directory and stops anyone else adding it (servers that already have it keep it); **Delete** removes it everywhere. Both go in the Activity log.

Calls (with your normal login; a bot token can't use them): `GET /api/apps?q=&sort=popular|new|name&offset=` (the directory, 24 a page, with `hasMore`), `GET /api/apps/:id` (an app's page: description, maker, the permissions it will get, its commands, and which of *your* servers can take it and why not), `POST /api/apps/:id/install {guildId}` (needs Manage Server there), `POST /api/developer/bots {name, description, preset}` (make an app in no server), `PATCH /api/developer/bots/:id {name, description, visibility, permPreset}`, `DELETE /api/developer/bots/:id` (delete the app) and `DELETE /api/guilds/:id/bots/:botId` (take it out of one server). Adding apps is limited to 20 an hour per person.

---

## Talking to the API

Use the normal NullChat API, with the bot token in the header:

```
Authorization: Bot nb_yourtoken
```

Only the calls below work with a bot token; anything else is refused with `403`. Everything is limited by the bot's role permissions, and by **600 requests a minute** per bot. A bot may send at most **8 messages per 5 seconds**.

| Call | What it does |
|---|---|
| `GET /api/users/@me` | The bot's own account |
| `PATCH /api/users/@me/presence` | Set status (`online`, `idle`, `dnd`, `invisible`) |
| `GET /api/guilds/:id` | The server: channels, roles, emoji |
| `GET /api/guilds/:id/members` | Members |
| `PATCH /api/guilds/:id/members/:userId` | Change nickname / roles / timeout |
| `DELETE /api/guilds/:id/members/:userId` | Kick |
| `GET /api/guilds/:id/bans`, `PUT /api/guilds/:id/bans/:userId`, `DELETE /api/guilds/:id/bans/:userId` | Bans |
| `GET /api/channels/:id` | A channel |
| `GET /api/channels/:id/messages` | History (`?limit=50&before=<id>`) |
| `GET /api/channels/:id/messages/:messageId` | One message |
| `POST /api/channels/:id/messages` | Send a message, see below |
| `PATCH /api/channels/:id/messages/:messageId` | Edit its own message (`content`, `embeds`, `components`) |
| `DELETE /api/channels/:id/messages/:messageId` | Delete (needs *Manage Messages* for other people's) |
| `POST /api/channels/:id/messages/bulk-delete` | Delete up to 100: `{ "ids": [...] }` |
| `PUT` / `DELETE /api/channels/:id/messages/:messageId/reactions/:emoji[/:userId]` | Add / remove reactions |
| `GET` / `PUT` / `DELETE /api/channels/:id/pins[/:messageId]` | Pins |
| `GET` / `POST /api/channels/:id/threads` | Threads |
| `POST /api/attachments` | Upload a file to attach to a message |
| `GET /api/bot/commands`, `PUT /api/bot/commands`, `DELETE /api/bot/commands/:name` | The bot's slash commands |

IDs are strings. Errors come back as JSON with a `message`.

### Sending a message

```http
POST /api/channels/:id/messages
{
  "content": "Hello **world**",
  "replyTo": "1234567890123456789",
  "embeds": [ { "title": "…" } ],
  "attachmentIds": [],
  "silent": false
}
```

`content` is up to 4000 characters and uses the same formatting as people's messages (bold, code, links, `<@userId>` mentions, `<#channelId>`). At least one of `content`, `embeds`, `components` or `attachmentIds` is needed.

Answers to commands, buttons and forms don't count towards the limit of 8 messages per 5 seconds, because someone had to start each one.

### Embeds (rich cards)

Only bots can send embeds, up to **10 per message** and about 6000 characters of text in total.

```json
{
  "title": "Deploy finished",
  "description": "All **green**. Markdown works here too.",
  "url": "https://example.com/build/42",
  "color": "#3ddc97",
  "author": { "name": "CI", "url": "https://example.com", "iconUrl": "https://example.com/ci.png" },
  "fields": [
    { "name": "Time", "value": "41s", "inline": true },
    { "name": "Branch", "value": "main", "inline": true },
    { "name": "Notes", "value": "Nothing to report." }
  ],
  "thumbnail": "https://example.com/small.png",
  "image": "https://example.com/big.png",
  "footer": { "text": "ci", "iconUrl": "https://example.com/ci.png" },
  "timestamp": "2026-11-05T21:00:00Z"
}
```

All parts are optional (at least one must be present). `color` is `"#rrggbb"` or a number. Up to 25 fields; `inline` fields sit side by side. Links must start with `http://` or `https://`. Snake-case spellings (`icon_url`) are accepted too.

---

## The live connection

To react to things as they happen, connect a WebSocket to `/gateway` (use `wss://` on an `https://` server), then send your token:

```json
{ "op": "identify", "d": { "token": "nb_yourtoken" } }
```

The server answers `{ "t": "READY", "d": { "bot": true, "user": {…}, "guilds": […], "users": […] } }` and from then on sends events as `{ "t": "EVENT_NAME", "d": {…} }`. A wrong token gets `INVALID_SESSION` and the connection is closed.

Bots may send only two messages: `{ "op": "heartbeat" }` (answered with `HEARTBEAT_ACK`; do this every 25 seconds or so to notice dead connections) and `{ "op": "typing", "d": { "channelId": "…" } }`. The server also pings the connection itself; `WebSocket` in Node 22 and in browsers answers automatically. If the connection drops, reconnect and `identify` again. Nothing is replayed, so fetch history over REST if you need what you missed.

Events you will use most (the same ones people's apps get, for the server the bot is in):

| Event | When |
|---|---|
| `INTERACTION_CREATE` | Someone ran one of the bot's slash commands |
| `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK` | Messages in channels the bot can see (`d.author.bot` tells you whether a bot wrote it) |
| `MESSAGE_REACTIONS_UPDATE` | A message's reactions changed (it carries the message's full reaction list) |
| `GUILD_MEMBER_ADD` / `GUILD_MEMBER_REMOVE` / `GUILD_MEMBER_UPDATE` | People joining, leaving or changing |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` / `CHANNEL_DELETE` | Channels |

A message looks like `{ "id", "channelId", "guildId", "author": { "id", "username", "displayName", "bot" }, "content", "mentions": [userIds], "replyTo", "embeds", "attachments", "createdAt" }`.

---

## Slash commands

A bot publishes its commands with one call. This is the whole list: anything not in it is removed, and a command with the same name is updated in place. Do it each time the bot starts.

```http
PUT /api/bot/commands
[
  { "name": "echo", "description": "Repeat what you type",
    "options": [ { "name": "text", "description": "What to repeat", "required": true } ] },
  { "name": "mood", "description": "Pick a mood",
    "options": [ { "name": "mood", "description": "How are you?", "required": true,
                   "choices": [ { "name": "Happy", "value": "happy" }, { "name": "Sleepy", "value": "sleepy" } ] } ] }
]
```

* Command and option names: 1–32 lowercase letters, numbers, `-` or `_`. Descriptions: up to 100 characters.
* Option `type`: `string` (default), `integer`, `number`, `boolean`, `user`, `channel` or `role`. `user`, `channel` and `role` arrive as ids.
* Up to **50 commands**, **10 options** each, **25 choices** per option; required options come first.
* Commands are per bot, per server. Members see them when they type `/`, with the bot's name beside them. Updating more than 20 times an hour is refused.

### How people use them

In the message box they type `/`, pick a command, and type its options either as `name:value` pairs or, for the first option, just the text: `/echo hello there`, `/roll sides:20`. Options with choices offer a pick list. A member needs permission to send messages in the channel, and the bot must be able to see and write in it. If the bot is offline they are told so right away.

### What the bot receives

```json
{ "t": "INTERACTION_CREATE", "d": {
  "id": "…", "token": "…", "type": "command",
  "commandName": "echo", "commandId": "…",
  "options": { "text": "hello there" },
  "channelId": "…", "guildId": "…",
  "user": { "id": "…", "username": "alice", "displayName": "Alice" },
  "member": { … }
} }
```

If you run the same bot twice, only the newest connection gets commands.

### Answering

You have **5 seconds** to answer or defer, otherwise the person is told the bot didn't respond. The `id` and `token` in the event go into the URL; no `Authorization` header is needed.

```http
POST /api/interactions/:id/:token/callback
{ "content": "Pong!" }                                    ← a normal message
{ "embeds": [ {…} ] }                                      ← a rich card
{ "content": "Only you see this", "ephemeral": true }      ← private reply (not stored; gone on reload)
{ "type": "defer" }                                        ← "Bot is thinking…" while you work (up to 15 minutes)
```

After `defer`, finish with `PATCH /api/interactions/:id/:token/original` and `{ "content": "…", "embeds": […] }`. You can also change the first answer later the same way. `POST /api/interactions/:id/:token/followup` sends up to **5** more messages (also `ephemeral` if you like). A command can be answered only once; the token is good for 15 minutes.

Answers are shown with "*Name* used **/command**" above them, so everyone can see who asked for what.

---

## Buttons, menus and forms

A bot's message can carry **buttons** and **menus**, and a press can open a **form**. People use them like anything else in the message; the bot is told what they did.

### Putting them in a message

`components` is a list of **rows** (up to 5). A row holds up to **5 buttons**, or **one menu**.

```http
POST /api/channels/:id/messages
{
  "content": "Pick one",
  "components": [
    { "type": 1, "components": [
      { "type": 2, "style": 1, "label": "Yes",  "custom_id": "vote_yes" },
      { "type": 2, "style": 4, "label": "No",   "custom_id": "vote_no", "emoji": { "name": "🔥" } },
      { "type": 2, "style": 5, "label": "Rules", "url": "https://example.com/rules" }
    ] },
    { "type": 1, "components": [
      { "type": 3, "custom_id": "colour", "placeholder": "Choose a colour", "min_values": 1, "max_values": 1,
        "options": [ { "label": "Red", "value": "red", "description": "Warm", "emoji": { "name": "🔴" } },
                     { "label": "Blue", "value": "blue" } ] }
    ] }
  ]
}
```

| Part | Rules |
|---|---|
| Button `style` | `1` primary, `2` secondary, `3` success, `4` danger, `5` link (names such as `"danger"` work too) |
| Button | needs a `label` or an `emoji` (`{ "name": "🔥" }`, or `{ "id": "…", "name": "party" }` for a custom emoji); label up to 80 characters; `disabled` turns it off |
| `custom_id` | what comes back to you: up to 100 characters, **different for every button and menu in the message**. Link buttons have a `url` (http or https) instead and send nothing |
| Menu | `type: 3` (choices from a list). Up to 25 `options`, each with a `label`, a `value` (different from the others) and optionally `description`, `emoji` and `default`. `min_values` (0–25, default 1) and `max_values` (default 1) say how many can be picked |
| Pickers | menus of the server's own people, roles or channels, with a search box, so you don't have to list them yourself: `type: 5` people, `6` roles, `7` people **and** roles, `8` channels. They take `custom_id`, `placeholder`, `min_values` (0–25, default 1), `max_values` (default 1, up to 25) and optionally `default_values`: `[{ "id": "…", "type": "user" }]` (`"user"` or `"role"`, `"channel"` for type 8) already ticked. A channel picker can say which kinds with `channel_types` (`0` text, `2` voice, `4` category, `5` announcement, `11` thread, `13` stage, `15` forum; Discord's other thread numbers are accepted); leave it out for any |
| Rows | a menu of any kind needs a row of its own. Webhooks may only send link buttons |

To change or remove them later, `PATCH` the message with a new `components` list (`[]` takes them away). Editing only the text leaves them as they are. Snake-case and camelCase spellings both work.

### When someone uses one

The bot gets `INTERACTION_CREATE`, just like a slash command, with a `type` that says what happened:

```json
{ "t": "INTERACTION_CREATE", "d": {
  "id": "…", "token": "…", "type": "component", "componentType": "button",
  "customId": "vote_yes", "channelId": "…", "guildId": "…",
  "user": { "id": "…", "username": "alice", "displayName": "Alice" },
  "message": { "id": "…", "content": "Pick one", … }
} }
```

* A **menu** choice has `componentType: "select"` and `values: ["red"]`.
* A **picker** has `componentType` `user_select`, `role_select`, `mentionable_select` or `channel_select`, `values` with the ids picked, and `resolved` so you don't have to look anyone up:
  ```json
  "values": ["1042"],
  "resolved": { "users": { "1042": { "id": "1042", "username": "carol", … } },
                "members": { "1042": { "userId": "1042", "nick": null, "roles": ["…"], … } },
                "roles": { }, "channels": { } }
  ```
  Each pick is checked against the server before you hear about it: people must still be members, roles must exist (and are never `@everyone`), channels must be in this server, of an allowed kind, and ones the person can open. Someone who picks wrong gets an error and you get nothing. Only the ids and public details come with it, never emails.
* A **sent form** has `type: "modal"`, the form's `customId` and `values: { "box_custom_id": "what they typed" }`. `message` is the message the button was on, or `null` if the form came from a slash command.

Anyone who can read the channel can press, as long as the bot is online (otherwise they are told it is offline right now). A turned-off button can't be pressed. You have **5 seconds** to answer, then the person is told the bot didn't respond; the token is good for 15 minutes.

### Answering a press

Use the same `callback` address as for slash commands, with a `type`:

| `type` | What happens |
|---|---|
| `update` | Changes the message the button is on (`content`, `embeds` and `components`; leave out what stays). It is not marked "(edited)" |
| `defer_update` | Takes the press without changing anything. You can still change the message later with `PATCH …/original` |
| `message` | A new message. It shows "*Name* used a button" above it (or "a menu", "a form") |
| `defer` | "Bot is thinking…", then finish with `PATCH …/original`, as for commands |
| `modal` | Opens a form for the person who pressed (see below) |

`update` and `defer_update` only work for an answer to a button or menu (or a form that came from one). Follow-ups work as before. **Buttons and menus can't be put in a private (`ephemeral`) answer.**

### Forms

```http
POST /api/interactions/:id/:token/callback
{ "type": "modal", "modal": {
  "custom_id": "bug_report", "title": "Report a bug",
  "components": [
    { "type": 1, "components": [ { "type": 4, "custom_id": "what", "label": "What happened?", "style": 1, "max_length": 60, "placeholder": "A few words" } ] },
    { "type": 1, "components": [ { "type": 4, "custom_id": "steps", "label": "Steps to see it", "style": 2, "required": false, "value": "1. " } ] }
  ] } }
```

A form has a title (up to 45 characters) and **1 to 5 text boxes**, one per row. `style` is `1` short or `2` paragraph; `min_length`, `max_length`, `required` (default true), `value` (starting text) and `placeholder` are optional. The person sees a window naming your bot ("Your answers go to *Name*"), and the server checks length and required boxes before sending it to you. A form can be opened from a slash command too. Only text boxes work in forms.

`examples/example-bot/bot.mjs` has `/counter` (buttons, a form) and `/pick` (a menu).

---

## Webhooks

A webhook is a web address that posts into **one channel**. Anything that can send a web request (a monitoring tool, a CI job, a script, a form service) can use it, with no bot and no login. The address itself is the key, so keep it private.

**Create one:** Server Settings → Integrations → Webhooks → Create Webhook (needs *Manage Server*). Pick a name and a channel, then **Copy Address**. Up to **25** per server. You can rename it, give it a picture, move it to another channel, or **Reset Address** (the old one stops working at once). The server's audit log records who created, changed, reset or removed one.

```http
POST https://nullchat.fly.dev/api/webhooks/<id>/<token>
{
  "content": "Deploy finished",
  "username": "CI",                              ← optional: another name for this one message
  "avatar_url": "https://example.com/ci.png",     ← optional: another picture for this one message
  "embeds": [ { "title": "Build 42", "color": "#3ddc97" } ],
  "components": [ { "type": 1, "components": [ { "type": 2, "style": 5, "label": "Open run", "url": "https://example.com/run/42" } ] } ]
}
```

* The reply is `204 No Content`. Add `?wait=true` to get the message back (with its `id`).
* Messages show the webhook's name (or `username`) with a **WEBHOOK** tag. They don't belong to a member, so there is no profile to open.
* `content` is up to 4000 characters, with at least one of `content`, `embeds` or `components`. `@everyone` and `@here` don't ping; role mentions work only for roles set to be mentionable.
* A webhook can only send **link buttons** (style 5), because nothing is listening to answer other buttons.
* `?thread_id=<id>` (or `thread_id` in the body) posts into a thread of the webhook's channel.
* Messages it sent can be read, changed or deleted: `GET`, `PATCH`, `DELETE /api/webhooks/<id>/<token>/messages/<messageId>`.
* Limits: **20 messages per 10 seconds** per webhook (then `429` with `retryAfter`). Too many wrong addresses from one place in a minute are refused for a while, so addresses can't be guessed.
* **Discord-style senders work too.** The same body goes to `https://nullchat.fly.dev/api/v10/webhooks/<id>/<token>`, so a tool that offers a "Discord webhook" setting can use that address. Tools that send to Discord's `/github` or `/slack` variants are not supported.
* The address is stored as it is (so you can copy it again later), not as a one-way hash. It is as private as the rest of the server's data.

---

## Developer Portal

**User Settings → Developer Portal** gathers your apps and the webhooks of every server where you have *Manage Server* (the page only appears if you have that somewhere). It is built for the moment you are writing a bot and want to see what is going on.

* **Apps:** every app you made, and every bot in the servers you manage that you are allowed to change, yours first. Each card shows whether it is online, where it is (*Not in a server yet*, the server's name, or *N servers*), who may add it (for apps you made), the end of its token (never the token itself), how many slash commands it has and when it was last seen. **New App** makes one that is in no server yet and shows its token once. **Add to Server** adds it to a server you manage, **Edit** (name, picture, description, who may add it, permissions for new servers), **Reset Token**, **Copy ID**, **Copy Link** (for apps that are not private) and **Delete App** (or **Remove**, for a bot you only manage in someone else's app) are on the card.
* **Details → Servers:** the servers the app is in that you manage, each with **Remove**, a count of the ones you don't manage, and the app's link when it is shared.
* **Details → Slash commands:** what the bot has registered, with each option and whether it is required. The bin button deletes one (it disappears from the `/` list at once; a bot registers its commands again whenever it starts, so one it still defines comes back). The audit log records who deleted which command.
* **Details → Recent activity:** a live list of what the bot has been asked to do, newest first: the kind (command, button, menu or form), its name or `custom_id`, who asked, and how it went: *answered in 120 ms*, *waiting*, *no answer within 5 s*, *the bot was not connected* (someone tried while it was offline), or *failed* with the reason. It is for testing: if a command says "no answer", your bot got it too late or not at all.
  * It keeps the **last 50 per bot, in memory only**, so it is empty after the server restarts.
  * It never shows **what people typed** into a command or a form, or which menu choice they made.
  * It updates by itself every few seconds while the details are open.
* **Webhooks:** every webhook in those servers with **Copy Address** and **Send Test Message** (posts "Test message from the Developer Portal…" into its channel, so you see right away that the address works). Create, rename and delete them in Server Settings → Integrations.
* **Build:** this server's API address and live-connection address to copy, a one-line `curl` to send a first message, and where the guides are.

One app runs in as many servers as you add it to; the same program and token serve all of them (see [Apps in many servers](#apps-in-many-servers-and-the-app-directory)). You only see the servers where you have *Manage Server* today.

The portal uses these calls with your normal login (a bot token can't use them): `GET /api/developer/bots`, `POST /api/developer/bots`, `PATCH`, `DELETE` and `POST …/token` on `/api/developer/bots/:id`, `GET /api/developer/bots/:id/commands`, `DELETE /api/developer/bots/:id/commands/:name`, `GET /api/developer/bots/:id/activity` and `GET /api/developer/webhooks`.

---

## Porting a Discord bot

You have two choices.

**1. Keep the Discord library and point it at NullChat.** Usually the least work: change the REST address and the token, keep the rest of the bot. [DISCORD_BOTS.md](DISCORD_BOTS.md) has the exact settings for `discord.js` and `discord.py`, and lists what does not carry over (autocomplete, subcommands, file uploads, threads, voice).

**2. Rewrite the thin layer for NullChat's own API.** The API is deliberately close to the shape Discord bots use, so most of a bot carries over:

| Discord | NullChat |
|---|---|
| Bot application and token in the developer portal | **User Settings → Developer Portal → New App** (or **Server Settings → Integrations → Add Bot**); token starts with `nb_` |
| "Add to server" invite link for a bot | **Add to Server** on the app's page, `/apps/<id>`; list it under Discover → Apps to let others find it |
| `Authorization: Bot <token>` | The same |
| `/api/v10/...` endpoints | `/api/...` with the calls in the table above |
| Gateway with intents and a heartbeat handshake | `identify` with the token, no intents; you get every event for every server you are in |
| Slash commands registered globally or per guild | `PUT /api/bot/commands` (one list, shown in every server the bot is in) |
| Interaction response types | `callback` with `content` / `embeds` / `ephemeral`, or `defer` then `PATCH …/original`; `update`, `defer_update` and `modal` for buttons, menus and forms |
| Embeds | Same fields |
| Buttons, select menus (your own options, or the server's people, roles and channels), modals | `components` on messages, the `update` / `modal` answers (see above). Voice: not available |
| Snowflake IDs | Long numeric strings; treat them as opaque strings |

`examples/example-bot/bot.mjs` is a complete bot written this way, with no library.

---

## Good to know

* **Keep tokens secret.** Don't commit them to a public repository. If one leaks: **Reset Token**, then update your program.
* A bot only works while its program runs. For an always-on bot, run it on any small host (a free-tier VM, a Raspberry Pi, a second Fly.io app). It needs only outbound internet access.
* The server forgets a bot's pending commands when it restarts (the person just runs the command again).
* Bots show as **Online** in the member list and on their Integrations card while connected.
