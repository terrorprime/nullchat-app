# Shared helpers for the Mac and Linux scripts (the equivalents of the Windows .bat files).
# Sourced by the other scripts in this folder; it is not meant to be run on its own.
# shellcheck shell=bash

# Always work from the project folder, wherever the script was started from.
NC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$NC_ROOT" || exit 1

NC_OS="$(uname -s)"                       # Darwin = Mac, Linux = Linux
[ "$NC_OS" = "Darwin" ] && NC_MAC=1 || NC_MAC=0

say() { printf '%s\n' "$*"; }

# Open a web address in the default browser (quietly does nothing on a machine with no desktop).
open_url() {
  if [ "$NC_MAC" = 1 ]; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  else say "  Open this address in your browser:  $1"
  fi
}

# When a script was started by double-clicking (the .command files set NULLCHAT_PAUSE=1), keep the window open
# so the message can be read. In a normal terminal there is nothing to wait for.
pause() {
  if [ "${NULLCHAT_PAUSE:-}" = "1" ] && [ -t 0 ]; then
    printf '\n'; read -r -p "  Press Enter to close this window… " _ || true
  fi
}

die() { printf '\n'; for l in "$@"; do say "  $l"; done; pause; exit 1; }

# Ask a question; the answer ends up in $REPLY_TEXT. Gives up cleanly if the input is closed.
ask() {
  local prompt="$1"
  if ! read -r -p "$prompt" REPLY_TEXT; then printf '\n'; die "No answer was given, so I stopped."; fi
}

# need_node [minimum-version]  -  stop with a friendly message when Node.js is missing or too old.
need_node() {
  local want="${1:-}"
  if ! command -v node >/dev/null 2>&1; then
    say "  Node.js is not installed."
    if [ "$NC_MAC" = 1 ] && command -v brew >/dev/null 2>&1; then say "  Easiest: run  brew install node  and then start this again."; fi
    say "  Opening https://nodejs.org  -  install the LTS version, then start this again."
    say "  (On Linux you can also use your package manager, e.g.  sudo apt install nodejs npm,  or nvm.)"
    open_url "https://nodejs.org"
    pause; exit 1
  fi
  if [ -n "$want" ] && ! node -e '
      const [a, b] = process.versions.node.split(".").map(Number); const [wa, wb] = process.argv[1].split(".").map(Number);
      process.exit(a > wa || (a === wa && b >= wb) ? 0 : 1);' "$want" 2>/dev/null; then
    die "Your Node.js is version $(node -v), but NullChat needs $want or newer." \
        "Install the current LTS from https://nodejs.org (or run  nvm install 22 ) and start this again."
  fi
}

# Put the Fly.io tool on the PATH (its installer puts it in ~/.fly/bin) and set $FLY to its command name.
find_fly() {
  export PATH="${FLYCTL_INSTALL:-$HOME/.fly}/bin:$PATH"
  FLY=""
  if command -v fly >/dev/null 2>&1; then FLY=fly
  elif command -v flyctl >/dev/null 2>&1; then FLY=flyctl
  fi
  [ -n "$FLY" ]
}
