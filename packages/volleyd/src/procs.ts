import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { type Clock, sleep, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import { PS_ARGV } from "./fence";

/**
 * Stopping a retired agent's `claude` process (retire's session end on the local host, and
 * `volleyd cleanup --yes`). The only module that signals a process volleyd did not spawn
 * (exec.ts signals only its own children): it lists processes with the fenced, read-only
 * `ps -axo pid=,command=` and signals them with `process.kill`, so no child process is spawned
 * for it. A process counts only by its argv: the launch script passes
 * `--mcp-config=<worktree>/.volley/mcp.json`, and that worktree must lie under the given root.
 */

export interface PsEntry {
  pid: number;
  command: string;
}

/** `ps -axo pid=,command=` output → one entry per line. Pure. */
export function parsePs(stdout: string): PsEntry[] {
  return stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), command: m[2] as string }];
  });
}

/** The `--mcp-config=` value of a command line (bare, or single- or double-quoted), or null. Pure. */
export function mcpConfigOf(command: string): string | null {
  const m = /(?:^|\s)--mcp-config=(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
  const v = m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
  return v === undefined || v === "" ? null : v;
}

/** `path` with symlinks resolved as far as it exists (a removed worktree keeps its tail as is). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** Is `path` `root` itself or inside it? Realpaths, with a trailing separator: `w1` ≠ `w10`. */
export function underRoot(path: string, root: string): boolean {
  const p = canonical(path);
  const r = canonical(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** The processes whose `--mcp-config=` names a worktree (`<worktree>/.volley/mcp.json`). */
export async function listAgentProcesses(exec: ExecFn): Promise<(PsEntry & { mcp: string })[]> {
  const r = await exec(PS_ARGV, { timeoutMs: DAEMON_DEFAULTS.ps_timeout_ms });
  if (r.code !== 0 || r.timedOut) throw new Error(`ps failed: ${r.stderr.trim() || r.code}`);
  return parsePs(r.stdout).flatMap((p) => {
    const mcp = mcpConfigOf(p.command);
    return mcp === null || p.pid === process.pid ? [] : [{ ...p, mcp }];
  });
}

/** A launch script's profile line (launch.ts renderLaunchScript): `export CLAUDE_CONFIG_DIR='…'`. */
const LAUNCH_PROFILE = /^export CLAUDE_CONFIG_DIR='((?:[^']|'\\'')*)'$/m;

/**
 * How many agent sessions run in the Claude profile `dir`: the agent processes (by their
 * `--mcp-config=`) whose worktree's `.volley/launch.sh` exports that `CLAUDE_CONFIG_DIR`. A
 * session started by hand under the profile is not counted.
 */
export async function sessionsRunningIn(exec: ExecFn, dir: string): Promise<number> {
  const procs = await listAgentProcesses(exec);
  return procs.filter((p) => {
    try {
      const m = LAUNCH_PROFILE.exec(readFileSync(join(dirname(p.mcp), "launch.sh"), "utf-8"));
      return m !== null && (m[1] as string).replace(/'\\''/g, "'") === dir;
    } catch {
      return false;
    }
  }).length;
}

export interface StopOptions {
  graceMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  clock?: Clock;
}

export interface Stopped {
  pid: number;
  /** The last signal it was sent. */
  signal: "SIGTERM" | "SIGKILL";
}

const POLL_MS = 100;

/**
 * SIGTERM each pid, wait up to the grace for them to exit (probed with signal 0), then SIGKILL
 * the rest. A pid already gone is skipped. Returns the ones it signalled.
 */
export async function stopProcesses(
  pids: readonly number[],
  opts: StopOptions = {},
): Promise<Stopped[]> {
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  // real clock: the default when no clock is injected (a real process's grace)
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DAEMON_DEFAULTS.proc_kill_grace_ms;
  const send = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const stopped: Stopped[] = pids
    .filter((pid) => send(pid, "SIGTERM"))
    .map((pid) => ({ pid, signal: "SIGTERM" as const }));
  for (let waited = 0; waited < graceMs; waited += POLL_MS) {
    if (!stopped.some((s) => send(s.pid, 0))) return stopped;
    await sleep(clock, POLL_MS);
  }
  for (const s of stopped) if (send(s.pid, 0) && send(s.pid, "SIGKILL")) s.signal = "SIGKILL";
  return stopped;
}

export interface ReapOptions extends StopOptions {
  /** Worktrees under `root` whose processes are left alone (a live agent's). */
  exclude?: readonly string[];
}

/**
 * Stop every process whose `--mcp-config=` worktree lies under `root` (and under no `exclude`).
 * `stopped` carries each one's mcp path; `skipped` counts the agent processes outside the root.
 */
export async function reapUnder(
  exec: ExecFn,
  root: string,
  opts: ReapOptions = {},
): Promise<{ stopped: (Stopped & { mcp: string })[]; skipped: number }> {
  const procs = await listAgentProcesses(exec);
  const worktreeOf = (mcp: string) => dirname(dirname(mcp));
  const mine = procs.filter(
    (p) =>
      underRoot(worktreeOf(p.mcp), root) &&
      !(opts.exclude ?? []).some((x) => underRoot(worktreeOf(p.mcp), x)),
  );
  const stopped = await stopProcesses(
    mine.map((p) => p.pid),
    opts,
  );
  const mcpOf = new Map(mine.map((p) => [p.pid, p.mcp]));
  return {
    stopped: stopped.map((s) => ({ ...s, mcp: mcpOf.get(s.pid) ?? "" })),
    skipped: procs.length - mine.length,
  };
}
