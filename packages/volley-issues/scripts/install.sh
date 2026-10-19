#!/usr/bin/env bash
# Idempotent installer for the /volley-issues Claude Code skill.
# Symlinks $REPO_ROOT/packages/volley-issues → ~/.claude/skills/volley-issues
# so edits to SKILL.md in this repo are immediately reflected in Claude Code.
#
#   install.sh           install (or re-point) the skill; prints installed vs repo version
#   install.sh --check   change nothing; exit 1 when the installed copy is missing or older

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/.claude/skills/volley-issues"

CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "usage: install.sh [--check]" >&2; exit 2 ;;
esac

# The frontmatter `version:` of a SKILL.md; "none" when the file or the field is missing
# (the v0.1 skill declared no version).
skill_version() {
  local v=""
  [[ -f "$1" ]] && v="$(awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
    NR > 1 && sub(/^version:[ \t]*/, "") { gsub(/["\047 \t\r]/, ""); print; exit }' "$1")"
  echo "${v:-none}"
}

# True when installed version $1 is older than repo version $2 ("none" is older than anything).
older() {
  [[ "$1" == "none" ]] && return 0
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" ]]
}

REPO_VERSION="$(skill_version "$SKILL_DIR/SKILL.md")"
INSTALLED_VERSION="$(skill_version "$TARGET/SKILL.md")"
echo "/volley-issues skill: installed $INSTALLED_VERSION, repo $REPO_VERSION ($SKILL_DIR)"

if [[ "$CHECK" == 1 ]]; then
  if older "$INSTALLED_VERSION" "$REPO_VERSION"; then
    echo "the installed /volley-issues skill is missing or older than this repo's: run $SCRIPT_DIR/install.sh" >&2
    exit 1
  fi
  exit 0
fi

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
echo "/volley-issues skill installed: $TARGET → $SKILL_DIR (version $REPO_VERSION)"
echo

REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
MCP_ENTRY="$REPO_ROOT/packages/volley-mcp/src/index.ts"

cat <<EOF
Next: register the volley-mcp server with Claude Code at user scope (the same
registration the /volley skill needs). Claude Code stores MCP servers separately
from settings.json — DO NOT edit settings.json by hand (it does not accept an
mcpServers field). Run:

  claude mcp add-json -s user volley '{"command":"bun","args":["run","$MCP_ENTRY"],"env":{"VOLLEY_AGENT_ID":"coordinator","VOLLEY_NAMESPACE":"example-dispatch","VOLLEY_AUTH_USERNAME":"coordinator","VOLLEY_AUTH_PASSWORD":"<coordinator password from volley auth init>"}}'

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
