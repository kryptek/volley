#!/usr/bin/env bash
# Idempotent installer for the /volley Claude Code skill.
# Symlinks $REPO_ROOT/packages/volley-skill → ~/.claude/skills/volley
# so edits to SKILL.md in this repo are immediately reflected in Claude Code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/.claude/skills/volley"

mkdir -p "$HOME/.claude/skills"

if [[ -L "$TARGET" ]]; then
  current="$(readlink "$TARGET")"
  if [[ "$current" == "$SKILL_DIR" ]]; then
    echo "/volley skill already installed (symlink → $SKILL_DIR)"
    exit 0
  fi
  echo "replacing existing /volley symlink ($current → $SKILL_DIR)"
  rm "$TARGET"
elif [[ -e "$TARGET" ]]; then
  backup="$TARGET.backup.$(date +%Y%m%d-%H%M%S)"
  echo "backing up existing /volley skill directory to $backup"
  mv "$TARGET" "$backup"
fi

ln -s "$SKILL_DIR" "$TARGET"
echo "/volley skill installed: $TARGET → $SKILL_DIR"
echo

cat <<EOF
Next: the volley MCP server. \`volley setup\` registers it with Claude Code at user
scope (its Claude Code step), with no password in it: the login comes from
coordinator.json in the auth dir the registration names. \`volley setup --check\`
shows whether it is registered (and the skills, the hooks and the coordinator name).

Then quit Claude Code (Cmd-Q) and reopen. Verify with:

  claude mcp list   # expect "volley: ... ✓ Connected"

Then type /volley list in any new Claude Code conversation to verify.
EOF
