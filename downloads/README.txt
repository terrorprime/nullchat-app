Files in this folder are offered for download inside NullChat ("Get the app") and are shipped with every deploy.

Put your finished app files here, then run the Deploy script again ("Deploy to Fly.io.bat", "Deploy to Fly.io.command" on a Mac, or ./nullchat.sh deploy on Linux).
The Build Installer scripts copy their results in here for you:

  NullChat.apk          the Android app  -> shown to Android phones
  NullChatSetup.exe     the Windows installer
  *.dmg / *.AppImage    Mac and Linux installers (the full desktop app)
  *-launcher.*          the light Mac / Linux versions (a Mac .zip, a Linux .deb and .tar.gz) that open NullChat
                        in its own window using Chrome, Edge or Brave. Built by scripts/launchers/build.sh
  assetlinks.json       (Android app only) the file PWABuilder gives you; it lets the Android app open
                        NullChat full screen without a browser bar

See "Get an Android app" in SETUP-FLY.md.

IMPORTANT: a deploy replaces what the server offers with what is in this folder. Keep NullChatSetup.exe here
(and its .blockmap and latest.yml) or the Windows download disappears. When you unzip a new NullChat
update, unzip it over your existing folder (choose "Replace" or "Skip") instead of into a new folder.
