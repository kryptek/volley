import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

/**
 * `volley peer cleanup`: what a wave left on this (paired) machine, removed. The supervisor runs
 * it over ssh during `volleyd cleanup` (and its automatic run when a wave ends), naming every
 * item itself: the box never chooses what goes. In one call, in this order:
 *
 * 1. processes: each `--worktree`'s, found by working directory (a dev server, a watcher the
 *    agent started there) or by `--mcp-config=<worktree>/.volley/mcp.json` in the argv (the
 *    agent itself); `--yes` stops them (SIGTERM, a grace, SIGKILL);
 * 2. branches: `git -C <repo> branch -D <branch>` for each `--branch` (an agent branch the
 *    supervisor proved merged), with `--yes`;
 * 3. clones: each `--clone` is removed with `--yes` only when nothing in it is unpushed: a clean
 *    work tree, no stash, every local branch on its upstream. Branches step 2 deleted no longer
 *    count, so a merged agent branch never keeps its clone.
 *
 * Without `--yes` it only reports. The answer is one JSON line (`PeerCleanupReport`); an item
 * kept says why, and the exit is 0 unless the arguments were wrong or something unexpected failed.
 */

export const CLEANUP_DEFAULTS = {
  /** How long a SIGTERMed process has to exit before it is SIGKILLed. */
  grace_ms: 5_000,
  /** How often a stopping process is probed (signal 0). */
  probe_ms: 50,
  /** Each git, ps or lsof run's time limit. */
  exec_timeout_ms: 30_000,
} as const;

/**
 * An agent branch, `<wave>/<task>-<role>-<n>` or `<wave>/release-<stage>-<n>`. A copy of volleyd's
 * `AGENT_BRANCH` (worktree.ts): volleyd imports this module's types, so this package does not
 * import volleyd's.
 */
export const AGENT_BRANCH =
  /^[a-z0-9][a-z0-9_-]{0,62}\/([A-Za-z0-9][A-Za-z0-9_-]{0,62}-(implementer|spec_reviewer|quality_reviewer|fixup|rebase)|release-[a-z0-9][a-z0-9_-]{0,62})-[1-9][0-9]*$/;

/** macOS: every process and its command line. */
export const PS_ARGV = ["ps", "-axo", "pid=,command="];
/** macOS: every process's working directory (`p<pid>` / `n<path>` lines). */
export const LSOF_CWD_ARGV = ["lsof", "-a", "-d", "cwd", "-F", "pn"];

export interface PeerCleanupProcess {
  pid: number;
  command: string;
}

export interface PeerCleanupWorktree {
  worktree: string;
  /** The processes found under it (before any was stopped). */
  pids: PeerCleanupProcess[];
  /** `--yes` and every one of them is gone. */
  stopped: boolean;
}

export interface PeerCleanupBranch {
  branch: string;
  deleted: boolean;
  /** Why not: `dry run`, `no such branch`, or git's error. */
  why?: string;
}

export interface PeerCleanupClone {
  clone: string;
  removed: boolean;
  /**
   * Why not: `dry run`, `gone`, `not a git clone`, `dirty work tree`, `linked worktree <path>`, `stash`,
   * `<b> has no upstream`, `<n> unpushed commit(s) on <b>`, or an error.
   */
  why?: string;
}

/** What `volley peer cleanup --json` prints: one line of this. */
export interface PeerCleanupReport {
  worktrees: PeerCleanupWorktree[];
  branches: PeerCleanupBranch[];
  clones: PeerCleanupClone[];
}

export interface PeerCleanupOptions {
  worktrees: string[];
  repo?: string;
  branches: string[];
  clones: string[];
  yes: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A listed process and its working directory (null: unreadable, e.g. another user's). */
export interface ProcEntry extends PeerCleanupProcess {
  cwd: string | null;
}

export interface PeerCleanupDeps {
  platform: NodeJS.Platform;
  /** Runs `argv` (git; ps and lsof on macOS) with no shell. */
  exec: (argv: string[]) => Promise<ExecResult>;
  /** Linux: the process table's source (default `/proc`). */
  procRoot: string;
  /** Pids never listed: this process and its parent (the ssh shell that ran it). */
  self: readonly number[];
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  graceMs: number;
  rm: (path: string) => void;
}

function realExec(argv: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), CLEANUP_DEFAULTS.exec_timeout_ms);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function realPeerCleanupDeps(): PeerCleanupDeps {
  return {
    platform: process.platform,
    exec: realExec,
    procRoot: "/proc",
    self: [process.pid, process.ppid],
    kill: (pid, sig) => process.kill(pid, sig),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    graceMs: CLEANUP_DEFAULTS.grace_ms,
    rm: (path) => rmSync(path, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/** `ps -axo pid=,command=` output → one entry per line. Pure. */
export function parsePs(stdout: string): PeerCleanupProcess[] {
  return stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), command: m[2] as string }];
  });
}

/** `lsof -a -d cwd -F pn` output → pid → working directory (its first `n` line). Pure. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = /^p(\d+)$/.test(line) ? Number(line.slice(1)) : null;
    else if (line.startsWith("n") && pid !== null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** The `--mcp-config=` value of a command line (bare, or single- or double-quoted), or null. */
export function mcpConfigOf(command: string): string | null {
  const m = /(?:^|\s)--mcp-config=(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
  const v = m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
  return v === undefined || v === "" ? null : v;
}

/** Every process on this machine but `self`, with its working directory where readable. */
export async function listProcesses(deps: PeerCleanupDeps): Promise<ProcEntry[]> {
  const skip = new Set(deps.self);
  if (deps.platform === "linux") {
    const out: ProcEntry[] = [];
    for (const name of readdirSync(deps.procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (skip.has(pid)) continue;
      let command: string;
      try {
        command = readFileSync(join(deps.procRoot, name, "cmdline"), "utf-8")
          .replace(/\0/g, " ")
          .trim();
      } catch {
        continue; // exited meanwhile
      }
      if (command === "") continue; // a kernel thread or a zombie
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(join(deps.procRoot, name, "cwd"));
      } catch {}
      out.push({ pid, command, cwd });
    }
    return out;
  }
  const ps = await deps.exec(PS_ARGV);
  if (ps.code !== 0) throw new Error(`ps failed: ${ps.stderr.trim() || ps.code}`);
  const lsof = await deps.exec(LSOF_CWD_ARGV);
  // lsof exits 1 when some process could not be read; what it printed still counts.
  if (lsof.code !== 0 && lsof.stdout === "") {
    throw new Error(`lsof failed: ${lsof.stderr.trim() || lsof.code}`);
  }
  const cwds = parseLsofCwd(lsof.stdout);
  return parsePs(ps.stdout)
    .filter((p) => !skip.has(p.pid))
    .map((p) => ({ ...p, cwd: cwds.get(p.pid) ?? null }));
}

/** `path` with symlinks resolved as far as it exists (a removed directory keeps its tail). */
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

/** Whether a process belongs under `worktree`: by its agent's `--mcp-config=` or by its cwd. */
function belongs(p: ProcEntry, worktree: string): boolean {
  const mcp = mcpConfigOf(p.command);
  if (mcp !== null && isAbsolute(mcp) && underRoot(dirname(dirname(mcp)), worktree)) return true;
  return p.cwd !== null && isAbsolute(p.cwd) && underRoot(p.cwd, worktree);
}

const isAlive = (deps: PeerCleanupDeps, pid: number): boolean => {
  try {
    deps.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** SIGTERM each pid, wait up to the grace, SIGKILL the rest. Whether every one is gone. */
async function stop(deps: PeerCleanupDeps, pids: readonly number[]): Promise<boolean> {
  const send = (pid: number, sig: NodeJS.Signals) => {
    try {
      deps.kill(pid, sig);
    } catch {}
  };
  for (const pid of pids) send(pid, "SIGTERM");
  const until = Date.now() + deps.graceMs;
  let left = pids.filter((p) => isAlive(deps, p));
  while (left.length > 0 && Date.now() < until) {
    await deps.sleep(CLEANUP_DEFAULTS.probe_ms);
    left = left.filter((p) => isAlive(deps, p));
  }
  for (const pid of left) send(pid, "SIGKILL");
  if (left.length === 0) return true;
  // A SIGKILL takes effect at once, but the kernel reaps asynchronously: probe briefly.
  for (let i = 0; i < 20 && left.length > 0; i++) {
    await deps.sleep(CLEANUP_DEFAULTS.probe_ms);
    left = left.filter((p) => isAlive(deps, p));
  }
  return left.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Branches and clones (read-only git, then `branch -D` / the remove)
// ---------------------------------------------------------------------------------------------

const git = (deps: PeerCleanupDeps, dir: string, ...args: string[]) =>
  deps.exec(["git", "-C", dir, ...args]);

const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

async function deleteBranch(
  deps: PeerCleanupDeps,
  repo: string,
  branch: string,
  yes: boolean,
): Promise<PeerCleanupBranch> {
  const there = await git(deps, repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (there.code !== 0) return { branch, deleted: false, why: "no such branch" };
  if (!yes) return { branch, deleted: false, why: "dry run" };
  const r = await git(deps, repo, "branch", "-D", branch);
  if (r.code !== 0) {
    return { branch, deleted: false, why: lastLine(r.stderr) || `git branch -D exited ${r.code}` };
  }
  return { branch, deleted: true };
}

/** Why the clone must stay (something in it is not on the remote), or null when nothing is. */
async function cloneKeeps(deps: PeerCleanupDeps, clone: string): Promise<string | null> {
  const top = await git(deps, clone, "rev-parse", "--show-toplevel");
  if (top.code !== 0 || canonical(top.stdout.trim()) !== canonical(clone)) return "not a git clone";
  const status = await git(deps, clone, "status", "--porcelain");
  if (status.code !== 0) return lastLine(status.stderr) || "git status failed";
  if (status.stdout.trim() !== "") return "dirty work tree";
  // A worktree still checked out from it needs its gitdir; the first entry is the clone itself.
  const wts = await git(deps, clone, "worktree", "list", "--porcelain");
  if (wts.code !== 0) return lastLine(wts.stderr) || "git worktree list failed";
  const linked = wts.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .slice(1)
    .map((l) => l.slice("worktree ".length));
  if (linked.length > 0) return `linked worktree ${linked.join(", ")}`;
  const stash = await git(deps, clone, "stash", "list");
  if (stash.code !== 0) return lastLine(stash.stderr) || "git stash list failed";
  if (stash.stdout.trim() !== "") return "stash";
  const refs = await git(deps, clone, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  if (refs.code !== 0) return lastLine(refs.stderr) || "git for-each-ref failed";
  for (const b of refs.stdout.split("\n").map((l) => l.trim())) {
    if (b === "") continue;
    const up = await git(deps, clone, "rev-parse", "--verify", "--quiet", `${b}@{u}`);
    if (up.code !== 0) return `${b} has no upstream`;
    const ahead = await git(deps, clone, "rev-list", "--count", `${b}@{u}..${b}`);
    if (ahead.code !== 0) return lastLine(ahead.stderr) || `git rev-list failed on ${b}`;
    const n = Number(ahead.stdout.trim());
    if (n > 0) return `${n} unpushed commit${n === 1 ? "" : "s"} on ${b}`;
  }
  return null;
}

async function removeClone(
  deps: PeerCleanupDeps,
  clone: string,
  yes: boolean,
): Promise<PeerCleanupClone> {
  if (!existsSync(clone)) return { clone, removed: false, why: "gone" };
  const why = await cloneKeeps(deps, clone);
  if (why !== null) return { clone, removed: false, why };
  if (!yes) return { clone, removed: false, why: "dry run" };
  try {
    deps.rm(clone);
  } catch (e) {
    return { clone, removed: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { clone, removed: true };
}

/** The whole run: processes, then branches, then clones. */
export async function peerCleanup(
  opts: PeerCleanupOptions,
  deps: PeerCleanupDeps,
): Promise<PeerCleanupReport> {
  const worktrees: PeerCleanupWorktree[] = [];
  if (opts.worktrees.length > 0) {
    const procs = await listProcesses(deps);
    for (const worktree of opts.worktrees) {
      const mine = procs.filter((p) => belongs(p, worktree));
      const pids = mine.map(({ pid, command }) => ({ pid, command }));
      const stopped = opts.yes
        ? await stop(
            deps,
            mine.map((p) => p.pid),
          )
        : false;
      worktrees.push({ worktree, pids, stopped });
    }
  }
  const branches: PeerCleanupBranch[] = [];
  for (const branch of opts.branches) {
    branches.push(await deleteBranch(deps, opts.repo as string, branch, opts.yes));
  }
  const clones: PeerCleanupClone[] = [];
  for (const clone of opts.clones) clones.push(await removeClone(deps, clone, opts.yes));
  return { worktrees, branches, clones };
}

// ---------------------------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------------------------

export const PEER_CLEANUP_HELP = `Usage: volley peer cleanup --json [--worktree <abs>]... [--repo <abs> --branch <name>...]
                           [--clone <abs>]... [--yes]

Run by the supervisor on a paired machine (over ssh) while it cleans a wave up: stops the
processes in each worktree (by working directory, or an agent's --mcp-config), deletes each
named agent branch, and removes each named clone when nothing in it is unpushed. Without --yes
it only reports. Prints one JSON line: { worktrees, branches, clones }.

  --json             Required: the report is for the supervisor
  --worktree <abs>   A task worktree whose processes go (repeatable)
  --repo <abs>       The clone the --branch names live in
  --branch <name>    An agent branch <wave>/<task>-<role>-<n> to delete (repeatable)
  --clone <abs>      A clone to remove when it is clean, has no stash and every local branch is
                     on its upstream (repeatable); branches deleted above no longer count
  --yes              Do it (default: a dry run)
`;

const OPTIONS = {
  json: { type: "boolean" },
  worktree: { type: "string", multiple: true },
  repo: { type: "string" },
  branch: { type: "string", multiple: true },
  clone: { type: "string", multiple: true },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** An absolute path with no control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const absPath = (p: string) => isAbsolute(p) && !/[\u0000-\u001f\u007f]/.test(p);

/** `volley peer cleanup …` (argv after the verb). */
export async function runPeerCleanup(
  argv: string[],
  io: IO,
  deps: PeerCleanupDeps = realPeerCleanupDeps(),
): Promise<ExitCode> {
  const usage = (msg: string) => {
    io.stderr(`volley peer cleanup: ${msg}\n`);
    return EXIT.USAGE;
  };
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(PEER_CLEANUP_HELP);
    return EXIT.OK;
  }
  if (parsed.positionals.length > 0) return usage("takes no arguments");
  if (v.json !== true) return usage("needs --json (its answer is for the supervisor)");
  const worktrees = v.worktree ?? [];
  const branches = v.branch ?? [];
  const clones = v.clone ?? [];
  for (const [flag, paths] of [
    ["--worktree", worktrees],
    ["--repo", v.repo !== undefined ? [v.repo] : []],
    ["--clone", clones],
  ] as const) {
    for (const p of paths) if (!absPath(p)) return usage(`${flag} "${p}" is not an absolute path`);
  }
  if (branches.length > 0 && v.repo === undefined) return usage("--branch needs --repo <abs>");
  for (const b of branches) {
    if (!AGENT_BRANCH.test(b)) {
      return usage(`--branch "${b}" is not an agent branch (<wave>/<task>-<role>-<n>)`);
    }
  }
  try {
    const report = await peerCleanup(
      {
        worktrees,
        ...(v.repo !== undefined ? { repo: v.repo } : {}),
        branches,
        clones,
        yes: v.yes === true,
      },
      deps,
    );
    io.stdout(`${JSON.stringify(report)}\n`);
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volley peer cleanup: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}

// ---------------------------------------------------------------------------------------------
// The supervisor's side: reading the answer
// ---------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const optString = (x: unknown) => x === undefined || typeof x === "string";

/**
 * `volley peer cleanup --json`'s stdout (its last non-empty line) as a report; throws when it is
 * not one.
 */
export function parsePeerCleanupReport(stdout: string): PeerCleanupReport {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  if (line === undefined) throw new Error("peer cleanup printed nothing");
  let x: unknown;
  try {
    x = JSON.parse(line);
  } catch {
    throw new Error(`peer cleanup printed no JSON: ${line.slice(0, 200)}`);
  }
  const bad = (what: string): never => {
    throw new Error(`peer cleanup's report has a bad ${what}`);
  };
  if (!isObj(x)) return bad("shape");
  const { worktrees, branches, clones } = x;
  if (!Array.isArray(worktrees) || !Array.isArray(branches) || !Array.isArray(clones)) {
    return bad("shape");
  }
  for (const w of worktrees) {
    if (
      !isObj(w) ||
      typeof w.worktree !== "string" ||
      typeof w.stopped !== "boolean" ||
      !Array.isArray(w.pids) ||
      !w.pids.every((p) => isObj(p) && Number.isInteger(p.pid) && typeof p.command === "string")
    ) {
      bad("worktree entry");
    }
  }
  for (const b of branches) {
    if (
      !isObj(b) ||
      typeof b.branch !== "string" ||
      typeof b.deleted !== "boolean" ||
      !optString(b.why)
    )
      bad("branch entry");
  }
  for (const c of clones) {
    if (
      !isObj(c) ||
      typeof c.clone !== "string" ||
      typeof c.removed !== "boolean" ||
      !optString(c.why)
    )
      bad("clone entry");
  }
  return x as unknown as PeerCleanupReport;
}
