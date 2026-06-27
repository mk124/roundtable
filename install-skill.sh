#!/usr/bin/env bash
# Install the Roundtable skill into each supported agent runtime on this machine
# (Claude, Codex, Antigravity). Copies SKILL.md and the watch scripts into each
# runtime's skills folder; re-running refreshes an existing install.
set -euo pipefail

src="$(cd "$(dirname "$0")/skills/roundtable" && pwd)"
installed=0

install_to() {
  local name="$1" parent="$2"
  [ -d "$parent" ] || { echo "skipped: $name (not found)"; return; }
  local dest="$parent/skills/roundtable"
  mkdir -p "$dest"
  cp "$src"/SKILL.md "$src"/watch.sh "$src"/codex-watch.sh "$dest/"
  chmod +x "$dest"/watch.sh "$dest"/codex-watch.sh
  echo "installed: $name -> $dest"
  installed=$((installed + 1))
}

install_to Claude      "$HOME/.claude"
install_to Codex       "$HOME/.codex"
install_to Antigravity "$HOME/.gemini/antigravity-cli"

[ "$installed" -gt 0 ] || echo "no supported agent runtime found."
