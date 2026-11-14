# Phone apps (Android and iPhone)

NullChat already works on a phone: open your server's address in the browser, or use **Add to Home Screen** and it runs full screen with its own icon (and notifications, see the README). The phone apps in the `mobile/` folder are the other way to get it there: a **real app** you install from a file, TestFlight or an app store, that opens your NullChat in a native shell and can use the phone's own notification systems (Google's for Android, Apple's for iPhone).

You don't have to do any of this. Do it if you want one of these:

- an app people install like any other (and, later, an app-store listing),
- notifications on Android without relying on Chrome,
- notifications on an iPhone from an app that isn't a Home Screen shortcut.

You can build the apps without Android Studio, Xcode or a Mac: GitHub builds them for you (the same way it builds the desktop installers, see "Build every installer on GitHub" in the README).

---

## What is real and what isn't (read this first)

**What was tested while this was written.** The build scripts were run against Capacitor's own project templates (the files its `cap add` command creates), and the results were checked: the permissions, icons, version numbers, notification setup and signing setup. The Android signing setup was run in a real Gradle (with a stand-in for Google's Android plugin, which can't be downloaded there). The GitHub workflow's shell steps were run with a stand-in for Apple's build tool. The website side of notifications (turning them on, sending the phone's token to your server, opening the right chat when you tap one) was run in a browser against Capacitor's real native-bridge code, and the server's sending to Firebase and Apple was run against stand-in servers.

**What was not tested, because it can't be from where this was written.** An actual build: there is no Android SDK, no Xcode and no connection to Google's or Apple's services there. So nobody has yet installed these apps on a real phone, received a real notification, or uploaded a build to TestFlight. Expect that the **first Android build might need a small fix**, and that the **iPhone build is the most likely to need one** (it is marked experimental in the workflow for that reason). If a step fails, the red error text in the GitHub run says what; see "If a build step fails" at the bottom.

**What the apps can't do** (these come from phones, not from NullChat):

| | |
|---|---|
| **Share your screen** | Not from the phone apps. Phones' built-in web views don't allow it. You can watch other people's screen shares. |
| **Stay in a call with the app in the background** | The app has to stay open on screen. Switching to another app can cut your microphone after a while. (Apps that keep calls going in the background do it with extra native code that isn't part of these apps.) |
| **Save files from chat** | Expect the download buttons (attachments, *Export my data*, backups) **not to work** in the apps: Capacitor's shell has no file-download handler (checked in its source) and nothing here adds one. Pictures and videos show in the app. To save a file, open NullChat in the phone's browser. Not tested on a phone. |
| **Open NullChat links from other apps** | Tapping a NullChat link in Messages or a browser opens the browser, not the app. Links aren't wired to the app. |
| **Keep message text private from Google and Apple** | Browser notifications are encrypted so the browser makers can't read them. Phone-app notifications can't be: they go through Google's and Apple's services, which can see the title and text. *Settings → Notifications → Show message text* turned off keeps the text out: they then only say "New message". |

**The App Store question.** The app shows your live website inside the native shell. That is what makes it update by itself (see below), but Capacitor's own documentation says this setting (`server.url`) is meant for live-reload servers and "is not intended for use in production", and Apple's review rules let a reviewer reject an app that is mostly a repackaged website. TestFlight for you and your friends is fine. A public App Store listing might be rejected, and there is no way to promise it won't be. Google Play is more relaxed, but it can ask the same question.

**Updates are automatic.** Because the app shows your server's NullChat, deploying your server updates every phone app straight away. You only build the apps again if you change the name, icon, server address or appId, or want newer Android/iPhone components.

---

## Android

### 1. Build it (no accounts needed)

1. Put the NullChat folder on GitHub and add the repository variable `NULLCHAT_SERVER_URL`, exactly as in the README's **Build every installer on GitHub** steps 1 to 3. If you already did that for the desktop apps, it is done.
2. On GitHub open the repository → **Actions** → **Build phone apps** (left side) → **Run workflow**. Leave *Which app to build* on **android** → **Run workflow**.
3. About 10 minutes later the run has a green tick. Open it and download **NullChat-Android** from **Artifacts** at the bottom. Unzip it: the app is `apk/debug/app-debug.apk`.
4. Get that file onto your phone (email it to yourself, a cable, a cloud drive) and open it. Android asks to allow installing apps from this source: allow it for that one app (Files or your browser). If Play Protect warns about an unknown developer, that is because you built it yourself.
5. Open NullChat, log in, and use it. Voice and video ask for the microphone and camera the first time.

> **One catch with this basic build:** every run on GitHub starts on a fresh machine, so every build is signed with a different temporary key, and Android refuses to install a new build over an old one signed with another key ("App not installed"). Uninstall the old app first, or do **Your own signing key** below once and your builds will update in place.

### 2. Your own signing key (recommended; needed for Google Play)

You make one key file, once, and keep it forever. **If you lose it you can never update the app in Google Play. Back it up somewhere safe, and never put it in git** (`mobile/.gitignore` already keeps it out).

1. Install Java if you don't have it (for example **Temurin 21** from adoptium.net) and open a terminal in any folder.
2. Run (answer the questions; when it asks for a key password, pressing Enter means "same as the keystore password"):

   ```
   keytool -genkeypair -v -keystore nullchat-release.jks -alias nullchat -keyalg RSA -keysize 2048 -validity 10000
   ```
3. Turn the file into text GitHub can store (PowerShell; it copies it to your clipboard):

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("nullchat-release.jks")) | Set-Clipboard
   ```
4. On GitHub: repository → **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Make these four:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | what you just copied |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password you chose |
   | `ANDROID_KEY_ALIAS` | `nullchat` (the `-alias` above) |
   | `ANDROID_KEY_PASSWORD` | the key password (the same as the keystore password if you pressed Enter) |
5. Run **Build phone apps** again. The artifact now also has `apk/release/app-release.apk` (install this one) and `bundle/release/app-release.aab` (what Google Play takes).

### 3. Android notifications (Firebase, free)

Firebase's and Apple's pages change now and then. If a button or menu is named slightly differently from what is written here, look for the closest one.

Notifications to Android apps go through Google's Firebase Cloud Messaging. Two files are involved: one goes **into the app**, the other goes **onto your server**. They are different files with similar names.

1. Go to <https://console.firebase.google.com>, **Add project**, give it any name (you can turn Google Analytics off).
2. In the project, click the Android icon to **add an Android app**. The *Android package name* must be exactly your appId: `chat.nullchat.app` unless you changed it in `mobile/nullchat-app.json`. Register it and **download `google-services.json`**. Skip the rest of Firebase's instructions.
3. **Into the app:** on GitHub make a repository secret named `GOOGLE_SERVICES_JSON` and paste the **whole text** of that file into it. Run **Build phone apps** again (and install the new app). The build checks the package name matches and tells you if it doesn't.
4. **Onto your server:** in Firebase, **Project settings → Service accounts → Generate new private key**. Save the JSON file it gives you. In a terminal in your NullChat folder run:

   ```
   node scripts/phone-notification-keys.cjs --android "C:\path\to\that-file.json"
   ```
   (You can drag the file onto the terminal window to type its path.) This runs `fly secrets set` for you; Fly restarts your server by itself. The command checks you picked the right file: it refuses `google-services.json` here and says which one it wants. Add `--dry-run` to check without changing anything.
5. In the app: **Settings → Notifications → When NullChat is closed → turn on**. Android 13 and newer asks for permission. Your Admin Panel (Overview) now lists *Phone app notifications: Android on (1 phone)*.

---

## iPhone (experimental: never run)

You need a paid **Apple Developer Program** membership (about $99 a year) at <https://developer.apple.com/programs>. You don't need a Mac: GitHub builds the app on a Mac of its own and sends it to **TestFlight**, Apple's way of installing apps on iPhones before (or without) the App Store. GitHub Mac minutes count ten times, so a 15 minute build uses about 150 of your 2,000 free monthly minutes.

### 1. Set up the app with Apple

1. At <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles → Identifiers → +** → **App IDs** → **App** → continue. Description: NullChat. **Bundle ID: Explicit**, exactly your appId (`chat.nullchat.app` unless you changed it). Under **Capabilities** tick **Push Notifications**. Register.
2. At <https://appstoreconnect.apple.com> → **Apps → + → New App**. Platform iOS, any name, language, **Bundle ID: the one you just registered**, any SKU.
3. Still in App Store Connect: **Users and Access → Integrations → App Store Connect API → Team Keys → +**. Name it NullChat build, access **Admin** (App Manager may also be enough), and generate. Download the `.p8` file **now** (Apple shows it once), and write down the **Key ID** and the **Issuer ID** shown on that page.
4. Your **Team ID** is on developer.apple.com under **Membership details** (10 letters and digits).
5. On GitHub add four repository secrets:

   | Secret | Value |
   |---|---|
   | `APPLE_TEAM_ID` | your Team ID |
   | `ASC_KEY_ID` | the key's Key ID |
   | `ASC_ISSUER_ID` | the Issuer ID |
   | `ASC_KEY_P8` | the whole text of the `.p8` file (open it in Notepad, select all, paste) |

### 2. Build and install

1. **Actions → Build phone apps → Run workflow → ios** (or *both*). It archives the app, signs it automatically with your Apple account, and uploads it to TestFlight. If it stops at the first step, the error names the secret that is missing.
2. A few minutes after it finishes the build appears in App Store Connect → your app → **TestFlight** (Apple "processes" it first). The first time, Apple may ask an export-compliance question: the app only uses standard HTTPS, but that answer is yours to give.
3. Add yourself under **Internal Testing** (people on your Apple developer team, up to 100, no Apple review). Install Apple's **TestFlight** app on the iPhone, accept the invite, install NullChat. Friends outside your team need **External Testing**, which Apple reviews once.

### 3. iPhone notifications

This needs a **second** `.p8` file, different from the build key above:

1. developer.apple.com → **Certificates, Identifiers & Profiles → Keys → +**. Name it NullChat notifications, tick **Apple Push Notifications service (APNs)**, continue, register, **download the `.p8`** (shown once). Its file name is `AuthKey_` + the key's Key ID.
2. In a terminal in your NullChat folder:

   ```
   node scripts/phone-notification-keys.cjs --ios "C:\path\to\AuthKey_XXXXXXXXXX.p8" --team-id YOURTEAMID
   ```
   The Key ID is read from the file name and the bundle id from `mobile/nullchat-app.json`. TestFlight and App Store builds use Apple's **production** push service, which is the default. Only add `--sandbox` if you run the app straight from Xcode on your own phone (a server can serve one kind at a time).
3. In the app on the iPhone: **Settings → Notifications → turn on**, allow when iOS asks.

---

## Change the name, server or appId

Everything is in **`mobile/nullchat-app.json`**:

| Setting | |
|---|---|
| `appName` | The name under the icon. Up to 30 characters. |
| `appId` | The app's permanent identity, like `chat.yourname.nullchat`. Letters and digits in dot-separated parts. **Changing it makes a different app** to Google and Apple: new Firebase Android app and `google-services.json`, new App ID and TestFlight app, and `--bundle-id` for notifications. |
| `serverUrl` | Your server, `https://…`. Empty means: the `NULLCHAT_SERVER_URL` GitHub variable, else the desktop app's address, else the `PUBLIC_URL` in `fly.toml`. Must be `https` (voice, camera and notifications don't work without it). |
| `versionName`, `versionCode` | The number people see, and the build number stores compare. The GitHub build sets the build number itself (the run number), so it always goes up. |

The icons and launch screens are in `mobile/resources`. They are the NullChat logo; `make-icons.py` redraws them if you change it.

---

## If a build step fails

Open the failed run on GitHub, click the step with the red cross and read the last lines. The common ones:

- **"…is for com.something, but this app's appId is…"**: the `google-services.json` was made for a different Android package name. In Firebase add an Android app with exactly your appId and download the file again.
- **"Capacitor may have changed its template"**: the build tools update themselves, and a new Capacitor version moved something these scripts patch. In `mobile/package.json` change each `"^8.0.0"`-style version of `@capacitor/…` to the exact versions this was written against (`8.6.0` for `core`, `cli`, `android` and `ios`; `8.1.3` for `push-notifications`), and run again.
- **Android says "App not installed"**: an older build is installed with a different signing key. Uninstall it first, or set up your own signing key.
- **iPhone: "No profiles for … were found", or the profile "doesn't include the aps-environment entitlement"**: the App ID in step 1 is missing or doesn't have Push Notifications ticked.
- **iPhone: the upload says the app doesn't exist**: do step 2 (New App in App Store Connect) with the same bundle id.
- **The Notifications switch says the server isn't set up**: the server key step for that kind of phone hasn't been done (Android: step 4 of "Android notifications"; iPhone: step 2 of "iPhone notifications"), or Fly hasn't finished restarting.
- **iPhone notifications never arrive but Android's do**: almost always sandbox vs production. TestFlight builds need the default (no `--sandbox`); a build run from Xcode needs `--sandbox`. Run the key command again with the other choice.
- **The microphone or camera is refused**: phone Settings → Apps → NullChat → Permissions (Android), or Settings → NullChat (iPhone).

If you get stuck, copy the red error text from the GitHub run: it is usually enough to say what to change.

---

## For reference

**Where things are**

| | |
|---|---|
| `mobile/` | The project. `npm run android:add` and `npm run ios:add` (run there, after `npm install`) create the native projects; the GitHub workflow does exactly this. |
| `mobile/scripts/` | `configure.mjs` writes Capacitor's settings from `nullchat-app.json`; `patch-android.mjs` and `patch-ios.mjs` add permissions, icons, notification setup, version numbers and signing. They are safe to run again. |
| `mobile/www/index.html` | The "Can't reach NullChat" page the app shows when your server is down or the phone is offline, with a Try again button. |
| `.github/workflows/mobile.yml` | The build. Runs only when you start it. |
| `scripts/phone-notification-keys.cjs` | Puts the Firebase and Apple keys on your server. |

**Settings on the server** (the helper sets them for you; if you run NullChat yourself, put them in `.env`, or use `--env` to print the lines)

| Setting | |
|---|---|
| `FCM_SERVICE_ACCOUNT_B64` (or `FCM_SERVICE_ACCOUNT`) | The Firebase service account key file (base64 of the file, or the JSON itself). Android notifications. |
| `APNS_KEY_B64` (or `APNS_KEY`) | The Apple `.p8` notification key. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | That key's ID, your Team ID, and the iPhone app's bundle id. |
| `APNS_SANDBOX` | `true` only for apps run from Xcode. Default `false`. |

If only part of an Apple or Firebase setting is given, the server prints a warning when it starts and leaves that kind of phone off; everything else keeps working.

**Secrets on GitHub** (all optional except the Apple ones for iPhone): `GOOGLE_SERVICES_JSON`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`. **Variable:** `NULLCHAT_SERVER_URL`.
