import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../config-defaults";
import { ConfigStore, volleydHome } from "../config-store";
import { resolveControlTarget, withClient } from "../control";
import { callerFor, ownedByHint } from "../controls";
import { type ExecFn, type ExecResult, exec as fencedExec } from "../exec";
import {
  type CloneRemoveToken,
  type ConsentToken,
  mintBranchDeleteToken,
  mintCloneRemoveToken,
  mintConsentToken,
} from "../fence";
import type { Host } from "../hosts/host";
import { LocalCmuxHost } from "../hosts/local-cmux";
import { LocalTmuxHost } from "../hosts/local-tmux";
import { type RemoteHost, SshTmuxHost } from "../hosts/ssh-tmux";
import { type CommandArgs, EXIT, type ExitCode, type IO } from "../io";
import { Journal, readJournalFile } from "../journal";
import { type StopOptions, listProcessesUnder, stopProcesses } from "../procs";
import { replay } from "../reducer";
import { type OwnedClone, isSlug, ownedClonesOf, sameSlug } from "../repos";
import { SYSTEM_WAVE } from "../types";
import type {
  CleanupCounts,
  JournalEvent,
  NewEvent,
  RemoteHostConfig,
  Resource,
  WaveState,
} from "../types";
import { expandHome } from "../worktree";

const HELP = `Usage: volleyd cleanup <wave> [--yes] [--force] [--all] [--by <name|agent-id>] [--json]
                       [--broker-url <url>] [--namespace <ns>]

Remove everything Volley made for a wave, on every machine (SPEC "Wave cleanup"): its agents'
workspaces or tmux sessions, git worktrees and locks; every process under those worktrees (by
--mcp-config= or by working directory: a dev server an agent started dies with it; SIGTERM, a
grace, then SIGKILL; on a paired machine through \`volley peer cleanup\` there); the agent branches
whose PR the journal shows merged at the branch's current tip; leftover agent logins; and a
registration, account or managed clone made for the wave (\`--for-wave\`). Everything it keeps is
named with the reason (\`kept <kind> <what>: <why>\`), and the last line sums the run up. Never an
unmerged branch, an owner's registration or clone, a human account or the release branch.
Without --yes, only prints what it would do. Only worktrees whose every agent is retired
(journaled agent_retired) are touched; live agents are listed and skipped. A worktree with
uncommitted changes is skipped unless --force is given. Only tasks that are done or cancelled are
touched: an unfinished task (e.g. merge_ready, its agents retired while the merge waits) is listed
and skipped unless --all is given. With \`cleanup_on_end\` on (the default) the supervisor runs
this itself as each task and the wave end. With the daemon up, the run is the daemon's, for the
wave's owner only: it acts as the caller (--by, else the caller's session, else
VOLLEY_COORDINATOR), like \`stop\` and \`steer\`, and --json prints { wave, lines, failed }. While
it is down, the command reads $VOLLEYD_HOME directly, needs no identity, and leaves logins,
registrations and accounts for the daemon.
`;

/** A worktree the wave's agents used, and what cleanup does with it. */
interface Target {
  worktree: string;
  agents: string[];
  workspaces: string[];
  live: string[];
  /** `local`, or the paired machine's name (agent_spawned `host`). */
  host: string;
  task?: string;
  /** Set for a remote host's worktree (agent_spawned `remote`): where it lives. */
  remote?: { host: string; target: string; repo: string };
  /** A local worktree's agents ran in tmux (agent_spawned `terminal`), not cmux. */
  tmux?: boolean;
  /** The spawn locks its agents held (`$VOLLEYD_HOME/locks/…`, supervisor only). */
  locks: string[];
}

/** An agent branch of the wave, and the journal's evidence that it merged. */
interface BranchItem {
  branch: string;
  host: string;
  task: string;
  /** The clone it lives in, on its host. */
  repo: string;
  remote?: { host: string; target: string; repo: string };
  /** The head its PR merged at (merged_by_* / release_stage_verified); null: not merged. */
  head: string | null;
  /** Why it is kept regardless of its tip (a cancelled or failed task, no merge on file). */
  unmerged?: string;
}

export interface LedgerInput {
  state: WaveState;
  events: JournalEvent[];
  /** The `_system` journal: registrations, accounts, clone runs. */
  system: JournalEvent[];
  /** The other waves on file (not archived) and their `repo:`: who else uses a registration. */
  otherWaves?: { wave: string; repo: string }[];
  /** For the managed clones (repos.ts ownedClonesOf): `fleet.repo_root`, this machine's name. */
  clones?: { repo_root: string; localName: string; localHome?: string };
  /** The supervisor's clone of the wave's repository when `repo:` is an `owner/name`. */
  localRepo?: string;
}

export interface LedgerOptions {
  /** Also unfinished tasks' items (default: only done and cancelled tasks'). */
  all?: boolean;
  /** One task's items only: its worktrees, sessions, processes, locks and branch (D8 i). */
  task?: string;
}

/** Everything cleanup acts on (SPEC §4.6.26): one list for the dry run, the run and the Desk. */
export interface Ledger {
  owned: Resource[];
  borrowed: Resource[];
  /** `owned` by host (`local`: the supervisor). */
  byHost: Record<string, Resource[]>;
  held: { task: string; stage: string }[];
  repo: string;
  targets: Target[];
  branches: BranchItem[];
  logins: { agent_id: string; task?: string }[];
  repos: string[];
  accounts: string[];
  clones: OwnedClone[];
  /** The wave's `owner/name`, when known (its release branch check reads GitHub). */
  slug?: string;
}

/** A wave's reduced state and its journal ($VOLLEYD_HOME directly; works while the daemon is down). */
export function readWave(home: string, wave: string): { state: WaveState; events: JournalEvent[] } {
  const events = readJournalFile(join(home, "waves", wave, "journal.jsonl"));
  const { state } = replay(events);
  if (state === null) throw new Error(`unknown wave '${wave}'`);
  return { state, events };
}

const MERGED = new Set(["merged_by_supervisor", "merged_by_operator"]);

/** The head each task's PR merged at, and each release stage agent's verified head. */
function mergedHeads(events: readonly JournalEvent[]): {
  byTask: Map<string, string>;
  byAgent: Map<string, string>;
} {
  const byTask = new Map<string, string>();
  const byAgent = new Map<string, string>();
  for (const e of events) {
    const head = e.data.head;
    if (typeof head !== "string") continue;
    if (MERGED.has(e.type) && e.task !== undefined) byTask.set(e.task, head);
    if (e.type === "release_stage_verified" && typeof e.data.agent_id === "string")
      byAgent.set(e.data.agent_id, head);
  }
  return { byTask, byAgent };
}

/** The registrations and accounts in `_system` as they stand now: by slug / name, last event wins. */
function registrations(system: readonly JournalEvent[]) {
  const repos = new Map<string, { slug: string; by: string; wave?: string }>();
  const accounts = new Map<string, { wave?: string }>();
  for (const e of system) {
    const slug = typeof e.data.slug === "string" ? e.data.slug : undefined;
    if (e.type === "repo_added" && slug !== undefined)
      repos.set(slug.toLowerCase(), {
        slug,
        by: String(e.data.by ?? "?"),
        ...(typeof e.data.wave === "string" ? { wave: e.data.wave } : {}),
      });
    else if (e.type === "repo_removed" && slug !== undefined) repos.delete(slug.toLowerCase());
    const name = typeof e.data.name === "string" ? e.data.name : undefined;
    if (e.type === "account_created" && name !== undefined)
      accounts.set(name, typeof e.data.wave === "string" ? { wave: e.data.wave } : {});
    else if (e.type === "account_revoked" && name !== undefined) accounts.delete(name);
  }
  return { repos, accounts };
}

/**
 * The ledger (SPEC §4.6.26, D1), pure: everything Volley made for the wave (owned: cleanup removes
 * it) and what exists for it but was not made for it (borrowed: kept and named). A worktree of a
 * task that is not done or cancelled is left out (`held`) unless `all`: a merge_ready task's
 * agents are all retired while its merge waits, and the pipeline still reads its PR. A task the
 * state does not know is not held.
 */
export function ledgerOf(input: LedgerInput, o: LedgerOptions = {}): Ledger {
  const { state, events } = input;
  const repo = input.localRepo ?? expandHome(state.repo);
  const stageOf = new Map(state.tasks.map((t) => [t.id, t.stage as string]));
  const unfinished = (task: string | undefined) => {
    const s = task !== undefined ? stageOf.get(task) : undefined;
    return s !== undefined && s !== "done" && s !== "cancelled" ? s : undefined;
  };
  const retired = new Set(
    events.filter((e) => e.type === "agent_retired").map((e) => e.data.agent_id as string),
  );
  // Agents whose retire already closed their workspace (agent_retired { workspace_closed }). By
  // agent, not by ref: a closed cmux ref can be handed to a later agent whose close failed.
  const closed = new Set(
    events
      .filter((e) => e.type === "agent_retired" && e.data.workspace_closed === true)
      .map((e) => e.data.agent_id as string),
  );
  const revoked = new Set(
    events
      .filter((e) => e.type === "credentials_revoked" && e.data.ok !== false)
      .map((e) => e.data.agent_id as string),
  );
  const { byTask, byAgent } = mergedHeads(events);
  const held = new Map<string, string>();
  const byPath = new Map<string, Target>();
  const branches = new Map<string, BranchItem>();
  const logins: { agent_id: string; task?: string }[] = [];
  for (const e of events) {
    if (e.type !== "agent_spawned" || typeof e.data.worktree !== "string") continue;
    if (o.task !== undefined && e.task !== o.task) continue;
    const stage = unfinished(e.task);
    if (stage !== undefined && o.all !== true) {
      held.set(e.task as string, stage);
      continue;
    }
    const id = e.data.agent_id as string;
    const host = typeof e.data.host === "string" ? e.data.host : "local";
    const t = byPath.get(e.data.worktree) ?? {
      worktree: e.data.worktree,
      agents: [],
      workspaces: [],
      live: [],
      host,
      locks: [],
      ...(e.task !== undefined ? { task: e.task } : {}),
    };
    t.agents.push(id);
    const remote = e.data.remote as { target?: unknown; repo?: unknown } | undefined;
    if (typeof remote?.target === "string" && typeof remote.repo === "string") {
      t.remote = { host, target: remote.target, repo: remote.repo };
    }
    if (e.data.terminal === "tmux") t.tmux = true;
    const ws = e.data.workspace;
    if (typeof ws === "string" && !closed.has(id) && !t.workspaces.includes(ws))
      t.workspaces.push(ws);
    if (typeof e.data.lock === "string" && !t.locks.includes(e.data.lock))
      t.locks.push(e.data.lock);
    if (!retired.has(id)) t.live.push(id);
    byPath.set(t.worktree, t);
    if (
      e.data.credentials === "minted" &&
      retired.has(id) &&
      !revoked.has(id) &&
      o.task === undefined
    )
      logins.push({ agent_id: id, ...(e.task !== undefined ? { task: e.task } : {}) });
    // A detached reviewer worktree has no branch of its own.
    const branch = e.data.branch;
    if (typeof branch !== "string" || e.data.detached === true || e.task === undefined) continue;
    const key = `${host}\u0000${branch}`;
    const stageNow = stageOf.get(e.task);
    const head = byAgent.get(id) ?? byTask.get(e.task) ?? null;
    const prior = branches.get(key);
    branches.set(key, {
      branch,
      host,
      task: e.task,
      repo: t.remote?.repo ?? repo,
      ...(t.remote !== undefined ? { remote: t.remote } : {}),
      head: head ?? prior?.head ?? null,
      ...(stageNow === "cancelled"
        ? { unmerged: "unmerged (the task was cancelled)" }
        : stageNow === "failed"
          ? { unmerged: "unmerged (the task failed)" }
          : head === null && prior?.head == null
            ? { unmerged: "unmerged (no merge on file)" }
            : {}),
    });
  }
  // A branch that is still some live agent's is no branch to delete.
  const liveWorktrees = [...byPath.values()].filter((t) => t.live.length > 0);
  const branchList = [...branches.values()].filter(
    (b) => !liveWorktrees.some((t) => t.host === b.host && t.task === b.task),
  );

  const owned: Resource[] = [];
  const borrowed: Resource[] = [];
  const res = (r: Resource) => r;
  for (const t of byPath.values()) {
    const task = t.task !== undefined ? { task: t.task } : {};
    owned.push(res({ kind: "worktree", host: t.host, what: t.worktree, ...task }));
    for (const ws of t.workspaces)
      owned.push(res({ kind: "session", host: t.host, what: ws, ...task }));
    for (const l of t.locks) owned.push(res({ kind: "lock", host: "local", what: l, ...task }));
  }
  for (const b of branchList)
    owned.push(res({ kind: "branch", host: b.host, what: b.branch, task: b.task }));
  for (const l of logins)
    owned.push(
      res({ kind: "login", host: "local", what: l.agent_id, ...(l.task ? { task: l.task } : {}) }),
    );

  const regs = registrations(input.system);
  const repos: string[] = [];
  const accounts: string[] = [];
  let clones: OwnedClone[] = [];
  let slug: string | undefined = isSlug(state.repo) ? state.repo : undefined;
  if (o.task === undefined) {
    for (const r of regs.repos.values()) {
      if (r.wave !== state.wave) continue;
      repos.push(r.slug);
      owned.push(res({ kind: "repo", host: "local", what: r.slug }));
    }
    for (const [name, a] of regs.accounts) {
      if (a.wave !== state.wave) continue;
      accounts.push(name);
      owned.push(res({ kind: "account", host: "local", what: name }));
    }
    if (input.clones !== undefined) {
      clones = ownedClonesOf(state.wave, input.system, input.clones);
      for (const c of clones)
        owned.push(
          res({ kind: "clone", host: hostOfMachine(c.machine, input.clones), what: c.path }),
        );
    }
    // The wave's own registration, made by the owner: named once, when no other wave uses it.
    const own = slug !== undefined ? regs.repos.get(slug.toLowerCase()) : undefined;
    if (own !== undefined) slug = own.slug;
    if (own !== undefined && own.wave === undefined) {
      const used = (input.otherWaves ?? []).some(
        (w) => w.wave !== state.wave && sameSlug(w.repo, own.slug),
      );
      if (!used)
        borrowed.push(
          res({
            kind: "repo",
            host: "local",
            what: own.slug,
            why: `added by ${own.by} (not for a wave) — volley repo remove ${own.slug}`,
          }),
        );
    }
    borrowed.push(res({ kind: "release_branch", host: "local", what: state.release_branch }));
  }

  const byHost: Record<string, Resource[]> = {};
  for (const r of owned) byHost[r.host] = [...(byHost[r.host] ?? []), r];
  return {
    owned,
    borrowed,
    byHost,
    held: [...held].map(([task, stage]) => ({ task, stage })),
    repo,
    targets: [...byPath.values()],
    branches: branchList,
    logins,
    repos,
    accounts,
    clones,
    ...(slug !== undefined ? { slug } : {}),
  };
}

/** A `repo_clone_run.machine` as a ledger host: the supervisor's own machine is `local`. */
const hostOfMachine = (machine: string, c: { localName: string }) =>
  machine === c.localName ? "local" : machine;

/** The daemon's side of a run: what only it can remove (absent: kept, `daemon down`). */
export interface CleanupDeps {
  exec: ExecFn;
  /** Absent: a dry run. */
  consent?: ConsentToken;
  force?: boolean;
  /** How processes are stopped (tests: a shorter grace). */
  reap?: StopOptions;
  /** Paired machines by name (config `hosts`): their target and volley checkout. */
  hosts?: Record<string, Pick<RemoteHostConfig, "target" | "volley_dir">>;
  /** The supervisor's own machine name (a clone's `repo_clone_run.machine`). */
  localName?: string;
  /** `autopilot.delete_branch`: merged branches were deleted on GitHub at merge time. */
  deleteBranchAtMerge?: boolean;
  /** Delete a leftover agent login (retire.ts reapAndRevoke); true when it is gone. */
  revokeLogin?: (agentId: string, task?: string) => Promise<boolean>;
  /** `repo_remove` of a wave-owned registration on `machines` (absent: all); null, or why not. */
  removeRepo?: (slug: string, machines?: string[]) => Promise<string | null>;
  /** `account_revoke` of a wave-owned account; null, or why not. */
  revokeAccount?: (name: string) => Promise<string | null>;
  /** Journal in `_system` (repo_clone_removed). */
  journalSystem?: (ev: NewEvent) => Promise<unknown> | unknown;
  /** Build the remote host a worktree or clone lives on (the daemon's, tests' fakes). */
  remoteHost?: (r: {
    host: string;
    target: string;
    repo: string;
    worktree_root: string;
  }) => RemoteHost;
}

export interface CleanupRun {
  removed: CleanupCounts;
  /** Remote worktrees removed per machine (the summary's `(<m> on <machine>)`). */
  worktrees_on: Record<string, number>;
  kept: Resource[];
  summary: string;
  failed: number;
}

const zero = (): CleanupCounts => ({
  worktrees: 0,
  sessions: 0,
  processes: 0,
  branches: 0,
  logins: 0,
  repos: 0,
  accounts: 0,
  clones: 0,
});

const KIND_WORD: Record<Resource["kind"], string> = {
  worktree: "worktree",
  session: "session",
  process: "process",
  branch: "branch",
  remote_branch: "remote branch",
  release_branch: "release branch",
  login: "login",
  lock: "lock",
  repo: "repo",
  clone: "clone",
  account: "account",
};

/** `kept <kind> <what>[ on <machine>]: <why>`. Pure. */
export function keptLine(r: Resource): string {
  const on = r.host !== "local" && r.kind !== "clone" ? ` on ${r.host}` : "";
  return `kept ${KIND_WORD[r.kind]} ${r.what}${on}: ${r.why ?? "kept"}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The run's last line (SPEC §4.6.26): `cleaned <wave>: <n> worktrees (<m> on <machine>), …;
 * kept <k>`, zeros omitted; `nothing to clean` when nothing was removed. Pure.
 */
export function summaryLine(
  wave: string,
  removed: CleanupCounts,
  keptCount: number,
  o: { dry?: boolean; worktrees_on?: Record<string, number> } = {},
): string {
  const on = Object.entries(o.worktrees_on ?? {}).filter(([, n]) => n > 0);
  const parts = [
    removed.worktrees > 0
      ? `${plural(removed.worktrees, "worktree")}${on.length > 0 ? ` (${on.map(([m, n]) => `${n} on ${m}`).join(", ")})` : ""}`
      : "",
    removed.sessions > 0 ? plural(removed.sessions, "session") : "",
    removed.processes > 0 ? plural(removed.processes, "process", "processes") : "",
    removed.branches > 0 ? plural(removed.branches, "branch", "branches") : "",
    removed.logins > 0 ? plural(removed.logins, "login") : "",
    removed.clones > 0 ? plural(removed.clones, "clone") : "",
    removed.repos > 0 ? plural(removed.repos, "registration") : "",
    removed.accounts > 0 ? plural(removed.accounts, "account") : "",
  ].filter((p) => p !== "");
  const kept = keptCount > 0 ? `; kept ${keptCount}` : "";
  if (parts.length === 0) return `nothing to clean${kept}`;
  return `${o.dry === true ? "would clean" : "cleaned"} ${wave}: ${parts.join(", ")}${kept}`;
}

/** ssh's own exit status: the box could not be reached, which says nothing about the path. */
const SSH_FAILED = 255;
const unreachable = (r: ExecResult) => r.code === SSH_FAILED || r.timedOut;
const unreachableWhy = (machine: string) => `${machine} unreachable; cleanup runs again next tick`;

/** True when the box answered that `path` is no work tree (already removed): a re-run is a no-op. */
async function remoteGone(host: Host, path: string): Promise<boolean | null> {
  const r = await host.exec(["git", "-C", path, "rev-parse", "--is-inside-work-tree"]);
  if (unreachable(r)) return null;
  return r.code !== 0;
}

/** The remote host a journaled worktree lives on. */
function remoteHostOf(
  r: { host: string; target: string; repo: string },
  worktreeRoot: string,
  deps: CleanupDeps,
): RemoteHost {
  if (deps.remoteHost !== undefined) return deps.remoteHost({ ...r, worktree_root: worktreeRoot });
  return new SshTmuxHost(
    {
      name: r.host,
      target: r.target,
      repo: r.repo,
      worktree_root: worktreeRoot,
      // The box's checkout runs `volley peer cleanup`; without one, that step is skipped.
      volley_dir: deps.hosts?.[r.host]?.volley_dir ?? "",
      tunnel: { remote_port: 0, supervise: false },
    },
    deps.exec,
  );
}

/** `<root>` of a worktree `<root>/<wave>/<task>-<role>`. */
const worktreeRootOf = (worktree: string) => dirname(dirname(worktree));

/**
 * Is `branch` at the merged head? Reads `git rev-parse` (and how far it moved) where the branch
 * lives. Null: it is gone; `ok`: delete it; otherwise why it is kept.
 */
async function branchVerdict(
  run: (argv: string[]) => Promise<ExecResult>,
  b: BranchItem,
): Promise<{ gone: true } | { ok: true } | { why: string } | { unreachable: true }> {
  const r = await run(["git", "-C", b.repo, "rev-parse", "--verify", "--quiet", b.branch]);
  if (unreachable(r)) return { unreachable: true };
  if (r.code !== 0) return { gone: true };
  if (b.unmerged !== undefined) return { why: b.unmerged };
  const tip = r.stdout.trim();
  if (b.head === null) return { why: "unmerged (no merge on file)" };
  if (tip === b.head) return { ok: true };
  const n = await run(["git", "-C", b.repo, "rev-list", "--count", `${b.head}..${b.branch}`]);
  const count = n.code === 0 ? Number(n.stdout.trim()) : Number.NaN;
  return {
    why:
      Number.isInteger(count) && count > 0
        ? `${plural(count, "commit")} after the merged head`
        : "its tip is not the merged head",
  };
}

/** The linked worktrees in `git worktree list --porcelain` output: every entry after the main one. */
export const linkedWorktrees = (porcelain: string): string[] =>
  porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .slice(1)
    .map((l) => l.slice("worktree ".length));

/**
 * The clone checks (D10), read-only: a clean tree, no linked worktree, no stash, every local branch pushed to its
 * upstream or one of `proven` (agent branches this run proved merged). Null: delete it; `gone`:
 * nothing there; otherwise why it is kept.
 */
async function cloneVerdict(
  run: (argv: string[]) => Promise<ExecResult>,
  path: string,
  proven: ReadonlySet<string>,
): Promise<string | null | "gone" | { unreachable: true }> {
  const status = await run(["git", "-C", path, "status", "--porcelain"]);
  if (unreachable(status)) return { unreachable: true };
  if (status.code !== 0)
    return /No such file|cannot change to|not a git repository/.test(status.stderr)
      ? "gone"
      : `unreadable: ${status.stderr.trim() || `exit ${status.code}`}`;
  if (status.stdout.trim() !== "") return "dirty work tree";
  // A worktree still checked out from it (one cleanup kept, or anyone's) needs its gitdir.
  const wts = await run(["git", "-C", path, "worktree", "list", "--porcelain"]);
  if (wts.code !== 0) return `unreadable: ${wts.stderr.trim() || `exit ${wts.code}`}`;
  const linked = linkedWorktrees(wts.stdout);
  if (linked.length > 0) return `linked worktree ${linked.join(", ")}`;
  const stash = await run(["git", "-C", path, "stash", "list"]);
  if (stash.code !== 0 || stash.stdout.trim() !== "") return "stash";
  const refs = await run([
    "git",
    "-C",
    path,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (refs.code !== 0) return `unreadable: ${refs.stderr.trim() || `exit ${refs.code}`}`;
  for (const b of refs.stdout.split("\n").map((l) => l.trim())) {
    if (b === "" || proven.has(b)) continue;
    const n = await run(["git", "-C", path, "rev-list", "--count", `${b}@{u}..${b}`]);
    if (n.code !== 0) return `${b} has no upstream`;
    const count = Number(n.stdout.trim());
    if (count > 0) return `${plural(count, "unpushed commit")} on ${b}`;
  }
  return null;
}

/**
 * Run (or, without `deps.consent`, print) the cleanup of `ledger` (SPEC §4.6.26). Every kept item
 * is printed as `kept <kind> <what>: <why>`, then one summary line. Returns the counts, the kept
 * list and the summary for `wave_cleaned`.
 */
export async function runCleanup(
  wave: string,
  ledger: Ledger,
  deps: CleanupDeps,
  io: IO,
): Promise<CleanupRun> {
  const removed = zero();
  const worktrees_on: Record<string, number> = {};
  const kept: Resource[] = [];
  const dry = deps.consent === undefined;
  const consent = deps.consent;
  let failed = 0;
  const keep = (r: Resource) => {
    kept.push(r);
  };
  for (const h of ledger.held) io.stdout(`skip ${h.task}: ${h.stage}\n`);
  const cmux = new LocalCmuxHost(deps.exec);
  const tmux = new LocalTmuxHost(deps.exec);
  const proven = new Set<string>();

  // --- The supervisor's own worktrees, sessions, processes, locks ---
  const local = ledger.targets.filter((t) => t.remote === undefined);
  const retiredLocal = local.filter((t) => t.live.length === 0);
  for (const t of local) {
    if (t.live.length > 0) {
      io.stdout(`skip ${t.worktree}: agent(s) not retired: ${t.live.join(", ")}\n`);
      keep({
        kind: "worktree",
        host: "local",
        what: t.worktree,
        ...(t.task ? { task: t.task } : {}),
        why: `agent(s) not retired: ${t.live.join(", ")}`,
      });
    }
  }
  if (dry) {
    for (const t of retiredLocal)
      io.stdout(
        `would remove ${t.worktree}${t.workspaces.length > 0 ? ` and workspace(s) ${t.workspaces.join(", ")}` : ""}\n`,
      );
  } else {
    for (const t of retiredLocal) {
      const host: Host = t.tmux === true ? tmux : cmux;
      for (const ws of t.workspaces) {
        try {
          await host.close(ws, consent as ConsentToken);
          removed.sessions++;
        } catch (e) {
          io.stderr(`workspace ${ws}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
  }
  // Processes before the worktrees go: a dev server holds its directory and its port.
  failed += await stopLocalProcesses(retiredLocal, local, deps, removed, io);
  if (!dry) {
    for (const t of retiredLocal) {
      if (!existsSync(t.worktree)) {
        io.stdout(`gone ${t.worktree}\n`);
      } else {
        const argv = ["git", "-C", ledger.repo, "worktree", "remove"];
        if (deps.force === true) argv.push("--force");
        const r = await deps.exec([...argv, t.worktree], { consent: consent as ConsentToken });
        if (r.code === 0) {
          io.stdout(`removed ${t.worktree}\n`);
          removed.worktrees++;
        } else {
          failed++;
          io.stderr(`could not remove ${t.worktree}: ${r.stderr.trim()}\n`);
          keep({
            kind: "worktree",
            host: "local",
            what: t.worktree,
            ...(t.task ? { task: t.task } : {}),
            why: r.stderr.trim().split("\n")[0] || "git worktree remove failed",
          });
          continue;
        }
      }
      for (const l of t.locks) {
        try {
          unlinkSync(l);
        } catch {}
      }
    }
  }

  // --- The supervisor's agent branches: deleted only at the merged head, with a token ---
  for (const b of ledger.branches.filter((x) => x.remote === undefined)) {
    if (ledger.targets.some((t) => t.task === b.task && t.live.length > 0)) continue;
    const v = await branchVerdict((argv) => deps.exec(argv), b);
    if ("gone" in v || "unreachable" in v) continue;
    if ("why" in v) {
      keep({ kind: "branch", host: "local", what: b.branch, task: b.task, why: v.why });
      continue;
    }
    if (dry) {
      proven.add(b.branch);
      io.stdout(`would delete branch ${b.branch}\n`);
      continue;
    }
    const r = await deps.exec(["git", "-C", b.repo, "branch", "-D", b.branch], {
      branchDelete: mintBranchDeleteToken(b.repo, b.branch),
    });
    if (r.code === 0) {
      // Proven only once it is gone: a branch still checked out somewhere was not deleted.
      proven.add(b.branch);
      io.stdout(`deleted branch ${b.branch}\n`);
      removed.branches++;
    } else {
      failed++;
      keep({
        kind: "branch",
        host: "local",
        what: b.branch,
        task: b.task,
        why: r.stderr.trim().split("\n")[0] || "git branch -D failed",
      });
    }
  }

  // --- Each paired machine, through its RemoteHost ---
  const remoteHosts = new Set([
    ...ledger.targets.flatMap((t) => (t.remote !== undefined ? [t.remote.host] : [])),
    ...ledger.clones
      .filter((c) => c.machine !== deps.localName && deps.hosts?.[c.machine] !== undefined)
      .map((c) => c.machine),
  ]);
  for (const machine of remoteHosts) {
    failed += await cleanRemote(
      wave,
      machine,
      ledger,
      deps,
      { removed, worktrees_on, keep, proven },
      io,
    );
  }

  // --- Leftover agent logins (D6) ---
  for (const l of ledger.logins) {
    if (dry) {
      io.stdout(`would delete login ${l.agent_id}\n`);
      continue;
    }
    if (deps.revokeLogin === undefined) {
      keep({ kind: "login", host: "local", what: l.agent_id, why: "daemon down" });
      continue;
    }
    if (await deps.revokeLogin(l.agent_id, l.task)) {
      io.stdout(`deleted login ${l.agent_id}\n`);
      removed.logins++;
    } else {
      keep({
        kind: "login",
        host: "local",
        what: l.agent_id,
        why: "the broker refused the delete",
      });
    }
  }

  // --- The managed clones volleyd made on this machine (D10) ---
  const keptMachines = new Set<string>();
  for (const c of ledger.clones.filter((x) => x.machine === deps.localName)) {
    const v = await cloneVerdict((argv) => deps.exec(argv), c.path, proven);
    if (v === "gone") continue;
    if (typeof v === "string" || (v !== null && "unreachable" in v)) {
      keptMachines.add(c.machine);
      keep({
        kind: "clone",
        host: "local",
        what: c.path,
        why: `${typeof v === "string" ? v : "unreadable"} (on ${c.machine})`,
      });
      continue;
    }
    if (dry) {
      io.stdout(`would remove clone ${c.path} on ${c.machine}\n`);
      continue;
    }
    const r = await deps.exec(["rm", "-rf", c.path], {
      cloneRemove: [mintCloneRemoveToken(c.path)],
    });
    if (r.code === 0) {
      io.stdout(`removed clone ${c.path} on ${c.machine}\n`);
      removed.clones++;
      await deps.journalSystem?.({
        type: "repo_clone_removed",
        data: { machine: c.machine, slug: c.slug, path: c.path, wave },
      });
    } else {
      failed++;
      keptMachines.add(c.machine);
      keep({ kind: "clone", host: "local", what: c.path, why: r.stderr.trim() || "rm failed" });
    }
  }
  for (const r of kept) if (r.kind === "clone" && r.host !== "local") keptMachines.add(r.host);

  // --- Registrations and accounts made for the wave (D5): after the clones ---
  for (const slug of ledger.repos) {
    if (dry) {
      io.stdout(`would remove repo ${slug}\n`);
      continue;
    }
    if (deps.removeRepo === undefined) {
      keep({ kind: "repo", host: "local", what: slug, why: "daemon down" });
      continue;
    }
    const cloneMachines = new Set(
      ledger.clones.filter((c) => sameSlug(c.slug, slug)).map((c) => c.machine),
    );
    const machines =
      keptMachines.size > 0 ? [...cloneMachines].filter((m) => !keptMachines.has(m)) : undefined;
    if (machines !== undefined && machines.length === 0) {
      keep({ kind: "repo", host: "local", what: slug, why: "a clone of it is kept" });
      continue;
    }
    const why = await deps.removeRepo(slug, machines);
    if (why === null) {
      io.stdout(
        `removed repo ${slug}${machines !== undefined ? ` from ${machines.join(", ")}` : ""}\n`,
      );
      removed.repos++;
      if (machines !== undefined)
        keep({
          kind: "repo",
          host: "local",
          what: slug,
          why: `still on ${[...keptMachines].join(", ")}, where its clone is kept`,
        });
    } else keep({ kind: "repo", host: "local", what: slug, why });
  }
  for (const name of ledger.accounts) {
    if (dry) {
      io.stdout(`would revoke account ${name}\n`);
      continue;
    }
    if (deps.revokeAccount === undefined) {
      keep({ kind: "account", host: "local", what: name, why: "daemon down" });
      continue;
    }
    const why = await deps.revokeAccount(name);
    if (why === null) {
      io.stdout(`revoked account ${name}\n`);
      removed.accounts++;
    } else keep({ kind: "account", host: "local", what: name, why });
  }

  // --- What the wave borrowed: named, with the command, never removed ---
  for (const b of ledger.borrowed) {
    if (b.kind === "release_branch") keep({ ...b, why: await releaseWhy(ledger, b.what, deps) });
    else keep(b);
  }
  if (removed.branches > 0 && deps.deleteBranchAtMerge !== true && ledger.slug !== undefined)
    io.stdout(
      "note: merged agent branches stay on GitHub: set autopilot.delete_branch: true to delete them at merge time\n",
    );

  for (const r of kept) io.stdout(`${keptLine(r)}\n`);
  const summary = summaryLine(wave, removed, kept.length, { dry, worktrees_on });
  io.stdout(`${summary}\n`);
  if (dry && ledger.targets.some((t) => t.live.length === 0))
    io.stdout("dry run: pass --yes to remove\n");
  return { removed, worktrees_on, kept, summary, failed };
}

/**
 * Stop the processes under the retired local worktrees (by argv or cwd), never one under a live
 * agent's. Not the whole wave root: the daemon launches an agent before it journals
 * agent_spawned, so a worktree the plan does not name may be one being launched right now.
 * Without consent, only prints them. Returns 1 when the processes could not be listed.
 */
async function stopLocalProcesses(
  retired: Target[],
  all: Target[],
  deps: CleanupDeps,
  removed: CleanupCounts,
  io: IO,
): Promise<number> {
  if (retired.length === 0) return 0;
  try {
    const found = await listProcessesUnder(
      deps.exec,
      retired.map((t) => t.worktree),
      { exclude: all.filter((t) => t.live.length > 0).map((t) => t.worktree) },
    );
    const labelOf = new Map(
      found.map((p) => [
        p.pid,
        retired.find((t) => t.worktree === p.root)?.agents.at(-1) ?? p.root,
      ]),
    );
    if (deps.consent === undefined) {
      for (const p of found) io.stdout(`would stop ${p.pid} (${labelOf.get(p.pid)})\n`);
      return 0;
    }
    const stopped = await stopProcesses(
      found.map((p) => p.pid),
      deps.reap ?? {},
    );
    for (const s of stopped) io.stdout(`stopped ${s.pid} (${labelOf.get(s.pid)})\n`);
    removed.processes += stopped.length;
    return 0;
  } catch (e) {
    io.stderr(`processes: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * One paired machine's items: sessions (`kill-session`), the branch evidence reads, the
 * processes (`peer cleanup --worktree … --yes`), the worktrees (`git worktree remove`), then the
 * proven branches and the owned clones (`peer cleanup --repo … --branch … --clone … --yes`). A box
 * that cannot be reached keeps every item, `(<machine> unreachable; …)`, for the next run.
 */
async function cleanRemote(
  wave: string,
  machine: string,
  ledger: Ledger,
  deps: CleanupDeps,
  acc: {
    removed: CleanupCounts;
    worktrees_on: Record<string, number>;
    keep: (r: Resource) => void;
    proven: Set<string>;
  },
  io: IO,
): Promise<number> {
  const dry = deps.consent === undefined;
  const targets = ledger.targets.filter((t) => t.remote?.host === machine);
  const retired = targets.filter((t) => t.live.length === 0);
  const branches = ledger.branches.filter((b) => b.remote?.host === machine);
  const clones = ledger.clones.filter((c) => c.machine === machine);
  const first = targets[0]?.remote;
  const target = first?.target ?? deps.hosts?.[machine]?.target;
  const allKept = (why: string) => {
    for (const t of targets)
      acc.keep({
        kind: "worktree",
        host: machine,
        what: t.worktree,
        ...(t.task ? { task: t.task } : {}),
        why,
      });
    for (const b of branches)
      acc.keep({ kind: "branch", host: machine, what: b.branch, task: b.task, why });
    for (const c of clones) acc.keep({ kind: "clone", host: machine, what: c.path, why });
  };
  if (target === undefined) {
    allKept(`${machine} is no configured host`);
    return 0;
  }
  const host = remoteHostOf(
    { host: machine, target, repo: first?.repo ?? clones[0]?.path ?? "/" },
    targets[0] !== undefined ? worktreeRootOf(targets[0].worktree) : "",
    deps,
  );
  // Reachability first: a box that is down is not "nothing to do".
  const probe = await host.exec([
    "git",
    "-C",
    first?.repo ?? clones[0]?.path ?? "/",
    "rev-parse",
    "--git-dir",
  ]);
  if (unreachable(probe)) {
    allKept(unreachableWhy(machine));
    io.stdout(`${machine}: unreachable; its items are kept for the next run\n`);
    return 0;
  }
  for (const t of targets.filter((x) => x.live.length > 0)) {
    io.stdout(`skip ${t.worktree} on ${target}: agent(s) not retired: ${t.live.join(", ")}\n`);
    acc.keep({
      kind: "worktree",
      host: machine,
      what: t.worktree,
      ...(t.task ? { task: t.task } : {}),
      why: `agent(s) not retired: ${t.live.join(", ")}`,
    });
  }
  let failed = 0;
  if (dry) {
    for (const t of retired)
      io.stdout(
        `would remove ${t.worktree} on ${target}${t.workspaces.length > 0 ? ` and workspace(s) ${t.workspaces.join(", ")}` : ""}\n`,
      );
  } else {
    for (const t of retired)
      for (const ws of t.workspaces) {
        try {
          await host.close(ws, deps.consent as ConsentToken);
          acc.removed.sessions++;
        } catch (e) {
          io.stderr(
            `workspace ${ws} on ${target}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
  }
  // The evidence (D4): the box's own `git rev-parse` of each branch against the merged head.
  const deleteNow: BranchItem[] = [];
  for (const b of branches) {
    if (targets.some((t) => t.task === b.task && t.live.length > 0)) continue;
    const v = await branchVerdict((argv) => host.exec(argv), b);
    if ("gone" in v) continue;
    if ("unreachable" in v) {
      acc.keep({
        kind: "branch",
        host: machine,
        what: b.branch,
        task: b.task,
        why: unreachableWhy(machine),
      });
      continue;
    }
    if ("why" in v) {
      acc.keep({ kind: "branch", host: machine, what: b.branch, task: b.task, why: v.why });
      continue;
    }
    acc.proven.add(b.branch);
    deleteNow.push(b);
  }
  const peerStep = host.spec.volley_dir !== "" && host.runCleanup !== undefined;
  // The processes under its worktrees, before the worktrees go.
  if (retired.length > 0 && peerStep) {
    try {
      const report = await (host.runCleanup as NonNullable<RemoteHost["runCleanup"]>).call(host, {
        worktrees: retired.map((t) => t.worktree),
        ...(deps.consent !== undefined ? { consent: deps.consent } : {}),
      });
      if (report === null) io.stderr(`processes on ${target}: ssh failed\n`);
      for (const w of report?.worktrees ?? []) {
        const label = retired.find((t) => t.worktree === w.worktree)?.agents.at(-1) ?? w.worktree;
        for (const p of w.pids)
          io.stdout(`${dry ? "would stop" : "stopped"} ${p.pid} (${label}) on ${target}\n`);
        if (!dry && w.stopped) acc.removed.processes += w.pids.length;
      }
    } catch (e) {
      io.stderr(`processes on ${target}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  } else if (retired.length > 0)
    io.stderr(`processes on ${target}: no volley_dir configured for ${machine}: not listed\n`);
  if (!dry) {
    for (const t of retired) {
      const gone = await remoteGone(host, t.worktree);
      if (gone === null) {
        acc.keep({
          kind: "worktree",
          host: machine,
          what: t.worktree,
          ...(t.task ? { task: t.task } : {}),
          why: unreachableWhy(machine),
        });
        continue;
      }
      if (gone) {
        io.stdout(`gone ${t.worktree} on ${target}\n`);
        continue;
      }
      const repo = t.remote?.repo ?? host.spec.repo ?? "/";
      const argv = ["git", "-C", repo, "worktree", "remove"];
      if (deps.force === true) argv.push("--force");
      const r = await host.exec([...argv, t.worktree], { consent: deps.consent as ConsentToken });
      if (r.code === 0) {
        io.stdout(`removed ${t.worktree} on ${target}\n`);
        acc.removed.worktrees++;
        acc.worktrees_on[machine] = (acc.worktrees_on[machine] ?? 0) + 1;
      } else {
        failed++;
        io.stderr(`could not remove ${t.worktree} on ${target}: ${r.stderr.trim()}\n`);
        acc.keep({
          kind: "worktree",
          host: machine,
          what: t.worktree,
          ...(t.task ? { task: t.task } : {}),
          why: unreachable(r)
            ? unreachableWhy(machine)
            : r.stderr.trim().split("\n")[0] || "git worktree remove failed",
        });
      }
    }
  }
  // The clone checks on the box (read-only), then the box deletes branches and clones itself.
  const cloneTokens: { clone: OwnedClone; token: CloneRemoveToken }[] = [];
  for (const c of clones) {
    const v = await cloneVerdict((argv) => host.exec(argv), c.path, acc.proven);
    if (v === "gone") continue;
    if (v !== null) {
      acc.keep({
        kind: "clone",
        host: machine,
        what: c.path,
        why: typeof v === "string" ? `${v} (on ${machine})` : unreachableWhy(machine),
      });
      continue;
    }
    cloneTokens.push({ clone: c, token: mintCloneRemoveToken(c.path) });
  }
  if (dry) {
    for (const b of deleteNow) io.stdout(`would delete branch ${b.branch} on ${target}\n`);
    for (const { clone } of cloneTokens)
      io.stdout(`would remove clone ${clone.path} on ${machine}\n`);
    return failed;
  }
  if ((deleteNow.length > 0 || cloneTokens.length > 0) && !peerStep) {
    for (const b of deleteNow)
      acc.keep({
        kind: "branch",
        host: machine,
        what: b.branch,
        task: b.task,
        why: `no volley_dir configured for ${machine}`,
      });
    for (const { clone } of cloneTokens)
      acc.keep({
        kind: "clone",
        host: machine,
        what: clone.path,
        why: `no volley_dir configured for ${machine}`,
      });
    return failed;
  }
  if (deleteNow.length === 0 && cloneTokens.length === 0) return failed;
  const repo = deleteNow[0]?.repo;
  try {
    const report = await (host.runCleanup as NonNullable<RemoteHost["runCleanup"]>).call(host, {
      ...(repo !== undefined ? { repo, branches: deleteNow.map((b) => b.branch) } : {}),
      clones: cloneTokens.map((c) => c.token),
      consent: deps.consent as ConsentToken,
    });
    if (report === null) {
      for (const b of deleteNow)
        acc.keep({
          kind: "branch",
          host: machine,
          what: b.branch,
          task: b.task,
          why: unreachableWhy(machine),
        });
      for (const { clone } of cloneTokens)
        acc.keep({ kind: "clone", host: machine, what: clone.path, why: unreachableWhy(machine) });
      return failed;
    }
    for (const b of report.branches) {
      const item = deleteNow.find((x) => x.branch === b.branch);
      if (b.deleted) {
        io.stdout(`deleted branch ${b.branch} on ${target}\n`);
        acc.removed.branches++;
      } else if (b.why !== "no such branch")
        acc.keep({
          kind: "branch",
          host: machine,
          what: b.branch,
          ...(item ? { task: item.task } : {}),
          why: b.why ?? "not deleted",
        });
    }
    for (const c of report.clones) {
      const item = cloneTokens.find((x) => x.clone.path === c.clone)?.clone;
      if (c.removed && item !== undefined) {
        io.stdout(`removed clone ${c.clone} on ${machine}\n`);
        acc.removed.clones++;
        await deps.journalSystem?.({
          type: "repo_clone_removed",
          data: { machine, slug: item.slug, path: item.path, wave },
        });
      } else if (c.why !== "gone")
        acc.keep({
          kind: "clone",
          host: machine,
          what: c.clone,
          why: `${c.why ?? "not removed"} (on ${machine})`,
        });
    }
  } catch (e) {
    failed++;
    io.stderr(`peer cleanup on ${target}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return failed;
}

/**
 * Why the wave's release branch stays (D4): volleyd never deletes it. When GitHub reads it fully
 * merged into the default branch (`ahead_by: 0`, read-only GETs), the command to delete it.
 */
async function releaseWhy(ledger: Ledger, branch: string, deps: CleanupDeps): Promise<string> {
  const slug = ledger.slug;
  const fallback = "the wave's release branch (volleyd never deletes it)";
  if (slug === undefined) return fallback;
  const def = await deps.exec(["gh", "api", `repos/${slug}`, "--jq", ".default_branch"]);
  const base = def.code === 0 ? def.stdout.trim() : "";
  if (base === "") return fallback;
  const cmp = await deps.exec([
    "gh",
    "api",
    `repos/${slug}/compare/${base}...${branch}`,
    "--jq",
    ".ahead_by",
  ]);
  const ahead = cmp.code === 0 ? Number(cmp.stdout.trim()) : Number.NaN;
  if (!Number.isInteger(ahead)) return fallback;
  return ahead === 0
    ? `merged into ${base} — git push origin --delete ${branch}`
    : `${plural(ahead, "commit")} not on ${base}`;
}

export interface CleanupOptions {
  yes: boolean;
  force: boolean;
  /** Also unfinished tasks' worktrees (default: only done and cancelled tasks'). */
  all?: boolean;
  exec?: ExecFn;
  /** How processes are stopped (tests: a shorter grace). */
  reap?: StopOptions;
  /** Tests: build remote hosts. */
  remoteHost?: CleanupDeps["remoteHost"];
}

/** The `_system` journal, read directly. */
const readSystem = (home: string) =>
  readJournalFile(join(home, "waves", SYSTEM_WAVE, "journal.jsonl"));

/** The other waves on file that are not archived, and their `repo:`. */
function otherWavesOf(home: string, wave: string): { wave: string; repo: string }[] {
  const dir = join(home, "waves");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  return names.flatMap((name) => {
    if (name === wave || name.startsWith("_")) return [];
    try {
      const { state } = readWave(home, name);
      return state.status === "archived" ? [] : [{ wave: name, repo: state.repo }];
    } catch {
      return [];
    }
  });
}

/**
 * Run (or with `yes: false`, print) the cleanup from `$VOLLEYD_HOME` directly, while the daemon is
 * down: logins, registrations and accounts are left for the daemon (`kept …: daemon down`). The
 * run is journaled `wave_cleaned` in the wave's journal (not while a daemon holds the home: the
 * journal has one writer). Returns the number of failed removals.
 */
export async function cleanupWave(
  home: string,
  wave: string,
  opts: CleanupOptions,
  io: IO,
): Promise<number> {
  const { state, events } = readWave(home, wave);
  const system = readSystem(home);
  let cfg = CONFIG_DEFAULTS;
  let localName: string | undefined;
  try {
    const system = Journal.open(join(home, "waves", SYSTEM_WAVE));
    const store = ConfigStore.load({ home, system, log: () => {} });
    cfg = store.effective();
    localName = store.localName();
  } catch {}
  const ledger = ledgerOf(
    {
      state,
      events,
      system,
      otherWaves: otherWavesOf(home, wave),
      ...(localName !== undefined
        ? { clones: { repo_root: cfg.fleet.repo_root, localName, localHome: homedir() } }
        : {}),
    },
    { all: opts.all === true },
  );
  const run = await runCleanup(
    wave,
    ledger,
    {
      exec: opts.exec ?? fencedExec,
      ...(opts.yes ? { consent: mintConsentToken(`volleyd cleanup ${wave} --yes`) } : {}),
      force: opts.force,
      ...(opts.reap !== undefined ? { reap: opts.reap } : {}),
      hosts: cfg.hosts,
      ...(localName !== undefined ? { localName } : {}),
      deleteBranchAtMerge: cfg.autopilot.delete_branch === true,
      journalSystem: (ev) => Journal.open(join(home, "waves", SYSTEM_WAVE)).append(ev),
      ...(opts.remoteHost !== undefined ? { remoteHost: opts.remoteHost } : {}),
    },
    io,
  );
  // Only one writer per journal: a daemon that holds the home journals its own runs.
  if (!daemonUp(home))
    Journal.open(join(home, "waves", wave)).append(
      cleanedEvent(
        "volleyd cleanup",
        run,
        !opts.yes,
        undefined,
        opts.yes ? coveredTasks(state, run.kept) : undefined,
      ),
    );
  return run.failed;
}

/**
 * The tasks a whole-wave run covers: every one done or cancelled when it ran (`wave_cleaned.tasks`),
 * whose own pass is then never needed. A task whose worktree the run kept for a live agent is not
 * covered: its own pass runs once the agent retires.
 */
export const coveredTasks = (state: WaveState, kept: Resource[]): string[] => {
  const live = new Set(
    kept.filter((r) => r.why?.startsWith("agent(s) not retired")).map((r) => r.task),
  );
  return state.tasks
    .filter((t) => (t.stage === "done" || t.stage === "cancelled") && !live.has(t.id))
    .map((t) => t.id);
};

/** The `wave_cleaned` event of a run (SPEC §4.6.26); `tasks`: a whole-wave run's `coveredTasks`. */
export function cleanedEvent(
  by: string,
  run: CleanupRun,
  dry: boolean,
  task?: string,
  tasks?: string[],
): NewEvent {
  return {
    type: "wave_cleaned",
    ...(task !== undefined ? { task } : {}),
    data: {
      by,
      removed: run.removed,
      kept: run.kept,
      summary: run.summary,
      dry_run: dry,
      ...(Object.keys(run.worktrees_on).length > 0 ? { worktrees_on: run.worktrees_on } : {}),
      ...(task !== undefined ? { task } : {}),
      ...(task === undefined && tasks !== undefined ? { tasks } : {}),
    },
  };
}

/** Is the daemon running on `home` (its `volleyd.lock` names a live pid)? */
function daemonUp(home: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(join(home, "volleyd.lock"), "utf-8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function cleanup({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseCleanup>;
  try {
    parsed = parseCleanup(argv);
  } catch (e) {
    io.stderr(`volleyd cleanup: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const [wave, ...extra] = parsed.positionals;
  if (wave === undefined || extra.length > 0 || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(wave)) {
    io.stderr(`volleyd cleanup: expected one wave id\n${HELP}`);
    return EXIT.USAGE;
  }
  const home = volleydHome(env);
  const yes = parsed.values.yes === true;
  const force = parsed.values.force === true;
  const all = parsed.values.all === true;
  // The daemon owns the journals while it runs: the run is its own (one writer, and it can
  // delete logins and remove registrations).
  if (daemonUp(home)) {
    let target: ReturnType<typeof resolveControlTarget>;
    try {
      target = resolveControlTarget(parsed.values, env);
    } catch (e) {
      io.stderr(`volleyd cleanup: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.USAGE;
    }
    return withClient(target, io, "volleyd cleanup", async (client) => {
      // The owner's identity, as every owner-gated command resolves it (controls.ts).
      const flag = typeof parsed.values.by === "string" ? parsed.values.by : undefined;
      const who = await callerFor(client, flag, env);
      if (who.warning !== undefined) io.stderr(`warning: ${who.warning}\n`);
      const res = await client.request(
        "cleanup",
        { wave, dry_run: !yes, force, all, ...(who.by !== null ? { by: who.by } : {}) },
        { text: `volleyd cleanup ${wave}`, timeoutMs: DAEMON_DEFAULTS.cleanup_op_timeout_ms },
      );
      const r = (res.result ?? {}) as { lines?: string[]; failed?: number };
      if (parsed.values.json === true && res.ok)
        io.stdout(
          `${JSON.stringify({ wave, lines: r.lines ?? [], failed: r.failed ?? 0 }, null, 2)}\n`,
        );
      else for (const l of r.lines ?? []) io.stdout(`${l}\n`);
      if (!res.ok) {
        io.stderr(`volleyd cleanup: ${ownedByHint(res.error ?? "refused", who.by)}\n`);
        return EXIT.ERROR;
      }
      return (r.failed ?? 0) > 0 ? EXIT.ERROR : EXIT.OK;
    });
  }
  try {
    const failed = await cleanupWave(home, wave, { yes, force, all }, io);
    return failed > 0 ? EXIT.ERROR : EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd cleanup: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}

function parseCleanup(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      by: { type: "string" },
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** The ledger's worktree targets and held tasks (`ledgerOf`), as the plan was before #612. */
export function cleanupPlan(
  state: WaveState,
  events: JournalEvent[],
  o: { all?: boolean } = {},
): { repo: string; targets: Target[]; held: { task: string; stage: string }[] } {
  const l = ledgerOf({ state, events, system: [] }, o);
  return { repo: l.repo, targets: l.targets, held: l.held };
}

/** Does a kept list hold an item kept because its machine was unreachable (a run to repeat)? */
export function keptUnreachable(kept: unknown): boolean {
  return (
    Array.isArray(kept) &&
    kept.some(
      (r) =>
        typeof (r as Resource)?.why === "string" &&
        (r as Resource).why?.includes("unreachable; cleanup runs again"),
    )
  );
}

/**
 * A whole-wave run with the per-task runs since the last whole-wave run folded in (their counts
 * and remote worktrees), so the wave's summary covers everything its cleanup removed. Pure.
 */
export function withTaskRuns(run: CleanupRun, events: readonly JournalEvent[]): CleanupRun {
  const removed = { ...run.removed };
  const on = { ...run.worktrees_on };
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === "wave_cleaned" && e.data.dry_run !== true && e.data.task === undefined)
      start = i + 1;
  });
  for (const e of events.slice(start)) {
    if (e.type !== "wave_cleaned" || e.data.dry_run === true || typeof e.data.task !== "string")
      continue;
    for (const [k, v] of Object.entries((e.data.removed ?? {}) as Record<string, unknown>))
      if (typeof v === "number" && k in removed) removed[k as keyof CleanupCounts] += v;
    for (const [m, v] of Object.entries((e.data.worktrees_on ?? {}) as Record<string, unknown>))
      if (typeof v === "number") on[m] = (on[m] ?? 0) + v;
  }
  return { ...run, removed, worktrees_on: on };
}
