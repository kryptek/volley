#!/usr/bin/env bash
# Install the Volley hooks into a Claude Code settings file (default ~/.claude/settings.json)
# for coordinator sessions: merges the settings.volley-hooks.json block with this package's
# absolute path substituted for $VOLLEY_HOOKS_DIR and VOLLEY_HOOKS_COORDINATOR=1 set, so a
# session with no .volley/agent.json speaks as the registry entry registered from its cwd.
# The usage statusLine replaces the file's own statusLine, which is saved to
# ${VOLLEY_HOOKS_STATE_DIR:-~/.volley/hooks}/statusline-chain.json: the publisher runs it and
# prints its output, and --uninstall puts it back.
#
#   scripts/install.sh               install (re-running replaces the previous install)
#   scripts/install.sh --uninstall   remove every volley-hooks entry
#   scripts/install.sh --dry-run     print the merged settings instead of writing them
#
# CLAUDE_SETTINGS overrides the target file. A timestamped backup is written before changes.
# VOLLEY_BROKER_URL, when set, is carried in every command's prefix (after
# VOLLEY_HOOKS_COORDINATOR=1), so the hooks reach that broker from any session: a paired
# machine's profile gets its tunnel's URL. It must be a plain URL without a login.
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

STATE_ROOT="${VOLLEY_HOOKS_STATE_DIR:-$HOME/.volley/hooks}"

# The URL lands in settings.json and in a shell command line: never a login, nothing to quote.
BROKER_URL="${VOLLEY_BROKER_URL:-}"
URL_RE='^(mqtt|mqtts|ws|wss)://[]A-Za-z0-9._~:/[-]+$'
if [[ "$MODE" != uninstall && -n "$BROKER_URL" && ! "$BROKER_URL" =~ $URL_RE ]]; then
  echo "install.sh: VOLLEY_BROKER_URL must be a plain mqtt(s):// or ws(s):// URL without a login" >&2
  exit 2
fi

HOOKS_DIR="$HOOKS_DIR" SETTINGS="$SETTINGS" MODE="$MODE" STATE_ROOT="$STATE_ROOT" BROKER_URL="$BROKER_URL" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const { HOOKS_DIR, SETTINGS, MODE, STATE_ROOT, BROKER_URL } = process.env;
const MARK = "/volley-hooks/src/hooks/";
const STATUS_MARK = "/volley-hooks/src/statusline/";
const CHAIN = path.join(STATE_ROOT, "statusline-chain.json");
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

// The statusLine: ours is recognised by its path; the one it replaced lives in CHAIN.
const ours = String(settings.statusLine?.command ?? "").includes(STATUS_MARK);
const fileOps = [];
if (MODE === "uninstall") {
  if (ours) {
    if (fs.existsSync(CHAIN)) settings.statusLine = JSON.parse(fs.readFileSync(CHAIN, "utf-8"));
    else delete settings.statusLine;
  }
  fileOps.push(() => fs.rmSync(CHAIN, { force: true }));
} else if (!ours && settings.statusLine !== undefined) {
  const saved = settings.statusLine;
  fileOps.push(() => {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    fs.writeFileSync(CHAIN, JSON.stringify(saved, null, 2) + "\n");
  });
}

if (MODE !== "uninstall") {
  const quoted = JSON.stringify(HOOKS_DIR).slice(1, -1);
  const prefix = "VOLLEY_HOOKS_COORDINATOR=1 " + (BROKER_URL ? "VOLLEY_BROKER_URL=" + BROKER_URL + " " : "");
  settings.statusLine = {
    ...template.statusLine,
    command: prefix + template.statusLine.command.replaceAll("$VOLLEY_HOOKS_DIR", quoted),
  };
  for (const [event, groups] of Object.entries(template.hooks)) {
    const resolved = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => ({
        ...h,
        command: prefix + h.command.replaceAll("$VOLLEY_HOOKS_DIR", quoted),
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
  for (const op of fileOps) op();
  console.log((MODE === "uninstall" ? "removed volley-hooks from " : "installed volley-hooks into ") + SETTINGS);
}
'
