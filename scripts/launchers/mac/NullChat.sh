#!/bin/bash
# NullChat for Mac: opens NullChat in its own window using Chrome, Edge, Brave, Vivaldi or Chromium.
# The server address is in NullChat.app/Contents/Resources/server-url.txt.
here="$(cd "$(dirname "$0")" && pwd)"
url="${NULLCHAT_URL:-$(tr -d ' \t\r\n' < "$here/../Resources/server-url.txt" 2>/dev/null)}"
case "$url" in
  http://*|https://*) ;;
  *) osascript -e 'display dialog "NullChat could not find its server address. Download NullChat again from your server." buttons {"OK"} default button 1 with icon stop' >/dev/null 2>&1; exit 1 ;;
esac

dirs="${NULLCHAT_APP_DIRS:-/Applications:$HOME/Applications}"
find_app() {
  local old_ifs="$IFS" dir
  IFS=":"
  for dir in $dirs; do
    if [ -d "$dir/$1.app" ]; then IFS="$old_ifs"; printf '%s\n' "$dir/$1.app"; return 0; fi
  done
  IFS="$old_ifs"
  return 1
}

for name in "Google Chrome" "Microsoft Edge" "Brave Browser" "Vivaldi" "Chromium"; do
  if app="$(find_app "$name")"; then
    exec open -n -a "$app" --args "--app=$url"
  fi
done

# No browser that can open an app window: use the normal browser and say why.
open "$url"
osascript -e 'display dialog "NullChat opens in its own window with Chrome, Edge or Brave. None of them is installed, so it opened in your browser. Install one of them to get the app window." buttons {"OK"} default button 1' >/dev/null 2>&1
