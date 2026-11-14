#!/usr/bin/env bash
# NullChat for Linux (and Mac, from the Terminal). The Windows files are the .bat ones; on a Mac you can also
# double-click the .command files.
#
#   ./nullchat.sh            show a small menu
#   ./nullchat.sh start      run NullChat on this computer
#   ./nullchat.sh deploy     put it online on Fly.io (run again to update)
#   ./nullchat.sh account    show accounts / set a new password on your Fly.io server
#   ./nullchat.sh installer  build the desktop app for this computer (.dmg on a Mac, AppImage + .deb on Linux)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run() { exec bash "$here/scripts/unix/$1"; }
case "${1:-}" in
  start)     run start.sh ;;
  deploy)    run deploy-fly.sh ;;
  account)   run account-help.sh ;;
  installer) run build-installer.sh ;;
  "")
    echo
    echo "  NullChat"
    echo "    1  Start NullChat on this computer"
    echo "    2  Put NullChat online (Fly.io)"
    echo "    3  Account help for the Fly.io server"
    echo "    4  Build the desktop app for this computer"
    echo "    5  Quit"
    echo
    read -r -p "  Type 1-5 and press Enter: " pick || exit 0
    case "$pick" in
      1) run start.sh ;; 2) run deploy-fly.sh ;; 3) run account-help.sh ;; 4) run build-installer.sh ;; *) exit 0 ;;
    esac ;;
  *) echo "Usage: ./nullchat.sh [start|deploy|account|installer]"; exit 1 ;;
esac
