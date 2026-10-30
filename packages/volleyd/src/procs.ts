import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";
import { type Clock, sleep, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import { LSOF_ARGV, PS_ARGV } from "./fence";

/**
 * Stopping a retired agent's `claude` process (retire's session end on the local host, and
 * `volleyd cleanup --yes`). The only module that signals a process volleyd did not spawn
 * (exec.ts signals only its own children): it lists processes with the fenced, read-only
 * `ps -axo pid=,command=` and signals them with `process.kill`, so no child process is spawned
 * for it. A process counts by its argv (the launch script passes
 * `--mcp-config=<worktree>/.volley/mcp.json`, and that worktree must lie under the given root) or
 * by its working directory (a dev server, a watcher, a REPL the agent started in its worktree):
 * Linux reads `/proc/<pid>/cwd`, macOS the fenced `lsof -a -d cwd -F pn`.
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

/**
 * Is `path` `root` itself or inside it? With a trailing separator: `w1` ≠ `w10`. `path` (another
 * process's working directory or argv) is compared as given and never resolved: on macOS,
 * resolving a path in another app's protected folder (`~/Library/Containers/…`) blocks until a
 * privacy prompt a background service can never show, and the whole process hangs with it. The
 * kernel reports working directories already resolved, so only `root` is: `path` is matched
 * against `root` as given and resolved.
 */
export function underRoot(path: string, root: string): boolean {
  const p = normalize(path);
  return [normalize(root), canonical(root)].some(
    (r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep),
  );
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

/** `lsof -a -d cwd -F pn` output → pid → working directory. Pure. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = /^p(\d+)$/.test(line) ? Number(line.slice(1)) : null;
    else if (line.startsWith("n") && pid !== null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** A listed process with what makes it a wave's: its agent's mcp path and its working directory. */
export interface ProcEntry extends PsEntry {
  /** Its `--mcp-config=` value, or null. */
  mcp: string | null;
  /** Its working directory, or null when it cannot be read (another user's process). */
  cwd: string | null;
}

export interface ListOptions {
  /** Paths under which a process is left alone (a live agent's worktree). */
  exclude?: readonly string[];
  /** Which way the cwd is read (tests; default this machine's). */
  platform?: NodeJS.Platform;
}

/** Every process's working directory: Linux `/proc/<pid>/cwd`, otherwise one fenced `lsof`. */
async function cwdsOf(
  exec: ExecFn,
  pids: readonly number[],
  platform: NodeJS.Platform,
): Promise<Map<number, string>> {
  if (platform === "linux") {
    const out = new Map<number, string>();
    for (const pid of pids) {
      try {
        out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
    }
    return out;
  }
  const r = await exec(LSOF_ARGV, { timeoutMs: DAEMON_DEFAULTS.lsof_timeout_ms });
  // lsof exits 1 when some process could not be read; what it printed still counts.
  if (r.timedOut || (r.code !== 0 && r.stdout === "")) {
    throw new Error(`lsof failed: ${r.stderr.trim() || r.code}`);
  }
  return parseLsofCwd(r.stdout);
}

/**
 * The processes that belong under one of `roots`: their `--mcp-config=` worktree lies under it
 * (an agent) or their working directory does (anything the agent started there). Never this
 * process, never one under an `exclude`.
 */
export async function listProcessesUnder(
  exec: ExecFn,
  roots: readonly string[],
  opts: ListOptions = {},
): Promise<(ProcEntry & { root: string })[]> {
  if (roots.length === 0) return [];
  const r = await exec(PS_ARGV, { timeoutMs: DAEMON_DEFAULTS.ps_timeout_ms });
  if (r.code !== 0 || r.timedOut) throw new Error(`ps failed: ${r.stderr.trim() || r.code}`);
  const ps = parsePs(r.stdout).filter((p) => p.pid !== process.pid);
  const cwds = await cwdsOf(
    exec,
    ps.map((p) => p.pid),
    opts.platform ?? process.platform,
  );
  const exclude = opts.exclude ?? [];
  const inside = (path: string | null) => {
    if (path === null || exclude.some((x) => underRoot(path, x))) return undefined;
    return roots.find((root) => underRoot(path, root));
  };
  return ps.flatMap((p) => {
    const mcp = mcpConfigOf(p.command);
    const cwd = cwds.get(p.pid) ?? null;
    const root = inside(mcp === null ? null : dirname(dirname(mcp))) ?? inside(cwd);
    return root === undefined ? [] : [{ ...p, mcp, cwd, root }];
  });
}

/** A launch script's profile line (launch.ts renderLaunchScript): `export CLAUDE_CONFIG_DIR='…'`. */
const LAUNCH_PROFILE = /^export CLAUDE_CONFIG_DIR='((?:[^']|'\\'')*)'$/m;

/** The `CLAUDE_CONFIG_DIR` a launch script's text exports, unquoted, or null. Pure. */
export function launchProfileOf(launchSh: string): string | null {
  const m = LAUNCH_PROFILE.exec(launchSh);
  return m === null ? null : (m[1] as string).replace(/'\\''/g, "'");
}

/**
 * How many agent sessions run in the Claude profile `dir`: the agent processes (by their
 * `--mcp-config=`) whose worktree's `.volley/launch.sh` exports that `CLAUDE_CONFIG_DIR`. A
 * session started by hand under the profile is not counted.
 */
export async function sessionsRunningIn(exec: ExecFn, dir: string): Promise<number> {
  const procs = await listAgentProcesses(exec);
  return procs.filter((p) => {
    try {
      return launchProfileOf(readFileSync(join(dirname(p.mcp), "launch.sh"), "utf-8")) === dir;
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
 * Stop every process under `root` (and under no `exclude`), by argv or by working directory
 * (listProcessesUnder). `stopped` carries each one's mcp path ("" for a process that counted by
 * its cwd alone) and command.
 */
export async function reapUnder(
  exec: ExecFn,
  root: string,
  opts: ReapOptions = {},
): Promise<{ stopped: (Stopped & { mcp: string; command: string })[] }> {
  const mine = await listProcessesUnder(exec, [root], {
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
  });
  const stopped = await stopProcesses(
    mine.map((p) => p.pid),
    opts,
  );
  const byPid = new Map(mine.map((p) => [p.pid, p]));
  return {
    stopped: stopped.map((s) => ({
      ...s,
      mcp: byPid.get(s.pid)?.mcp ?? "",
      command: byPid.get(s.pid)?.command ?? "",
    })),
  };
}
