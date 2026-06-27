#!/usr/bin/env bash
# Double-click in Finder to start Roundtable and open it in your browser.
# Requires Node.js >= 23.6.
cd "$(dirname "$0")" || exit 1

[ -d node_modules ] || npm install || exit 1

# Open the browser once the server is listening.
( for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:8787 >/dev/null 2>&1 && { open http://127.0.0.1:8787; break; }
    sleep 0.5
  done ) &

npm start
