#!/bin/bash
# Builds the lightweight Mac and Linux launchers into the project's downloads/ folder.
# These are NOT the full desktop app: they open NullChat in its own window using Chrome, Edge or Brave.
# Needs bash, zip, tar and dpkg-deb (for the .deb). Run it on Mac or Linux:
#     scripts/launchers/build.sh [server-address]        (default: the address in desktop/app-config.json)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
URL="${1:-$(sed -n 's/.*"serverUrl": *"\([^"]*\)".*/\1/p' "$ROOT/desktop/app-config.json" | head -1)}"
URL="${URL%/}"
case "$URL" in http://*|https://*) ;; *) echo "Give the server address, for example: $0 https://chat.example.com" >&2; exit 1 ;; esac
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/desktop/package.json" | head -1)"
OUT="$ROOT/downloads"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
echo "Server: $URL    Version: $VERSION"

# ---- Mac: NullChat.app in a zip (works on Intel and Apple Silicon: it is a script, not a compiled program)
APP="$WORK/mac/NullChat.app/Contents"
mkdir -p "$APP/MacOS" "$APP/Resources"
sed "s|@VERSION@|$VERSION|g" "$HERE/mac/Info.plist.in" > "$APP/Info.plist"
install -m 755 "$HERE/mac/NullChat.sh" "$APP/MacOS/NullChat"
install -m 644 "$HERE/mac/NullChat.icns" "$APP/Resources/NullChat.icns"
printf '%s\n' "$URL" > "$APP/Resources/server-url.txt"
rm -f "$OUT/NullChat-$VERSION-mac-universal-launcher.zip"
(cd "$WORK/mac" && zip -r -X -q "$OUT/NullChat-$VERSION-mac-universal-launcher.zip" NullChat.app)
echo "  built NullChat-$VERSION-mac-universal-launcher.zip"

# ---- Linux: .tar.gz that installs for the current user (any distro)
TAR="$WORK/tar/NullChat"
mkdir -p "$TAR"
install -m 755 "$HERE/linux/nullchat" "$TAR/nullchat"
install -m 755 "$HERE/linux/install.sh" "$TAR/install.sh"
install -m 755 "$HERE/linux/uninstall.sh" "$TAR/uninstall.sh"
install -m 644 "$HERE/linux/nullchat.desktop.in" "$TAR/nullchat.desktop.in"
install -m 644 "$HERE/linux/nullchat.png" "$TAR/nullchat.png"
printf '%s\n' "$URL" > "$TAR/server-url"
rm -f "$OUT/NullChat-$VERSION-linux-launcher.tar.gz"
tar -C "$WORK/tar" --owner=0 --group=0 -czf "$OUT/NullChat-$VERSION-linux-launcher.tar.gz" NullChat
echo "  built NullChat-$VERSION-linux-launcher.tar.gz"

# ---- Linux: .deb for Debian, Ubuntu and Mint
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB="$WORK/deb"
  mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/256x256/apps" "$DEB/usr/share/nullchat"
  install -m 755 "$HERE/linux/nullchat" "$DEB/usr/bin/nullchat"
  sed "s|@EXEC@|nullchat|" "$HERE/linux/nullchat.desktop.in" > "$DEB/usr/share/applications/nullchat.desktop"
  chmod 644 "$DEB/usr/share/applications/nullchat.desktop"
  install -m 644 "$HERE/linux/nullchat.png" "$DEB/usr/share/icons/hicolor/256x256/apps/nullchat.png"
  printf '%s\n' "$URL" > "$DEB/usr/share/nullchat/server-url"
  chmod 644 "$DEB/usr/share/nullchat/server-url"
  cat > "$DEB/DEBIAN/control" <<CONTROL
Package: nullchat
Version: $VERSION
Section: net
Priority: optional
Architecture: all
Recommends: chromium | chromium-browser | google-chrome-stable | microsoft-edge-stable | brave-browser
Maintainer: NullChat <noreply@nullchat.invalid>
Homepage: $URL
Description: NullChat in its own window
 Opens NullChat in its own app window using Chrome, Chromium, Edge or Brave.
CONTROL
  for script in postinst postrm; do
    printf '#!/bin/sh\nset -e\nupdate-desktop-database -q >/dev/null 2>&1 || true\ngtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true\nexit 0\n' > "$DEB/DEBIAN/$script"
    chmod 755 "$DEB/DEBIAN/$script"
  done
  rm -f "$OUT/NullChat-$VERSION-linux-launcher.deb"
  dpkg-deb --build --root-owner-group -Zgzip "$DEB" "$OUT/NullChat-$VERSION-linux-launcher.deb" >/dev/null
  echo "  built NullChat-$VERSION-linux-launcher.deb"
else
  echo "  (skipped the .deb: dpkg-deb is not installed here)"
fi
echo "Done. The files are in $OUT"
