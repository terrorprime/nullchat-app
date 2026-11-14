#!/usr/bin/env bash
# Put NullChat online on Fly.io (Mac and Linux). Same steps as "Deploy to Fly.io.bat". Safe to run again to update.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

say
say "  ==============================================="
say "     NullChat  -  put your server online (Fly.io)"
say "  ==============================================="
say
say "  You can run this again any time to update the server."
say

[ -f Dockerfile ] && [ -f fly.toml ] || die \
  'This script must stay inside the "nullchat" folder, right next to the file named' \
  '"Dockerfile". Move it back there and run it again.'

need_node

# ---- 1. The Fly.io tool
if ! find_fly; then
  say "[1/6] Installing the Fly.io tool..."
  command -v curl >/dev/null 2>&1 || die "curl is needed to install the Fly.io tool but was not found." \
    "Install it (Linux: sudo apt install curl) or install Fly by hand: https://fly.io/docs/flyctl/install/"
  curl -fsSL https://fly.io/install.sh | sh
  find_fly || die "The Fly.io tool did not install. Close this window and run this again." \
    "If it still fails, install it by hand from https://fly.io/docs/flyctl/install/"
fi
say "[1/6] Fly.io tool ready."

# ---- 2. Log in
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  say "[2/6] A browser window will open. Log in or sign up, then come back here."
  "$FLY" auth login || die "Logging in to Fly.io did not work."
fi
say "[2/6] Logged in to Fly.io."

# ---- 3. Pick the app name
DEFAULT_NAME="$(node scripts/fly-rename.cjs --print-name)"
REGION="$(node scripts/fly-rename.cjs --print-region)"
while true; do
  say
  say "[3/6] Choose a name. Your server will live at  https://NAME.fly.dev"
  ask "Name (press Enter for $DEFAULT_NAME): "
  APPNAME="${REPLY_TEXT:-$DEFAULT_NAME}"
  node scripts/fly-rename.cjs "$APPNAME" || continue
  APPNAME="$(node scripts/fly-rename.cjs --print-name)"   # (the helper lower-cases it)
  "$FLY" status -a "$APPNAME" >/dev/null 2>&1 && break
  "$FLY" apps create "$APPNAME" && break
  say
  say "  Could not create \"$APPNAME\". The usual reasons:"
  say "    - That name is already taken by someone else. Type a different name next."
  say "    - Fly needs a payment method on your account. Add one at"
  say "      https://fly.io/dashboard  (Billing), then press Enter to try the same name again."
  say
  DEFAULT_NAME="$APPNAME"
done
say "[3/6] App \"$APPNAME\" ready."

# ---- 4. Disk for the database and uploads
if ! "$FLY" volumes list -a "$APPNAME" 2>/dev/null | grep -q "nullchat_data"; then
  say "[4/6] Creating a 3 GB disk for your data in region $REGION..."
  "$FLY" volumes create nullchat_data --size 3 --region "$REGION" --yes -a "$APPNAME" || die "Could not create the data disk."
fi
node scripts/fly-snapshots.cjs "$APPNAME"
say "[4/6] Data disk ready."

# ---- 5. Secret login key (created once, never changed)
if ! "$FLY" secrets list -a "$APPNAME" 2>/dev/null | grep -q "APP_SECRET"; then
  NEWSECRET="$(node scripts/gen-secret.cjs)"
  [ -n "$NEWSECRET" ] || die "Could not create the secret key."
  "$FLY" secrets set "APP_SECRET=$NEWSECRET" --stage -a "$APPNAME" || die "Could not save the secret key."
  NEWSECRET=""
fi
say "[5/6] Secret key ready."

# ---- Is the installer in the downloads folder whole? (stops a damaged one from going online)
say
node scripts/check-downloads.cjs
[ $? -ge 2 ] && die "Nothing was uploaded because the installer above is damaged." 'Run "Build Installer" and wait until it is done, then run this again.'

# ---- 6. Upload and start
say
say "[6/6] Uploading and starting NullChat. The first time takes a few minutes..."
"$FLY" deploy --ha=false -a "$APPNAME" || die "Something went wrong. Scroll up to see the message and send it to Claude." \
  'After a deploy, "fly logs" shows what the server is printing.'

say
say "  Checking the installer on the server..."
node scripts/check-downloads.cjs --live "https://$APPNAME.fly.dev"
LIVECHECK=$?

say
say "  ==============================================="
say "   Done!  NullChat is online at:"
say
say "       https://$APPNAME.fly.dev"
say "  ==============================================="
say
say "  1. Open that address in your browser and create your account."
say '  2. Make a server, click "Invite People", and send the link to friends.'
say "     Friends can just open the link in a browser, no install needed."
say '  3. Optional desktop app: run "Build Installer" (Mac: Build Installer.command, Linux: ./nullchat.sh installer)'
say "     and press Enter at the address question, it is already filled in."
say
[ "$LIVECHECK" = "3" ] && { say "  The installer on the server is NOT right yet: run this once more (see the message above)."; say; }
open_url "https://$APPNAME.fly.dev"
pause
