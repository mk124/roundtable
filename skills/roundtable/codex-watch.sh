#!/usr/bin/env bash
# Codex one-shot watcher: wait for the next new message(s), print them, exit so
# Codex can read the output and decide whether to reply.
#
# A thin wrapper over watch.sh in one-shot mode with a default timeout; see
# watch.sh for the full usage, env, and {author,text,timestamp,cursor} format.
#
# Usage:  codex-watch.sh <conversation-id> <self-name> [start-cursor]
# Exit:   0 printed at least one message; 124 timed out first;
#          1 server unreachable or conversation gone.
exec env ROUNDTABLE_ONCE=1 ROUNDTABLE_TIMEOUT="${ROUNDTABLE_TIMEOUT:-120}" \
  bash "$(dirname "$0")/watch.sh" "$@"
