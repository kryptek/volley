import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/volley-hooks` in this checkout: `$VOLLEY_HOOKS_DIR` for every launched agent. */
export const HOOKS_DIR = fileURLToPath(new URL("../../volley-hooks", import.meta.url));

/** The hooks' settings template, passed to claude as-is with `--settings`. */
export const hooksSettingsPath = (hooksDir: string) => join(hooksDir, "settings.volley-hooks.json");

/** The command a new pane's shell runs. The two leading spaces keep it out of shell history and
 * protect it from prompts (update checks, history expansion) that eat the first character. */
export const LAUNCH_COMMAND = "  bash .volley/launch.sh";

export const launchScriptPath = (worktree: string) => join(worktree, ".volley", "launch.sh");

/** Single-quote for bash: the value is taken literally. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchScriptVars {
  hooksDir: string;
  model: string;
  agentId: string;
  /** Extra exports (a remote host's VOLLEY_BROKER_URL / _NAMESPACE / _AGENT_ID, for tooling). */
  env?: Record<string, string>;
}

/**
 * `.volley/launch.sh`. It runs under bash whatever the login shell is (zsh does not word-split),
 * exports `VOLLEY_HOOKS_DIR` for the hook commands in the settings template, and execs claude
 * with the hooks via `--settings` — never `--mcp-config`, which is variadic and would swallow the
 * prompt. The brief is read from `.volley/brief.md` at launch, so it never appears in any argv
 * volleyd builds. Identity comes from `.volley/agent.json`; `env` exports (remote hosts) are for
 * tooling that reads env only — the identity file wins.
 */
export function renderLaunchScript(v: LaunchScriptVars): string {
  return [
    "#!/usr/bin/env bash",
    "# Written by volleyd for one agent launch. Do not edit.",
    "set -euo pipefail",
    'cd "$(dirname "${BASH_SOURCE[0]}")/.."',
    `export VOLLEY_HOOKS_DIR=${shq(v.hooksDir)}`,
    ...Object.entries(v.env ?? {}).map(([k, val]) => `export ${k}=${shq(val)}`),
    `exec claude --dangerously-skip-permissions --model ${shq(v.model)} --settings ${shq(hooksSettingsPath(v.hooksDir))} --name ${shq(v.agentId)} "$(cat .volley/brief.md)"`,
    "",
  ].join("\n");
}
