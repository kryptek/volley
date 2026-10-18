#!/usr/bin/env bash
# Install the Volley hooks into a Claude Code settings file (default ~/.claude/settings.json)
# for coordinator sessions: merges the settings.volley-hooks.json block with this package's
# absolute path substituted for $VOLLEY_HOOKS_DIR and VOLLEY_HOOKS_COORDINATOR=1 set, so a
# session with no .volley/agent.json speaks as the registry entry registered from its cwd.
#
#   scripts/install.sh               install (re-running replaces the previous install)
#   scripts/install.sh --uninstall   remove every volley-hooks entry
#   scripts/install.sh --dry-run     print the merged settings instead of writing them
#
# CLAUDE_SETTINGS overrides the target file. A timestamped backup is written before changes.
set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
MODE=install
case "${1:-}" in
  "") ;;
  --uninstall) MODE=uninstall ;;
  --dry-run) MODE=dry-run ;;
  *) echo "usage: $0 [--uninstall|--dry-run]" >&2; exit 2 ;;
esac

command -v bun >/dev/null || { echo "install.sh: bun is required" >&2; exit 1; }

HOOKS_DIR="$HOOKS_DIR" SETTINGS="$SETTINGS" MODE="$MODE" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const { HOOKS_DIR, SETTINGS, MODE } = process.env;
const MARK = "/volley-hooks/src/hooks/";
const template = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "settings.volley-hooks.json"), "utf-8"));
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, "utf-8")) : {};
const hooks = settings.hooks ?? {};

// Drop any earlier install, so re-running is idempotent.
for (const [event, groups] of Object.entries(hooks)) {
  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
    .filter((g) => g.hooks.length > 0);
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
}

if (MODE !== "uninstall") {
  const quoted = JSON.stringify(HOOKS_DIR).slice(1, -1);
  for (const [event, groups] of Object.entries(template.hooks)) {
    const resolved = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => ({
        ...h,
        command: "VOLLEY_HOOKS_COORDINATOR=1 " + h.command.replaceAll("$VOLLEY_HOOKS_DIR", quoted),
      })),
    }));
    hooks[event] = [...(hooks[event] ?? []), ...resolved];
  }
}

if (Object.keys(hooks).length > 0) settings.hooks = hooks;
else delete settings.hooks;
const out = JSON.stringify(settings, null, 2) + "\n";
if (MODE === "dry-run") {
  process.stdout.write(out);
} else {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    fs.copyFileSync(SETTINGS, SETTINGS + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-"));
  }
  fs.writeFileSync(SETTINGS, out);
  console.log((MODE === "uninstall" ? "removed volley-hooks from " : "installed volley-hooks into ") + SETTINGS);
}
'
