import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_ENV } from "./claude/signin-script";

/** `packages/volley-hooks` in this checkout: `$VOLLEY_HOOKS_DIR` for every launched agent. */
export const HOOKS_DIR = fileURLToPath(new URL("../../volley-hooks", import.meta.url));

/**
 * `packages/volley-mcp/src/index.ts` in this checkout: the MCP server every launched agent runs
 * (`.volley/mcp.json`), so it is the same release as volleyd and its hooks.
 */
export const MCP_ENTRY = fileURLToPath(new URL("../../volley-mcp/src/index.ts", import.meta.url));

/** The hooks' settings template, passed to claude as-is with `--settings`. */
export const hooksSettingsPath = (hooksDir: string) => join(hooksDir, "settings.volley-hooks.json");

/** The command a new pane's shell runs. The two leading spaces keep it out of shell history and
 * protect it from prompts (update checks, history expansion) that eat the first character. */
export const LAUNCH_COMMAND = "  bash .volley/launch.sh";

export const launchScriptPath = (worktree: string) => join(worktree, ".volley", "launch.sh");

/** `<worktree>/.volley/mcp.json`: the only MCP config a launched agent loads. */
export const mcpConfigPath = (worktree: string) => join(worktree, ".volley", "mcp.json");

/**
 * `.volley/mcp.json`: one `volley` server, `bun run <entry>` (volley-mcp). The server reads its
 * broker URL, identity and minted credentials from `.volley/agent.json` in its cwd (the
 * worktree), so nothing secret is in this file.
 */
export function renderMcpConfig(entry: string): string {
  return `${JSON.stringify({ mcpServers: { volley: { command: "bun", args: ["run", entry] } } }, null, 2)}\n`;
}

/** Single-quote for bash: the value is taken literally. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * launch.sh's line before it execs claude: a session whose PATH has no `claude` (a remote box's
 * non-interactive ssh shell without it on PATH) says so, with the fix, and stays open so the
 * screen volleyd reads (and the decision it opens) shows why, instead of dying empty.
 */
export const LAUNCH_CLAUDE_CHECK =
  "command -v claude >/dev/null 2>&1 || { printf 'volleyd: cannot start the agent: claude is not on this session'\\''s PATH (%s). Put its directory on the PATH a non-interactive shell gets (zsh: ~/.zshenv; bash: the top of ~/.bashrc), then relaunch.\\n' \"$PATH\" >&2; exec tail -f /dev/null; }";

export interface LaunchScriptVars {
  hooksDir: string;
  model: string;
  agentId: string;
  /** The agent's worktree: its `.volley/mcp.json` is passed with `--mcp-config=`. */
  worktree: string;
  /** Extra exports (a remote host's VOLLEY_BROKER_URL / _NAMESPACE / _AGENT_ID, for tooling). */
  env?: Record<string, string>;
  /**
   * The Claude account profile the agent runs under (`CLAUDE_CONFIG_DIR`); absent: the primary
   * (Claude Code's default profile).
   */
  claudeConfigDir?: string;
}

/**
 * `.volley/launch.sh`. It runs under bash whatever the login shell is (zsh does not word-split),
 * exports `VOLLEY_HOOKS_DIR` for the hook commands in the settings template, and execs claude
 * with the hooks via `--settings` and volleyd's own MCP server: `--strict-mcp-config` (the
 * user's MCP servers — an everyday `volley` on another broker — are not loaded) and
 * `--mcp-config=<worktree>/.volley/mcp.json`. The `=` form gives the variadic option exactly one
 * value and `--` ends option parsing, so the prompt (last) is never swallowed as a config. The
 * brief is read from `.volley/brief.md` at launch, so it never appears in any argv volleyd
 * builds. Identity comes from `.volley/agent.json`; `env` exports (remote hosts) are for tooling
 * that reads env only — the identity file wins. Under a Claude account profile it exports
 * `CLAUDE_CONFIG_DIR` and unsets every credential variable, so the profile's own login is the one
 * claude uses.
 */
export function renderLaunchScript(v: LaunchScriptVars): string {
  return [
    "#!/usr/bin/env bash",
    "# Written by volleyd for one agent launch. Do not edit.",
    "set -euo pipefail",
    'cd "$(dirname "${BASH_SOURCE[0]}")/.."',
    `export VOLLEY_HOOKS_DIR=${shq(v.hooksDir)}`,
    ...(v.claudeConfigDir !== undefined
      ? [`export CLAUDE_CONFIG_DIR=${shq(v.claudeConfigDir)}`, `unset ${CREDENTIAL_ENV.join(" ")}`]
      : []),
    ...Object.entries(v.env ?? {}).map(([k, val]) => `export ${k}=${shq(val)}`),
    LAUNCH_CLAUDE_CHECK,
    `exec claude --dangerously-skip-permissions --model ${shq(v.model)} --settings ${shq(hooksSettingsPath(v.hooksDir))} --strict-mcp-config --mcp-config=${shq(mcpConfigPath(v.worktree))} --name ${shq(v.agentId)} -- "$(cat .volley/brief.md)"`,
    "",
  ].join("\n");
}
