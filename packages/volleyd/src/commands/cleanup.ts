import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { type ExecFn, exec as fencedExec } from "../exec";
import { type ConsentToken, mintConsentToken } from "../fence";
import { LocalCmuxHost } from "../hosts/local-cmux";
import { type CommandArgs, EXIT, type ExitCode, type IO } from "../io";
import { readJournalFile } from "../journal";
import type { Wave } from "../types";
import { expandHome } from "../worktree";

const HELP = `Usage: volleyd cleanup <wave> [--yes] [--force]

Remove what a wave's retired agents left behind: their cmux workspaces and git worktrees.
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
    const ws = e.data.workspace;
    if (typeof ws === "string" && !t.workspaces.includes(ws)) t.workspaces.push(ws);
    if (!retired.has(id)) t.live.push(id);
    byPath.set(t.worktree, t);
  }
  return { repo, targets: [...byPath.values()] };
}

export interface CleanupOptions {
  yes: boolean;
  force: boolean;
  exec?: ExecFn;
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
  const host = new LocalCmuxHost(run);
  const consent: ConsentToken | undefined = opts.yes
    ? mintConsentToken(`volleyd cleanup ${wave} --yes`)
    : undefined;
  let failed = 0;
  for (const t of targets) {
    if (t.live.length > 0) {
      io.stdout(`skip ${t.worktree}: agent(s) not retired: ${t.live.join(", ")}\n`);
      continue;
    }
    if (consent === undefined) {
      io.stdout(
        `would remove ${t.worktree}${t.workspaces.length > 0 ? ` and workspace(s) ${t.workspaces.join(", ")}` : ""}\n`,
      );
      continue;
    }
    for (const ws of t.workspaces) {
      try {
        await host.close(ws, consent);
      } catch (e) {
        io.stderr(`workspace ${ws}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (!existsSync(t.worktree)) {
      io.stdout(`gone ${t.worktree}\n`);
      continue;
    }
    const argv = ["git", "-C", repo, "worktree", "remove", ...(opts.force ? ["--force"] : [])];
    const r = await run([...argv, t.worktree], { consent });
    if (r.code === 0) io.stdout(`removed ${t.worktree}\n`);
    else {
      failed++;
      io.stderr(`could not remove ${t.worktree}: ${r.stderr.trim()}\n`);
    }
  }
  if (consent === undefined && targets.some((t) => t.live.length === 0)) {
    io.stdout("dry run: pass --yes to remove\n");
  }
  return failed;
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
