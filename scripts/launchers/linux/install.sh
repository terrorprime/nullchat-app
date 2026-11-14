#!/bin/sh
# Installs NullChat for the current user (no admin password needed). Works on any Linux desktop.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$HOME/.local/bin"
share="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$bin" "$share/nullchat" "$share/applications" "$share/icons/hicolor/256x256/apps"
install -m 755 "$here/nullchat" "$bin/nullchat"
install -m 644 "$here/server-url" "$share/nullchat/server-url"
install -m 644 "$here/nullchat.png" "$share/icons/hicolor/256x256/apps/nullchat.png"
sed "s|@EXEC@|$bin/nullchat|" "$here/nullchat.desktop.in" > "$share/applications/nullchat.desktop"
chmod 644 "$share/applications/nullchat.desktop"
update-desktop-database "$share/applications" >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t -f "$share/icons/hicolor" >/dev/null 2>&1 || true
echo "NullChat is installed. Find it in your app menu."
echo "It opens in its own window with Chrome, Chromium, Edge or Brave (install one if you have none)."
