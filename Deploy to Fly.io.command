#!/bin/bash
# Double-click this on a Mac (if macOS blocks it: right-click -> Open). On Linux use  ./nullchat.sh  instead.
cd "$(dirname "$0")" || exit 1
export NULLCHAT_PAUSE=1
exec bash scripts/unix/deploy-fly.sh
