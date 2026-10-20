import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_ENV } from "./claude/signin-script";
import type { AgentMcp } from "./types";

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

/**
 * The name of volleyd's server in `.volley/mcp.json`. Under `agent_mcp: inherit` it must stay
 * `volley`: Claude Code lets an `--mcp-config` server take over a user-scope server of the same
 * name, so an everyday `volley` entry (the coordinator's) never starts in an agent's session.
 */
export const VOLLEY_MCP_SERVER = "volley";

/** `<worktree>/.volley/mcp.json`: volleyd's MCP config for a launched agent. */
export const mcpConfigPath = (worktree: string) => join(worktree, ".volley", "mcp.json");

/**
 * `.volley/mcp.json`: one `volley` server, `bun run <entry>` (volley-mcp). The server reads its
 * broker URL, identity and minted credentials from `.volley/agent.json` in its cwd (the
 * worktree), so nothing secret is in this file.
 */
export function renderMcpConfig(entry: string): string {
  const servers = { [VOLLEY_MCP_SERVER]: { command: "bun", args: ["run", entry] } };
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/** An MCP server entry, other than volleyd's own `volley`, that runs volley-mcp. */
export interface StrayVolleyServer {
  /** Where the entry was found (a `.claude.json`, the worktree's `.mcp.json`). */
  source: string;
  name: string;
}

/**
 * The entries in `configs` (each a parsed `.claude.json` or `.mcp.json`, or null) that run
 * volley-mcp under a name other than `volley`. Under `agent_mcp: inherit` such an entry is not
 * taken over by volleyd's server, so it starts too: a second Volley server in the agent's
 * session. A command or argument naming `volley-mcp` counts; a URL-based server is never one.
 */
export function strayVolleyServers(
  configs: readonly { source: string; config: unknown }[],
): StrayVolleyServer[] {
  const out: StrayVolleyServer[] = [];
  for (const { source, config } of configs) {
    const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
    if (typeof servers !== "object" || servers === null) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (name === VOLLEY_MCP_SERVER || typeof entry !== "object" || entry === null) continue;
      const { command, args } = entry as { command?: unknown; args?: unknown };
      const argv = [command, ...(Array.isArray(args) ? args : [])];
      if (argv.some((a) => typeof a === "string" && a.includes("volley-mcp")))
        out.push({ source, name });
    }
  }
  return out;
}

/** Single-quote for bash: the value is taken literally. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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
  /** `inherit`: the user's MCP servers load too (no `--strict-mcp-config`); absent: `strict`. */
  agentMcp?: AgentMcp;
}

/**
 * `.volley/launch.sh`. It runs under bash whatever the login shell is (zsh does not word-split),
 * exports `VOLLEY_HOOKS_DIR` for the hook commands in the settings template, and execs claude
 * with the hooks via `--settings` and volleyd's own MCP server: `--strict-mcp-config` (the
 * user's MCP servers — an everyday `volley` on another broker — are not loaded; omitted under
 * `agent_mcp: inherit`, where they load and volleyd's `volley` shadows a user-scope one) and
 * `--mcp-config=<worktree>/.volley/mcp.json`. The `=` form gives the variadic option exactly one
 * value and `--` ends option parsing, so the prompt (last) is never swallowed as a config. The
 * brief is read from `.volley/brief.md` at launch, so it never appears in any argv volleyd
 * builds. Identity comes from `.volley/agent.json`; `env` exports (remote hosts) are for tooling
 * that reads env only — the identity file wins. Under a Claude account profile it exports
 * `CLAUDE_CONFIG_DIR` and unsets every credential variable, so the profile's own login is the one
 * claude uses.
 */
export function renderLaunchScript(v: LaunchScriptVars): string {
  const strict = v.agentMcp === "inherit" ? "" : " --strict-mcp-config";
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
    `exec claude --dangerously-skip-permissions --model ${shq(v.model)} --settings ${shq(hooksSettingsPath(v.hooksDir))}${strict} --mcp-config=${shq(mcpConfigPath(v.worktree))} --name ${shq(v.agentId)} -- "$(cat .volley/brief.md)"`,
    "",
  ].join("\n");
}
