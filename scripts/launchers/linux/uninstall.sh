#!/bin/sh
# Removes what install.sh added.
share="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -f "$HOME/.local/bin/nullchat" "$share/applications/nullchat.desktop" "$share/icons/hicolor/256x256/apps/nullchat.png"
rm -rf "$share/nullchat"
update-desktop-database "$share/applications" >/dev/null 2>&1 || true
echo "NullChat is removed."
