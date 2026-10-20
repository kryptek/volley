import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { type ExecFn, exec as fencedExec } from "../exec";
import { type ConsentToken, mintConsentToken } from "../fence";
import type { Host } from "../hosts/host";
import { LocalCmuxHost } from "../hosts/local-cmux";
import { SshTmuxHost } from "../hosts/ssh-tmux";
import { type CommandArgs, EXIT, type ExitCode, type IO } from "../io";
import { readJournalFile } from "../journal";
import { type ReapOptions, listAgentProcesses, reapUnder, underRoot } from "../procs";
import type { Wave } from "../types";
import { expandHome } from "../worktree";

const HELP = `Usage: volleyd cleanup <wave> [--yes] [--force]

Remove what a wave's retired agents left behind: their cmux workspaces (tmux sessions on a
remote host), git worktrees, and claude processes still running on this machine (any process
whose --mcp-config= lies in the wave's worktree root: SIGTERM, a grace, then SIGKILL).
Without --yes, only prints what would be removed. Only worktrees whose every agent is retired
(journaled agent_retired) are touched; live agents are listed and skipped. Branches are kept.
A worktree with uncommitted changes is skipped unless --force is given.
Reads $VOLLEYD_HOME directly; works while the daemon is down.
`;

interface Target {
  worktree: string;
  agents: string[];
  workspaces: string[];
  live: string[];
  /** Set for a remote host's worktree (agent_spawned `remote`): where it lives. */
  remote?: { host: string; target: string; repo: string };
}

/** The cleanup plan from a wave journal: one entry per worktree its agents used. */
export function cleanupPlan(home: string, wave: string): { repo: string; targets: Target[] } {
  const events = readJournalFile(join(home, "waves", wave, "journal.jsonl"));
  const submitted = events.find((e) => e.type === "wave_submitted");
  if (submitted === undefined) throw new Error(`unknown wave '${wave}'`);
  const repo = expandHome((submitted.data.wave as Wave).repo);
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
  const byPath = new Map<string, Target>();
  for (const e of events) {
    if (e.type !== "agent_spawned" || typeof e.data.worktree !== "string") continue;
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
    const ws = e.data.workspace;
    if (typeof ws === "string" && !closed.has(id) && !t.workspaces.includes(ws))
      t.workspaces.push(ws);
    if (!retired.has(id)) t.live.push(id);
    byPath.set(t.worktree, t);
  }
  return { repo, targets: [...byPath.values()] };
}

export interface CleanupOptions {
  yes: boolean;
  force: boolean;
  exec?: ExecFn;
  /** How processes are stopped (tests: a shorter grace). */
  reap?: ReapOptions;
}

/** Run (or with `yes: false`, print) the cleanup. Returns the number of failed removals. */
export async function cleanupWave(
  home: string,
  wave: string,
  opts: CleanupOptions,
  io: IO,
): Promise<number> {
  const { repo, targets } = cleanupPlan(home, wave);
  const run = opts.exec ?? fencedExec;
  const local = new LocalCmuxHost(run);
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
    const host: Host = t.remote !== undefined ? remoteHost(t.remote, run) : local;
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
  failed += await stopProcesses(targets, run, consent !== undefined, opts.reap ?? {}, io);
  if (consent === undefined && targets.some((t) => t.live.length === 0)) {
    io.stdout("dry run: pass --yes to remove\n");
  }
  return failed;
}

/**
 * Stop the retired agents' processes still running on this machine: once per wave root (the
 * directory its local worktrees are in), never under a worktree a live agent holds, never
 * outside the root. Without `yes`, only prints them. Returns 1 when the processes could not be
 * listed.
 */
async function stopProcesses(
  targets: Target[],
  run: ExecFn,
  yes: boolean,
  reap: ReapOptions,
  io: IO,
): Promise<number> {
  const local = targets.filter((t) => t.remote === undefined);
  // Every local worktree is held by a live agent: nothing of this wave is left to stop.
  if (!local.some((t) => t.live.length === 0)) return 0;
  const roots = [...new Set(local.map((t) => dirname(t.worktree)))];
  const exclude = local.filter((t) => t.live.length > 0).map((t) => t.worktree);
  /** `<agent id>` of the worktree an mcp path is in, else the path itself. */
  const label = (mcp: string) => {
    const t = local.find((x) => underRoot(dirname(dirname(mcp)), x.worktree));
    return t?.agents.at(-1) ?? mcp;
  };
  try {
    for (const root of roots) {
      if (!yes) {
        const inRoot = (mcp: string) =>
          underRoot(dirname(dirname(mcp)), root) &&
          !exclude.some((x) => underRoot(dirname(dirname(mcp)), x));
        for (const p of await listAgentProcesses(run))
          if (inRoot(p.mcp)) io.stdout(`would stop ${p.pid} (${label(p.mcp)})\n`);
        continue;
      }
      const r = await reapUnder(run, root, { ...reap, exclude });
      for (const p of r.stopped) io.stdout(`stopped ${p.pid} (${label(p.mcp)})\n`);
    }
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
      { yes: parsed.values.yes === true, force: parsed.values.force === true },
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
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
