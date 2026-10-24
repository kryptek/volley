import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { type ExecFn, exec as fencedExec } from "../exec";
import { type ConsentToken, mintConsentToken } from "../fence";
import type { Host } from "../hosts/host";
import { LocalCmuxHost } from "../hosts/local-cmux";
import { LocalTmuxHost } from "../hosts/local-tmux";
import { SshTmuxHost } from "../hosts/ssh-tmux";
import { type CommandArgs, EXIT, type ExitCode, type IO } from "../io";
import { readJournalFile } from "../journal";
import { type StopOptions, listAgentProcesses, stopProcesses, underRoot } from "../procs";
import { replay } from "../reducer";
import type { JournalEvent, WaveState } from "../types";
import { expandHome } from "../worktree";

const HELP = `Usage: volleyd cleanup <wave> [--yes] [--force] [--all]

Remove what a wave's retired agents left behind: their cmux workspaces or tmux sessions (the
terminal each agent ran in), git worktrees, and claude processes still running on this machine (any process
whose --mcp-config= lies in one of those worktrees: SIGTERM, a grace, then SIGKILL).
Without --yes, only prints what would be removed. Only worktrees whose every agent is retired
(journaled agent_retired) are touched; live agents are listed and skipped. Branches are kept.
A worktree with uncommitted changes is skipped unless --force is given. Only tasks that are done
or cancelled are touched: an unfinished task (e.g. merge_ready, its agents retired while the
merge waits) is listed and skipped unless --all is given. The pipeline falls back to the repo
root for a local task's removed worktree, not for a remote task's: --all on an unfinished remote
task leaves its git checks failing until it is resolved by hand.
Reads $VOLLEYD_HOME directly; works while the daemon is down.
`;

interface Target {
  worktree: string;
  agents: string[];
  workspaces: string[];
  live: string[];
  /** Set for a remote host's worktree (agent_spawned `remote`): where it lives. */
  remote?: { host: string; target: string; repo: string };
  /** A local worktree's agents ran in tmux (agent_spawned `terminal`), not cmux. */
  tmux?: boolean;
}

/** A wave's reduced state and its journal ($VOLLEYD_HOME directly; works while the daemon is down). */
export function readWave(home: string, wave: string): { state: WaveState; events: JournalEvent[] } {
  const events = readJournalFile(join(home, "waves", wave, "journal.jsonl"));
  const { state } = replay(events);
  if (state === null) throw new Error(`unknown wave '${wave}'`);
  return { state, events };
}

/**
 * The cleanup plan: one entry per worktree the wave's agents used, and the tasks it holds back.
 * A worktree of a task that is not done or cancelled is left alone (`held`) unless `all`: a
 * merge_ready task's agents are all retired while its merge waits, and the pipeline still reads
 * its PR. A task the state does not know is not held.
 */
export function cleanupPlan(
  state: WaveState,
  events: JournalEvent[],
  o: { all?: boolean } = {},
): { repo: string; targets: Target[]; held: { task: string; stage: string }[] } {
  const repo = expandHome(state.repo);
  const unfinished = new Map(
    state.tasks
      .filter((t) => t.stage !== "done" && t.stage !== "cancelled")
      .map((t) => [t.id, t.stage as string]),
  );
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
  const held = new Map<string, string>();
  const byPath = new Map<string, Target>();
  for (const e of events) {
    if (e.type !== "agent_spawned" || typeof e.data.worktree !== "string") continue;
    const stage = e.task !== undefined ? unfinished.get(e.task) : undefined;
    if (stage !== undefined && o.all !== true) {
      held.set(e.task as string, stage);
      continue;
    }
    const t = byPath.get(e.data.worktree) ?? {
      worktree: e.data.worktree,
      agents: [],
      workspaces: [],
      live: [],
    };
    const id = e.data.agent_id as string;
    t.agents.push(id);
    const remote = e.data.remote as { target?: unknown; repo?: unknown } | undefined;
    if (typeof remote?.target === "string" && typeof remote.repo === "string") {
      t.remote = { host: String(e.data.host), target: remote.target, repo: remote.repo };
    }
    if (e.data.terminal === "tmux") t.tmux = true;
    const ws = e.data.workspace;
    if (typeof ws === "string" && !closed.has(id) && !t.workspaces.includes(ws))
      t.workspaces.push(ws);
    if (!retired.has(id)) t.live.push(id);
    byPath.set(t.worktree, t);
  }
  return {
    repo,
    targets: [...byPath.values()],
    held: [...held].map(([task, stage]) => ({ task, stage })),
  };
}

export interface CleanupOptions {
  yes: boolean;
  force: boolean;
  /** Also unfinished tasks' worktrees (default: only done and cancelled tasks'). */
  all?: boolean;
  exec?: ExecFn;
  /** How processes are stopped (tests: a shorter grace). */
  reap?: StopOptions;
}

/** Run (or with `yes: false`, print) the cleanup. Returns the number of failed removals. */
export async function cleanupWave(
  home: string,
  wave: string,
  opts: CleanupOptions,
  io: IO,
): Promise<number> {
  const { state, events } = readWave(home, wave);
  const { repo, targets, held } = cleanupPlan(state, events, { all: opts.all === true });
  for (const h of held) io.stdout(`skip ${h.task}: ${h.stage}\n`);
  const run = opts.exec ?? fencedExec;
  const cmux = new LocalCmuxHost(run);
  const tmux = new LocalTmuxHost(run);
  const consent: ConsentToken | undefined = opts.yes
    ? mintConsentToken(`volleyd cleanup ${wave} --yes`)
    : undefined;
  let failed = 0;
  for (const t of targets) {
    // A remote worktree's lines name the machine it is on.
    const where = t.remote !== undefined ? ` on ${t.remote.target}` : "";
    if (t.live.length > 0) {
      io.stdout(`skip ${t.worktree}${where}: agent(s) not retired: ${t.live.join(", ")}\n`);
      continue;
    }
    if (consent === undefined) {
      io.stdout(
        `would remove ${t.worktree}${where}${t.workspaces.length > 0 ? ` and workspace(s) ${t.workspaces.join(", ")}` : ""}\n`,
      );
      continue;
    }
    const host: Host =
      t.remote !== undefined ? remoteHost(t.remote, run) : t.tmux === true ? tmux : cmux;
    for (const ws of t.workspaces) {
      try {
        await host.close(ws, consent);
      } catch (e) {
        io.stderr(`workspace ${ws}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (t.remote === undefined ? !existsSync(t.worktree) : await remoteGone(host, t.worktree)) {
      io.stdout(`gone ${t.worktree}${where}\n`);
      continue;
    }
    const gitRepo = t.remote?.repo ?? repo;
    const argv = ["git", "-C", gitRepo, "worktree", "remove", ...(opts.force ? ["--force"] : [])];
    const r = await host.exec([...argv, t.worktree], { consent });
    if (r.code === 0) io.stdout(`removed ${t.worktree}${where}\n`);
    else {
      failed++;
      io.stderr(`could not remove ${t.worktree}${where}: ${r.stderr.trim()}\n`);
    }
  }
  failed += await stopRetiredProcesses(targets, run, consent !== undefined, opts.reap ?? {}, io);
  if (consent === undefined && targets.some((t) => t.live.length === 0)) {
    io.stdout("dry run: pass --yes to remove\n");
  }
  return failed;
}

/**
 * Stop the retired agents' processes still running on this machine: only under the worktree of
 * a local target whose every agent is retired. Not the whole wave root: the daemon launches an
 * agent before it journals agent_spawned, so a worktree the plan does not name may be one being
 * launched right now. Without `yes`, only prints them. Returns 1 when the processes could not be
 * listed.
 */
async function stopRetiredProcesses(
  targets: Target[],
  run: ExecFn,
  yes: boolean,
  reap: StopOptions,
  io: IO,
): Promise<number> {
  const retired = targets.filter((t) => t.remote === undefined && t.live.length === 0);
  if (retired.length === 0) return 0;
  /** The retired target an mcp path's worktree is in, if any. */
  const targetOf = (mcp: string) =>
    retired.find((t) => underRoot(dirname(dirname(mcp)), t.worktree));
  try {
    const mine = (await listAgentProcesses(run)).flatMap((p) => {
      const t = targetOf(p.mcp);
      return t === undefined ? [] : [{ ...p, label: t.agents.at(-1) ?? p.mcp }];
    });
    const labelOf = new Map(mine.map((p) => [p.pid, p.label]));
    if (!yes) {
      for (const p of mine) io.stdout(`would stop ${p.pid} (${p.label})\n`);
      return 0;
    }
    const stopped = await stopProcesses(
      mine.map((p) => p.pid),
      reap,
    );
    for (const s of stopped) io.stdout(`stopped ${s.pid} (${labelOf.get(s.pid)})\n`);
    return 0;
  } catch (e) {
    io.stderr(`processes: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/** ssh's own exit status: the probe could not reach the box, which says nothing about the path. */
const SSH_FAILED = 255;

/** True when the box answered that `path` is no work tree (already removed): a re-run is a no-op. */
async function remoteGone(host: Host, path: string): Promise<boolean> {
  const r = await host.exec(["git", "-C", path, "rev-parse", "--is-inside-work-tree"]);
  return r.code !== 0 && r.code !== SSH_FAILED && !r.timedOut;
}

/** The remote host a journaled worktree lives on: only its target and repo are needed here. */
function remoteHost(r: NonNullable<Target["remote"]>, exec: ExecFn): Host {
  return new SshTmuxHost(
    {
      name: r.host,
      target: r.target,
      repo: r.repo,
      // Not used by close() or exec(); cleanup never launches anything.
      worktree_root: r.repo,
      volley_dir: r.repo,
      tunnel: { remote_port: 0, supervise: false },
    },
    exec,
  );
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
  try {
    const failed = await cleanupWave(
      volleydHome(env),
      wave,
      {
        yes: parsed.values.yes === true,
        force: parsed.values.force === true,
        all: parsed.values.all === true,
      },
      io,
    );
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
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
