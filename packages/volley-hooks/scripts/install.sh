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
#   --broker-url <url>               carry VOLLEY_BROKER_URL=<url> in every command's prefix
#   --namespace <ns>                 carry VOLLEY_NAMESPACE=<ns> in every command's prefix
#   --force                          install without a coordinator identity (see below)
#
# An install into the user-level ~/.claude/settings.json (CLAUDE_SETTINGS unset) needs a
# coordinator identity on this machine: VOLLEY_AUTH_USERNAME, or the coordinator.json the hooks
# read (`volley auth init --coordinator-file`). Without one, every session on the machine would
# run coordinator hooks with nobody to speak for, so the script refuses unless --force (a broker
# that takes anonymous connects needs none). An explicit CLAUDE_SETTINGS is not checked.
#
# CLAUDE_SETTINGS overrides the target file. A timestamped backup is written before changes.
# The prefix values come from the flags only, never from the environment (a session's own
# VOLLEY_BROKER_URL is read by the hooks at run time; one in the prefix overrides it): `volley
# peer doctor --fix` passes a paired machine's tunnel URL. The URL must be a plain one without a
# login; the hooks take their credentials from VOLLEY_AUTH_* or coordinator.json.
set -euo pipefail

usage() {
  echo "usage: $0 [--uninstall|--dry-run] [--broker-url <url>] [--namespace <ns>] [--force]" >&2
  exit 2
}

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
USER_LEVEL=""
[[ -n "${CLAUDE_SETTINGS:-}" ]] || USER_LEVEL=1
MODE=install
BROKER_URL=""
NAMESPACE=""
FORCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --dry-run) MODE=dry-run ;;
    --broker-url) [[ $# -ge 2 ]] || usage; BROKER_URL="$2"; shift ;;
    --namespace) [[ $# -ge 2 ]] || usage; NAMESPACE="$2"; shift ;;
    --force) FORCE=1 ;;
    *) usage ;;
  esac
  shift
done

command -v bun >/dev/null || { echo "install.sh: bun is required" >&2; exit 1; }

STATE_ROOT="${VOLLEY_HOOKS_STATE_DIR:-$HOME/.volley/hooks}"

# Both land in settings.json and in a shell command line: never a login, nothing to quote.
if [[ "$BROKER_URL" == *@* ]]; then
  echo "install.sh: --broker-url must not carry a login: pass the bare URL, and give the login as VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD or in coordinator.json (see the README's Broker credentials)" >&2
  exit 2
fi
URL_RE='^(mqtt|mqtts|tcp|ws|wss)://[]A-Za-z0-9._~:/[-]+$'
if [[ -n "$BROKER_URL" && ! "$BROKER_URL" =~ $URL_RE ]]; then
  echo "install.sh: --broker-url must be a plain mqtt(s)://, tcp://, or ws(s):// URL" >&2
  exit 2
fi
if [[ -n "$NAMESPACE" && ! "$NAMESPACE" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "install.sh: --namespace must match [a-z0-9][a-z0-9_-]{0,62}" >&2
  exit 2
fi

if [[ "$MODE" == install && -n "$USER_LEVEL" && -z "$FORCE" ]]; then
  # Where the hooks look for coordinator.json: resolved by volley-mcp itself, never re-derived.
  AUTH_PATH="$(HOOKS_DIR="$HOOKS_DIR" bun -e '
    const { coordinatorAuthPath } = require(require.resolve("volley-mcp/config", { paths: [process.env.HOOKS_DIR] }));
    process.stdout.write(coordinatorAuthPath(process.env) ?? "");
  ')"
  if [[ -z "${VOLLEY_AUTH_USERNAME:-}" && ( -z "$AUTH_PATH" || ! -f "$AUTH_PATH" ) ]]; then
    echo "install.sh: no coordinator identity on this machine (no VOLLEY_AUTH_USERNAME, no ${AUTH_PATH:-coordinator.json}): run \`volley auth init --coordinator-file\` first, or pass --force to install anyway" >&2
    exit 1
  fi
fi

HOOKS_DIR="$HOOKS_DIR" SETTINGS="$SETTINGS" MODE="$MODE" STATE_ROOT="$STATE_ROOT" BROKER_URL="$BROKER_URL" NAMESPACE="$NAMESPACE" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const { HOOKS_DIR, SETTINGS, MODE, STATE_ROOT, BROKER_URL, NAMESPACE } = process.env;
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
  const prefix =
    "VOLLEY_HOOKS_COORDINATOR=1 " +
    (BROKER_URL ? "VOLLEY_BROKER_URL=" + BROKER_URL + " " : "") +
    (NAMESPACE ? "VOLLEY_NAMESPACE=" + NAMESPACE + " " : "");
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
