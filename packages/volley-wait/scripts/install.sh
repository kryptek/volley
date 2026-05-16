#!/usr/bin/env bash
# Idempotent installer for the /wait Claude Code skill.
# Symlinks $REPO_ROOT/packages/volley-wait → ~/.claude/skills/volley-wait
# so edits to SKILL.md in this repo are immediately reflected in Claude Code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/.claude/skills/volley-wait"

mkdir -p "$HOME/.claude/skills"

if [[ -L "$TARGET" ]]; then
  current="$(readlink "$TARGET")"
  if [[ "$current" == "$SKILL_DIR" ]]; then
    echo "/wait skill already installed (symlink → $SKILL_DIR)"
    exit 0
  fi
  echo "replacing existing /wait symlink ($current → $SKILL_DIR)"
  rm "$TARGET"
elif [[ -e "$TARGET" ]]; then
  backup="$TARGET.backup.$(date +%Y%m%d-%H%M%S)"
  echo "backing up existing /wait skill directory to $backup"
  mv "$TARGET" "$backup"
fi

ln -s "$SKILL_DIR" "$TARGET"
echo "/wait skill installed: $TARGET → $SKILL_DIR"
echo
echo "Next: quit Claude Code (Cmd-Q) and reopen so the new skill is picked up at startup."
echo "Then type /wait --help in any new Claude Code conversation to verify."
