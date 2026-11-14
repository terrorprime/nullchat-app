#!/usr/bin/env bash
# Build the NullChat desktop app for THIS computer: a .dmg on a Mac, an AppImage + .deb on Linux.
# (Windows: "Build Installer.bat".) Each system builds its own app; to get all three without owning all three
# computers, use the "Build desktop apps" GitHub workflow (see the README).
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [ "$NC_MAC" = 1 ]; then TARGET="desktop:mac"; WHAT="Mac app (.dmg)"; TAG="mac"
else TARGET="desktop:linux"; WHAT="Linux app (AppImage + .deb)"; TAG="linux"; fi

say
say "  ============================================="
say "     NullChat  -  build the $WHAT"
say "  ============================================="
say

need_node 22.13

BAKED="$(node scripts/fly-rename.cjs --print-url)"
if [ -n "$BAKED" ]; then
  say "The app is set to open your online server:  $BAKED"
  say "  - Press Enter to keep it, or type a different address."
  say
  ask "Server address [$BAKED]: "
  NULLCHAT_SERVER_URL="${REPLY_TEXT:-$BAKED}"
else
  say "Which NullChat server should the app open automatically?"
  say "  - Type its address, e.g.  https://chat.example.com   or   192.168.1.23:3001"
  say "  - Or just press Enter: the app will ask on first launch"
  say '    ("Host on this computer" or "Join a server").'
  say
  ask "Server address: "
  NULLCHAT_SERVER_URL="$REPLY_TEXT"
fi
export NULLCHAT_SERVER_URL

say
say "[1/2] Installing tools (first time takes a few minutes)..."
npm install --no-audit --no-fund || die "Install failed. Check your internet connection."

# Old builds are removed first so only the current version is published below.
rm -f desktop/release/*-"$TAG"-* "desktop/release/latest-$TAG.yml"
say
say "[2/2] Building the $WHAT ..."
npm run "$TARGET" || die "Build failed - scroll up to see why."

# Publish the app + its update file:
#   data/downloads  = the server running on this computer
#   downloads       = shipped with every deploy, so your online server offers them too
#                     and apps that are already installed update themselves.
mkdir -p data/downloads downloads
rm -f data/downloads/*-"$TAG"-* downloads/*-"$TAG"-* "data/downloads/latest-$TAG.yml" "downloads/latest-$TAG.yml"
shopt -s nullglob
FOUND=0
for f in desktop/release/*-"$TAG"-* "desktop/release/latest-$TAG.yml"; do
  [ -f "$f" ] || continue
  cp -f "$f" data/downloads/ && cp -f "$f" downloads/ && FOUND=1
done
[ "$FOUND" = 1 ] || die "The build finished but no app files were found in desktop/release."

say
say "  Done!  Your app files are in:  desktop/release"
ls -1 desktop/release/*.dmg desktop/release/*.AppImage desktop/release/*.deb 2>/dev/null | sed 's/^/    /'
say
if [ "$NC_MAC" = 1 ]; then
  say "  - Open the .dmg and drag NullChat into Applications."
  say "    (First launch: right-click the app -> Open, because it is not signed by Apple.)"
else
  say "  - AppImage: make it runnable and start it:   chmod +x desktop/release/*.AppImage && desktop/release/*.AppImage"
  say "  - Debian/Ubuntu:   sudo apt install ./desktop/release/*.deb"
  say "    (If the AppImage will not start on Ubuntu 24.04 or newer, use the .deb, or start the AppImage with --no-sandbox.)"
fi
say "  - To update the app for everyone who already has it, run the Deploy script now."
say "    The new files were copied into the \"downloads\" folder, so your online server offers them"
say "    and installed apps update themselves the next time they start."
say
if [ "$NC_MAC" = 1 ]; then open desktop/release >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open desktop/release >/dev/null 2>&1 || true; fi
pause
