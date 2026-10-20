import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../src/brief";
import {
  type DecisionInput,
  type DecisionRecord,
  openEvent,
  resolveEvent,
} from "../../src/decisions";
import type { ExecFn, ExecOptions, ExecResult } from "../../src/exec";
import { assertAllowed } from "../../src/fence";
import { agentIdFor } from "../../src/identity";
import { PipelineDriver, type PipelineEvent, type SpawnStart } from "../../src/pipeline";
import { type WaveRecord, apply, emptyRecord } from "../../src/reducer";
import type { HygieneLevel } from "../../src/reviews";
import type { BranchUpdate, JournalEvent, NewEvent, NudgeOnMerge } from "../../src/types";
import { parseWaveFile } from "../../src/wave-file";
import { branchName } from "../../src/worktree";
import { FIXTURES } from "./fake-host";
import { tempDir } from "./tmp";

/**
 * The pipeline driver on an in-memory journal and a scripted git/GitHub "world": no broker, no
 * processes. Agents are simulated by `finish(role, …)`, which pushes a head (unless told not to)
 * and reports a terminal status the way the daemon's supervisor would.
 */

/** The design's default pipeline. */
export const DEFAULT_PIPELINE = "[implement, [spec_review, quality_review], fixup, merge_ready]";

export const sha = (n: number) => n.toString(16).padStart(40, "0");

export interface World {
  /** HEAD per worktree. */
  local: Record<string, string>;
  /** Branch heads on origin. */
  origin: Record<string, string>;
  /** Open PRs. */
  prs: {
    number: number;
    url: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
  }[];
  /** CI per head (absent: no run). */
  ci: Record<string, "green" | "red" | "running">;
  /** Several CI runs per head (overrides `ci`): each run's status and conclusion. */
  /** Runs on a head; `id` / `workflow` / `event` default to one distinct workflow per run. */
  ciRuns: Record<
    string,
    { status: string; conclusion: string; id?: number; workflow?: string; event?: string }[]
  >;
  releaseTip: string;
  /** merge-base(head, releaseTip) per head (default: the release tip, i.e. current). */
  mergeBase: Record<string, string>;
  /** PR states by number for `gh pr view` (default OPEN). */
  prState: Record<number, "OPEN" | "MERGED" | "CLOSED">;
  /** `git diff --name-only a b` per `a..b`. */
  diffNames: Record<string, string[]>;
  /** `git merge-base --is-ancestor a b` per `a..b` (default: not an ancestor). */
  ancestor: Record<string, boolean>;
  /** `git log --left-right --cherry-pick --format=%m%H <release>...<head>` per head. */
  cherry: Record<string, string>;
  /** `git log --format=%H %s <base>..<release>`: the release branch's new commits. */
  releaseLog: string;
  /** `git diff <a> <b>` / `git show --format= <sha>` text per `a..b` / sha. */
  patches: Record<string, string>;
  /** `gh pr view <n> --json files` by PR number (default: fixtures/gh-pr-view-files.json). */
  prFiles: Record<number, string>;
  /** `gh pr view` overrides by PR number (e.g. a `headRefOid` GitHub reports after a merge). */
  prView: Record<number, Record<string, unknown>>;
  /** `gh run view <id> --json jobs` (default: one failed `test` job). */
  runJobs?: string;
  /** `gh run view <id> --log-failed`. */
  runLog: string;
  /** Called with every argv before it is answered (a test may change the world mid-run). */
  before?: ((argv: string[]) => void) | undefined;
  /** An argv this answers true for never returns (a hung network call). */
  hang?: ((argv: string[]) => boolean) | undefined;
  /** An argv this answers true for comes back `timedOut` (exec's hard timeout fired). */
  timeout?: ((argv: string[]) => boolean) | undefined;
  /** An argv this answers true for rejects (e.g. `gh` not on PATH). */
  fail?: ((argv: string[]) => boolean) | undefined;
}

export interface Spawned {
  role: Role;
  agent_id: string;
  worktree: string;
  start?: SpawnStart;
  files: Record<string, string>;
  /** How the step tells a rebase role to bring the branch up to date (absent: rebase). */
  branch_update?: BranchUpdate;
}

export interface HarnessOptions {
  pipeline?: string;
  /** Enforce the real fence on every argv (default true). */
  fence?: boolean;
  /** Wrap the harness exec per task (the daemon's remote-host routing). */
  execFor?: (task: string, exec: ExecFn) => ExecFn;
  /** More tasks after T1 (queued, never admitted or driven), e.g. `{ T2: [T1] }` → `after: [T1]`. */
  dependents?: Record<string, string[]>;
  /**
   * Sibling tasks of T1 (no `after:`), each with its wave-file `files` hint (null: none); their
   * implementers are started with `startSibling`.
   */
  siblings?: Record<string, string[] | null>;
  /** The `placement.nudge_on_merge` the driver reads (default: the driver's own default). */
  nudgeOnMerge?: NudgeOnMerge;
  /** What the daemon adds to a decision before opening it (F6: `respawn on <best>`). */
  decideWith?: (input: DecisionInput, extra: Record<string, unknown>) => DecisionInput;
  /** The `branch_update` tunable the driver reads (default: absent, i.e. `rebase`). */
  branchUpdate?: BranchUpdate;
  /** The wave's hygiene level the driver reads (default: absent, i.e. `p1`). */
  hygiene?: HygieneLevel;
}

export function pipelineHarness(o: HarnessOptions = {}) {
  const home = tempDir("volleyd-pipeline-");
  const wave = parseWaveFile(
    [
      "wave: w1",
      "repo: /repo",
      "release_branch: release/w1",
      "model: claude-opus-5-5",
      `pipeline: ${o.pipeline ?? DEFAULT_PIPELINE}`,
      "tasks:",
      "  T1: { issue: 42 }",
      ...Object.entries(o.dependents ?? {}).map(
        ([id, after], i) => `  ${id}: { issue: ${43 + i}, after: [${after.join(", ")}] }`,
      ),
      ...Object.entries(o.siblings ?? {}).map(
        ([id, files], i) =>
          `  ${id}: { issue: ${60 + i}${files !== null ? `, files: [${files.join(", ")}]` : ""} }`,
      ),
      "",
    ].join("\n"),
  );
  let rec: WaveRecord = emptyRecord();
  const events: JournalEvent[] = [];
  let seq = 0;
  const journal = async (ev: NewEvent) => {
    const e: JournalEvent = { ...ev, seq: ++seq, at: new Date().toISOString() } as JournalEvent;
    events.push(e);
    rec = apply(rec, e);
    return e;
  };

  const world: World = {
    local: {},
    origin: {},
    prs: [],
    ci: {},
    ciRuns: {},
    releaseTip: sha(0xbea5e),
    mergeBase: {},
    prState: {},
    diffNames: {},
    ancestor: {},
    cherry: {},
    releaseLog: "",
    patches: {},
    prView: {},
    prFiles: {},
    runLog: "",
  };
  const calls: string[][] = [];
  /** The exec options of every call, parallel to `calls`. */
  const callOpts: ExecOptions[] = [];
  const out = (stdout: string, code = 0): ExecResult => ({
    code,
    stdout,
    stderr: "",
    timedOut: false,
  });
  const exec: ExecFn = async (argv, opts = {}) => {
    if (o.fence !== false) assertAllowed(argv);
    calls.push([...argv]);
    callOpts.push(opts);
    const a = [...argv];
    world.before?.(a);
    if (world.hang?.(a)) return new Promise<ExecResult>(() => {});
    if (world.timeout?.(a)) return { ...out(""), code: 124, timedOut: true };
    if (world.fail?.(a)) throw new Error(`spawn ${a[0]} ENOENT`);
    if (a[0] === "git" && a[1] === "-C") {
      const wt = a[2] as string;
      const [verb, ...rest] = a.slice(3);
      if (verb === "rev-parse" && rest[0] === "HEAD")
        return out(`${world.local[wt] ?? ""}\n`, world.local[wt] ? 0 : 1);
      if (verb === "rev-parse") {
        const ref = (rest.at(-1) as string).replace("refs/remotes/origin/", "");
        const head = ref === wave.release_branch ? world.releaseTip : world.origin[ref];
        return head !== undefined ? out(`${head}\n`) : out("", 1);
      }
      if (verb === "fetch") return out("");
      const tipOf = (r: string) => (r === `origin/${wave.release_branch}` ? world.releaseTip : r);
      if (verb === "merge-base" && rest[0] === "--is-ancestor")
        return out(
          "",
          world.ancestor[`${tipOf(rest[1] as string)}..${tipOf(rest[2] as string)}`] ? 0 : 1,
        );
      if (verb === "log" && rest.includes("--cherry-pick")) {
        const range = rest.at(-1) as string;
        // Default: the head's own commit has no equivalent upstream.
        const head = range.split("...")[1] as string;
        return out(world.cherry[head] ?? `>${head}\n`);
      }
      if (verb === "log" && rest.includes("--format=%H %s")) return out(world.releaseLog);
      if (verb === "show" && rest[0] === "--format=")
        return out(world.patches[rest[1] as string] ?? "");
      if (verb === "diff" && rest.length === 2 && !(rest[0] as string).startsWith("-"))
        return out(world.patches[`${rest[0]}..${rest[1]}`] ?? "");
      if (verb === "merge-base")
        return out(`${world.mergeBase[rest[0] as string] ?? world.releaseTip}\n`);
      if (verb === "log") return out("c1 upstream change\nc2 upstream change\n");
      if (verb === "diff" && rest[0] === "--name-only")
        return out(`${(world.diffNames[`${rest[1]}..${rest[2]}`] ?? []).join("\n")}\n`);
      if (verb === "diff" && rest[0] === "--stat")
        return out(" src/batch.ts | 4 ++--\n 1 file changed\n");
      return out("");
    }
    if (a[0] === "gh" && a[1] === "pr" && a[2] === "list") {
      const branch = a[a.indexOf("--head") + 1];
      return out(JSON.stringify(world.prs.filter((p) => p.headRefName === branch)));
    }
    if (a[0] === "gh" && a[1] === "pr" && a[2] === "view" && a.at(-1) === "files") {
      const n = Number(a[3]);
      return out(
        world.prFiles[n] ?? readFileSync(join(FIXTURES, "gh-pr-view-files.json"), "utf-8"),
      );
    }
    if (a[0] === "gh" && a[1] === "pr" && a[2] === "view") {
      const n = Number(a[3]);
      const state = world.prState[n] ?? "OPEN";
      return out(
        JSON.stringify({
          state,
          headRefOid: world.prs.find((p) => p.number === n)?.headRefOid ?? null,
          mergedAt: state === "MERGED" ? "2026-10-18T13:00:00Z" : null,
          mergeCommit: state === "MERGED" ? { oid: sha(0xa11) } : null,
          baseRefName: wave.release_branch,
          ...world.prView[n],
        }),
      );
    }
    if (a[0] === "gh" && a[1] === "run" && a[2] === "list") {
      const head = a[a.indexOf("--commit") + 1] as string;
      const many = world.ciRuns[head];
      if (many !== undefined)
        return out(
          JSON.stringify(
            many.map((r, i) => ({
              databaseId: r.id ?? 900 + i,
              name: r.workflow ?? `check-${i + 1}`,
              workflowName: r.workflow ?? `check-${i + 1}`,
              event: r.event ?? "pull_request",
              status: r.status,
              conclusion: r.conclusion,
              headSha: head,
              url: `https://github.com/example/repo/actions/runs/${r.id ?? 900 + i}`,
            })),
          ),
        );
      const state = world.ci[head];
      if (state === undefined) return out("[]");
      return out(
        JSON.stringify([
          {
            databaseId: 900,
            name: "CI",
            workflowName: "CI",
            status: state === "running" ? "in_progress" : "completed",
            conclusion: state === "green" ? "success" : state === "red" ? "failure" : "",
            headSha: head,
            url: `https://github.com/example/repo/actions/runs/${head.slice(-4)}`,
          },
        ]),
      );
    }
    if (a[0] === "gh" && a[1] === "run" && a[2] === "view") {
      if (a.includes("--log-failed")) return out(world.runLog);
      if (world.runJobs !== undefined) return out(world.runJobs);
      return out(
        JSON.stringify({
          jobs: [
            {
              name: "test",
              conclusion: "failure",
              steps: [{ name: "Run tests", conclusion: "failure" }],
            },
          ],
        }),
      );
    }
    return out("");
  };

  const spawns: Spawned[] = [];
  const steers: { task: string; role: Role; agent_id: string; text: string; reason: string }[] = [];
  const attempts: Record<string, number> = {};
  /** The last result each agent reported (retire journals it, as retireAgent does). */
  const lastResult: Record<string, unknown> = {};
  /** Every retire the driver asked for, with its status. */
  const retired: { agent_id: string; status: string }[] = [];
  /** Role spawns the daemon holds (budget, admission, a refused launch) while this is true. */
  let holdSpawns = false;
  let branchUpdate = o.branchUpdate;
  const spawnAgent = async (
    role: Role,
    start?: SpawnStart,
    files: Record<string, string> = {},
    update?: BranchUpdate,
  ) => {
    const attempt = (attempts[role] ?? 0) + 1;
    attempts[role] = attempt;
    const agent_id = agentIdFor("w1", "T1", role, attempt);
    const worktree = `/wt/w1/T1-${role}-${attempt}`;
    const branch = start?.detach ? "HEAD" : branchName("w1", "T1", role, attempt);
    spawns.push({
      role,
      agent_id,
      worktree,
      ...(start !== undefined ? { start } : {}),
      files,
      ...(update !== undefined ? { branch_update: update } : {}),
    });
    if (start !== undefined) world.local[worktree] = start.ref;
    await journal({
      type: "agent_spawned",
      task: "T1",
      data: {
        agent_id,
        role,
        attempt,
        worktree,
        branch,
        // Cut from the release branch as it is (the spawn's base_sha), or from a start ref.
        ...(start !== undefined ? { start: start.ref } : { base_sha: world.releaseTip }),
      },
    });
    if (role === "implementer" && attempt === 1)
      await journal({ type: "stage_entered", task: "T1", data: { stage: "implement" } });
    return agent_id;
  };

  let clock = Date.parse("2026-10-18T12:00:00.000Z");
  let queue: Promise<unknown> = Promise.resolve();
  const deps: ConstructorParameters<typeof PipelineDriver>[1] = {
    now: () => clock,
    ...(o.nudgeOnMerge !== undefined ? { nudgeOnMerge: () => o.nudgeOnMerge as NudgeOnMerge } : {}),
    exec,
    ...(o.execFor !== undefined
      ? {
          execFor: (task: string) =>
            (o.execFor as NonNullable<HarnessOptions["execFor"]>)(task, exec),
        }
      : {}),
    home,
    record: () => rec,
    journal,
    spawn: async (_task, role, req) =>
      holdSpawns ? null : spawnAgent(role, req.start, req.files, req.branch_update),
    branchUpdate: () => branchUpdate ?? "rebase",
    ...(o.hygiene !== undefined ? { hygiene: () => o.hygiene as HygieneLevel } : {}),
    // One serial queue, like the daemon's: pipeline I/O folds its results back in through it.
    enqueue: (fn) => {
      const p = queue.then(fn);
      queue = p.catch(() => {});
      return p;
    },
    steer: async (task, role, agentId, text, reason) => {
      steers.push({ task, role, agent_id: agentId, text, reason });
      await journal({
        type: "steering_sent",
        task,
        data: {
          agent_id: agentId,
          role,
          type: "steering",
          reason,
          text,
          seq: steers.length,
          message_id: `m${steers.length}`,
        },
      });
    },
    decide: async (input, extra) => {
      const r = openEvent(rec, o.decideWith?.(input, extra) ?? input, new Date());
      if ("error" in r) throw new Error(r.error);
      await journal({ ...r.event, data: { ...extra, ...r.event.data } });
    },
    nextAgent: (_task, role) => {
      const attempt = (attempts[role] ?? 0) + 1;
      return { agent_id: agentIdFor("w1", "T1", role, attempt), attempt };
    },
    retire: async (agentId, status = "done") => {
      retired.push({ agent_id: agentId, status });
      const role = Object.entries(rec.pipeline.T1?.runs ?? {}).find(
        ([, run]) => run?.agent_id === agentId,
      )?.[0];
      await journal({
        type: "agent_retired",
        task: "T1",
        data: {
          agent_id: agentId,
          role,
          status,
          ...(lastResult[agentId] !== undefined ? { result: lastResult[agentId] } : {}),
        },
      });
    },
  };
  let driver = new PipelineDriver("w1", deps);

  const run = (role: Role) => rec.pipeline.T1?.runs[role];
  const PR_BRANCH = branchName("w1", "T1", "implementer", 1);

  const h = {
    home,
    wave,
    world,
    calls,
    callOpts,
    events,
    spawns,
    steers,
    retired,
    get driver() {
      return driver;
    },
    /** A daemon restart: a new driver (no in-memory state) over the same journal and world. */
    restart() {
      driver = new PipelineDriver("w1", deps);
    },
    exec,
    PR_BRANCH,
    record: () => rec,
    /** Move the driver's clock (level-triggered re-checks are rate-limited by it). */
    elapse(ms: number) {
      clock += ms;
    },
    task: () => rec.state?.tasks.find((t) => t.id === "T1"),
    /** While true, role spawns are held (the daemon refused them); the next tick retries. */
    holdSpawns(v: boolean) {
      holdSpawns = v;
    },
    /** One level-triggered tick, then wait for the pipeline I/O it started to fold back in. */
    async tick() {
      await driver.tick();
      await driver.settled();
    },
    run,
    journal,
    /** Submit the wave and start the implementer (what the daemon's admission + T4 spawn do). */
    async start() {
      await journal({ type: "wave_submitted", data: { wave, owner: "coord-1" } });
      await journal({ type: "task_queued", task: "T1", data: { issue: 42 } });
      await journal({ type: "task_admitted", task: "T1", data: {} });
      for (const [i, id] of Object.keys(o.dependents ?? {}).entries())
        await journal({ type: "task_queued", task: id, data: { issue: 43 + i } });
      for (const [i, id] of Object.keys(o.siblings ?? {}).entries())
        await journal({ type: "task_queued", task: id, data: { issue: 60 + i } });
      return spawnAgent("implementer");
    },
    /** A sibling task (`siblings`) is admitted and its implementer starts. */
    async startSibling(id: string) {
      await journal({ type: "task_admitted", task: id, data: {} });
      const agent_id = agentIdFor("w1", id, "implementer", 1);
      await journal({
        type: "agent_spawned",
        task: id,
        data: {
          agent_id,
          role: "implementer",
          attempt: 1,
          worktree: `/wt/w1/${id}-implementer`,
          branch: branchName("w1", id, "implementer", 1),
          base_sha: world.releaseTip,
        },
      });
      await journal({ type: "stage_entered", task: id, data: { stage: "implement" } });
      return agent_id;
    },
    /** The implementer opens its PR once (the first push). */
    openPr(head: string) {
      world.prs.push({
        number: 7,
        url: "https://github.com/example/repo/pull/7",
        headRefName: PR_BRANCH,
        baseRefName: wave.release_branch,
        headRefOid: head,
      });
    },
    /** Change the `branch_update` tunable (a config_set): only a step entered later sees it. */
    setBranchUpdate(m: BranchUpdate) {
      branchUpdate = m;
    },
    /**
     * A role finishes: its worktree is at `head` (pushed to the PR branch unless `push: false`,
     * CI `ci` on it), and it reports `status` with `result`.
     */
    async finish(
      role: Role,
      o: {
        head?: string;
        push?: boolean;
        ci?: "green" | "red" | "running";
        result?: unknown;
        status?: "done" | "failed";
      } = {},
    ) {
      const r = run(role);
      if (r === undefined) throw new Error(`no ${role} run`);
      if (o.head !== undefined) {
        world.local[r.worktree as string] = o.head;
        if (o.push !== false) {
          world.origin[PR_BRANCH] = o.head;
          for (const pr of world.prs) if (pr.headRefName === PR_BRANCH) pr.headRefOid = o.head;
        }
        if (o.ci !== undefined) world.ci[o.head] = o.ci;
      }
      const ev: PipelineEvent = {
        kind: "agent_done",
        role,
        agent_id: r.agent_id,
        status: o.status ?? "done",
        ...(o.result !== undefined ? { result: o.result } : {}),
      };
      if (o.result !== undefined) lastResult[r.agent_id] = o.result;
      await driver.handle("T1", ev);
      await driver.settled();
    },
    /** Resolve an open decision and hand the resolution to the pipeline. */
    async resolve(id: string, answer: string) {
      const r = resolveEvent(rec, id, { answer, by: "coord-1" }, new Date());
      if (!("event" in r)) throw new Error(`cannot resolve ${id}`);
      await journal(r.event);
      await driver.handle("T1", {
        kind: "decision_resolved",
        decision: rec.decisions[id] as DecisionRecord,
      });
      await driver.settled();
    },
    openDecisions: () =>
      (rec.state?.open_decisions ?? []).map((id) => rec.decisions[id] as DecisionRecord),
    /** @deprecated Nothing to release: `home` is a tempDir, removed when the test ends. */
    cleanup: () => {},
  };
  return h;
}

export type Harness = ReturnType<typeof pipelineHarness>;
