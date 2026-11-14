# Put NullChat online with Fly.io

After this, anyone can join through a normal link like `https://your-name.fly.dev/invite/abc123`.
No localhost, no keeping your PC on.

## One-time setup (about 10 minutes)

1. **Unzip** the project. Open the folder named **`nullchat`**. You should see a file called `Dockerfile` in it.
2. **Double-click `Deploy to Fly.io.bat`** (Windows). On a Mac double-click `Deploy to Fly.io.command` (if macOS blocks it, right-click it → Open). On Linux open a terminal in the folder and run `./nullchat.sh deploy`.
3. When a browser window opens, **sign up for Fly.io** and add a payment method (Billing page). Fly requires a card even for small apps.
4. Back in the window, **type a name** (or press Enter for the default). Names are lowercase letters, numbers and dashes. If it's taken, run the file again and pick another.
5. **Wait** while it uploads and starts the server. The first deploy takes a few minutes.
6. Your site opens in the browser. **Create your account** (the first account is the admin and owns a ready-made community server called **Nullspace**; every person who signs up after you is added to it automatically so they can meet each other). Make your own server too if you like, click **Invite People**, and send the link.

Friends open the link in any browser. They do not need to install anything.

## Mac and Linux

Nothing to build: on a Mac or Linux computer, open NullChat in Chrome, Edge or Brave and click **Download Apps → Install NullChat** (Safari on a Mac: **File → Add to Dock…**). Send friends the **`/install`** page of your server and it tells them the right steps for their computer. It gets its own window and icon. Real installers (`.dmg`, AppImage, `.deb`) are optional; see below.

## The optional desktop app

Double-click **`Build Installer.bat`** and press Enter when it asks for the server address (it's already filled in). Share the `NullChatSetup.exe` it creates. A Mac builds its own app with `Build Installer.command` (a `.dmg`) and a Linux PC with `./nullchat.sh installer` (an AppImage and a `.deb`); each system has to build its own, or use the GitHub workflow in `README.md` to get all three. This one connects to your online server, unlike the old installer that pointed at localhost.

**Screen sharing:** the desktop app has its own screen picker inside NullChat (every screen and window with a preview). A normal browser can't do that, because browsers always show their own picker. So to share the screen "in the app", use the desktop app.

**Updating people who already have the app:** after the installer build finishes, run the Deploy script again (`Deploy to Fly.io.bat`, `Deploy to Fly.io.command` or `./nullchat.sh deploy`). The build copies the installer into the project's `downloads` folder, so your online server offers it, and every installed NullChat updates itself the next time it starts (you can also check under Settings, Advanced, Desktop App). Updates only happen when the version number is higher; this version is 1.5.0.

## Using it on a phone

NullChat works in any phone browser (Safari on iPhone, Chrome on Android). Friends just open your invite link, make an account and they're in. Nothing to install.

- **Getting around:** it works like Discord's phone app. The first screen is your servers and channels; tap a channel to open the chat, and use the back arrow (or swipe right) to return. Swipe left in a server chat to see its members. The bar along the bottom switches between **Home**, **Friends**, **Inbox** and **You** (your settings). Swipe a message to the left to reply to it, and pinch a photo to zoom.
- **Message actions** (reply, react, edit, copy, delete): press and hold a message.
- **Rearranging channels** (server owners and anyone with Manage Channels): tap the server name, choose **Reorder Channels**, then drag the handles on the right of each channel and category. Press **Done** when you are finished.
- **Make it a real app on the home screen:** phone visitors see a **Get the NullChat app** bar at the top. On Android it installs in one tap. On iPhone it shows the steps (Share, then **Add to Home Screen**). It then opens full screen with its own icon, like any other app. You can also send friends the page **`https://YOUR-APP.fly.dev/install`**, which explains it for their phone.
- **Voice and video** work on the `https://...fly.dev` address, and the phone will ask permission for the microphone and camera the first time.

## Get an Android app file (APK) for your friends

The home-screen install above already behaves like an app. If you also want a downloadable **Android app file**, make one for free:

1. Open **pwabuilder.com**, enter your address (for example `https://nullchat.fly.dev`) and press Start.
2. Choose **Package for stores → Android**. Pick a package ID such as `app.nullchat.yourname` and let it create a new signing key. **Keep the key file and its password** somewhere safe.
3. Download the result and unzip it. Copy the **`.apk`** file into the project's **`downloads`** folder and name it `NullChat.apk`. If the zip has an **`assetlinks.json`**, copy that into the same folder too (it makes the app open without a small address bar at the top).
4. Run `Deploy to Fly.io.bat` again.

Android phones now see a **Download the Android app** button in the install screen. Android asks to allow installs from the browser the first time.

iPhone can't take app files like this. Apple only allows them through the App Store, which needs a Mac and a paid Apple developer account, so iPhone users use **Add to Home Screen** (it works the same way).

The `downloads` folder also works for the Windows installer: drop `NullChatSetup.exe` in it and redeploy.

## Updating later

Change anything in the project, then double-click `Deploy to Fly.io.bat` again and press Enter at the name question. Your accounts, messages and uploads are kept on the data disk.

## Settings you can add later

Run these in PowerShell inside the `nullchat` folder (the Fly tool is installed by the deploy script). Each one restarts the server.

| What | Command |
| --- | --- |
| Email for password resets | `fly secrets set SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=you SMTP_PASS=secret "MAIL_FROM=NullChat <no-reply@yourdomain.com>"` |
| GIF picker | `fly secrets set GIPHY_API_KEY=your-key` |
| **Voice that works for everyone** (people who can't hear or be heard) | Double-click **`Voice Relay Setup.bat`** and follow it: you make a free relay key on Cloudflare's site and paste two values. See *Voice relay* in the README. |
| Better voice and video across strict networks | `fly secrets set TURN_URLS=turn:your-turn-server:3478 TURN_USERNAME=user TURN_CREDENTIAL=pass` |
| Bigger voice calls and screen shares (more than about 8 people) | Make a free LiveKit Cloud project, then `fly secrets set LIVEKIT_URL=wss://your-project.livekit.cloud LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...`. Everyone reloads the page once. Full steps and honest limits: `docs/BIG_CALLS.md`. |
| Notifications for the Android and iPhone apps (only if you build them from `mobile/`) | `node scripts/phone-notification-keys.cjs --android firebase-key.json` and/or `--ios AuthKey_XXXXXXXXXX.p8 --team-id YOURTEAMID`. It checks the files and runs `fly secrets set` for you. Steps, and what is and isn't tested: `docs/PHONE_APPS.md`. |
| Make someone the site admin (see the Admin Panel) | `fly secrets set ADMIN_USERS=yourusername` (several: `ADMIN_USERS=you,friend@example.com`). Without it, the oldest account is the admin. |
| Your own domain (for example chat.yourdomain.com) | `fly certs add chat.yourdomain.com`, point a DNS record at the addresses it shows, then `fly secrets set PUBLIC_URL=https://chat.yourdomain.com` |

Without email set up, password reset emails can't be delivered. If a friend forgets their password, open **Settings → Admin Panel → Users**, pick their account and press **Reset password…**: it makes a one-time link you send them yourself. (`Account Help (Fly.io).bat` can also set a password for you.) Registration is open by default; do not set `REGISTRATION_OPEN=false` unless you want to block invited friends from signing up too. You can also open and close sign-ups any time without redeploying: **Settings → Admin Panel → Site**.

## Looking after your users (admin panel)

The person who made the first account is the site admin. Open **Settings (gear) -> Admin Panel** to:

- see every account and server, with a search box,
- **suspend** someone (they are logged out and can't log back in; you can restore them any time),
- **delete** an account or a whole server for good (you have to type its name first),
- see what other admins did in the **Activity** log.
- under **Site**, switch the **Nullspace lounge** auto-join on or off, and close or open sign-ups.

You can't read anyone's messages from there, and you can't act on your own account. To change who is admin, set `ADMIN_USERS` (table above), then restart.

## Free "Nitro" perks (everything is free for everyone)

There is no paid tier, so everybody gets all of this, with no setup:

- **Profile themes**: a two-colour gradient on your profile card (Settings > Profiles).
- **Animated avatars and GIF banners**: upload a GIF, up to 10 MB for avatars and 15 MB for banners.
- **Avatar decorations**: ready-made ones, a designer for your own, or upload your own artwork (PNG, GIF or WebP, up to 3 MB) to wrap around your avatar. The admin gets a special Admin Crest only they can use. Plus **styled display names** (font, glow/neon/shimmer/outline, one or two colours).
- **Custom app themes**: 13 presets, your own background colour, an optional sidebar gradient, and shareable theme codes (Settings > Appearance).
- **Bigger uploads**: 150 MB per file. Change it with `fly secrets set MAX_UPLOAD_MB=200` if you want more.
- **Sharper screen sharing**: up to 1440p at 60 frames per second.
- **Longer messages** (4000 characters) and **custom and animated emoji** you can use in every server.

Bigger uploads need disk space. The deploy script creates a **3 GB** disk. If you already deployed before and have the old 1 GB disk, grow it (it never shrinks, and nothing is lost):

```
fly volumes list
fly volumes extend <volume-id> -s 3
```

A bigger disk costs a little more each month (about 15 cents per GB on Fly).

## Backups

Your data is protected two ways, both automatic:

- **Fly disk snapshots:** a daily copy of the whole data disk (database and uploads), kept for 14 days.
  List them with `fly volumes snapshots list`.
- **Database backups made by NullChat:** every 12 hours it saves a compressed copy of the database to
  `/data/backups` on the same disk and keeps the newest 3. They show up in `fly logs` as `[backup] saved ...`.
  Change this with `fly secrets set BACKUP_EVERY_HOURS=6 BACKUP_KEEP=5`, or turn it off with `BACKUPS=false`.

To save a copy to your own PC, the easy way is **Settings → Admin Panel → Backups → Download** (you re-enter your
password first; you can also press **Back up now** to make a fresh one). The file holds every account and private
message, so keep it somewhere private. The command-line way still works:
`fly ssh sftp get /data/backups/<file name> .` (run `fly ssh console -C "ls /data/backups"` to see the names).

Backups contain the database only. Uploaded pictures and files live on the disk and are covered by Fly's daily snapshots.

### Restoring a backup

Use this if something went badly wrong and you want to go back to an earlier copy (everything said since that copy
is lost). It is safe: the database it replaces is kept.

1. Have the backup file on your PC (for example `nullchat-20261105-0133.db.gz` from the Admin panel).
2. In a PowerShell window in the project folder, run `fly ssh sftp shell`, then at the prompt type
   `put "C:\Users\you\Downloads\nullchat-20261105-0133.db.gz" /data/restore.db.gz` and press Enter, then type `exit`.
3. Run `fly apps restart`.

When the server starts it checks the file (it must be a healthy NullChat database that this version understands) and
swaps it in. `fly logs` shows `[restore] restored the database from restore.db.gz`. The database it replaced is kept in
`/data/backups/before-restore-<date>/` (delete that folder once you are sure you don't need it). If the file is damaged
or from a newer version, the server says why in `fly logs`, sets the file aside as `restore-rejected-...` and carries on
with the current database, so a bad file can't break anything. Everyone stays signed in only if their sign-in existed when
the backup was made; otherwise they just log in again.

## Handy commands

| What | Command |
| --- | --- |
| See what the server is printing | `fly logs` |
| Check it is running | `fly status` |
| Restart | `fly apps restart` |
| Open a shell on the server | `fly ssh console` |
| See every account / set a new password | double-click `Account Help (Fly.io).bat` (Mac: `Account Help (Fly.io).command`, Linux: `./nullchat.sh account`) |
| List disk backups (Fly keeps daily snapshots) | `fly volumes snapshots list` |

## If something goes wrong

- **"Login or password is invalid" for an account you made earlier**: that message means *the server you are logging in to* has no account with that name and password. NullChat does not lose accounts when you redeploy, so the usual cause is that you are on a different server than the one you signed up on (for example the old `nullchat-damen.fly.dev` address, a copy running on your own PC, or a new Fly app with a new empty disk after renaming). Double-click `Account Help (Fly.io).bat` and choose **1** to see which accounts exist on the server you are using. If your account is listed, choose **2** to set a new password (the "forgot password" email only works once email is set up). If the list is empty, the account lives on the other server: either sign in there, or just create the account again here.
- **"Could not find a Dockerfile, nor detect a runtime or framework"**: the command ran in the wrong folder. Don't run `fly launch` by hand. Use `Deploy to Fly.io.bat`, which always starts in the right place. The right folder is the one containing `Dockerfile`, `fly.toml` and `package.json`.
- **"Name has already been taken"**: pick a different app name.
- **Payment or billing error**: add a card in the Fly dashboard, then run the file again.
- **The site shows an error after deploying**: run `fly logs` and look for the last red line.
- **Some people can't hear each other, or can't be heard**: their networks block direct calls. Run **`Voice Relay Setup.bat`** once; it gives every call a relay to fall back on.
- **Cost**: the server runs all the time, which costs a few dollars a month. See https://fly.io/docs/about/pricing/ for current prices. To lower it, open `fly.toml` and follow the comment under `[http_service]` to let it sleep when idle.
