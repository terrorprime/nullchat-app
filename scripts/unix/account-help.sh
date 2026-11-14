#!/usr/bin/env bash
# Account help for your Fly.io server (Mac and Linux). Same as "Account Help (Fly.io).bat".
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

say
say "  ==============================================="
say "     NullChat  -  account help (Fly.io server)"
say "  ==============================================="
say
say "  Use this if you cannot log in to your online server."
say "  It can show which accounts exist and set a new password."
say

[ -f fly.toml ] || die "This has to stay in the NullChat folder (next to fly.toml)."
find_fly || die 'The Fly.io tool is not installed yet. Run the "Deploy to Fly.io" script first.'
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  say "  You are not logged in to Fly.io. A browser window will open."
  "$FLY" auth login || die "Logging in to Fly.io did not work."
fi

APPNAME="$(sed -n 's/^app *= *"\(.*\)".*$/\1/p' fly.toml | head -n 1 | tr -d '\r ')"
[ -n "$APPNAME" ] || die "This has to stay in the NullChat folder (next to fly.toml)."
say "  Server: $APPNAME  (https://$APPNAME.fly.dev)"
say

REMOTE="node --disable-warning=ExperimentalWarning scripts/account.js"
while true; do
  say "  What would you like to do?"
  say "    1  Show all accounts on this server"
  say "    2  Set a new password for an account"
  say "    3  Lift a suspension from an account"
  say "    4  Quit"
  say
  ask "  Type 1, 2, 3 or 4 and press Enter: "
  case "$REPLY_TEXT" in
    1) say; "$FLY" ssh console -a "$APPNAME" -C "$REMOTE list"; say ;;
    2|3)
      CHOICE="$REPLY_TEXT"; say
      ask "  Username or email of the account: "; WHO="$REPLY_TEXT"
      [ -n "$WHO" ] || continue
      # These words are sent to the server as a command, so only plain characters are allowed.
      if ! [[ "$WHO" =~ ^[A-Za-z0-9._@+-]+$ ]]; then say "  That doesn't look like a username or email (letters, numbers and . _ @ + - only)."; say; continue; fi
      if [ "$CHOICE" = 2 ]; then
        say "  Choose a new password: 8 or more letters and numbers (no spaces or symbols, to keep this simple)."
        ask "  New password: "; NEWPW="$REPLY_TEXT"
        [ -n "$NEWPW" ] || continue
        if ! [[ "$NEWPW" =~ ^[A-Za-z0-9]{8,}$ ]]; then say "  Please use 8 or more letters and numbers only."; say; continue; fi
        "$FLY" ssh console -a "$APPNAME" -C "$REMOTE password $WHO $NEWPW"
      else
        "$FLY" ssh console -a "$APPNAME" -C "$REMOTE unsuspend $WHO"
      fi
      say ;;
    4) exit 0 ;;
    *) ;;
  esac
done
