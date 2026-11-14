#!/usr/bin/env bash
# Run NullChat on this computer (Mac and Linux). Same as "Start NullChat.bat".
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

say
say "  =============================="
say "          NullChat launcher"
say "  =============================="
say

need_node 22.13

if [ ! -d node_modules ]; then
  say "[1/3] Installing dependencies - first run only, takes about a minute..."
  npm install --no-audit --no-fund || die "Install failed. Check your internet connection."
fi
if [ ! -f .env ]; then
  npm run setup || die "Setup did not finish."
fi
if [ ! -f client/dist/index.html ]; then
  say "[2/3] Building the web app - first run only..."
  npm run build || die "Build failed."
fi

# Use the port from .env when there is one (the default is 3001).
PORT_NOW="$(sed -n 's/^PORT=\(.*\)$/\1/p' .env 2>/dev/null | tail -n 1 | tr -d '\r"'"'"' ')"
PORT_NOW="${PORT_NOW:-3001}"
export PUBLIC_URL="http://localhost:$PORT_NOW"
say "[3/3] Starting NullChat on $PUBLIC_URL"
say "      Keep this window open. Close it (or press Ctrl+C) to stop NullChat."
say
( sleep 3; open_url "$PUBLIC_URL" ) &
npm start
pause
