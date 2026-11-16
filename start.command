#!/bin/bash
# Double-click this file (macOS) to open the tape shelf.
# It serves this folder on this computer only and opens the page in your browser.
cd "$(dirname "$0")" || exit 1
PORT=5183
( sleep 1; open "http://localhost:$PORT/" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
