# NullChat

NullChat is a self-hosted chat, voice and video app modeled on Discord's layout and features, with its own name, logo and artwork. It covers accounts, servers, roles and permissions, text channels, threads, DMs, group calls, voice channels with camera and screen sharing, moderation and a full settings system. All data is stored in a local database and stays there between restarts.

> NullChat is an original implementation. It contains no Discord code, assets, or trademarks; Discord was only used as a functional/design reference.

---

## Contents

1. [Quick start (Windows 11 + VS Code)](#1-quick-start-windows-11--visual-studio-code)
2. [Trying it with several users](#2-trying-it-with-several-users)
3. [Feature tour](#3-feature-tour)
4. [Desktop app & installable app](#desktop-app--installable-app)
5. [Project structure & architecture](#4-project-structure--architecture)
5. [Configuration (.env)](#5-configuration-env)
6. [Deploying online](#6-deploying-online)
7. [Troubleshooting](#7-troubleshooting)
8. [Useful commands](#8-useful-commands)

---

## 1. Quick start (Windows 11 + Visual Studio Code)

> **Fastest way:** install Node.js 22 LTS from <https://nodejs.org>, unzip NullChat, then start it:
>
> | | Start NullChat | Put it online (Fly.io) | Account help | Build the desktop app |
> | --- | --- | --- | --- | --- |
> | **Windows** | double-click `Start NullChat.bat` | `Deploy to Fly.io.bat` | `Account Help (Fly.io).bat` | `Build Installer.bat` (Windows app), `Build Mac App.bat` (Mac and Linux apps, built on GitHub), `Voice Relay Setup.bat` (calls that connect for everyone) |
> | **Mac** | double-click `Start NullChat.command` | `Deploy to Fly.io.command` | `Account Help (Fly.io).command` | `Build Installer.command` |
> | **Linux** | `./nullchat.sh start` | `./nullchat.sh deploy` | `./nullchat.sh account` | `./nullchat.sh installer` |
>
> (`./nullchat.sh` with no word shows a small menu. On a Mac, if macOS blocks a `.command` file, right-click it → **Open**. If the files lost their "runnable" flag when you copied them, run `chmod +x *.command *.sh scripts/unix/*.sh` once in the folder.)
>
> The first run installs and builds everything (about 1–2 minutes), then NullChat opens in your browser at <http://localhost:3001>. Keep the window open while you use it. The steps below are for working on the code in VS Code.

### 1.1 Install the prerequisites (one time)

| Tool | Where | Notes |
|---|---|---|
| **Node.js 22 LTS or newer** (22.13+) | <https://nodejs.org> → "LTS" → Windows Installer (.msi) | Keep the default options. This also installs `npm`. |
| **Visual Studio Code** | <https://code.visualstudio.com> | Optional extras: the "SQLite Viewer" extension lets you browse the database. |
| A modern browser | Edge, Chrome or Firefox | Needed for voice, video and screen sharing. |

You do **not** need Python, Visual Studio Build Tools or a separate database server. NullChat uses SQLite through Node.js's built-in `node:sqlite` module.

Check the install by opening **PowerShell** and running:

```powershell
node -v    # should print v22.13.0 or higher
npm -v
```

### 1.2 Open the project

1. Unzip `nullchat.zip` somewhere convenient, e.g. `C:\Users\<you>\Projects\nullchat`.
2. Start VS Code → **File → Open Folder…** → choose the `nullchat` folder.
3. If VS Code asks "Do you trust the authors of the files in this folder?", choose **Yes, I trust the authors**.
4. Open a terminal with **Terminal → New Terminal** (or `` Ctrl+` ``). It opens in the project folder.

### 1.3 Install and set up

In the VS Code terminal run:

```powershell
npm install
npm run setup
```

- `npm install` downloads all dependencies for the server and the web client. It takes about a minute.
- `npm run setup` creates your private `.env` file with a randomly generated `APP_SECRET`, plus the `data/` folder.

> If PowerShell says *"running scripts is disabled on this system"* when you run `npm`, run this once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and answer **Y**. Then try again.

Optional: load demo accounts and a demo server so you have something to look at right away:

```powershell
npm run seed
```

This creates the users **alice**, **bob** and **carol** (all with the password `nullchat123`) and a public server called **NullChat Lounge**.

### 1.4 Run it

```powershell
npm run dev
```

This starts two processes side by side:

- **server**: the API, the real-time gateway and the database, on <http://localhost:3001>
- **client**: the web app with hot reload, on <http://localhost:5173>

Open **<http://localhost:5173>** in your browser. Register a new account, or log in as `alice` / `nullchat123` if you ran the seed.

To stop, press `Ctrl+C` in the terminal. Your accounts, servers and messages stay in `data/nullchat.db` and are there again the next time you start.

**Running from VS Code:** press `Ctrl+Shift+B` (default build task "NullChat: dev"). You can also open **Terminal → Run Task…** and pick a NullChat task. To debug the server with breakpoints, use **Run and Debug → "NullChat: Debug server"**.

### 1.5 Emails during development

Without an email server configured, password-reset emails are **not sent**. (There is no email verification: new accounts work straight away.) Instead they are:

- printed in the terminal running the server, and
- listed at <http://localhost:3001/api/dev/outbox>.

Copy the link from either place into your browser. To send real emails, see [Configuration](#5-configuration-env).

---

## 2. Trying it with several users

**Same computer:** open a second browser profile or an InPrivate/Incognito window (each window keeps its own login), then log in as a different user. Messages, typing indicators, reactions, presence and calls all sync between the windows instantly.

**Voice and video on one PC:** both windows will use the same microphone and camera, so you'll hear echo. Use headphones, or mute one of the windows.

**Other devices on your network (phone, laptop):** browsers only allow microphone and camera on `https://` addresses (or on `localhost`). Start the HTTPS dev mode:

```powershell
npm run dev:https
```

Then open `https://<your-PC-IP>:5173` on the other device. Find your PC's IP with `ipconfig`; it's the "IPv4 Address", e.g. `192.168.1.23`. The certificate is self-signed, so tap **Advanced → Proceed** once. If the page won't load, allow Node.js through Windows Defender Firewall (Windows usually asks the first time it runs).

---

## 3. Feature tour

### Accounts and security
- Sign up with email, username, display name and date of birth (you must be 13 or older), and log in by email **or** username.
- No email verification: sign up and start chatting. Email is only used for password resets.
- Password recovery by email link (valid for 1 hour). Resetting signs you out on every device. If no email is set up, the site admin can make the same kind of link in the Admin Panel and send it to the person (see below).
- **Two-factor authentication** with any authenticator app (TOTP), plus 10 single-use backup codes.
- **Switch accounts:** click your name at the bottom left → **Switch Account** lists the other accounts signed in on this device, and **Add Account** signs in to one more (up to 5), keeping the one you are in signed in. Switching restarts the page as that account, so nothing of the other one is left on screen; if you have several tabs open they follow. An account is only remembered when you add it, on this device only (its sign-in is kept in the same place as your current one, nothing is sent anywhere). *Log out* forgets the account you log out of, the **×** next to another account logs it out and removes it, and an account whose sign-in stops working (password change, "log out all devices") is dropped by itself. After logging out, the login page offers "Continue as…" for the others.
- A session list under **Devices**: see where you're signed in, sign out a single device, or sign out all of them.
- Change your username, email or password (current password required), or delete your account.
- Passwords are hashed with scrypt, session tokens are random and stored hashed, and every endpoint validates its input. Rate limits cover sign-ups, logins, messages, uploads, invites and searches.

### Profiles and presence
- Avatar, profile banner, banner colour, display name, pronouns and an "About Me" that supports markdown. The editor shows a live preview.
- Status: Online, Idle (set automatically after 10 minutes without activity), Do Not Disturb (no notifications or sounds) and Invisible.
- Custom status with an emoji and an expiry time.
- A profile popout opens when you click any user: roles, member-since dates, a private note, and a quick "Message @user" box.
- The full profile view adds mutual servers and mutual friends. A mobile indicator shows who is on a phone.

### Servers (communities)
- Create a server from a template (Gaming, Friends, Study, Community or blank), with an icon, banner and description.
- **Your own server templates:** **Server Settings → Server Template** turns a server's set-up into a link (`/template/<code>`). Whoever opens it sees what is inside (roles, channels under their categories) and, signed in, gets a new server of their own with the same roles, permissions, channels, categories, topics, slowmode, forum tags, verification level and AutoMod rules. **Never copied:** messages, members, emoji, bots, webhooks, invites, permission overrides for single people, the server's name and picture. A server has one template; it is a snapshot, so later changes show a yellow **Out of sync** notice with a **Sync Template** button. The page also shows who shared it and how often it was used. **Create Server → Use a Template** takes a pasted link too. Anyone with the link can look at it, so treat it like an invite; **Delete** makes the link stop working (servers already made from it are not affected).
- Join with an invite link or code, or browse **Discover** for public servers.
- **Invites:** set an expiry and a use limit, see every invite with its use count, revoke any of them, and send an invite to a friend in one click. Add a **Joined from** label (YouTube, TikTok, *Heard from a friend*…) to see where new people came from.
- **Text and voice channels and categories:** create, rename, add topics, move channels and categories around (see "Moving channels and categories" below), collapse categories, use slowmode, mark channels age-restricted, and set a user limit and bitrate on voice channels.
- **Editing categories:** hover a category (it is always visible on a phone) and use the gear button to open its settings, or the **+** to add a channel to it. Right-click it (long-press on a phone) for *Rename Category*, *Move Up*, *Move Down*, *Edit Category*, *Delete Category* and more. Right-click or long-press a channel and pick *Move to Category* to move it without dragging. Deleting a category keeps its channels; they just become uncategorised.
- **Moving channels and categories:** on a computer, press on a category or channel and drag it (a line shows where it will land; drop on a category name to put a channel at the top of it; Esc cancels). On a phone, open the server menu (tap the server name) and choose **Reorder Channels**: every row gets a handle, drag by the handle, then press **Done**. Dragging a category folds them all up so the whole order fits on screen, and the list scrolls by itself near its edges. Move Up / Move Down in the right-click or long-press menu do the same one step at a time. Voice channels always list after text channels in a category, so a channel can only be placed among its own kind.
- **Roles:** name, colour, "display separately" (hoist), mentionable, and 30 permission flags grouped like Discord's. You can reorder roles by dragging them by their handle in *Server Settings → Roles* (or with the arrow buttons; unless you own the server, roles at or above your own highest role are locked), manage who has each role, and set default @everyone permissions. The role hierarchy is enforced: you can't manage roles at or above your own.
- **Channel permission overrides:** per role or per member, with allow, neutral or deny for each permission. Private channels and categories, plus "Sync with category".
- Transfer server ownership, delete the server, leave the server, set a per-server nickname, and drag server icons to reorder them.
- Custom server emoji (static and animated). You can use them in messages and reactions, including across servers.
- **Forum channels:** make a channel of type *Forum* for questions, ideas and bug reports, anything better as separate conversations than as one long stream. Someone starts a **post** with a title (up to 100 characters), up to 5 tags and a first message (files allowed). Each post is its own thread and opens in the side panel. The forum page shows the posts as cards (title, tags, a preview of the first message, who wrote it, how many replies, last activity) with a search box for titles, tag filters, and sorting by *Recent activity* or *Newest posts*; a dot marks a post with something new. The channel's settings hold its **tags** (up to 20, each with an optional emoji), *Require a tag on every post*, and the default sort. Starting a post needs **Create Threads** (plus **Send Messages in Threads** for the first message). The person who started a post can rename it, change its tags and close it; people who can manage threads can do the same on any post, and can also lock it. AutoMod reads post titles and thread names like any other message. **Pinned posts:** people who can manage threads can **Pin Post** from a post's menu (or its panel); up to 3 open posts stay at the top of the forum, marked with a pin, newest pin first. A post that is closed comes off the top by itself, and pinning or unpinning goes in the audit log.
- **Server insights:** **Server Settings → Insights** (for the owner and anyone who can manage the server) shows how the server is doing over the last 7, 30 or 90 days, compared with the period before: messages per day, people joining and leaving, a weekday-and-hour map of when people write, the busiest channels, the most active people, and how many new people spoke up. Every chart has a table view. It shows numbers only, never message text, leaves bots out, and counts days in your own time zone. Two honest limits: leaves are only known from the day this feature arrived (earlier joins are counted from who is still a member), and a report is kept for 5 minutes (press **Refresh** for a new one; on a very large server it takes about a second to work out).
- **Bots and slash commands:** **Server Settings → Integrations → Bots → Add Bot** gives a bot its own member, role and token. One bot can be in **many servers** at once (each gives it its own role), and its maker decides who may add it: private, anyone with its link, or **listed in the App Directory** (**Discover → Apps**, with search, sorting and an **Add to Server** that shows exactly which permissions the bot will get first, with a warning for Administrator). **Remove** takes a bot out of one server and leaves the app, token and other servers alone. A small program you run anywhere uses that token to answer slash commands (typing `/` in a channel lists them), post messages and rich cards, and read what is said. `docs/BOTS.md` explains it step by step and `examples/example-bot` is a short starting point. Bots you run yourself and wrote with a Discord library (`discord.js`, `discord.py`…) can connect to NullChat by changing their web address and token (`docs/DISCORD_BOTS.md`, including what isn't supported). Bots that Discord-hosted companies run (MEE6, Dyno and so on) can't join, because they only talk to Discord's servers.
- **Buttons, menus and forms from bots:** a bot's message can carry rows of **buttons** (five looks, link buttons, emoji) **select menus** (pick one, or several with a Send button) and **pickers** for the server's own people, roles, people-or-roles and channels (with a search box, defaults, and only what the person can see; the bot gets the ids plus who and what they are). Pressing one tells the bot, which can change the message, answer with a new one, or open a **form** (up to 5 text boxes) in a window; the window says which bot receives the answers. The bot must be online and has 5 seconds to answer. Works for NullChat bots (`docs/BOTS.md`) and for `discord.js` / `discord.py` bots through the Discord-style layer. Limit: buttons can't go in a private (ephemeral) reply.
- **Webhooks:** **Server Settings → Integrations → Webhooks → Create Webhook** gives one channel an address that any tool able to send a web request can post to: a CI job, a monitoring alert, a script, a form. No bot is needed. A message can use its own name and picture, embeds and link buttons, and shows a **WEBHOOK** tag. Discord-style senders work by changing the address (`/api/v10/webhooks/…`). **Copy Address** and **Reset Address** are on the card; 25 webhooks per server and 20 messages per 10 seconds each. The address is stored as it is (so you can copy it again), which makes it as private as the rest of the server's data. See `docs/BOTS.md`.
- **Developer Portal:** **User Settings → Developer Portal** (shown when you have Manage Server somewhere) lists the bots and webhooks of every server you manage. An app card shows online or offline, where it is, who may add it, the end of its token and its slash commands (with a bin button to delete one); **Details** adds a live list of what the bot is being asked to do (commands, buttons, menus and forms, newest first, with how fast it answered or that it didn't, or that the bot was offline), which is the quickest way to see why a bot isn't responding. The list keeps the last 50 per bot, only in memory, and never shows what people typed. **New App** (it starts in no server, and **Add to Server** puts it in any server you manage), **Edit** (including who may add it), **Reset Token**, **Copy Link** and **Delete App** are there too, webhooks have **Send Test Message**, and a **Build** tab has the addresses and a first `curl`. See `docs/BOTS.md`.
- **Joined from:** add a label to any invite link so you can see where people came from. Open **Invite People** and pick **Joined from**: social media (YouTube, TikTok, Instagram, X, Facebook, Reddit, Twitch, Snapchat, Threads, Bluesky, LinkedIn, Pinterest), chat apps (Discord, WhatsApp, Telegram, text message), people (*Heard from a friend*, family, school or work, in person or at an event) and elsewhere (a website or blog, a search engine, an email, a podcast, an ad, other), or type a label of your own (up to 24 letters, numbers or hyphens; capitals, spaces and symbols are cleaned up for you). The link then ends in it, like `yoursite/invite/pixelclub/youtube`, and you can also add a label by hand to any link. It works for the server's own link and for one-off links, a person who is logged out keeps the label through logging in or registering, pasting a labelled link into **Join a Server** works, and the desktop app's `nullchat://invite/CODE/LABEL` link carries it too. **Server Settings → Invites → Where people joined from** (for anyone who can manage the server) shows how many people joined through each label over the last 7, 30 or 90 days or the last year, most first (up to 40 labels, with the rest rolled into *Other labels*). People who join from **Server Discovery** are counted under *Server Discovery*. The honest limits: only **counts** are kept, never who joined through which label (so you can't look a person up by it, and removing someone doesn't change a count); a link without a label, and everyone who joined before this feature existed, is counted under *No label*; the owner's own start of the server is left out; the joins are kept for a little over a year, so *Last year* may be slightly short; and the label is a bookkeeping note, not a secret, because anyone can edit a link by hand (it never stops anyone joining and never changes who can).
- **Invite cards:** paste an invite link into a chat and it turns into a card under the message: the server's picture (blurred behind it as the banner, or its own banner if it has one), its name, how many people are **online** and how many are **members**, when it was made (*Est. Nov 2026*), and a button. Members of that server get **Go to Server**, everyone else gets **Join** (it adds them and opens the server), a server that has paused new members says so instead, and a revoked, expired or used-up link shows **Invite invalid**. Up to three cards per message. Links in `code`, a code block or wrapped in `<angle brackets>` stay plain, and turning off **Settings → Chat → Show embeds and preview website links** turns the cards off too.
- **Invite links preview in other apps:** the invite page (`/invite/CODE`) carries preview tags, so pasting a link into another chat app or social site shows *Join Pixel Club on NullChat*, the server's picture and *12 online · 22 members*. Whoever opens an invite link could already see the same details on the invite page; nothing else about the server or its members is in it. A dead invite gets the normal page with no preview. Whether another app shows the preview is up to that app (some only fetch links they have seen before).
- **Your own invite link:** **Server Settings → Invites → Your own invite link** (for anyone who can manage the server) gives the server a short name such as `yoursite/invite/pixelclub`: 3 to 32 letters, numbers or hyphens, no two servers can share one, and names that look like part of the site or like staff (`admin`, `support`, `mod`, `nullchat`…) are kept back. It never expires and has no use limit, it works whatever the capitals, and it is what the **Invite People** window shows first (with *Make a one-off link instead* for a normal expiring one). Taking the name away, or revoking it in the invites list, frees it again.
- **A different name and picture in each server:** open the server menu (the server's name) → *Edit Server Profile*, or right-click yourself → *Change Nickname*, to set a **nickname and a picture** that only show in that server, in chat, the member list, voice and profile cards. Your main profile stays the same everywhere else. It needs the *Change Nickname* permission, and people with *Manage Nicknames* (and a higher role) can take someone's server picture away (*Remove their server picture* in the nickname window; it is written to the audit log). A server picture goes when you leave the server. Pictures are PNG, JPEG, GIF or WebP up to 8 MB.
- **Server folders:** group servers in the bar on the left. Right-click (long-press on a phone) a server and choose *Add to Folder → New Folder…*, or on a computer drag one server onto another. A folder has a name and one of 8 colours, shows up to four of its servers' icons while closed, opens with a click to list its servers, and carries one badge with the unread and mention counts of everything inside. Right-click a folder for *Folder Settings* and *Ungroup Servers*; drag servers in and out, or to a new place in the bar. A folder needs two servers (when one is left it dissolves), you can have up to 50 folders, and the layout is saved with your account so it follows you to every device.
- **Announcement channels:** make a channel of type **Announcement** (📣). People who can send messages write posts as in any text channel, then press **Publish** under a post (or use *Publish* in its menu): a copy goes into every channel that follows it (always in another server), marked with the server it came from. Someone who manages channels in another server follows an announcement channel with the megaphone button in its header (*Follow in Another Server*), picking one of their text channels. **Channel Settings → Overview** of both channels lists who follows and what is followed, and either side can stop it. Honest limits: nothing is sent until someone presses Publish (and each post publishes once); a copy is a plain message, so editing or deleting the original does not change copies; nobody is pinged by a copy (`@everyone`, role and user mentions turn into plain text); an announcement channel has at most 50 followers, a channel can receive from at most 10, and a channel publishes at most 10 posts an hour. An existing text channel can be turned into an announcement channel (and back) with a switch in its settings.

### Messaging
- Real-time messages over WebSocket, sent optimistically with automatic retry and reconnect.
- Edit (press ↑ in an empty box to edit your last message), delete (hold Shift to skip the confirmation), and reply with an optional ping (@ON/OFF).
- Reactions with unicode or custom emoji, a frequently-used list and a full emoji picker with search.
- **Your own GIFs:** the GIF button opens the GIFs people on your server have uploaded. Anyone can upload a GIF (up to 5 MB; GIF or animated WebP) with a name and tags, and everyone can search and send them, with no outside service or key. *Mine* lists your uploads, where you can edit or remove them (the person who runs the server can remove any). Each person can keep 300 GIFs and upload 20 an hour. A sent GIF shows up in chat instantly; the most used ones come first. Removing a GIF that is already in chat hides it from the picker but keeps the file, so old messages still show it. If you also add a free `GIPHY_API_KEY` (see `.env`), a GIPHY tab appears too.
- **Stickers:** a server's own pictures that members send as a message. Someone who can *Manage Emojis and Stickers* adds them in **Server Settings → Stickers** (PNG, GIF or WebP up to 512 KB, a name of 2 to 30 characters and an optional related word; up to 50 per server) and renames or deletes them there. Members pick one from the **Stickers** tab next to the emoji button (search works on the name and the related word) and it is sent at once as its own message, with a reply if one was started. The picker lists the current server's stickers first, then those of your other servers; in a server that is only when you may *Use External Emojis and Stickers*, and you can only send a sticker from a server you are in. A sticker can't be sent with a poll or forwarded, and a message whose sticker was later deleted says so. They are in the data download and the audit log.
- **Favorite GIFs:** every GIF in the picker has a star (on a phone it is always showing; on a computer it appears when you point at the GIF). Starred GIFs are collected under **Favorites**, the first tab, which is also where the picker opens once you have any. Search inside Favorites works on names, tags and GIPHY titles, and the Favorites tab offers to search everything when nothing matches. Un-starring from the Favorites tab shows an Undo. **A GIF someone sent in chat can be starred too:** point at it and click the star in its corner (on a phone the star is always showing), or choose *Add GIF to Favorites* in the message's right-click menu. A GIF you already keep shows a gold star, and the star changes at once in the picker and on your other devices. This works for GIFs uploaded to your server and for GIPHY ones; a GIF sent as a file attachment, or a picture from some other website, has no star. Favorites are private, follow your account to every device, and can hold up to 200. They work for GIFs from your server and from GIPHY (a GIPHY favorite keeps only GIPHY's own link, never a copy of the picture). If the person who uploaded a GIF removes it, it leaves everyone's favorites. Deleting your account deletes your favorites, and *Download my data* lists them.
- **File uploads** by button, drag-and-drop or paste: up to 10 files per message, upload progress, spoiler marking, and inline images, video and audio. Other files show as a download card.
- **Close friends:** on the Friends page every friend has a star. Starred friends sort to the top of the Online and All lists and carry a small gold star (also in a friend's right-click menu: **Close Friend**). With **Settings → Notifications → Let close friends through Do Not Disturb** turned on, a direct message or a mention from a close friend still notifies you while you are on Do Not Disturb (in the open app and on phones); everyone else stays silent. The list is private (the other person is never told), follows your account, holds up to 50 people, and someone you remove as a friend stops counting.
- **Warnings:** a moderator (the *Timeout Members* permission) right-clicks a member → **Warn**, and writes what it is for. The member gets a window with the server and the reason, at once or the next time they open NullChat, and closes it with **I understand**; the moderators see whether it was read. The member is never shown which moderator it was. **Server Settings → AutoMod → Warnings** can time a member out automatically when they reach a number of warnings (2 to 10) within 30 days, for 10 minutes up to a week. Every warning is in the Audit Log; the moderator who gave one, or someone who manages the server, can remove it. The history is kept if the member leaves and comes back. *Download my data* lists the warnings you received.
- **Timeouts of any length:** wherever a timeout length is chosen (**Timeout** on a member, the automatic timeout after warnings, and AutoMod's mention-spam timeout) there is a **Custom** choice next to the ready-made ones: type a number and pick minutes, hours, days or weeks, up to 28 days.
- **Moderator notes:** right-click a member → **Warnings and Notes** to read and add notes about them that only this server's moderators (anyone who can time out, kick or ban, or manage the server) can see. The member never sees them. The Audit Log records that a note was written, not what it says. Up to 100 notes per member.
- **Saving files on phones:** **Download** on a picture, a GIF, a video or a file works on phones. On an iPhone or iPad it opens the share sheet (**Save Image** puts it in Photos, **Save to Files** keeps any file); on Android it downloads like any file. In the full-size picture viewer you can also press and hold the picture. A GIF from GIPHY is fetched and saved as a `.gif` instead of only opening in a new tab.
- **Image descriptions (alt text):** describe a picture or video so people who use a screen reader know what is in it. While attaching a file, press **ALT** on its preview and type up to 1000 characters. After sending, right-click the message and choose **Add Image Description** (or **Edit Image Description**); only the author can, it doesn't mark the message as edited, and everyone sees the change at once. A described picture carries a small **ALT** badge that shows the text under the picture, the full-size viewer shows it too, and screen readers read it as the picture's alt text. A forwarded copy keeps the description it had when it was forwarded, and *Download my data* includes it.
- **Server tags:** a short tag (2 to 4 letters or numbers) with a badge, which members choose to wear next to their name. Someone who manages the server sets it in **Server Settings → Overview → Server Tag**: the text (capitals and numbers only, so no look-alike letters; no two servers can share one, and a few like ADM, MOD and NULL are kept for the people who run the place), one of 8 colours, and a badge, either one of 12 built-in icons or **your own picture** (press **+**; it is cropped to a square and shrunk to 128 pixels, and the server takes at most 256 KB). Everyone in the server can then pick it in **User Settings → Profiles → Server Tag** (one server's tag at a time, or none), and it shows next to their name in chat, the member list and profiles, and on the profile preview. Clicking a tag opens a small card with the server's name, description and how many wear it, and an **Open Server** or **Join Server** button (the description and counts show only to members or when the server is in Discovery; a private server just says so). Changes show everywhere at once. A tag comes off by itself when someone leaves, is kicked or banned, or the server removes its tag or is deleted, so a tag always means the person is still in that server. Bots can't wear one. The site admin can take a server's tag away in **Admin Panel → Servers → Remove tag**. Limits: 10 tag changes per server per hour (saving without changes is free), 20 badge uploads per person per hour, 30 wear changes per hour; pictures nobody uses any more are deleted after an hour.
- **Markdown:** bold, italic, underline, strikethrough, spoilers, inline code, code blocks with a copy button, quotes, headings, lists, masked links and `<t:…>` timestamps.
- Mentions: `@user`, `@role`, `@everyone`/`@here` (permission-checked) and `#channel`, with autocomplete. Messages that mention you are highlighted.
- **Mention chips:** in the message box (and when you edit a message) a mention shows as a highlighted chip: a person, a role (in the role's colour), `@everyone` / `@here` and a `#channel`. A chip is only drawn for a mention that will really ping when you send it (a name nobody has, or `@everyone` when you may not use it, stays plain text), and it acts as one character: **Backspace** or **Delete** next to it removes all of it (and **Ctrl+Z** brings it back), the **arrow keys** jump over it, **Shift+arrow**, a double-click or dragging across it selects all of it, and a click inside it puts the cursor at its nearer edge. A letter typed right against a chip gets a space put between, so it can't spoil the mention. It is still plain text underneath, so typing, emoji, spell check and phone keyboards work as before. Honest limit: the chip shows the name as it is typed (`@bob`, the person's username), not their display name, and a mention you type out by hand (`@bob`) becomes a chip as soon as it is complete, the same as one picked from the list.
- Slash commands: `/shrug`, `/tableflip`, `/unflip`, `/lenny`, `/me`, `/spoiler`, `/silent`, `/nick`, `/thread`, `/poll`, `/schedule`.
- **Polls:** press the **+** next to the message box → **Create Poll** (or type `/poll Lunch? | Pizza | Tacos`, or just `/poll` for the form). 2 to 10 options, single or multiple choice, optional end time (1 hour to 1 week). Votes update live for everyone, people can change or withdraw their vote, and the author (or anyone who can manage messages) can end a poll early. Results stay visible after it ends.
- **Save for later and reminders:** right-click a message (or use its ⋯ menu) → **Save for Later**, and optionally **Remind Me** (in 20 minutes, 1 hour, 3 hours, tomorrow 9 AM, next Monday 9 AM, or a time you pick). Saved messages are private to you, show a small bookmark, sync across your devices, and are listed under **Inbox → Saved** (on a phone: **Saved** in the Home sidebar). When a reminder is due you get a clickable notification (plus a desktop notification if the app is in the background); if you're offline it waits until you're back. You can save up to 200 messages.
- **Reminder buttons:** the reminder notification has **Open** and **Snooze 10 min**.
- **Who voted:** click "N people voted" under a poll to see exactly who picked what (it updates live).
- **Send later:** type a message, then press the **clock** button next to Send (or start it with `/schedule Your message`). Pick *In 1 hour*, *This evening*, *Tomorrow at 9:00 AM*, *Monday at 9:00 AM*, or any time up to 30 days ahead. Nothing is posted until then and only you can see it. A small "N scheduled" note under the message box (and the **Scheduled** tab in the Inbox) lists what is waiting: **Send now**, **Change time**, **Edit** or cancel each one. Scheduled messages are checked exactly like normal ones when they go out (permissions, slowmode, blocks, AutoMod); if one can't be sent you get a notification with the reason and a **Try again** button. You can have 25 waiting at once. Text only (attachments can't be scheduled). If the server was off at the time, they go out as soon as it is back.
- **Forward a message:** right-click a message (or use its ⋯ menu) → **Forward**, pick up to 5 people, group chats or channels you can talk in (search by name), add a comment if you like, and send. The copy shows who wrote the original and when, keeps the text, link previews and files, and leaves the original alone: if it is later edited or deleted, your forward stays as it was (files are copied, so they stay too). You can only forward what you can read, a poll or a system notice can't be forwarded, and a channel that doesn't allow files won't take a message that has some. Words inside a forwarded message never ping anyone, and the server's AutoMod still checks them. Forwarding a forward credits the person who wrote the first one.
- **Report a message:** right-click someone else's message → **Report Message**, choose a reason (spam, harassment, hate, sexual content, violence, self-harm, or something else with a few words) and add details if you want. In a server it goes to that server's moderators (everyone who can manage messages there) and to the site admin and mods, who see every report on this NullChat; a direct message, or a message written by the server's owner, goes to the site admin and mods only, because nobody else could act on it. The dialog tells the person reporting who will see it before they send it. The person who is reported is never told and never sees reports about themselves. You can report a message once, and up to 10 an hour.
- **Inbox on phones:** the **Inbox** tab in the bottom bar (Mentions, Unreads, Saved, Scheduled) carries a badge for unread mentions.
- **App icon badge:** when NullChat is installed as an app (Chrome/Edge, Android, Safari 17+ on Mac), the unread mention count shows on its icon. It follows the same setting as the tab-title count (Settings → Notifications).
- **Threads:** start one from a message or on its own; archive and lock them; they open in a side panel.
- **Pinned messages** (up to 50 per channel), **search** with filters (`from:` `mentions:` `has:link|image|file|video|embed` `in:` `before:` `after:` `pinned:`), and an **Inbox** of mentions and unread channels.
- **Rich link previews:** page title, description and image, a YouTube player and image links. Fetching can only reach the public internet: the connection is opened to the exact address that was checked (so a DNS trick that answers differently the second time cannot point it at the server's own network), every redirect is checked the same way, private, internal and cloud-metadata addresses (including Fly's private network) are refused, pages are cut off at 512 KB and 6 seconds, and only a few previews are fetched at once.
- Typing indicators, unread markers with a "new messages" divider, a jump-to-present button (or press **Esc**), mention badges, Mark as Read and Mark Unread. **Mark Unread** (right-click a message) counts the channel as read up to the message before it, brings back the mentions from there on, and keeps the channel unread, with the new-messages line at that message, while you are looking at it, until you read it (**Esc**, or opening it again later); your other devices follow at once.
- Emoticon conversion (`:)` → 🙂) and `:shortcode:` emoji.

### Friends and direct messages
- Friend requests by username or from user search. Tabs for Online, All, Pending and Blocked, plus an **Active Now** column.
- Blocking: blocked users can't message you or send friend requests, and their messages are collapsed.
- Direct messages and **group DMs** for up to 10 people. Rename a group, change its icon, add people, remove people (owner only) or leave.
- Privacy controls for who can DM you and who can send you friend requests.

### Voice and video
- **Voice channels:** click to join, see who is in each channel in the sidebar, and see a green ring around whoever is speaking.
- **Stage channels:** a channel for a few people speaking to many listening, like a talk or a Q&A. Press **Join the stage**: moderators (anyone who can mute members) join as speakers, everyone else joins the **audience** as a listener, and a listener's microphone is never asked for. A listener presses **Raise hand**; a moderator sees the hands at the top of the audience and presses **Invite to speak** (or *Move to Audience* on a speaker's menu), and the speaker presses **Step down** to go back. Speakers start muted and unmute themselves when ready. **End stage** disconnects everyone. A stage holds up to 10 speakers and, by default, 50 people in all (the channel's *User limit* sets it). Honest limit: like all calls here it is direct audio between browsers, with no media server in between, so each speaker's computer sends audio to each listener: it is for talks of about 50 people or fewer, not for hundreds. Stage audio goes out at 32 kbps, and listeners cannot share a camera or screen.
- **Private calls** in DMs and group DMs, with ringing, an incoming-call prompt (accept/decline), "Ring again" and a call timer.
- **Camera and screen sharing** (with system audio where the browser supports it). Video tiles sit in a grid; click a tile to focus it and use the full-screen button. Shared screens show a LIVE badge.
- Mute and deafen yourself, and choose Voice Activity or Push-to-Talk (with a configurable key and release delay). Sensitivity is automatic or manual, with a live level meter.
- Per-user volume and local mute (right-click a user in voice).
- Moderators can server-mute, server-deafen, move or disconnect members.
- A connection indicator shows quality and ping, and calls reconnect automatically. Point at it to see what is really being sent right now: ping, voice bitrate, video size, frame rate and bitrate, and any packet loss.
- **Sound and picture quality:** voice goes out at **64 kbps** by default (the browser's own default is 32), with the highest network priority, so a screen share or camera can never make it crackle. The voice gate (Voice Activity mode) looks ahead by 50 milliseconds so the first syllable of a sentence is not cut off. Camera video starts at full size straight away (it used to start at 320×180 and take 20 to 30 seconds to climb to 720p). **Settings → Voice & Video** has *Voice Quality* (Standard 32 kbps, High 64 kbps, Studio 96 kbps) and *Camera Quality* (Data saver 480p, Standard 720p, High 1080p); both change right away, even in a call.
- **Sharing your upload between viewers:** in a call everyone sends to everyone, so what you upload is shared out. Your camera sends at most 2.5 Mbps (720p) to each person and 5 Mbps in total; a screen share at most 8 Mbps to each and about 16 Mbps in total. So with more people each one gets a smaller share, and a call stays smooth instead of stuttering. The shares grow back when people leave. A mesh still works best for about 2–8 people per channel.
- **Check my connection** (Settings → Voice & Video → Connection): in about five seconds it says whether calls can work from the device and network you are on, in plain words: whether your public address was found (direct calls), and whether the relay server works. **Copy details** gives something to paste when asking for help (it never includes the relay password). Use it on a phone on mobile data, or on school or work Wi-Fi, before a call night.
- A deploy during a call drops it for a moment: both people rejoin by themselves and the sound comes back (tested with real browsers), and anyone who opens the app meanwhile sees them in the channel.
- **Big calls (optional):** connect a LiveKit server with three settings and server voice channels stop being peer-to-peer, so calls of dozens of people and a screen share watched by many work (DMs and stages stay as they were). Off by default; see [docs/BIG_CALLS.md](docs/BIG_CALLS.md) for the steps, what it costs, and what has and has not been tested.
- **Android and iPhone apps (optional):** the `mobile/` folder turns NullChat into a real phone app (Android file, or iPhone through TestFlight) that GitHub builds for you with no Android Studio, Xcode or Mac, and that can get notifications through Google's and Apple's own services. Read [docs/PHONE_APPS.md](docs/PHONE_APPS.md) before starting: it lists what was tested, what could not be (no one has built or run these on a real phone yet), and what the apps can't do (screen sharing from the phone, staying in a call with the app in the background).
- Without it, media goes **peer-to-peer over WebRTC** (encrypted with DTLS-SRTP). The server only relays signaling and never records anything.

### Moderation
- Kick, ban (optionally deleting the user's last hour to 7 days of messages), unban, and time out a member (60 seconds to 1 week). Timed-out members can read but can't chat, react or speak.
- **AutoMod:** blocked words with `*` wildcards, invite-link and link blocking, a mention-spam limit (optionally with an automatic timeout), a duplicate-spam filter, and exempt roles.
- **Verification levels:** none, account older than 5 minutes, or member for longer than 10 minutes.
- **Raid protection:** **Server Settings → Safety Setup → New members.** *Pause new members* stops anyone new joining with an invite until you turn it off. *Raid guard* does it for you: when a number of people you choose (3 to 100, 10 by default) join within a minute, new joins are refused for 10 minutes and everyone who manages the server is told straight away. People already in the server are never affected, and the Nullspace lounge is exempt. It only closes the door; it does not remove anyone who got in before it fired (use kick or ban for those).
- **Remove many members at once:** **Server Settings → Members → Remove members…** (for anyone who can kick or ban). Filter the list by when they joined (last 24 hours, 7 or 30 days), by who has not written for 30 or 90 days or ever, by having no roles, or by name; tick people (*Select all* takes up to 200), choose *Kick* or *Ban* (a ban can also delete their recent messages), add a reason, and confirm. The owner, you, bots and anyone with a higher role than yours are never ticked and are skipped on the server too; the result lists who was removed and who was skipped, each is written to the audit log with the reason, and you can remove at most 200 at a time and 6 batches per 10 minutes. "Has not written" counts messages in channels only, not voice, and leaves out people who joined more recently than that.
- **Audit log:** every settings change, role change and moderation action, with filters by user and action, and an expandable details view.
- **Reports:** **Server Settings → Reports** (for anyone who can manage messages; the server menu shows Server Settings for them too) lists what members reported, with the reason, what the reporter wrote, who wrote the message, and **a copy of the message as it was when it was reported**, so it still makes sense after it is edited or deleted. You can jump to the message, delete it, then **Resolve** or **Dismiss** the report with an optional note (both go in the audit log), and reopen one later. A badge on the nav item and a notice (and a push notification if you turned them on, which never contains the message) tell you when a new one arrives. Handled reports are kept for 90 days, then removed. If a server is deleted its reports go with it. Moderators never see reports about themselves, and reports about the server's owner go to the site admin and mods instead. The site admin and mods can handle a server's reports too; whoever handles one handles it for everybody (a server moderator's action goes in the server's audit log, a site admin's or mod's in the Activity log).
- **Appeals:** a suspended person no longer hits a dead end at login. After entering the right password they see the reason and a short form (10 to 1000 characters) to say why they think it was a mistake. There is one open appeal per suspension, and after a "no" they wait a week before sending another. Staff decide under **Admin Panel → Appeals** or **Mod Panel → Appeals** (a badge counts the ones waiting): **Approve** restores the account (it is written to the log like any restore), and **Deny** needs a short note (up to 300 characters) that the person reads on the same screen. Moderators decide appeals from ordinary accounts; an appeal from a moderator's own suspended account goes to the admins. If email is set up, the person is emailed the answer too.
- Rate limits on the server act as anti-spam for everyone.

### Site admin panel (run the whole installation)
Server moderators only control their own server. The **site admin** controls the whole NullChat: open **User Settings → Admin Panel** (it only appears for admins).
- **Overview:** accounts, moderators, Dev Jrs, who is online, new sign-ins today, servers, channels, messages, upload and database size.
- **Users:** search every account by name, username or email. Open one to see its email, join date, last activity, servers and recent sign-ins (IP and device).
  - **Suspend** logs the person out everywhere, drops them from voice and blocks login, showing them your reason. Fully reversible with **Restore**.
  - **Reset password…** makes a one-time link (valid for an hour) for someone who is locked out, which matters when no email server is set up. You copy it and send it to them yourself; they open it, choose a new password, and are signed out everywhere. Two-factor still applies. Making a new link cancels the old one, and the Activity log records that you made it (never the link). You can't do this for yourself or another admin.
  - **Make mod / Remove mod** gives or takes back the **Mod Panel** (see *Moderators* below). The **Mods only** filter lists your mods.
  - **Make Dev Jr / Remove Dev Jr** gives or takes back the **Dev Jr Panel**, a step above a mod (see *Dev Jr* below). The **Dev Jr only** filter lists them.
  - **Delete account** is permanent. You must type their username. If they own servers you have to tick "also delete their servers". Their old messages stay and show as "Deleted User".
- **Servers:** every server with its owner, member and channel counts. **Delete** removes a server and all its files after you type its name.
- **Site:** **close or open sign-ups** with a switch (no redeploy; it overrides `REGISTRATION_OPEN` until you press "Use the server setting"), and post an **announcement**: a bar at the top of NullChat for everyone, live immediately, in *Notice*, *Warning* or *Urgent* style (for example "Maintenance tonight at 10 PM"). People can close it, and posting a new one shows it again. It also appears on the login page.
- **The lounge (Nullspace):** a server called **Nullspace** that every new account is added to, so people have somewhere to meet. It is made automatically the first time the site starts (owned by the admin) with a read-only `#welcome`, `#introductions`, `#general`, `#off-topic` and a voice room, and people land in its `#general` right after signing up. A switch in the **Site** tab turns the auto-join off (nothing else changes). Accounts that existed before are not added; send them an invite like to any server. If the owner deletes it, it stays deleted until you press **Create it again** there.
- **Apps:** every app (bot) that its maker has listed in the App Directory or shared by link, with its maker and how many servers it is in. **Hide** takes one out of the directory and stops anyone else adding it (servers that already have it keep it; **Show** puts it back); **Delete** removes it from every server. Private apps are not shown here. All three are written to the Activity log.
- **Backups:** make a backup of the database right now, see the automatic ones, and download any of them (you re-enter your password first). A backup holds every account, server and private message, so treat the file like a key to the whole site. Uploaded files are not inside; Fly's daily disk snapshots cover those. See *Restoring a backup* in `SETUP-FLY.md`.
- **Reports:** every report on this NullChat: a message someone reported in any server (that server's moderators see it too), a direct message, or something a server's owner wrote. The admin sees only the reported message (a copy from when it was reported), never the rest of a conversation, and can resolve or dismiss it with a note (written to the Activity log). The dialog tells the person reporting a private message that this is what happens before they send it. The tab and the **Admin Panel** entry carry a badge while some are open.
- **Activity:** a log of everything admins did, and everything mods and Dev Jrs did (marked **Mod** or **Dev Jr**).
- Admins can't act on themselves or on other admins, and the panel never shows anyone's messages, except a message someone has reported to them (above).

#### Moderators (mods)
A **mod** is a level below the admin, for people you trust to help look after the whole NullChat (not just one server). In **Admin Panel → Users**, open someone and press **Make mod**; **Remove mod** takes it back. It takes effect at once, with no reload: the person gets a note, a **Mod Panel** appears in their settings, and a small **Mod** tag shows on their profile card. Only an admin can make or remove mods, and a mod can never be made an admin from inside the app.

A mod's **Mod Panel** has:
- **Overview:** reports waiting, suspended accounts, accounts, new today, who is online.
- **Reports:** the same list the admin sees (messages reported in any server, direct messages, and things a server's owner wrote) with **Resolve / Dismiss** and a note. A mod sees the reported message only, never the rest of a conversation. Reports about an **admin or another mod** go to admins only: a mod never judges them, and never sees reports about themselves.
- **Users:** find accounts **by name** (not by email), see when they joined, last activity, message and server counts and how many reports there are about them, and **Suspend** or **Restore** them. A mod has to give a **reason** (the person sees it when they try to log in, and admins read it in the log), and can suspend up to 20 accounts an hour (the admin has no limit).
- **Activity:** what mods did, with their names. Admins see the same actions in the Admin Panel's Activity tab, marked **Mod**.

A mod **cannot**: see anyone's email or sign-in addresses, make password reset links, delete accounts or servers, make backups, change site settings or announcements, make or remove mods, or act on an admin, a Dev Jr or another mod. Those stay with the admin (or, for mods, a Dev Jr).

#### Dev Jr (a junior admin)
A **Dev Jr** sits between a mod and the admin: someone you trust with a few admin powers, but not the keys to the site. In **Admin Panel → Users**, open someone and press **Make Dev Jr** (you are asked first, and told what it allows); **Remove Dev Jr** takes it back and they become a normal member. It takes effect at once with no reload: they get a note, a **Dev Jr Panel** appears under **Staff** in their settings, and a **Dev Jr** tag shows on their profile card. Making a mod a Dev Jr replaces the mod level (one level at a time). Only an admin can hand it out or take it back.

The **Dev Jr Panel** is the Mod Panel (reports, appeals, users, activity) plus:
- **Emails:** each account's email is shown, and the Users search also finds people **by email**.
- **Password reset links:** **Reset password…** on an account makes a one-time link (valid for an hour) for someone who is locked out. The Dev Jr copies it and sends it to them privately; using it signs the person out everywhere, and two-factor still applies. It is recorded in the log (never the link itself), and a Dev Jr can make 20 an hour. **A reset link lets whoever holds it take over that account, so give Dev Jr only to someone you really trust.**
- **The site's numbers:** the Overview adds messages, servers, channels, uploads on disk, database size and the Node version.
- **Mods too:** a Dev Jr can suspend, restore and reset **mods** as well as ordinary accounts (up to 60 suspensions an hour), handle the reports and appeals about a mod, and sees what both mods and Dev Jrs did in **Activity** (marked **Dev Jr**).

A Dev Jr **cannot**: see anyone's sign-in addresses or devices, read messages (except one that was reported), delete accounts or servers, make backups, change site settings or announcements, hide or delete apps, hand out or remove mod or Dev Jr, or act on an admin or another Dev Jr. Reports and appeals about a Dev Jr go to admins only.

Who is an admin: the accounts listed in `ADMIN_USERS` (usernames or emails, comma separated). If you leave it empty, the **oldest account** (normally the first one you registered) is the admin. On Fly: `fly secrets set ADMIN_USERS=yourusername`.

### Settings
- **Download my data** (Privacy & Safety → Your data): after you re-enter your password you get one JSON file with your profile and settings, friends, the servers you're in, saved and scheduled messages, your favorite GIFs, the reports you sent (your reason and words only) and every message you've written (a forwarded message includes what it forwarded). It never contains your password, two-factor secret or login tokens, and not other people's messages (other than ones you saved or forwarded) or the uploaded files themselves. Limited to a few downloads an hour.
- **User settings:** My Account, Profiles, Privacy & Safety, Devices, Appearance, Accessibility, Voice & Video, Chat, Notifications, Keybinds, Language, Advanced, Help.
- **Appearance:** Dark, Light, Midnight or Sync with OS themes; a custom accent colour; cozy or compact message display; font scaling; spacing between message groups; zoom (50–200%; in a narrow window it is held to what still fits, and the page says so); and a 24-hour clock.
- **Custom CSS:** *Appearance → Custom CSS* is a code box for your own styles, free for everybody. They are added after NullChat's own, apply as you type, are saved with your account (so every device you use shows them) and only you see them. Change colours through the variables (`--accent`, `--bg-primary` and so on) or restyle anything with ordinary selectors; five examples are one click away. *Copy*, *Save as file*, *Load a file* and *Clear* are there too, and *Use my custom CSS* switches it off without losing what you wrote. Up to 20,000 characters. **Safety:** custom CSS cannot load anything from another website (no `@import`, no `url(https://…)`, no `image-set()`, and no tricks such as escaped letters or comments to hide one), because a pasted \"theme\" could otherwise tell its author when you open NullChat or leak what is on screen. Pictures and fonts inside the CSS itself (`data:` addresses), `#fragments` and files on this server are fine. Something that is refused shows why, is not applied and is not saved, so the last working CSS stays. **If a style breaks the app** (hides the settings, say): open NullChat with `?nocss` at the end of the address, or press `Ctrl+Alt+Shift+C` (also in the desktop app) to switch custom CSS off on this device; press it again to switch it back on. Your saved CSS is never touched by either.
- **Accessibility:** reduced motion, saturation, role colours, high contrast, a *Profile effects* switch (hides the animated layers on other people's profile cards), and a **Text Readability** section: *Display name styles* (switch it off and every name shows in the standard font and its normal colour, with no custom fonts, gradients, glow, outline or shimmer; a name's colour falls back to the person's role colour, or the usual name colour if role colours are off), always-underlined links, and a dyslexia-friendly font. It applies straight away, is saved with your account, and the name preview in your own profile editor keeps its style so you can still design your name.
- **Voice & Video:** input and output device selection, input and output volume, a mic test with playback, echo cancellation, noise suppression, automatic gain control, voice and camera quality, and a camera preview and selection.
- **Notifications:** desktop notifications, tab-title unread badge, and sounds with a per-sound on/off and preview. You can also set notifications per server and per channel (All, Mentions or Nothing, mute, suppress @everyone). **When NullChat is closed:** turn on *Notify me on this device* and your phone or browser shows a notification for direct messages, @mentions and replies even when NullChat isn't open, and for a saved-message reminder when it comes due (see *Notifications when the app is closed* under Phones). *Notify me for every message* also covers everything in servers you haven't muted, and *Show message text* can be turned off to only say "New message" on a lock screen. Phones are offered the switch with a one-tap bar at the top; the app icon shows an unread count and a chat's notifications stack as "(+2 more)" and clear when you read it.
- **Keybinds:** every shortcut can be rebound. Press `Ctrl+/` to see them all.
- **Languages:** English, Español, Français, Deutsch and Português (Brasil). Core UI strings are translated; other text falls back to English.
- Synced settings follow your account to every device. Device-specific settings, such as audio devices, stay on that device.

### Interface
- **The "void" design:** near-black floating panels with hairline borders, small monospace labels (`// TEXT CHANNELS`), a ∅ logo, and a single electric signal colour (acid lime by default) used like a terminal cursor: active channel bars, the focused message box, selected menu rows in inverse video. Themes: **Void** (default), **Black** (pure OLED black), **Bone** (light) and the free custom themes. The accent colour is changeable in *Settings → Appearance*.
- Layout: server rail, channel list with the account/voice cards at the bottom, a chat panel whose header shows `server / # channel`, and a member roster. The text is Inter, bundled in `client/public/fonts` (no calls to Google Fonts); the monospace labels use your system's monospace font.
- Where to change it: colours are the `--bg-*`, `--text-*` and `--accent` tokens at the top of `client/src/styles.css`; the shapes and layout are in `client/src/null-ui.css` (loaded after `styles.css`). The ∅ mark is `Logo` in `client/src/components/icons.jsx`.
- Responsive: desktop, laptop, tablet and phone. On phones it works the way Discord's app does: your servers and channels are their own screen (no menu button), tapping a channel slides the chat over it, and the back arrow or a swipe from the left goes back. There is a bottom bar with Home, Friends, Inbox and You, Settings open as a list of pages, the member list is an overlay (swipe left in a server chat), long-press opens context menus, and the composer gets a Send button.
- **Fast loading:** the app's files and big answers from the server are compressed (brotli or gzip, whatever the browser supports). The web app is about 885 KB of text; over the wire it is about 225 KB, which is most of the difference between a slow and a quick first load on a phone.
- **Phone gestures:** swipe a message to the **left** to reply to it (an arrow appears and lights up when you have pulled far enough; let go to reply). A left swipe that starts anywhere else in a server chat, like the header, opens the member list. Swipe right to go back.
- **Image viewer:** pinch (or scroll the wheel) to zoom, drag to move around a zoomed photo, double-tap or double-click to zoom in and out, and swipe a photo up or down to close it.
- **Stays in the message box (like Discord):** on a computer the cursor stays in the message box however you click around. Clicking messages, empty space or a button in the chat doesn't take it away; a letter typed or text/a picture pasted anywhere goes into the box; and it comes back when a menu, emoji picker, edit, search or settings screen closes. Dragging over text to copy it still works (the box waits until you let go), PageUp/PageDown scroll the chat from the box, and phones are left alone (so the keyboard doesn't pop up by itself). If push-to-talk is set to a plain key, the box doesn't grab the cursor (that key has to reach the page). Turn it off in Settings → Chat → "Keep the cursor in the message box".
- **Drafts:** half-written messages are kept per channel, and they survive reloads, app updates and the phone closing the app. They stay in your browser, one set per account, and are erased when you log out.
- Right-click context menus everywhere, a **quick switcher** (`Ctrl+K`), keyboard shortcuts, first-run onboarding, a reconnecting banner, toasts and skeleton loaders.
- Includes a web app manifest, so it can be pinned or installed as an app from your browser menu where supported.

---

### Free "Nitro" perks

Everything Discord locks behind Nitro is free here, for every account:

- **Custom app themes** (Settings > Appearance): 13 presets, your own background colour, an optional gradient across the sidebars, and shareable theme codes. Text colours are worked out automatically so every theme stays readable.
- **Profile themes** (Settings > Profiles): a two-colour gradient on your profile card and popout, with text colour chosen for contrast.
- **Animated avatars and GIF banners**: up to 10 MB (avatar) and 15 MB (banner).
- **Avatar decorations** (Settings > Profiles): 12 ready-made animated effects, a **designer** for your own (ring style, up to three colours, thickness, glow, motion, ten accessories like ears, crown, halo, wings; 12 starting points and a Surprise me button), and **Upload image** to wrap your own artwork (a PNG, GIF or WebP with a see-through middle, up to 3 MB) around your avatar. A new picture is **fitted automatically**: NullChat finds the ring in the picture (even when a crown or wings push it off-centre, or drips hang into it) and sizes and moves it so the ring sits exactly around your avatar. **Fit around my avatar** repeats that any time, and sliders for size (30–400%), left / right and up / down fine-tune it. A picture with no closed ring (wings, ears) is placed by its empty middle, and one that says nothing about where the avatar goes stays centred with a message. The site admin also has an **Admin Crest** that nobody else can pick; the server enforces that.
- **Display name styles** (Settings → Profiles): the same set Discord has. Fonts: Tempo, Sakura, Jellybean, Modern, Medieval, 8Bit, Vampyre, Monkey Bars, Mainframe, Headbang and Journal. Effects: Solid, Gradient (two colours), Neon, Toon, Pop, Gummy and Prism (five colours that slowly move along the name), plus Glow, Shimmer and Outline. The fonts are open-licence typefaces shipped inside the app (`client/public/fonts/names/`, licences in `LICENSES.txt` there), so nothing loads from another site; each is a small Latin-only file that a browser fetches only when a name on screen uses it. They are similar in spirit to Discord's, not copies of its fonts. The first five fonts NullChat had (Rounded, Serif, Typewriter, Handwritten, Poster) still show for anyone who chose them. *Accessibility → Display name styles* and High Contrast turn all of this off for the person looking.
- **Profile effects** (Settings → Profiles → Profile Effect): an animated layer over the whole profile card and the full profile, like Discord's profile effects. Twelve to pick from: Sakura Petals, Snowfall, Sparkles, Floating Hearts, Fireflies, Embers, Storm, Bubbles, Confetti, Autumn Leaves, Starfall and Code Rain. Discord's are shop artwork, so these are NullChat's own, of the same kinds; they are drawn entirely in CSS (no images, no downloads) from a few small elements that only move with `transform` and `opacity`, and the layer never catches a click. The picker shows a still snapshot of each that plays when you hover it, and your own preview card shows the one you chose. Stored as one id in `users.profile_effect` (a plain column that is added at startup if it is missing, like the moderator columns, so it needs no numbered database step); the list is in `shared/perks.js`, the particles in `client/src/lib/profileEffects.js` and the looks in the "profile effects" block of `styles.css`. To add one: add it to `PROFILE_EFFECTS`, to `SPEC` in `profileEffects.js`, and write its `.pfx-<id> i` rule. *Accessibility → Profile effects*, Reduced motion and High contrast turn them all off for the person looking (the picker and your own preview stay unless it is Reduced motion or High contrast that is on). Lightning in Storm is one soft glow every nine seconds, never a flash.
- **150 MB uploads** (`MAX_UPLOAD_MB`), **4000-character messages**, **1440p 60 fps screen share**, and custom / animated emoji in every server.

Per-server profiles and a soundboard are not included.

### Yapin'-style extras

- **Text chat in voice channels:** every voice channel has its own chat panel beside the call (toggle it with the chat icon in the header). It uses the same permissions as text channels.
- **Voice messages:** tap the mic button in the message box, record up to 5 minutes, then send. They play inline.
- **"Playing X" activity (desktop app):** the app spots known games and shows "Playing X" in the member list, friends list and profiles. Only the game's name is sent. Turn it off in *Privacy & Safety*. The game list is `KNOWN_GAMES` in `shared/levels.js`; add your own there. It is cleared when the app closes or loses its connection, and sent again after a reconnect or a server restart, so a stale "Playing" line never lingers.
- **Levels and leaderboard:** chatting in a server earns xp (15 to 25, at most once per 30 seconds). Levels show as a badge on profiles, and *server menu → Leaderboard* ranks the most active members. People can hide from the board or hide their level.
- **Server boosts:** free; every account gets 3 boosts to spread over servers (*server menu → Boost Server*). Servers show a boost level.
- **People you may know:** the Add Friend tab suggests people you share servers or friends with. *Privacy & Safety → Suggest me to people* turns it off for you.
- **Stream quality:** while sharing your screen, the settings button in the call controls switches between 720p30, 1080p60 and 1440p60 without restarting the share.

Not included: end-to-end encrypted calls (calls are already peer-to-peer and encrypted with DTLS-SRTP).

### Only in NullChat

- **Quiet replies:** reply to a message in a server channel or group chat so that only the people you pick can see it. Right-click a message → **Reply Quietly**, or turn on **Quiet** on the reply bar. It starts with the author of the message; **Add people** lets you choose up to 10 others who can see the channel (never bots), and you can take the author off. The people picked get a mention; nobody else gets anything, not even a sign that something was said.
  - Quiet replies are text only. They can't be pinned, reacted to, forwarded, saved, searched or turned into a thread, and they are as private as a direct message: server moderators and the site's staff tools don't see them. Only the author can delete one.
  - Answering a quiet reply is always quiet, and can only go to the people who can see that reply.
  - They are kept in their own table (`quiet_replies`), not with ordinary messages, so nothing else in the app can show one by accident. The author's data export lists the ones they wrote.
- **Catch-up card ("While you were gone"):** come back to a server with a backlog and a small card in the corner shows how much is new, the busiest channels and who was talking, one message per channel that stood out (the most reactions and replies), where you were mentioned, what was pinned, and the quiet replies waiting for you. Everything on it jumps to the place it talks about; **Mark all as read** clears the server.
  - It shows by itself when there are 15 or more new messages, or something addressed to you, and then not again for that server for 3 hours. *Server menu → Catch Up* opens it any time. Turn it off in *Settings → Chat → Catching Up*.
  - It only counts channels you can read, skips channels you muted and people you blocked, never looks further back than 14 days or than the day you joined, and marks nothing read by itself.
- **Mood rooms (room sounds):** a voice channel can have a quiet shared background: Rain, Fireplace, Ocean, Wind, Night or a Deep hum. The button next to the microphone (and the chip in the channel's header) opens the list. Anyone in the room can change it, and the room is told who did; people who can manage the channel can also change it from outside and can switch on **Only managers can change it**.
  - The server only stores which sound a room has. Each person's app makes the sound itself (no sound files, nothing goes into anyone's microphone), fades it in and out, and silences it when you deafen. **Hear the room sound** and **Your volume** in the same window are yours alone, per device.

- **Music in voice channels:** the music button next to the microphone opens the room's queue. Paste a YouTube link or a link to an audio file (.mp3, .ogg, .wav, .m4a, .flac; a file uploaded to NullChat works too) and everyone in the voice channel hears the same track at the same moment; later links wait in **Up next**. Anyone in the room can add, pause, skip, drag the position, jump to a track or remove one, and the room is told who added or skipped. **Only managers can control it** leaves adding open and keeps the rest for people who can manage the channel.
  - The server never touches the music. It keeps the list and a clock; each person's app plays the track for itself (YouTube in its own small player above the voice panel in the sidebar, where it keeps playing as you move around the app) and keeps to that clock. Nothing goes into anyone's microphone. **Hear the music** and **Your volume** are yours alone, per device, and deafening yourself silences it.
  - A track that will not play for at least half the room (a removed video, or one its owner does not allow outside YouTube) is skipped by itself. The queue holds 50 tracks, lives in memory, and is forgotten when the last person leaves the room.
  - YouTube videos are shown with YouTube's own player from `youtube-nocookie.com`; NullChat downloads nothing from YouTube.
- **Streaks:** a flame with a number next to a friend (in the DM list and at the top of the conversation) counts the days in a row on which you BOTH wrote to each other; next to a server's name it counts the days in a row on which at least two different people wrote there. It shows from two days on, turns grey while today is still to do, and a missed day ends it (the best is remembered). Round numbers (3, 7, 14, 30, 50, 100 …) get a small cheer. *Settings → Chat → Streaks* hides them.
  - A day is a calendar day in one time zone that stays with the streak: for two friends, that of whoever started it; for a server, its owner's. The app reports the device's time zone for this. No message is read or scanned: each message sent updates one small row.
- **Birthdays:** *Settings → My Account → Birthday* saves the day and month (never a year), with two separate choices: **Let my servers announce it** and **Show it on my profile**. A server picks a channel in *Server Settings → Overview → Birthday Channel*; on the day, at 9 in the morning where the person lives, that channel gets one "It's X's birthday today!" message. Nothing is posted in servers without a birthday channel, or in a channel the person cannot see. Someone born on February 29 is announced on February 28 in other years.
- **Your own join and leave sounds:** *Settings → Voice & Video → Join and Leave Sounds* lets you pick any audio file for the moment you come into a voice channel and another for when you leave; the people in the room hear it instead of the standard sound. Only the first 5 seconds are used, and the app evens out the loudness before uploading, so nobody's sound is louder than anyone else's. The server keeps nothing but a small WAV file it has checked itself.
- **Picture-in-picture for calls:** during a call, **Pop out the call** (next to the mute button, and in the voice panel at the bottom of the channel list) puts the call in a small window that stays on top of your other tabs and apps. It shows whoever is sharing a screen (first), else a camera (the person speaking first), else everyone's picture, lit while they speak; and it has mute, deafen and hang up. Click the call's name in it to go back to the call. It closes when the call ends. In Chrome and Edge the call can also pop out by itself when you switch tabs and go away when you come back (*Settings → Voice & Video → Picture-in-Picture*; the browser may ask you to allow it). It works in Chrome and Edge on a computer (Document Picture-in-Picture) and in the desktop app (a small always-on-top window); Firefox, Safari and phones have no way to do this, so the button is not shown there. Where the app has no small window of its own to use (a desktop app installed before this feature, Safari), the call is shown in the browser's ordinary video picture-in-picture instead: same view, with the mute and hang-up buttons the browser provides rather than ours. The window is laid out like a call screen: black, each person a rounded tile with their picture in the middle and their name in the corner (a green edge while they speak), the call's name top left, and mute, deafen, camera and a red hang-up centred along the bottom. The button in the window's bottom-right corner turns the small on-top window into an **ordinary window** (with minimise, maximise and close, because browsers do not let the small one be maximised); in that window the same button switches **full screen** on and off. The window also has **camera** and **share screen** buttons. In a browser without the small on-top window (Firefox, Safari, Opera), **Pop out the call** opens the ordinary window straight away, with every button; the picture-only version is now used only where no window can be opened at all (a desktop app older than 1.5.1, or a browser that blocks pop-ups). Desktop app **1.5.1** opens its own window for the call (on top, with all the buttons, and it can be maximised or made full screen): run `Build Installer.bat` and deploy, and installed apps update themselves to it. From desktop app **1.5.2** the call's window is an ordinary window of its own: it shows in the taskbar, and can be resized, maximised, made full screen and snapped into Windows' snap layouts like any other window; the pin button in its corner keeps it above other windows (off by default, remembered). **How the window works:** every person is a tile, a camera shows inside its person's tile, and each shared screen is a tile of its own. **Click a tile** to make it the big one, with the others in a row underneath; click the big one to see everyone again. A screen share that has just started becomes the big one by itself (your own never does). The buttons are two groups and the red hang-up, centred: microphone and camera (each with a small **arrow** that lists your microphones and speakers, or your cameras, and switches to the one you pick), then share screen and deafen. The top line has the call's name and a **chat** button; the bottom-right corner has **keep on top** (desktop app), **put the call back in NullChat**, and **full screen**. The top line and the buttons fade away after a few seconds without the mouse moving and return when it moves. While you are alone in a server's voice channel, a second tile offers **Invite to Voice**: it makes an invite link (or uses the server's own link), copies it, and shows it. **The whole call moves:** the **chat** button in the call's window opens the call's text chat beside the tiles (the voice channel's own chat, or the conversation a direct call is in): the latest messages with formatting, links, pictures and files, a box to type in (Enter sends, Shift+Enter makes a new line), a **+** to attach files, and pasting a picture attaches it. A red dot on the button means something arrived while it was closed; the window needs to be at least 720 wide for it. The app's menus, emoji picker and GIFs are not in that window. While the call is in its own window, the app shows **This call is in its own window** with **Bring It Back** where the call's tiles were (and leaves full screen if the call was filling it), so there is one copy of the call, not two. **Share your screen, in the window:** in the desktop app (from **1.5.3**) the **Share your screen** button in the call's window opens the picker right there, over the call: tabs for screens and windows with live previews, the quality, **Share computer sound**, and **Share** (double-click a preview to share it straight away, Esc to cancel). The capture is started from that window. An older desktop app shows its picker in the main window as before, and updates itself after the next deploy; in a browser the browser's own picker opens from the call's window.
- **Full screen calls:** the button at the right end of a call's buttons (voice channels, stages and DM calls) makes the call fill the whole screen; press it again or Esc to leave. Menus, tooltips and pop-ups still open on top of it, and hanging up or opening another channel leaves full screen. Where a browser refuses real full screen, the call fills the NullChat window instead.
- **Microphones and headphones of every kind (Mac, Windows, anything):** NullChat lists every input and output the system has (built-in, USB, Bluetooth such as AirPods, audio interfaces, virtual and aggregate devices) by name in **Settings → Voice & Video** and in the call window's device menus. A chosen device is saved **by name as well as id**, so it is found again when the browser gives it a new id (Safari does on every visit; a re-paired Bluetooth headset can). If it is **not connected**, the system's default is used, you are told once by the device's name, the setting shows it as *(not connected)*, and it is used again by itself when it comes back. **During a call**, plugging in or removing a device is noticed: sound moves to the chosen speaker when it is there, and the microphone is reopened when the one in use went away, the chosen one returned, or *Default* now means another device. A microphone that **refuses to start** with NullChat's extras (one channel at 48 kHz, low delay, echo cancelling), as some audio interfaces and aggregate devices do, is opened more plainly instead of failing; only when nothing opens are you told there is no microphone, and you can still listen. Where the browser cannot choose a speaker at all (Safari), the setting says to use the system's sound menu instead of offering a menu that does nothing. On a Mac the microphone also has to be allowed in **System Settings → Privacy & Security → Microphone** (for the browser, or for NullChat).
- **Dragging the installed app's window:** the app installed from the browser (**Install NullChat** in Chrome or Edge) keeps the system's normal title bar, which is what a window is dragged by. Earlier versions offered a mode that hides the title bar ("window controls overlay", the small arrow beside the window buttons), and with it hidden there was nothing to drag. NullChat no longer offers that mode, and for apps that are still in it, it draws its own draggable **NullChat** strip across the top and starts the app below it. The desktop app from **Download Apps** has always had a normal title bar.
- **Voice quality:** voice is Opus at 48 kHz. **High** (the default) gives the codec a full **64 kbps**, the same as a Discord voice channel; **Studio** gives it **128 kbps**; **Standard** is 32 kbps for slow connections. (The limit handed to the browser includes an allowance for each packet's wrapping, because the browser counts that against it: without it "64" was really about 46.) **Protect My Voice on a Bad Connection** (on by default, not in Standard) sends each packet with the previous one inside it (RED), on top of Opus's own error correction, so a lost packet is rebuilt instead of heard as a gap or a robotic blip; it costs about the voice bitrate again, and both sides must support it (Chrome, Edge, the desktop app and Safari do; otherwise the call is plain Opus). **Voice Enhancement** (on by default) runs your microphone through a low cut at 85 Hz, a gentle compressor, make-up gain and a fast limiter before it is sent, so quiet and loud speech arrive at a similar level and a shout does not distort; the gate still listens to the untouched microphone. Where the system has its own voice isolation (recent macOS, Windows and ChromeOS), the browser is asked to use it along with echo cancelling and noise suppression. All of it is in **Settings → Voice & Video → Voice Processing**.
- **Turning someone up to 200%:** right-click a person in a call (their tile, or their name in the channel list) and **User Volume** goes from 0% to **200%**. Up to 100% their sound is simply played quieter. Above 100% it is played through a boosted copy (a gain, then a limiter so that a shout at 200% is held under the point of crackling) and the plain copy is silenced, so they are heard once. It applies only to what you hear, is remembered per person on this device, and deafen, mute-for-me and your output device apply to the boosted copy as well.
- **Voice channel layout:** a server's voice channel is laid out like the call's window: equal 16:9 tiles sized to fit and centred, each a flat colour taken from the person's picture with the name in the bottom-left corner and a green edge while they speak; click a tile to make it the big one. The buttons are two groups (microphone, deafen, camera; then share screen, room sound, music, pop out) and a wide red hang-up, with full screen at the right. Alone in the channel you get an **Invite to Voice** tile. The chat beside the call is closed until you open it with the chat button, and stays how you left it. In full screen the top line and the buttons fade after a few seconds without the mouse moving.
- **Message layout:** messages use the familiar chat layout: 40px avatar, name followed by a short time (today shows only the time, yesterday shows "Yesterday at …", older shows the date), 16px text on 22px lines, and follow-up messages from the same person grouped underneath with the time shown on hover. Text size and group spacing are adjustable in **Settings → Appearance**.
- **Profile song:** in **Settings → Profiles → Profile Song**, pick any audio file, choose which 15 seconds of it to use, listen, name it and save. It plays quietly (and stops when the profile closes) for anyone who opens your profile card or full profile. The app cuts and levels the clip before sending it, so every song is about equally loud, and the server only accepts that small clip (a 16-bit WAV of at most 15 seconds). Listeners are in charge: the speaker button on any profile, or **Play other people's profile songs** in the same settings, stops songs from starting by themselves (the play button stays). A song never starts by itself while you are in a call or for someone you blocked.
  - **Play other people's own sounds** (same page) turns them all into the standard sound on your device. Right-click someone in your voice channel → **Standard Join Sound** does it for one person. People you blocked always get the standard sound.
  - A server can turn them off for its voice channels: *Server Settings → Overview → Members' own join and leave sounds*.
  - Someone who hops in and out gets their own sound once, then the standard one for the next 20 seconds. Switching off the User Join or User Leave sound in *Settings → Notifications* silences these too.


## Desktop app & installable app

### Download Apps: what each system gets
**Download Apps** (⬇ at the bottom of the server bar) shows one card each for **Windows**, **macOS** and **Linux**, with the visitor's own system first. A card has download buttons for every installer of that system that is on the server, and says "isn't on this server yet" until you add one:

- **Windows:** `NullChatSetup.exe`
- **macOS:** `NullChat-<version>-mac-arm64.dmg` (Apple Silicon) and `-mac-x64.dmg` (Intel)
- **Linux:** `NullChat-<version>-linux-x86_64.AppImage` (any distro) and `-linux-amd64.deb` (Debian / Ubuntu)

### The light Mac and Linux versions (already in `downloads`)
Until you add the full Mac and Linux installers, the project ships three small files in `downloads` so those systems have something real to download:

- `NullChat-1.5.0-mac-universal-launcher.zip`: **NullChat.app** for Macs (Intel and Apple Silicon).
- `NullChat-1.5.0-linux-launcher.deb`: for Debian, Ubuntu and Mint.
- `NullChat-1.5.0-linux-launcher.tar.gz`: for any other Linux (unpack it and run `./install.sh`; `./uninstall.sh` removes it).

They are **light versions, not the full desktop app**. They put a NullChat icon in the Dock or app menu and open NullChat in its own window using Chrome, Edge, Brave (or Chromium on Linux), so one of those must be installed; without one they open NullChat in the normal browser instead. They have no tray icon or unread badge on the icon, and can't host a server. The Mac app is not signed, so the first time macOS asks you to use **System Settings → Privacy & Security → Open Anyway**. The Download Apps window labels them "needs Chrome, Edge or Brave" and lists the full installers first when you have them, so you can leave both in the folder, or delete the three launcher files once the full ones are there.

They have your server address built in (`https://nullchat.fly.dev`, taken from `desktop/app-config.json`). To make new ones for another address, or after changing the version, run **`scripts/launchers/build.sh https://your-server`** on a Mac or Linux computer (it needs `zip`, `tar` and, for the .deb, `dpkg-deb`). For the Mac app you can also just edit the address in `NullChat.app/Contents/Resources/server-url.txt` (right-click the app → **Show Package Contents**).

Put the files in the project's `downloads` folder (or `data/downloads`); the cards pick them up by file name, with no setting to change.

**If an installer says it is damaged** (Windows: "Installer integrity check has failed"), the download was cut short on its way to that computer: delete it and download it again. Under each card, **Won't open, or says it is damaged?** shows the file's SHA-256 and the one command that prints the same number for the downloaded copy, so a good file and a bad one are easy to tell apart. If you rebuild an installer and deploy while someone is downloading it, their browser's "resume" starts the new file from the beginning instead of joining the old start to the new end (the server answers a resume only when the file is still the same one), so a download can no longer end up as a mix of two versions. If the copy on the computer you built it on (`desktop\release\NullChatSetup.exe`) also fails to start, the build itself is damaged: run `Build Installer.bat` again. Mac and Linux installers can't be built on a Windows PC: see "Mac" below and the GitHub workflow.

Separately, the public page **`/install`** (share the link) shows how to install NullChat straight from a computer's browser (Chrome, Edge, Brave, Opera; Safari on macOS 14+ via **File → Add to Dock**) and how to add it to a phone's home screen. That needs nothing from the server owner and no installer files.

NullChat installs just like Discord:

1. Someone downloads **`NullChatSetup.exe`** and double-clicks it.
2. It installs in a few seconds, with **no wizard and no admin prompt** (into `%LocalAppData%\Programs\NullChat`), and adds Desktop and Start-menu shortcuts.
3. NullChat opens with a small splash window that says **"Checking for updates…"**. If you have published a newer version, it downloads and installs itself, then restarts.
4. The app opens **straight into your NullChat server** and the person logs in. That's it.

Like Discord, it also:
- **opens when the computer starts** (minimized to the tray),
- **closes to the system tray** (quit from the tray icon),
- shows unread counts on the taskbar icon,
- handles **`nullchat://invite/CODE`** links, with or without a "joined from" label on the end (invite pages show an "Open in the NullChat app" link),
- has its own **screen-share picker inside the app**: every screen and window with a live preview, a quality choice (720p/1080p/1440p) and, on Windows, an option to share computer sound. (In a normal browser the browser shows its own picker, which a web page cannot replace.)

Users can change the startup and tray behavior under **User Settings → Advanced → Desktop App**.

The installer contains **everything**: the app, the web client *and* the NullChat server. Recipients don't need Node.js or anything else.

### Build the Windows installer (double-click)

1. Install **Node.js LTS** from <https://nodejs.org>. You only need it on the PC that builds the installer, not on the PCs that install it.
2. In the project folder, double-click **`Build Installer.bat`**.
3. When asked **"Server address"**, choose one:
   - **Type your server's address** (for example `https://chat.example.com`, or `192.168.1.23:3001` on your home network). Everyone who installs the app is connected to it automatically, and the app checks it for updates. This is the Discord-style setup.
   - **Press Enter to leave it empty.** On first launch the app then asks whether to **host a server on this computer** or **join an existing server**.
4. Wait a few minutes. The first run downloads Electron, the app framework, which is about 100 MB. When it finishes, the `desktop\release` folder opens with **`NullChatSetup.exe`**.

The script also copies the installer into `data\downloads`, so the NullChat server on that PC immediately offers it on the **Download Apps** button.

If you prefer the terminal: `set NULLCHAT_SERVER_URL=https://chat.example.com` and then `npm run desktop:win`. To change the default server permanently, edit `desktop/app-config.json`.

> **Windows SmartScreen:** the installer isn't code-signed, so the first time it runs Windows may show "Windows protected your PC". Click **More info → Run anyway**. Removing this warning requires buying a code-signing certificate (set `CSC_LINK` and `CSC_KEY_PASSWORD` before building).

### Updating an installed app (including the Fly.io setup)
`Build Installer.bat` now copies `NullChatSetup.exe`, its `.blockmap` and `latest.yml` into the project's **`downloads`** folder as well as `data\downloads`. Run `Deploy to Fly.io.bat` afterwards and your online server offers the new installer and every installed app updates itself on its next start. Updates only happen when the version in `desktop/package.json` is higher than the installed one (currently 1.5.2).

**A damaged installer is caught, not handed out.** The deploy script checks `downloads\NullChatSetup.exe` against its `latest.yml` (size and SHA-512) and against the length the installer itself declares, and stops with a message before uploading a bad one. After the upload it compares the server's copy with yours. If a damaged installer is ever found on the server (for instance, if `Build Installer.bat` replaced the file while a deploy was uploading it), the **Get the app** window says so instead of offering it, the download is refused, and the server log names the file. The fix is always the same: let `Build Installer.bat` finish, then run `Deploy to Fly.io.bat` again. (This is what an installer's *"Installer integrity check has failed"* message means: the file is not the one that was built.)

### Distributing it and shipping updates

To let people download the app from your NullChat website, and have installed apps update themselves:

1. Copy these three files from `desktop\release` into your NullChat server's **`data/downloads/`** folder:
   - `NullChatSetup.exe`
   - `NullChatSetup.exe.blockmap`
   - `latest.yml`
2. On the website, people click the **Download Apps** button (⬇ at the bottom of the server bar). It detects their operating system and offers the right installer.
3. **To release an update:** raise `"version"` in `desktop/package.json` (for example `1.0.0` → `1.0.1`), build again, and replace the three files.
   - Installed apps pick up the update on their next launch (the splash screen downloads and installs it).
   - Apps that are already running find it within 4 hours, or straight away via **Check for Updates** in the tray menu or Settings.

Updates come from `<server address>/downloads` by default. To use another location, set `"updateUrl"` in `desktop/app-config.json`, or set it to `false` to turn updates off.

### Mac (MacBook, iMac, Mac mini)

A Mac version can only be built *on a Mac*: either on your own Mac, or on GitHub's Macs using the workflow described below. If you only have a Windows PC, the GitHub workflow below is the way to get the Mac and Linux installers. Until you add them, the macOS and Linux cards in **Download Apps** say they aren't on the server yet (the **`/install`** page still works for browser installs).

- **On a Mac:** install Node.js, then double-click **`Build Installer.command`**. If macOS blocks it, right-click it → **Open**. It asks for the server address in the same way, copies the results into the `downloads` folder (so `Deploy to Fly.io.command` publishes them and installed Macs update themselves) and produces:
  - `NullChat-1.0.0-mac-arm64.dmg` for Apple Silicon Macs (M1–M4)
  - `NullChat-1.0.0-mac-x64.dmg` for Intel Macs

  To check which one a Mac needs, open Apple menu  → **About This Mac**: "Chip: Apple M…" means Apple Silicon.
- **Installing:** open the `.dmg` and drag **NullChat** into **Applications**. The first time, macOS says it can't verify the developer. Go to **System Settings → Privacy & Security** and click **Open Anyway** (you only do this once). If macOS says the app "is damaged", run `xattr -cr /Applications/NullChat.app` in Terminal.
- **Permissions:** macOS asks for microphone and camera access the first time you use them. Screen sharing needs **System Settings → Privacy & Security → Screen Recording → NullChat**; NullChat offers a button that opens this page.
- **Updates on Mac:** Apple only allows signed apps to update themselves. Unsigned Mac builds therefore tell the user when a new version is available and open the download page.
- **Signing (optional):** with an Apple Developer account ($99/year), add the secrets listed at the top of `.github/workflows/desktop.yml`. The Mac app is then signed and notarized: it opens without any warning and updates itself automatically.

### Linux

A Linux version can only be built *on Linux* (or on GitHub's Linux machines with the workflow below). Everything else (running NullChat, deploying to Fly.io, account help) works on any distro with **Node.js 22.13 or newer**.

- **Build it:** `./nullchat.sh installer`. It asks for the server address like the Windows and Mac builders, copies the results into the `downloads` folder (so the Deploy script publishes them and installed copies update themselves) and produces:
  - `NullChat-1.5.0-linux-x86_64.AppImage` runs on any distro: `chmod +x NullChat-*.AppImage && ./NullChat-*.AppImage`
  - `NullChat-1.5.0-linux-amd64.deb` for Debian, Ubuntu and Mint: `sudo apt install ./NullChat-*.deb`
- **Ubuntu 24.04 and newer:** the system blocks the AppImage's sandbox by default, so the AppImage may refuse to start. Use the `.deb` (it installs the sandbox helper properly), or start the AppImage with `--no-sandbox`.
- **Closing the window and starting at login:** on Linux the X button quits NullChat and it does not start at login by default, because many desktops (GNOME) show no tray icon and a hidden window would look like a crash. If your desktop has a tray, turn on **Minimize to tray when closing** and **Open NullChat when your computer starts** in User Settings → Advanced → Desktop App (starting at login writes `~/.config/autostart/nullchat.desktop`).

**The deploy builds the Windows app for you.** `Deploy to Fly.io.bat` looks in `downloads` before it uploads: if `NullChatSetup.exe` is missing, or is an older version than this NullChat ships (`desktop/package.json`), it builds it first (a few minutes) and puts it there, so the site always offers the current app and installed apps update themselves. This matters because unzipping a NullChat update into a fresh folder leaves `downloads` empty. If the build fails, the deploy carries on and says so. `Build Installer.bat` still builds it by hand.

### Voice relay (calls that connect for everyone)

Calls go **directly** from one person to another. That is fast and private, but it only works when both networks let the other in. A phone on mobile data, school or work Wi-Fi, and some home routers do not: those two people join the call, see each other in it, and **cannot hear or be heard**. (Discord never has this because it sends every call through its own servers.) The cure is a **relay** both sides can reach, used only by the pairs that need it.

**The easy way:** double-click **`Voice Relay Setup.bat`**. It walks you through making a relay key on Cloudflare (free account; **the first 1,000 GB are free**, which is thousands of hours of voice; Cloudflare may ask for a payment card before enabling Realtime), checks the two values you paste, and gives them to your Fly.io server (`fly secrets set CLOUDFLARE_TURN_KEY_ID=… CLOUDFLARE_TURN_API_TOKEN=…`). The server restarts; everyone rejoins the call once. `node scripts/voice-relay.cjs --off` turns it off.

How it works: the key stays on the server. Every six hours the server asks Cloudflare for short-lived relay logins (good for two days) and hands those to the apps along with the usual servers; the apps try a direct connection first and fall back to the relay. If Cloudflare cannot be reached, calls carry on the direct way and the server log says so.

**Checking:** **Settings → Voice & Video → Connection → Check my connection** says *The relay server works* when it is on, and *No relay server is set up* when it is not. In a call, if two people cannot be connected and there is no relay, each is told so by name, with what the server's owner can do. `GET /api/config` reports `voiceRelay: true|false`.

Running your own TURN server instead still works (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`).

**The Mac and Linux apps survive updates.** `Build Mac App.bat` also keeps a copy of what it built in `.nullchat/built-apps` in your user folder. When `Deploy to Fly.io.bat` finds `downloads` without them (a NullChat update unzipped into a fresh folder), it puts them back before uploading, so Mac users keep getting the real app. It says when that copy is older than the desktop app this NullChat ships; run `Build Mac App.bat` again to update it. If no Mac app was ever built, the deploy says so.

### Build every installer on GitHub (no Mac or Linux computer needed)

**The one-click way (Windows):** double-click **`Build Mac App.bat`**. It does every step below for you: it installs Git and the GitHub tool if they are missing (it asks first), opens your browser so you can sign in to a free GitHub account, uploads a **private** copy of this folder (never your `data` folder, `.env`, keys or the big installers), sets your server address, starts the build for the **Mac and Linux** apps, waits about 10 to 15 minutes, and puts the finished `.dmg`, `.zip`, `.AppImage`, `.deb` and `latest-*.yml` files into `downloads`. Then run **`Deploy to Fly.io.bat`**. Run it again whenever you want the Mac and Linux apps rebuilt (for example after an update that changes the desktop app). It uses roughly 100 of GitHub's 2,000 free monthly minutes per run. `node scripts/github-build.cjs --mac-only` builds only the Mac app; `--all` builds Windows too. Once a system's full app is in `downloads`, **Download Apps** stops offering that system's light version (the one that needs Chrome).

The same thing by hand:

This is the way to get the Mac and Linux installers when you only have a Windows PC. GitHub builds them on its own Mac and Linux machines for free (a private repository is fine). One run uses roughly 120 of the 2,000 free minutes you get each month, because Mac minutes count ten times.

1. Make a free account at <https://github.com>, then install **GitHub Desktop** from <https://desktop.github.com> and sign in.
2. In GitHub Desktop choose **File → Add local repository…** and pick the NullChat folder. If it says the folder isn't a repository, click **create a repository**, then **Create repository**. Type any message (for example `first upload`), click **Commit to main**, then **Publish repository**. Leave **Keep this code private** ticked. (The big installer files in `downloads` are left out on purpose: GitHub refuses files over 100 MB.)
3. On github.com open the new repository → **Settings → Secrets and variables → Actions → Variables → New repository variable**. Name: `NULLCHAT_SERVER_URL`, value: your server address (for example `https://nullchat.fly.dev`). This makes the Mac and Linux apps open straight into your server and update from it.
4. Open the **Actions** tab (click the green button if it asks to enable workflows), choose **Build desktop apps** on the left, then **Run workflow → Run workflow**.
5. About 10 to 15 minutes later the run shows a green tick. Open it and scroll to **Artifacts** at the bottom. Download **NullChat-macOS** and **NullChat-Linux** (each is a zip) and unzip them.
6. Copy everything from those two folders (the `.dmg`, `.AppImage`, `.deb`, `.zip` and `latest-*.yml` files) into the NullChat folder's **`downloads`** folder. **Keep `NullChatSetup.exe` in there too**, because a deploy replaces what the server offers with what is in that folder. Then run **`Deploy to Fly.io.bat`**. The macOS and Linux cards in **Download Apps** get their buttons.

(You can ignore the **NullChat-Windows** artifact if you already have your own `NullChatSetup.exe`. Pushing a tag such as `v1.5.1` also attaches the installers to a GitHub Release.)

### Phones: install it like an app
Phone visitors get a **Get the NullChat app** bar (Android: one tap; iPhone: Share, then Add to Home Screen) and a public page at **`/install`** that you can send to friends. The app opens full screen with its own icon, and the manifest ships proper Android and iPhone icons.

To offer a downloadable **Android app file**, generate an APK for free with [PWABuilder](https://www.pwabuilder.com) (enter your site address, then Package for stores → Android), save it as `downloads/NullChat.apk` in the project and redeploy. If PWABuilder also gives you an `assetlinks.json`, put it in `downloads/` too; the server publishes it at `/.well-known/assetlinks.json`, which lets the Android app open without an address bar. Anything in `downloads/` (or in `DATA_DIR/downloads` on the server) that looks like an installer is offered on the "Get the app" screens. iPhone apps cannot be distributed this way, so iPhone uses Add to Home Screen.

**A real app instead of PWABuilder:** `mobile/` builds a native Android app and an iPhone app (TestFlight) with Capacitor, including notifications through Google and Apple. It is built by GitHub (**Actions → Build phone apps**), needs no tools on your PC, and is described, with its limits and what is untested, in [docs/PHONE_APPS.md](docs/PHONE_APPS.md). The Add to Home Screen route above keeps working and needs nothing.

### Notifications when the app is closed
NullChat sends them itself (the standard Web Push system, no account with any outside service and nothing to configure). Each person turns them on per device in **Settings → Notifications → When NullChat is closed**. On a phone or tablet nobody has to go looking for it: a bar at the top asks **"Get notified when you're away"** with a **Turn on** button (one tap, then a test notification arrives so you can see it works). *Not now* asks again in two weeks, and the bar is never shown on a computer, where notifications are blocked or unsupported, or where they are already on. On an iPhone that hasn't been added to the Home Screen yet, the "Get the app" bar is shown instead (it says it is needed for notifications), and the notification bar appears once the app is opened from the Home Screen.
- **What you see on a phone:** one notification per chat. If a chat already has an unread notification, the next message replaces it with the newest text and how many came since (*"see you there (+2 more)"*), and reading the chat in the app takes its notification away. The app's icon shows the number of unread @mentions, DMs and friend requests (the same number as the badge inside the app, leaving out muted servers), and it is kept right while the app is closed. Posts from an announcement channel that your server follows arrive on devices set to *every message*, like any other message in that channel.
- **Android** (Chrome, Edge, Firefox, Samsung Internet): works in the browser; installing the app is optional. Allow notifications when asked.
- **iPhone and iPad** (iOS/iPadOS 16.4 or newer): Apple only allows it for an app added to the Home Screen. Open NullChat in Safari → **Share → Add to Home Screen**, open it from there, log in, then switch it on.
- **The Android and iPhone apps from `mobile/`** use Google's and Apple's own notification services instead of this (their notifications can be read by those services, which the browser ones can't: *Show message text* off keeps the text out). Setup and limits: [docs/PHONE_APPS.md](docs/PHONE_APPS.md).
- **Computers:** Chrome, Edge, Firefox and Safari work while the browser is running (Chrome and Edge also with the page closed). The Windows/Mac/Linux desktop app has its own notifications, so the switch isn't shown there.
- What comes through follows the same rules as in the app: Do Not Disturb silences everything, muted servers and channels only let direct @mentions through, a server set to *Only @mentions* or *Nothing* is respected, and `@silent` messages never notify. Reminders always come through.
- Messages are encrypted for the device before they leave your server, so the browser makers' push services only ever see scrambled bytes. The server keeps its own sending key in the database (so it survives updates and redeploys) and only talks to Google's, Mozilla's, Apple's and Microsoft's push services. Logging out stops that account's notifications on that device. Behind a proxy, nothing extra is needed beyond HTTPS, which Fly.io and Caddy already give you.

### Install from the browser (no installer at all)

When NullChat is served over HTTPS (or on `localhost`), it can be installed straight from the browser:
- **Edge:** menu → **Apps → Install this site as an app**
- **Chrome:** the install icon in the address bar
- **Android:** **Install app**
- **iPhone/iPad:** Safari → **Share → Add to Home Screen**
- **Safari on Mac:** **File → Add to Dock**

---

## 4. Project structure & architecture

```
nullchat/
├─ server/                 Node.js backend (no framework, minimal dependencies)
│  └─ src/
│     ├─ index.js          HTTP server: routing, security headers, uploads, serves the built client
│     ├─ gateway.js        WebSocket gateway: auth, presence, event fan-out, voice signaling, calls
│     ├─ db.js             SQLite (node:sqlite) connection + schema migrations
│     ├─ models.js         Serialization + permission-aware data access
│     ├─ services.js       Shared operations (system messages, joining servers, audit log)
│     ├─ seed.js           Demo data
│     ├─ routes/           auth, users (profiles, friends, DMs, settings), guilds, channels, messages,
│     │                    saved (+ reminders), scheduled (send later), reports, push, export (download my data), admin
│     └─ lib/              security (scrypt, TOTP, tokens), http, uploads, mailer, link previews, polls,
│                          backup + restore, site (admin announcement and sign-ups switch), lounge (the Nullspace server new accounts join),
│                          push (notifications while the app is closed)
├─ mobile/                 Android and iPhone apps (Capacitor): settings, patch scripts, icons; built by .github/workflows/mobile.yml
├─ client/                 React 19 single-page app (Vite)
│  └─ src/
│     ├─ App.jsx           Routing, app shell, global keybinds
│     ├─ styles.css        Complete theme (dark / light / midnight, responsive)
│     ├─ components/       UI: Sidebar, Chat, Messages, Composer, Voice, Friends, settings, modals…
│     └─ lib/              state store, gateway client, REST client, WebRTC voice engine,
│                          markdown renderer, emoji, notifications, sounds, keybinds, i18n
├─ shared/permissions.js   Permission flags + calculation, shared by server and client
├─ shared/tags.js          Server tag rules (length, reserved tags, colours, built-in badges), shared by server and client
├─ shared/community.js     Limits for bulk removal, own invite links, "joined from" labels, announcement follows and server folders, shared by server and client
├─ docs/BOTS.md            How to write a bot; examples/example-bot is a short working one
├─ docs/DISCORD_BOTS.md    Running a discord.js / discord.py bot on NullChat, and what is not supported
├─ scripts/                setup.js (creates .env), reset-db.js, account.js (list accounts / set a password)
│  └─ unix/                The Mac and Linux versions of the .bat files (start, deploy-fly, account-help, build-installer)
├─ nullchat.sh             Mac/Linux menu for those four jobs; the *.command files do the same by double-click on a Mac
├─ desktop/                Electron desktop app (main.cjs, preload, launcher, installer config)
├─ .github/workflows/      Builds Windows / Mac / Linux installers on GitHub
├─ deploy/                 Caddyfile and nginx example for HTTPS
├─ Dockerfile, docker-compose.yml
└─ .vscode/                Tasks, debug configurations, recommended extensions
```

**Stack**
- **Backend:** Node.js 22+, the built-in `node:http` and `node:sqlite` modules, `ws` for WebSockets, `zod` for input validation and `nodemailer` for email.
- **Database:** SQLite with write-ahead logging (WAL) and foreign keys, plus FTS5 full-text search for messages. It lives in a single file, `data/nullchat.db`, and uploads are stored in `data/uploads/`.
- **Real-time:** a WebSocket gateway (`/gateway`). The client identifies with its session token and receives a `READY` snapshot, then live events (`MESSAGE_CREATE`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`, …). Events are filtered by permission, so each user only receives what they're allowed to see.
- **Voice and video:** a WebRTC mesh using the "perfect negotiation" pattern, signaled over the gateway. The microphone runs through WebAudio (at 48 kHz, the voice codec's own rate) for gain, voice activity detection with a 50 ms look-ahead, push-to-talk and the speaking indicator. Each peer connection's bitrate and priority are set from the number of people in the call (`lib/voice.js`), and the video start bitrate is a one-line hint added to the session description (`lib/sdp.js`, Chrome and Safari follow it; Firefox ignores it). STUN is included; TURN is configurable. A mesh works well for small groups (about 2–8 people per channel).
- **Frontend:** React 19 with a small external store built on `useSyncExternalStore`, a History-API router, and markdown rendered safely without `innerHTML`.

**REST API overview** (all under `/api`, bearer-token auth):
`auth/*` (register, login, mfa, forgot/reset-password, sessions) ·
`users/@me` (profile, avatar, banner, account, settings, presence, relationships, channels, guild settings) ·
`users/search`, `users/:id/profile` ·
`guilds` (CRUD, members, bans, roles, channels, invites, audit-logs, emojis, ack, messages/search) ·
`channels/:id` (CRUD, permissions, recipients, messages, reactions, pins, threads, ack, invites) ·
`users/@me/saved`, `users/@me/scheduled`, `users/@me/export`, `channels/:id/scheduled` ·
`channels/:id/messages/:messageId/report`, `guilds/:id/reports`, `reports/summary`, `reports/:id/status` ·
`announcement` (public), `admin/*` (site admin only, including `admin/reports`) ·
`auth/appeal` + `mod/appeals/*` (suspension appeals) · `channels/:id/posts` (forum posts) · `guilds/:id/insights` · `guilds/:id/bots`, `apps`, `apps/:id`, `apps/:id/install`, `developer/bots*`, `bot/commands`, `interactions/*` (bots, the App Directory and slash commands; see `docs/BOTS.md`) · `v10/*` (also `v9`, `v8`), `cdn/*` and the `/discord-gateway` WebSocket (Discord-compatible bot layer; see `docs/DISCORD_BOTS.md`) · `attachments/:id` (image descriptions) · `guilds/:id/tag`, `guilds/:id/tag/badge`, `guilds/:id/tag-card`, `users/@me/tag` (server tags) · `guilds/:id/members/bulk`, `guilds/:id/members/activity` (remove many members) · `guilds/:id/vanity` (own invite link) · `guilds/:id/join-sources` (counts of joins per "joined from" label) · `guilds/:id/members/@me/avatar` (a picture per server) · `channels/:id/follows`, `follows/:id`, `channels/:id/messages/:messageId/publish` (announcement channels) · `guilds/:id/webhooks`, `webhooks/:id/:token` (webhooks) · `channels/:id/messages/:messageId/components`, `interactions/:id/modal` (bot buttons, menus and forms) · `guilds/:id/template`, `templates/:code`, `templates/:code/guilds` (server templates) · `developer/bots`, `developer/bots/:id/commands|activity`, `developer/webhooks` (Developer Portal) ·
`invites/:code`, `discovery`, `attachments`, `gifs/search`, `gif-favorites` (the star in the GIF picker and on GIFs in chat), `push/*` (closed-app notifications).

---

## 5. Configuration (.env)

`npm run setup` creates `.env` from `.env.example`. Restart the server after editing it. The most important settings:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Server port |
| `PUBLIC_URL` | `http://localhost:5173` | The address users open. Used in email links. |
| `APP_SECRET` | *(random)* | Signs login tickets. **Required and secret in production.** |
| `DATA_DIR` | `data` | Where the database and uploads live |
| `ADMIN_USERS` | *(empty)* | Site admins: usernames or emails, comma separated. Empty means the oldest account. |
| `TRUST_PROXY` | `false` | Set to `true` behind nginx, Caddy or a hosting platform's proxy |
| `MAX_UPLOAD_MB` | `150` | Maximum attachment size in MB (free for everyone, no paid tier) |
| `REGISTRATION_OPEN` | `true` | Allow new sign-ups (the admin can override this while running: Admin Panel → Site) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | – | Real email delivery (any SMTP provider: Gmail app password, Outlook, SendGrid, Mailgun, Brevo…) |
| `GIPHY_API_KEY` | – | Optional: adds a GIPHY tab to the GIF picker, next to the GIFs people on your server upload (free key from developers.giphy.com) |
| `LINK_PREVIEWS` | `true` | Rich link previews |
| `DB_DRIVER` | `auto` | Which SQLite to use: `auto` (Node's built-in `node:sqlite`), or force `node:sqlite` / `better-sqlite3` (see "The database and Node" below) |
| `STUN_URLS` | Google STUN | ICE servers for WebRTC |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | A TURN relay, strongly recommended for calls over the internet |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | – | A voice relay borrowed from Cloudflare instead of running your own (set by `Voice Relay Setup.bat`; see *Voice relay*) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | – | Optional: a LiveKit server for big calls (all three, or none). See `docs/BIG_CALLS.md` |
| `FCM_SERVICE_ACCOUNT` (or `FCM_SERVICE_ACCOUNT_B64`) | – | Optional: Firebase key so the Android phone app gets notifications. See `docs/PHONE_APPS.md` |
| `APNS_KEY` (or `APNS_KEY_B64`), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_SANDBOX` | – | Optional: Apple push key so the iPhone app gets notifications (the four ID/key settings together, or none). See `docs/PHONE_APPS.md` |

Example Gmail SMTP setup: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<16-character app password>`. Gmail requires 2-Step Verification to be turned on before it will issue an app password.

---

## 6. Deploying online

Production uses **one Node process** that serves the API, the WebSocket gateway and the built web app. You need **HTTPS**: browsers block microphone and camera on plain http:// (localhost is the only exception).

### Option A: Docker + Caddy (automatic HTTPS), recommended

On a Linux VPS (DigitalOcean, Hetzner, Linode, AWS Lightsail…) with Docker installed:

1. Point a domain (e.g. `chat.example.com`) at the server's IP with a DNS **A record**.
2. Copy the project to the server, then:
   ```bash
   cp .env.example .env
   # edit .env: NODE_ENV=production, PUBLIC_URL=https://chat.example.com,
   #            TRUST_PROXY=true, APP_SECRET=<long random string>, SMTP_* for email
   nano deploy/Caddyfile        # replace chat.example.com with your domain
   docker compose up -d --build
   ```
3. Open `https://chat.example.com`. Caddy gets and renews the certificate automatically. Data persists in the `nullchat-data` Docker volume.

Generate a strong secret with: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

### Option B: Plain Node.js (any VPS or Windows server)

```bash
npm install
npm run build          # builds client/dist
# set NODE_ENV=production, APP_SECRET, PUBLIC_URL, TRUST_PROXY=true in .env
npm start              # serves everything on PORT (3001)
```

Put a reverse proxy with HTTPS in front of it. `deploy/nginx.conf.example` is a ready-made nginx config that includes WebSocket upgrade headers. Keep the process running with a process manager such as `pm2` (`npm i -g pm2 && pm2 start npm --name nullchat -- start`), or as a Windows service using NSSM.

### Option C: Platforms (Render, Railway, Fly.io)

- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Environment:** `NODE_ENV=production`, `APP_SECRET`, `PUBLIC_URL`, `TRUST_PROXY=true`, and `DATA_DIR` pointing at a **persistent disk/volume** (for example `/data`). Without a persistent volume, data is lost on every redeploy.
- The platform must support WebSockets. All three listed above do.
- **Fly.io, step by step:** double-click `Deploy to Fly.io.bat` (Mac: `Deploy to Fly.io.command`, Linux: `./nullchat.sh deploy`) and follow `SETUP-FLY.md`. The Dockerfile, `fly.toml`, data disk and secret key are all handled for you.

### Voice and video over the internet (TURN)

STUN alone connects most home networks. Users behind strict NATs, mobile carriers or corporate networks need a **TURN relay**:
- Self-host **coturn** (there is a commented-out example in `docker-compose.yml`; open UDP/TCP 3478 and the relay port range), or use a hosted TURN service.
- Set `TURN_URLS=turn:your-domain:3478,turn:your-domain:3478?transport=tcp`, `TURN_USERNAME` and `TURN_CREDENTIAL`.

### Production checklist
- [ ] `NODE_ENV=production` and a long random `APP_SECRET`
- [ ] HTTPS in front (Caddy/nginx/platform) and `TRUST_PROXY=true`
- [ ] `PUBLIC_URL` set to your real https address
- [ ] SMTP configured, so password-reset emails are delivered
- [ ] Persistent storage for `DATA_DIR`, with regular backups of `nullchat.db` and `uploads/`
- [ ] A TURN server if users will call across different networks
- [ ] Optionally `REGISTRATION_OPEN=false` for a private community

### The database and Node

NullChat uses Node's built-in SQLite (`node:sqlite`), which Node still labels *experimental*. To keep a deploy from changing it under you:
- **Node is pinned to an exact version** in the `Dockerfile` (both `FROM` lines). A deploy never moves to a newer Node by itself. To upgrade on purpose: change the version in both lines, deploy, and check **Admin Panel → Overview**, which shows the Node and SQLite versions that are running.
- The server prints its Node and SQLite versions at start-up, and warns if it is running on a Node major version other than the one it is tested on (22).
- **Before a newer build changes the database's structure, a plain copy of the database is saved** to `DATA_DIR/backups/before-upgrade-v<N>-<time>.db` (the newest two are kept). If you have to go back to the previous build, stop the server, copy that file over `nullchat.db`, and start the old build. The upgrade itself is all-or-nothing, and a full disk never stops the server from starting.
- Way out if a future Node changes the built-in SQLite: install `better-sqlite3` next to the server (`npm install better-sqlite3 --workspace server`) and set `DB_DRIVER=better-sqlite3`. The server asks for exactly that driver and fails loudly if it is missing, rather than quietly using another.

### How many people it can handle

Measured here with one CPU core and a 512 MB limit (like Fly's `shared-cpu-1x` with 512 MB), with everyone in one server (`v2/load-test.mjs`):

| People online | Ordinary busy evening | A burst (many people talking in one channel) | Everyone reconnecting at the same moment (a deploy) |
|---|---|---|---|
| 300 | about 3% of the CPU; messages reach everyone in about 15 ms | 15 messages/s: about 30 ms | about 2 s |
| 600 | about 7%; about 20 ms | 28 messages/s: about 60 ms | about 7 s |
| 1,000 | about 20%; about 60 ms | 43 messages/s: it gets sluggish (about 0.2 s, sometimes over a second) | about 20 s |

Memory stays around 250 MB up to 1,000 people. The reconnect after a deploy is the heaviest moment, because the server builds a full picture of the community for each person; the app spreads the reconnects out over several seconds, so people see a short pause rather than a failure. Numbers on a real Fly machine can be lower, since a "shared" CPU is slower under load than this test machine. If you pass about 500 people online, give the machine more CPU (`fly scale vm shared-cpu-2x` or a `performance-1x`). To measure your own setup: `taskset -c 1 node v2/load-test.mjs` with `LT_USERS=300`.

**Scaling:** a single instance comfortably serves small and medium communities. The real-time state lives in memory, so run **one** instance. Voice uses a peer-to-peer mesh, which suits small groups; very large voice rooms would need a media server (SFU), which is outside the scope of this project.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `npm` blocked in PowerShell | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `node:sqlite` / "No such built-in module" | Your Node.js is too old. Install Node 22.13+ LTS. |
| "Still connecting… Is the NullChat server running?" | Make sure `npm run dev` shows both `server` and `client` running, and that nothing else uses port 3001 (`netstat -ano \| findstr :3001`). |
| Port already in use | Change `PORT` in `.env`. If you change it, also start the client with `$env:API_URL="http://localhost:<port>"; npm run dev`. |
| Mic or camera blocked | Click the 🔒 icon in the address bar → allow Microphone and Camera. Use `localhost` or HTTPS. |
| Can't hear anyone / no video across networks | Configure a TURN server (see above). |
| "No microphone found" | Check Windows Settings → Privacy & security → Microphone → allow desktop apps and browsers. |
| Screen share has no audio | In the desktop app (Windows), turn on **Share computer sound** in the share picker. In Chrome and Edge, tick "Share audio" (whole screen or a tab). |
| The screen share picker still looks like a plain list of buttons | You are running an older desktop app. Rebuild and reinstall it (`Build Installer.bat`); the new picker needs the new app, not just a server update. |
| Didn't get a password-reset email | In development, check the server terminal or <http://localhost:3001/api/dev/outbox>. |
| Phone notifications don't arrive when the app is closed | Open Settings → Notifications → *When NullChat is closed*, switch it on, and press *Send test notification*. On iPhone the app has to be added to the Home Screen first. Check that notifications for the browser/app aren't blocked in the phone's settings, that battery saver isn't stopping the browser, and that you aren't in Do Not Disturb. If the bar at the top never appeared, you already answered it (it asks again after two weeks), or notifications are blocked for the site. The number on the app icon needs a phone that supports icon badges (most Android launchers and iPhones with the app on the Home Screen do); notifications work without it. Clearing happens on the device where you read the chat: a second phone keeps its notification until you open the chat there too. |
| Desktop notifications don't show | User Settings → Notifications → enable, then allow notifications in your browser and in Windows Focus Assist. |
| Start fresh | `npm run reset-db` (deletes all data), then optionally `npm run seed`. |

---

## 8. Useful commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run setup` | Create `.env` with a random secret (safe to re-run) |
| `npm run dev` | Development mode: server on 3001 and client on 5173, with hot reload |
| `npm run dev:https` | Same, but the client uses HTTPS (for LAN voice/video testing) |
| `npm run seed` | Add demo users (alice, bob, carol / `nullchat123`) and a demo server |
| `npm run build` | Build the production web client into `client/dist` |
| `npm start` | Run the production server (serves the built client) |
| `npm run reset-db` | Delete the database and uploads |
| `node scripts/account.js list` | Show accounts; also `password <name> <new>`, `unsuspend <name>`, `mfa-off <name>` |
| `npm run desktop` | Run the desktop app (without building an installer) |
| `Build Installer.bat` (double-click) | Build the one-click Windows installer → `desktop/release/NullChatSetup.exe` |
| `npm run desktop:win` | Same, from the terminal (set `NULLCHAT_SERVER_URL` first to bake in your server) |
| `npm run desktop:mac` | Build the Mac apps (Apple Silicon + Intel `.dmg`) → `desktop/release/`. Run on a Mac, or use the GitHub workflow. |
| `npm run desktop:linux` | Build Linux `.AppImage` + `.deb` → `desktop/release/`. Run on Linux, or use the GitHub workflow. |
| `./nullchat.sh` | Mac/Linux menu: start, deploy to Fly.io, account help, build the desktop app (also `./nullchat.sh start`, `deploy`, `account`, `installer`) |
| `*.command` files | The same four jobs by double-click on a Mac (`Start NullChat`, `Deploy to Fly.io`, `Account Help (Fly.io)`, `Build Installer`) |

**Keyboard shortcuts (defaults):** `Ctrl+K` quick switcher · `Ctrl+/` all shortcuts · `Ctrl+Shift+M` mute · `Ctrl+Shift+D` deafen · `Ctrl+Shift+V` camera · `Alt+↑/↓` previous/next channel · `Alt+Shift+↑/↓` unread channels · `Esc` mark channel read and jump to the newest messages (when you have scrolled up; it leaves open windows, menus, replies and the search box alone) · `Shift+Esc` mark server read · `Ctrl+U` member list · `Ctrl+F` search · `Ctrl+,` settings · `Ctrl+Enter` answer call.


## The desktop app is locked to your server

When a server address is baked into the installer (`desktop/app-config.json` → `serverUrl`, which `Build Installer.bat` sets for you), the app can only ever talk to that server:

- There is no **Switch Server** in the menu, the tray icon, the login screen or Settings, and the "Host on this computer / Join a server" screen never appears. If the server can't be reached the app shows a plain **Can't connect → Try again** screen.
- It is enforced inside the app, not just hidden: requests to switch are refused, and a server choice saved by an older install (for example "Host on this computer") is replaced by yours the first time the new version starts.
- This also fixes "my browser account won't log in in the app": every copy of the app uses the same server as the website, so the same accounts work in both.

Want a build that can switch servers (for testing, say)? Set `"allowServerSwitch": true` in `desktop/app-config.json`, or set `NULLCHAT_ALLOW_SERVER_SWITCH=1` before building. A build with no server baked in is never locked.

If the app already says it is on `nullchat.fly.dev` and your login is still refused, the account isn't on that server (or the password differs). Run `Account Help (Fly.io).bat` and choose **1** to list the accounts that exist there, or **2** to set a new password.


## Updates: the "Update" button (browser and app)

When you deploy a new version (`Deploy to Fly.io.bat`), everyone who has NullChat open gets an **Update** bar:

- **Browser and installed web app:** the server gives every build a short id (shown in *Settings → Advanced → Updates* and at the bottom of the settings menu). Open pages compare their id with the server's, right after the connection comes back (a deploy restarts the server), when you switch back to the tab, and every 5 minutes. A mismatch shows *"A new version of NullChat is ready"* with **Update**, which reloads into the new version. **Later** hides it for that version.
- **Desktop app:** it loads the same website, so web updates work exactly the same way, with no reinstall. Changes to the app itself (a new installer from `Build Installer.bat`, with a higher version number in `desktop/package.json`) are downloaded in the background and the bar changes to *"NullChat X is ready to install" with **Restart to update***. If you pick Later it installs the next time the app is closed.
- **Voice calls:** if you are in a call, Update asks first, because reloading hangs up.
- **Settings → Advanced → Updates** has **Check for updates** (and **Update now** when one is waiting) in both the browser and the app.

You don't need to do anything extra. The build id is calculated from the built site automatically, so every deploy that changes the client is picked up. (A deploy that only changes server code doesn't show the bar, since nothing in the page needs reloading.)

### The "What's new" window

After an update, each person sees a small **What's new** window once, listing the new features (with a **Try it** button where there is somewhere to go). It is remembered per account, so it doesn't come back on another device, and people who joined after the update never see it, since nothing is new to them. If someone skipped a few updates they see everything since the last one they saw (up to three). It can be reopened any time from *Settings → Advanced → Updates* or *Settings → What's New & Help*.

**To announce an update, add one entry at the top of `RELEASES` in `client/src/lib/changelog.js`** (the file explains the fields), then deploy. Give it a new `id` (today's date, e.g. `'2026-11-20'`), the time you wrote it as `ts`, a short `title`, and one to six `items` (an icon name from `components/icons.jsx`, a name, and one plain sentence; add `to: '/apps'`, or any in-app path, for a *Try it* button). Don't edit old entries, and only list things that are really in this build. A deploy without a new entry shows nothing.
