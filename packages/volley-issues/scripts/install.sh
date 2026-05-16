#!/usr/bin/env bash
# Idempotent installer for the /volley-issues Claude Code skill.
# Symlinks $REPO_ROOT/packages/volley-issues → ~/.claude/skills/volley-issues
# so edits to SKILL.md in this repo are immediately reflected in Claude Code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/.claude/skills/volley-issues"

mkdir -p "$HOME/.claude/skills"

if [[ -L "$TARGET" ]]; then
  current="$(readlink "$TARGET")"
  if [[ "$current" == "$SKILL_DIR" ]]; then
    echo "/volley-issues skill already installed (symlink → $SKILL_DIR)"
    exit 0
  fi
  echo "replacing existing /volley-issues symlink ($current → $SKILL_DIR)"
  rm "$TARGET"
elif [[ -e "$TARGET" ]]; then
  backup="$TARGET.backup.$(date +%Y%m%d-%H%M%S)"
  echo "backing up existing /volley-issues skill directory to $backup"
  mv "$TARGET" "$backup"
fi

ln -s "$SKILL_DIR" "$TARGET"
echo "/volley-issues skill installed: $TARGET → $SKILL_DIR"
echo

REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
MCP_ENTRY="$REPO_ROOT/packages/volley-mcp/src/index.ts"

cat <<EOF
Next: register the volley-mcp server with Claude Code at user scope (the same
registration the /volley skill needs). Claude Code stores MCP servers separately
from settings.json — DO NOT edit settings.json by hand (it does not accept an
mcpServers field). Run:

  claude mcp add-json -s user volley '{"command":"bun","args":["run","$MCP_ENTRY"],"env":{"VOLLEY_AGENT_ID":"coordinator","VOLLEY_NAMESPACE":"example-dispatch"}}'

Then quit Claude Code (Cmd-Q) and reopen. Verify with:

  claude mcp list   # expect "volley: ... ✓ Connected"

(VOLLEY_AGENT_ID is a *prefix* — the MCP server appends a fresh -XXXX suffix at
every startup, so two Claude Code sessions sharing this user-scope MCP registration
get DIFFERENT agent_ids automatically. To find this session's actual id, call
vol_register or vol_list_agents in a Claude Code conversation.)

Use namespace "example-dispatch" so dispatched agents don't share the same registry
as ad-hoc /volley operations in the "default" namespace.

Then in a Claude Code session: /volley-issues #<issue-number> to dispatch.
EOF
