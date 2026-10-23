import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GithubStatus } from "../../src/autopilot/github-status";
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
    /** GitHub's mergeability of the PR (absent: not reported). */
    mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    mergeStateStatus?: string;
    /** A draft PR (`gh pr ready <n>` clears it). */
    isDraft?: boolean;
    body?: string;
  }[];
  /** CI per head (absent: no run). */
  ci: Record<string, "green" | "red" | "running">;
  /** Several CI runs per head (overrides `ci`): each run's status and conclusion. */
  /** Runs on a head; `id` / `workflow` / `event` default to one distinct workflow per run. */
  ciRuns: Record<
    string,
    {
      status: string;
      conclusion: string;
      id?: number;
      workflow?: string;
      event?: string;
      createdAt?: string;
    }[]
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
  /** `git log -n 1 --format=%P <sha>`: a commit's parents (default: none known). */
  parents: Record<string, string[]>;
  /** `git log --left-right --cherry-pick --format=%m%H <release>...<head>` per head. */
  cherry: Record<string, string>;
  /** `git log --format=%H %s <base>..<release>`: the release branch's new commits. */
  releaseLog: string;
  /** `git log --oneline <base>..<release>`: how many commits a head behind it lacks (default 2). */
  behindBy: number;
  /** `git diff <a> <b>` / `git show --format= <sha>` text per `a..b` / sha. */
  patches: Record<string, string>;
  /** `gh pr view <n> --json files` by PR number (default: fixtures/gh-pr-view-files.json). */
  prFiles: Record<number, string>;
  /** `gh pr view` overrides by PR number (e.g. a `headRefOid` GitHub reports after a merge). */
  prView: Record<number, Record<string, unknown>>;
  /** `gh run view <id> --json jobs` (default: one failed `test` job). */
  runJobs?: string;
  /**
   * `gh run view <id> --json jobs` per run id (overrides `runJobs`). Default for a run that is
   * not red: one job named after its workflow, with the run's status and conclusion.
   */
  jobs: Record<
    number,
    { name: string; status: string; conclusion: string; startedAt?: string; completedAt?: string }[]
  >;
  /** `gh run view <id> --log-failed`. */
  runLog: string;
  /** `gh run view <id> --log-failed` per run id (overrides `runLog`). */
  runLogs: Record<number, string>;
  /** `gh run list --branch <release>`: the release branch's runs, as JSON (default none). */
  releaseRuns: string;
  /** Set: `gh pr ready` exits 1 with this stderr (the PR stays a draft). */
  readyError?: string | undefined;
  /** Set: every read of a head's runs (`gh api …/actions/runs?head_sha=`, `gh run list --commit`) exits 1 with this stderr. */
  ciError?: string | undefined;
  /** Set: `gh run list --branch <release>` exits 1 with this stderr. */
  releaseError?: string | undefined;
  /** Called with every argv before it is answered (a test may change the world mid-run). */
  before?: ((argv: string[]) => void) | undefined;
  /** An argv this returns a promise for is answered only once it resolves. */
  gate?: ((argv: string[]) => Promise<void> | undefined) | undefined;
  /** An argv this answers true for never returns (a hung network call). */
  hang?: ((argv: string[]) => boolean) | undefined;
  /** An argv this answers true for comes back `timedOut` (exec's hard timeout fired). */
  timeout?: ((argv: string[]) => boolean) | undefined;
  /** An argv this answers true for rejects (e.g. `gh` not on PATH). */
  fail?: ((argv: string[]) => boolean) | undefined;
  /**
   * `gh pr merge` (autopilot merging): set, it exits 1 with this stderr (head moved, checks
   * required); unset, the PR merges: `prState` MERGED, the release tip moves to its merge commit.
   */
  mergeRefuse?: string | undefined;
  /** The merge commit per PR number once merged (default sha(0xa11)). */
  mergeCommit: Record<number, string>;
}

export interface Spawned {
  task: string;
  role: Role;
  agent_id: string;
  worktree: string;
  start?: SpawnStart;
  files: Record<string, string>;
  /** How the step tells a rebase role to bring the branch up to date (absent: rebase). */
  branch_update?: BranchUpdate;
}

/** A read of one head's runs: `gh api …/actions/runs?head_sha=` (the supervisor) or `gh run list --commit`. */
export const isHeadRunsRead = (c: readonly string[]): boolean =>
  (c[0] === "gh" && c[1] === "api" && /\/actions\/runs\?head_sha=/.test(c[2] ?? "")) ||
  (c[0] === "gh" && c[1] === "run" && c[2] === "list" && c.includes("--commit"));

export interface HarnessOptions {
  pipeline?: string;
  /** Enforce the real fence on every argv (default true). */
  fence?: boolean;
  /** Wrap the harness exec per task (the daemon's remote-host routing). */
  execFor?: (task: string, exec: ExecFn) => ExecFn;
  /** Which recorded worktrees are gone from disk (default: none; the harness's paths are fake). */
  worktreeGone?: (task: string, path: string) => boolean;
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
  /** The wave's effective `merge` mode the driver reads (default: absent, i.e. manual). */
  merge?: "auto" | "manual";
  /** `autopilot.merge_retry_max` the driver reads (default: the config default). */
  mergeRetryMax?: number;
  /** GitHub's status page as the driver reads it (default: none read, i.e. unknown). */
  statusPage?: GithubStatus;
  /** `autopilot.incident_wait_max_s` the driver reads (default: the config default). */
  incidentWaitMaxS?: number;
  /** `autopilot.delete_branch` the driver reads (default: absent, i.e. false). */
  deleteBranch?: boolean;
  /** The release-branch lock the driver merges under (default: the driver's own). */
  releaseLock?: ConstructorParameters<typeof PipelineDriver>[1]["releaseLock"];
  /**
   * Autopilot (the daemon's settleDecision): answers a just-opened decision at once (undefined:
   * left open for the owner). The resolution is journaled inside the `decide`, and the pipeline
   * hears of it later, on the queue, as the daemon's resolveNow hands it back.
   */
  autopilot?: (d: DecisionRecord) => string | undefined;
  /** The wave file's `repo:` (default: `/repo`). */
  repo?: string;
  /** T1 bundles these issues (`issues:`, 42 first). */
  bundle?: number[];
}

export function pipelineHarness(o: HarnessOptions = {}) {
  const home = tempDir("volleyd-pipeline-");
  const wave = parseWaveFile(
    [
      "wave: w1",
      `repo: ${o.repo ?? "/repo"}`,
      "release_branch: release/w1",
      "model: claude-opus-5-5",
      `pipeline: ${o.pipeline ?? DEFAULT_PIPELINE}`,
      "tasks:",
      o.bundle !== undefined
        ? `  T1: { issue: 42, issues: [${o.bundle.join(", ")}] }`
        : "  T1: { issue: 42 }",
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
    jobs: {},
    releaseTip: sha(0xbea5e),
    mergeBase: {},
    prState: {},
    diffNames: {},
    ancestor: {},
    parents: {},
    cherry: {},
    releaseLog: "",
    behindBy: 2,
    patches: {},
    prView: {},
    prFiles: {},
    runLog: "",
    runLogs: {},
    releaseRuns: "[]",
    mergeCommit: {},
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
  /** The runs the last head-runs read listed, by id (the default `gh run view --json jobs`). */
  const listed = new Map<number, { name: string; status: string; conclusion: string }>();
  const exec: ExecFn = async (argv, opts = {}) => {
    if (o.fence !== false) assertAllowed(argv, opts);
    calls.push([...argv]);
    callOpts.push(opts);
    // `--repo <slug>` (a GitHub read run from the repo root) says nothing about the answer.
    const a = argv.filter((x, i) => x !== "--repo" && argv[i - 1] !== "--repo");
    world.before?.(a);
    const gate = world.gate?.(a);
    if (gate !== undefined) await gate;
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
      if (verb === "log" && rest.includes("--format=%P")) {
        const parents = world.parents[rest.at(-1) as string];
        return parents !== undefined ? out(`${parents.join(" ")}\n`) : out("", 128);
      }
      if (verb === "show" && rest[0] === "--format=")
        return out(world.patches[rest[1] as string] ?? "");
      if (verb === "diff" && rest.length === 2 && !(rest[0] as string).startsWith("-"))
        return out(world.patches[`${rest[0]}..${rest[1]}`] ?? "");
      if (verb === "merge-base")
        return out(`${world.mergeBase[rest[0] as string] ?? world.releaseTip}\n`);
      if (verb === "log")
        return out(
          Array.from({ length: world.behindBy }, (_, i) => `c${i + 1} upstream change\n`).join(""),
        );
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
    if (a[0] === "gh" && a[1] === "pr" && a[2] === "merge") {
      if (world.mergeRefuse !== undefined)
        return { ...out(""), code: 1, stderr: world.mergeRefuse };
      const n = Number(a[3]);
      world.prState[n] = "MERGED";
      world.mergeCommit[n] ??= sha(0xa11);
      world.releaseTip = world.mergeCommit[n];
      return out("");
    }
    if (a[0] === "gh" && a[1] === "pr" && a[2] === "ready") {
      if (world.readyError !== undefined) return { ...out(""), code: 1, stderr: world.readyError };
      for (const pr of world.prs) if (pr.number === Number(a[3])) pr.isDraft = false;
      return out("");
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
          isDraft: world.prs.find((p) => p.number === n)?.isDraft === true,
          mergedAt: state === "MERGED" ? "2026-10-18T13:00:00Z" : null,
          mergeCommit: state === "MERGED" ? { oid: world.mergeCommit[n] ?? sha(0xa11) } : null,
          baseRefName: wave.release_branch,
          ...world.prView[n],
        }),
      );
    }
    if (a[0] === "gh" && a[1] === "run" && a[2] === "list" && a.includes("--branch"))
      return world.releaseError !== undefined
        ? { ...out(""), code: 1, stderr: world.releaseError }
        : out(world.releaseRuns);
    // A head's runs: `gh api …/actions/runs?head_sha=` (the supervisor's read, in the wave
    // repo), or `gh run list --commit` (no wave repo): the same runs in each one's shape.
    const runsApi =
      a[0] === "gh" && a[1] === "api" && /\/actions\/runs\?head_sha=/.test(a[2] ?? "");
    if (runsApi || (a[0] === "gh" && a[1] === "run" && a[2] === "list")) {
      if (world.ciError !== undefined) return { ...out(""), code: 1, stderr: world.ciError };
      const head = runsApi
        ? (/head_sha=([^&]+)/.exec(a[2] as string)?.[1] as string)
        : (a[a.indexOf("--commit") + 1] as string);
      const many = world.ciRuns[head];
      const state = world.ci[head];
      const rows =
        many !== undefined
          ? many.map((r, i) => ({
              id: r.id ?? 900 + i,
              name: r.workflow ?? `check-${i + 1}`,
              event: r.event ?? "pull_request",
              status: r.status,
              conclusion: r.conclusion,
              url: `https://github.com/example/repo/actions/runs/${r.id ?? 900 + i}`,
              createdAt: r.createdAt,
            }))
          : state === undefined
            ? []
            : [
                {
                  id: 900,
                  name: "CI",
                  event: undefined,
                  status: state === "running" ? "in_progress" : "completed",
                  conclusion: state === "green" ? "success" : state === "red" ? "failure" : "",
                  url: `https://github.com/example/repo/actions/runs/${head.slice(-4)}`,
                  createdAt: undefined as string | undefined,
                },
              ];
      for (const r of rows) listed.set(r.id, r);
      return out(
        JSON.stringify(
          rows.map((r) =>
            runsApi
              ? {
                  id: r.id,
                  name: r.name,
                  status: r.status,
                  conclusion: r.conclusion === "" ? null : r.conclusion,
                  html_url: r.url,
                  head_sha: head,
                  event: r.event,
                  run_attempt: 1,
                  created_at: r.createdAt,
                }
              : {
                  databaseId: r.id,
                  name: r.name,
                  workflowName: r.name,
                  event: r.event,
                  status: r.status,
                  conclusion: r.conclusion,
                  headSha: head,
                  url: r.url,
                  createdAt: r.createdAt,
                },
          ),
        ),
      );
    }
    if (a[0] === "gh" && a[1] === "run" && a[2] === "view") {
      if (a.includes("--log-failed")) return out(world.runLogs[Number(a[3])] ?? world.runLog);
      const id = Number(a[3]);
      const own = world.jobs[id];
      if (own !== undefined) return out(JSON.stringify({ jobs: own }));
      if (world.runJobs !== undefined) return out(world.runJobs);
      const row = listed.get(id);
      if (row !== undefined && !(row.status === "completed" && row.conclusion !== "success"))
        return out(
          JSON.stringify({
            jobs: [{ name: row.name, status: row.status, conclusion: row.conclusion }],
          }),
        );
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
    task = "T1",
  ) => {
    const key = task === "T1" ? role : `${task}/${role}`;
    const attempt = (attempts[key] ?? 0) + 1;
    attempts[key] = attempt;
    const agent_id = agentIdFor("w1", task, role, attempt);
    const worktree =
      task === "T1" ? `/wt/w1/T1-${role}-${attempt}` : `/wt/w1/${task}-${role}-${attempt}`;
    const branch = start?.detach ? "HEAD" : branchName("w1", task, role, attempt);
    spawns.push({
      task,
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
      task,
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
      await journal({ type: "stage_entered", task, data: { stage: "implement" } });
    return agent_id;
  };

  /** Autopilot answers not yet handed back to the pipeline (`settle` runs them). */
  const handBacks: (() => Promise<void>)[] = [];
  /** The driver's I/O, then every autopilot hand-back on the queue, until none is left. */
  const settle = async () => {
    for (;;) {
      await driver.settled();
      const fn = handBacks.shift();
      if (fn === undefined) return;
      await deps.enqueue(fn);
    }
  };
  let clock = Date.parse("2026-10-18T12:00:00.000Z");
  let queue: Promise<unknown> = Promise.resolve();
  const deps: ConstructorParameters<typeof PipelineDriver>[1] = {
    now: () => clock,
    ...(o.nudgeOnMerge !== undefined ? { nudgeOnMerge: () => o.nudgeOnMerge as NudgeOnMerge } : {}),
    exec,
    ...(o.worktreeGone !== undefined ? { worktreeGone: o.worktreeGone } : {}),
    ...(o.execFor !== undefined
      ? {
          execFor: (task: string) =>
            (o.execFor as NonNullable<HarnessOptions["execFor"]>)(task, exec),
        }
      : {}),
    home,
    record: () => rec,
    journal,
    spawn: async (task, role, req) =>
      holdSpawns ? null : spawnAgent(role, req.start, req.files, req.branch_update, task),
    branchUpdate: () => branchUpdate ?? "rebase",
    ...(o.hygiene !== undefined ? { hygiene: () => o.hygiene as HygieneLevel } : {}),
    ...(o.merge !== undefined ? { mergeMode: () => o.merge as "auto" | "manual" } : {}),
    ...(o.mergeRetryMax !== undefined ? { mergeRetryMax: () => o.mergeRetryMax as number } : {}),
    ...(o.statusPage !== undefined ? { statusPage: async () => o.statusPage as GithubStatus } : {}),
    ...(o.incidentWaitMaxS !== undefined
      ? { incidentWaitMaxS: () => o.incidentWaitMaxS as number }
      : {}),
    ...(o.deleteBranch !== undefined ? { deleteBranch: () => o.deleteBranch as boolean } : {}),
    ...(o.releaseLock !== undefined ? { releaseLock: o.releaseLock } : {}),
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
      const answer = o.autopilot?.(rec.decisions[r.id] as DecisionRecord);
      if (answer === undefined) return;
      const res = resolveEvent(rec, r.id, { answer, by: "volleyd" }, new Date());
      if (!("event" in res)) throw new Error(`cannot resolve ${r.id}`);
      await journal(res.event);
      const d = rec.decisions[r.id] as DecisionRecord;
      // After the observation being handled (the daemon's queue runs it next): `settle` runs it.
      handBacks.push(() =>
        driver.handle(d.task ?? "T1", { kind: "decision_resolved", decision: d }),
      );
    },
    // The daemon's resolveNow: journaled; a done task acts on no answer, so no hand-back here.
    resolveOpen: async (task, answer, rationale) => {
      for (const id of rec.state?.open_decisions ?? []) {
        if (rec.decisions[id]?.task !== task) continue;
        const r = resolveEvent(rec, id, { answer, by: "volleyd", rationale }, new Date());
        if ("event" in r) await journal(r.event);
      }
    },
    nextAgent: (task, role) => {
      const attempt = (attempts[task === "T1" ? role : `${task}/${role}`] ?? 0) + 1;
      return { agent_id: agentIdFor("w1", task, role, attempt), attempt };
    },
    retire: async (agentId, status = "done") => {
      retired.push({ agent_id: agentId, status });
      let task = "T1";
      let role: string | undefined;
      for (const [id, p] of Object.entries(rec.pipeline)) {
        const r = Object.entries(p.runs).find(([, run]) => run?.agent_id === agentId)?.[0];
        if (r !== undefined) {
          task = id;
          role = r;
          break;
        }
      }
      await journal({
        type: "agent_retired",
        task,
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

  const run = (role: Role, task = "T1") => rec.pipeline[task]?.runs[role];
  const PR_BRANCH = branchName("w1", "T1", "implementer", 1);
  const prBranch = (task: string) => branchName("w1", task, "implementer", 1);

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
    task: (id = "T1") => rec.state?.tasks.find((t) => t.id === id),
    /** While true, role spawns are held (the daemon refused them); the next tick retries. */
    holdSpawns(v: boolean) {
      holdSpawns = v;
    },
    /** One level-triggered tick, then wait for the pipeline I/O it started to fold back in. */
    async tick() {
      await driver.tick();
      await settle();
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
    /** A sibling task (`siblings`) is admitted and its implementer starts as the pipeline spawns it. */
    async startTask(id: string) {
      await journal({ type: "task_admitted", task: id, data: {} });
      return spawnAgent("implementer", undefined, {}, undefined, id);
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
    openPr(head: string, task = "T1", number = 7, o: { draft?: boolean; body?: string } = {}) {
      world.prs.push({
        number,
        url: `https://github.com/example/repo/pull/${number}`,
        headRefName: prBranch(task),
        baseRefName: wave.release_branch,
        headRefOid: head,
        ...(o.draft === true ? { isDraft: true } : {}),
        ...(o.body !== undefined ? { body: o.body } : {}),
      });
    },
    /** The driver's clock as ISO (a run's `createdAt`). */
    iso: (offsetMs = 0) => new Date(clock + offsetMs).toISOString(),
    /** Change the `branch_update` tunable (a config_set): only a step entered later sees it. */
    setBranchUpdate(m: BranchUpdate) {
      branchUpdate = m;
    },
    /**
     * A role finishes: its worktree is at `head` (pushed to the PR branch unless `push: false`,
     * CI `ci` on it), and it reports `status` with `result`. `conflicting`: GitHub reports the PR
     * CONFLICTING (no CI) while that head is verified, and MERGEABLE again after.
     */
    async finish(
      role: Role,
      o: {
        head?: string;
        push?: boolean;
        ci?: "green" | "red" | "running";
        result?: unknown;
        status?: "done" | "failed";
        task?: string;
        conflicting?: boolean;
      } = {},
    ) {
      const task = o.task ?? "T1";
      const prs = world.prs.filter((pr) => pr.headRefName === prBranch(task));
      if (o.conflicting === true) {
        if (prs.length === 0) throw new Error(`conflicting: no PR on ${prBranch(task)}`);
        for (const pr of prs) pr.mergeable = "CONFLICTING";
      }
      const r = run(role, task);
      if (r === undefined) throw new Error(`no ${role} run`);
      if (o.head !== undefined) {
        world.local[r.worktree as string] = o.head;
        if (o.push !== false) {
          world.origin[prBranch(task)] = o.head;
          for (const pr of world.prs) if (pr.headRefName === prBranch(task)) pr.headRefOid = o.head;
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
      try {
        await driver.handle(task, ev);
        await settle();
      } finally {
        if (o.conflicting === true) for (const pr of prs) pr.mergeable = "MERGEABLE";
      }
    },
    /** A role's current run publishes `blocked` with `reason` (the agent stays alive). */
    async block(role: Role, reason: string, task = "T1") {
      const r = run(role, task);
      if (r === undefined) throw new Error(`no ${role} run`);
      await driver.handle(task, {
        kind: "agent_blocked",
        role,
        agent_id: r.agent_id,
        reason,
        payload: { reason },
      });
      await driver.settled();
    },
    /** Resolve an open decision and hand the resolution to the pipeline. */
    async resolve(id: string, answer: string, by = "coord-1") {
      const r = resolveEvent(rec, id, { answer, by }, new Date());
      if (!("event" in r)) throw new Error(`cannot resolve ${id}`);
      await journal(r.event);
      await driver.handle(rec.decisions[id]?.task ?? "T1", {
        kind: "decision_resolved",
        decision: rec.decisions[id] as DecisionRecord,
      });
      await settle();
    },
    openDecisions: () =>
      (rec.state?.open_decisions ?? []).map((id) => rec.decisions[id] as DecisionRecord),
    /** @deprecated Nothing to release: `home` is a tempDir, removed when the test ends. */
    cleanup: () => {},
  };
  return h;
}

export type Harness = ReturnType<typeof pipelineHarness>;
