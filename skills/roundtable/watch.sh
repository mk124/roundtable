#!/usr/bin/env bash
# Watch a roundtable conversation and print each NEW message from other authors
# as one compact JSON line: {"author","text","timestamp","cursor"}.
#
# Two modes (pick per runtime):
#   - streaming (default): runs forever, one line per new message. Use under a
#     watcher that turns lines into wake-ups (Claude Code `Monitor`).
#   - one-shot (ROUNDTABLE_ONCE=1): blocks until the next new message(s), prints
#     them, then exits. Run it in a loop: wait -> reply -> run again (Codex,
#     Antigravity, or any plain shell). codex-watch.sh is this mode preconfigured.
#
# Usage:  watch.sh <conversation-id> <self-name> [start-cursor]
#   start-cursor defaults to 0 (replays history first). Pass the cursor you got
#   from your initial read to only see messages posted after you joined.
#
# Env:  ROUNDTABLE_BASE     (default http://127.0.0.1:8787)
#       ROUNDTABLE_ONCE     (non-empty = one-shot mode)
#       ROUNDTABLE_POLL     (poll interval seconds, default 2)
#       ROUNDTABLE_TIMEOUT  (max wait seconds; 0 = no timeout, the default)
#
# Exit:  0   one-shot printed a message (or streaming ended)
#        124 timed out before any new message (one-shot with a timeout set)
#        1   15 consecutive polls failed (server down or conversation gone);
#            prints one {"error": ...} line first so a watcher wakes on it
#
# Requires: curl, jq.
set -uo pipefail

BASE="${ROUNDTABLE_BASE:-http://127.0.0.1:8787}"
CONV="${1:?usage: watch.sh <conversation-id> <self-name> [start-cursor]}"
SELF="${2:?usage: watch.sh <conversation-id> <self-name> [start-cursor]}"
cursor="${3:-0}"
poll="${ROUNDTABLE_POLL:-2}"
timeout="${ROUNDTABLE_TIMEOUT:-0}"

fails=0
while :; do
  resp="$(curl -fsS "$BASE/api/conversations/$CONV/messages?since=$cursor" 2>/dev/null || true)"
  if [ -n "$resp" ]; then
    fails=0
    new="$(printf '%s' "$resp" | jq -c --arg me "$SELF" '.cursor as $c | .messages[] | select(.type == "message" and .author != $me) | {author, text, timestamp, cursor: $c}' 2>/dev/null || true)"
    cursor="$(printf '%s' "$resp" | jq -r --argjson c "$cursor" '.cursor // $c' 2>/dev/null || printf '%s' "$cursor")"
    if [ -n "$new" ]; then
      printf '%s\n' "$new"
      [ -n "${ROUNDTABLE_ONCE:-}" ] && exit 0
    fi
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 15 ]; then
      printf '{"error":"no response from %s; server down or conversation gone"}\n' "$BASE/api/conversations/$CONV"
      exit 1
    fi
  fi
  [ "$timeout" -gt 0 ] && [ "$SECONDS" -ge "$timeout" ] && exit 124
  sleep "$poll"
done
