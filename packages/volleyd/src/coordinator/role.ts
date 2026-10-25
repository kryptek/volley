import { posix } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { shq } from "../launch";

/**
 * The coordinator role (SPEC §4.6.25), its pure half: what volleyd runs on the machine
 * `coordinator.machine` names (a `claude remote-control` server in a fixed directory, inside a
 * tmux session), how it reads that server's screen, and when it starts it again. The runner
 * (runner.ts) does the I/O; the fence (fence.ts COORDINATOR) pins everything rendered here.
 */

/** The role's retained state, published by volleyd (the reserved `federation/*` prefix, §2.4). */
export const COORDINATOR_TOPIC = "volley/_system/federation/coordinator";
export const COORDINATOR_CHANNEL = "_system/federation";

/** `--permission-mode` values, as `claude remote-control --help` lists them (Claude Code 2.1.310). */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The script's path in the coordinator directory, and the one command its tmux session runs. */
export const COORDINATOR_SCRIPT = ".volley/coordinator.sh";
export const COORDINATOR_COMMAND = `bash ${COORDINATOR_SCRIPT}`;

/** The coordinator's tmux session: `volley-coordinator-<coordinator name>`. */
export const coordinatorSession = (name: string) => `volley-coordinator-${name}`;

/** The fixed agent-id prefix the server's sessions register under (`coordinator-<suffix>`). */
export const COORDINATOR_AGENT_PREFIX = "coordinator";

/** Where the coordinator's broker login is, inside its directory (`VOLLEY_AUTH_DIR`). */
export const coordinatorAuthDir = (dir: string) => posix.join(dir, ".volley", "auth");

export interface CoordinatorScriptVars {
  /** The coordinator directory on the host, absolute (`coordinator.dir`, expanded there). */
  dir: string;
  /** The coordinator name setup recorded (`setup.json` `coordinator`): the one waves bind to. */
  name: string;
  namespace: string;
  /** The port the host's agents reach the broker at on its loopback. */
  brokerPort: number;
  /** `$VOLLEY_HOOKS_DIR`: the machine's hooks install. */
  hooksDir: string;
  /** The machine's `~/.volley/bin`, first on PATH (absolute). */
  binDir: string;
  capacity: number;
  permissionMode: PermissionMode;
  /** A `--continue` that exits sooner than this fell through: the full command starts. */
  continueGraceS: number;
}

/**
 * The server's full command, exactly the flags of `claude remote-control --help` volleyd sets:
 * the coordinator name as the session name and its prefix, same-dir spawns, the capacity and
 * the permission mode. Nothing else.
 */
export const REMOTE_CONTROL_ARGV = (
  v: Pick<CoordinatorScriptVars, "name" | "capacity" | "permissionMode">,
): string[] => [
  "claude",
  "remote-control",
  "--name",
  v.name,
  "--remote-control-session-name-prefix",
  v.name,
  "--spawn",
  "same-dir",
  "--capacity",
  String(v.capacity),
  "--permission-mode",
  v.permissionMode,
];

/**
 * The reattach: alone, since Claude Code 2.1.310 refuses `--continue` with `--spawn` or
 * `--capacity` (`--session-id and --continue cannot be used with --spawn, --capacity, or
 * --create-session-in-dir`).
 */
export const REMOTE_CONTROL_CONTINUE: readonly string[] = [
  "claude",
  "remote-control",
  "--continue",
];

/**
 * `.volley/coordinator.sh`: cd into the directory, export the coordinator's env (its broker,
 * namespace and name; its login is the file `VOLLEY_AUTH_DIR` names, so no secret is in the
 * script), put the machine's `~/.volley/bin` first on PATH, then reattach to the session last
 * recorded here (`--continue`) and, when that falls through within the grace (nothing recorded),
 * exec the full command. A reattached server that later exits ends the script (the runner starts
 * it again). Sealed by the fence (sealCoordinatorScript) byte for byte.
 */
export function renderCoordinatorScript(v: CoordinatorScriptVars): string {
  const words = (argv: readonly string[]) => argv.map(shq).join(" ");
  return [
    "#!/usr/bin/env bash",
    "# Written by volleyd for the coordinator role. Do not edit.",
    "set -uo pipefail",
    `cd ${shq(v.dir)}`,
    ...Object.entries(coordinatorEnv(v)).map(([k, val]) => `export ${k}=${shq(val)}`),
    `export PATH=${shq(v.binDir)}:"$PATH"`,
    "started=$SECONDS",
    `${words(REMOTE_CONTROL_CONTINUE)} && exit 0`,
    `[ $((SECONDS - started)) -lt ${v.continueGraceS} ] || exit 1`,
    `exec ${words(REMOTE_CONTROL_ARGV(v))}`,
    "",
  ].join("\n");
}

/**
 * The coordinator's env, in the script's order: its identity prefix and name, its broker and
 * namespace, the login file's directory, and the hooks' coordinator switch and install.
 */
export function coordinatorEnv(
  v: Pick<CoordinatorScriptVars, "dir" | "name" | "namespace" | "brokerPort" | "hooksDir">,
): Record<string, string> {
  return {
    VOLLEY_AGENT_ID: COORDINATOR_AGENT_PREFIX,
    VOLLEY_COORDINATOR: v.name,
    VOLLEY_NAMESPACE: v.namespace,
    VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${v.brokerPort}`,
    VOLLEY_AUTH_DIR: coordinatorAuthDir(v.dir),
    VOLLEY_HOOKS_COORDINATOR: "1",
    VOLLEY_HOOKS_DIR: v.hooksDir,
  };
}

/** The coordinator directory's files volleyd writes (prepare.ts), relative to it. */
export const COORDINATOR_FILES = {
  script: COORDINATOR_SCRIPT,
  login: ".volley/auth/coordinator.json",
  mcp: ".mcp.json",
  settings: ".claude/settings.json",
} as const;

/** `<dir>/repos/<owner>/<name>`: the link to one repository's checkout on the machine. */
export const coordinatorRepoLink = (dir: string, slug: string) => posix.join(dir, "repos", slug);

/**
 * `<dir>/.mcp.json`: the `volley` MCP server, `bun <entry>` (the machine's volley-mcp), with the
 * coordinator's env (coordinatorEnv) and no secret: its login is the file VOLLEY_AUTH_DIR names.
 */
export function renderCoordinatorMcp(
  entry: string,
  v: Pick<CoordinatorScriptVars, "dir" | "name" | "namespace" | "brokerPort" | "hooksDir">,
): string {
  const server = { command: "bun", args: [entry], env: coordinatorEnv(v) };
  return `${JSON.stringify({ mcpServers: { volley: server } }, null, 2)}\n`;
}

/** `<dir>/.claude/settings.json`: the project's `.mcp.json` servers load without a prompt. */
export const COORDINATOR_SETTINGS = `${JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)}\n`;

/** `coordinator.dir` on a host whose home is `home`: a leading `~` expanded, anything else kept. */
export function expandDir(dir: string, home: string): string {
  if (dir === "~") return home;
  return dir.startsWith("~/") ? posix.join(home, dir.slice(2)) : dir;
}

/** The link the server prints: the first `https://claude.ai/code/<id>[?query]` on its screen. */
const LINK = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%.~-]*)?/;

export function extractRemoteControlLink(screen: string): string | null {
  return LINK.exec(screen)?.[0] ?? null;
}

/**
 * A question the server asks on its screen and nobody answers unattended: the folder trust
 * (`Trust <dir>? [y/N]`, a directory Claude Code was never trusted in) or the first-run consent
 * (`Enable Remote Control? (y/n)`, once per Claude profile). Null: neither.
 */
export function screenPrompt(screen: string): "trust" | "consent" | null {
  if (/Enable Remote Control\? \(y\/n\)/.test(screen)) return "consent";
  if (/^Trust .+\? \[y\/N\]/m.test(screen)) return "trust";
  return null;
}

/**
 * The wait (s) before the `deaths`-th consecutive start: the ladder's rung for it, its last rung
 * past the end; a server that was up for `resetS` before it died starts the ladder again.
 */
export function nextBackoff(
  backoff: readonly number[],
  deaths: number,
  upForS: number,
  resetS: number = DAEMON_DEFAULTS.coordinator_backoff_reset_s,
): number {
  if (backoff.length === 0) return 0;
  if (upForS >= resetS) return backoff[0] as number;
  const rung = Math.min(Math.max(deaths, 1), backoff.length) - 1;
  return backoff[rung] as number;
}

/**
 * What the role should be doing: `off` (no machine chosen), `waiting` (its machine is down or
 * not known yet: nothing is started or stopped there) or `run`.
 */
export function desiredState(o: { machine: string | null; up?: boolean }):
  | "off"
  | "waiting"
  | "run" {
  if (o.machine === null) return "off";
  return o.up === true ? "run" : "waiting";
}

/** The retained `volley/_system/federation/coordinator` payload (coordinator-role.schema.json). */
export interface CoordinatorRolePayload {
  machine: string;
  name: string;
  state: "starting" | "running" | "restarting" | "stopped" | "failed";
  since: string;
  session_url?: string;
  restarts: number;
  last_error?: string;
  /** The server waits for an answer on its screen (screenPrompt): someone attaches and answers. */
  needs_terminal?: "trust" | "consent";
  /** Absolute, expanded on that machine; absent until it is (a machine down before it was placed). */
  dir?: string;
}

/**
 * Whether `v` is a coordinator role payload (`name`, `machine`, `state`, `since` strings,
 * `restarts` a number): what `formatCoordinator` may format. A wave's `coordinator` (the owner's
 * presence) is not one.
 */
export function isCoordinatorRole(v: unknown): v is CoordinatorRolePayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    typeof p.machine === "string" &&
    typeof p.state === "string" &&
    typeof p.since === "string" &&
    typeof p.restarts === "number"
  );
}

/**
 * One line for the role's state: `coord-test on box-a: running since <t> · <link>`; a stop or
 * failure carries its reason, a question on the server's screen says so.
 */
export function formatCoordinator(p: CoordinatorRolePayload): string {
  const head = `${p.name} on ${p.machine}: ${p.state} since ${p.since}`;
  const link = p.session_url !== undefined ? ` · ${p.session_url}` : "";
  const why =
    p.needs_terminal !== undefined || p.state === "failed" || p.state === "stopped"
      ? p.last_error !== undefined
        ? ` (${p.last_error.split("\n").at(-1)})`
        : ""
      : "";
  return `${head}${link}${why}`;
}
