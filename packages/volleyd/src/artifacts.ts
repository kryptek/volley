import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput } from "./decisions";
import type { ExecFn, ExecResult } from "./exec";
import { parsePrFiles } from "./overlap";
import type { NewEvent, TaskId } from "./types";

/**
 * Artifact verification: a role's `done` is a claim, checked here against git and GitHub through
 * the fenced exec (read-only verbs only: rev-parse, fetch, diff, merge-base, log, gh pr list,
 * gh run list/view). `verifyArtifacts` gathers the facts; `artifactOutcome` (pure) turns them
 * into what the pipeline journals or asks.
 */

export interface ArtifactSpec {
  /** The role's worktree: its HEAD is what the role claims it published. */
  cwd: string;
  /** The PR's head branch (the implementer's branch). */
  branch: string;
  release_branch: string;
  /** The previously verified head: the report then lists the files changed since (a rebase). */
  since?: string;
  /**
   * Someone pushed the PR branch after this role's head was verified: check the branch head on
   * origin as it is now, not the role's own local HEAD.
   */
  adopt?: boolean;
}

export interface CiRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export type CiState = "green" | "red" | "running" | "none";

/** A run a newer run of the same workflow and trigger event replaced on the same head. */
export interface SupersededRun {
  id: number;
  url: string;
  conclusion: string | null;
}

/**
 * Why a red head looks like it is not the code's fault: `startup` (a run never started), `steps`
 * (every failed job failed in a runner / checkout / network step), `cancelled` (a run was
 * cancelled and nothing replaced it).
 */
export type InfraReason = "startup" | "steps" | "cancelled";

/**
 * CI on one head. `runs`: the effective runs (the latest per workflow and trigger event), which
 * every other field is computed over; `superseded`: the runs they replaced, kept as evidence only.
 */
export interface CiFacts {
  state: CiState;
  runs: CiRun[];
  superseded: SupersededRun[];
  failed_jobs: string[];
  infra: InfraReason | null;
  /** Red only (verifyArtifacts): failing test ids and the tail of the failed runs' logs. */
  failing_tests?: string[];
  log?: string;
}

/** GitHub's mergeability of a PR; `UNKNOWN` while it is still computing it. */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface PrRef {
  number: number;
  url: string;
  head_sha: string;
  base: string;
  /** Absent when GitHub reported none. */
  mergeable?: Mergeable;
  /** GitHub's `mergeStateStatus` (`CLEAN`, `DIRTY`, `BEHIND`, …), as reported. */
  merge_state?: string;
}

export type ArtifactReport =
  /**
   * `remote_head`: origin's branch is at another commit than the local head (a push from
   * elsewhere). `rewritten_from`: a merge-mode update's start, which the pushed head does not
   * descend from (the branch's history was rewritten).
   */
  | {
      kind: "missing";
      missing: "push" | "pr" | "base";
      detail: string;
      remote_head?: string;
      rewritten_from?: string;
    }
  | {
      kind: "ok";
      head: string;
      branch: string;
      pr: PrRef;
      ci: CiFacts;
      touched?: string[];
    };

const PR_FIELDS = "number,url,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus";
const RUN_FIELDS =
  "databaseId,name,workflowName,status,conclusion,url,headSha,event,createdAt,workflowDatabaseId";

/** Run conclusions that fail a head. */
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);
/** Failed steps that point at the runner or the network rather than the code. */
const INFRA_STEP = /checkout|set up job|runner|network|connection|timed? ?out while|fetch/i;

const line = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";

const isMergeable = (m: unknown): m is Mergeable =>
  m === "MERGEABLE" || m === "CONFLICTING" || m === "UNKNOWN";

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Gather the artifacts of a role's claimed work. Never throws for a missing artifact. */
export async function verifyArtifacts(exec: ExecFn, spec: ArtifactSpec): Promise<ArtifactReport> {
  const git = (...args: string[]) => exec(["git", "-C", spec.cwd, ...args]);
  const local = spec.adopt === true ? null : await git("rev-parse", "HEAD");
  let head = local !== null && local.code === 0 ? line(local.stdout) : "";
  if (local !== null && head === "")
    return { kind: "missing", missing: "push", detail: "no local HEAD" };

  const fetched = await git("fetch", "origin", spec.branch);
  const remote = await git(
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${spec.branch}`,
  );
  const remoteHead = remote.code === 0 ? line(remote.stdout) : "";
  if (fetched.code !== 0 || remoteHead === "") {
    return { kind: "missing", missing: "push", detail: `${spec.branch} is not on origin` };
  }
  if (spec.adopt === true) head = remoteHead;
  if (remoteHead !== head) {
    return {
      kind: "missing",
      missing: "push",
      detail: `origin/${spec.branch} is ${remoteHead.slice(0, 12)}, the local head is ${head.slice(0, 12)}`,
      remote_head: remoteHead,
    };
  }

  const prs = await exec(
    ["gh", "pr", "list", "--head", spec.branch, "--state", "open", "--json", PR_FIELDS],
    { cwd: spec.cwd },
  );
  const list =
    prs.code === 0
      ? (parseJson<
          {
            number: number;
            url: string;
            headRefName: string;
            baseRefName: string;
            headRefOid: string;
            mergeable?: string;
            mergeStateStatus?: string;
          }[]
        >(prs.stdout) ?? [])
      : [];
  // `gh pr list --head` has returned another branch's PR: only an exact head match counts.
  const pr = list.find((p) => p.headRefName === spec.branch);
  if (pr === undefined) {
    const others = list.map((p) => `#${p.number} (${p.headRefName})`).join(", ");
    return {
      kind: "missing",
      missing: "pr",
      detail: `no open PR for ${spec.branch}${others !== "" ? `; ignored ${others}` : ""}`,
    };
  }
  if (pr.baseRefName !== spec.release_branch) {
    return {
      kind: "missing",
      missing: "base",
      detail: `PR #${pr.number} targets ${pr.baseRefName}, not ${spec.release_branch}`,
    };
  }
  const prRef: PrRef = {
    number: pr.number,
    url: pr.url,
    head_sha: pr.headRefOid,
    base: pr.baseRefName,
    ...(isMergeable(pr.mergeable) ? { mergeable: pr.mergeable } : {}),
    ...(typeof pr.mergeStateStatus === "string" ? { merge_state: pr.mergeStateStatus } : {}),
  };

  const ci = await ciOn(exec, spec.cwd, head);
  // GitHub has not caught up with the push yet: the PR's checks are not this head's.
  if (pr.headRefOid !== head) ci.state = ci.state === "red" ? "red" : "running";
  // GitHub is still computing whether the PR conflicts (it runs no CI on a conflicting one):
  // pending, so no-CI's clock does not start.
  else if (ci.state === "none" && prRef.mergeable === "UNKNOWN") ci.state = "running";
  // What a CI fixup works from: the failed runs' logs (each call bounded by the driver's timeout).
  if (ci.state === "red") Object.assign(ci, await failedLogs(exec, spec.cwd, ci.runs));
  const report: ArtifactReport = { kind: "ok", head, branch: spec.branch, pr: prRef, ci };
  if (spec.since !== undefined && spec.since !== head) {
    const d = await git("diff", "--name-only", spec.since, head);
    report.touched = d.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return report;
}

/** The aggregate CI state on exactly `head` (e.g. a head merged other than the gated one). */
export async function ciStateOf(exec: ExecFn, cwd: string, head: string): Promise<CiState> {
  return (await ciOn(exec, cwd, head)).state;
}

interface RawRun {
  databaseId: number;
  name: string;
  workflowName?: string;
  workflowDatabaseId?: number;
  event?: string;
  createdAt?: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha?: string;
}

/**
 * Split a head's runs into the effective ones and the superseded ones. Runs of one workflow for
 * one trigger event are a replacement chain (a concurrency cancel-in-progress, a re-push of the
 * same sha): the highest id wins (`gh run list` lists one row per run, its latest attempt, so ids are
 * unique; `createdAt` only breaks a tie between duplicate rows). Runs of another event (`push`
 * beside `pull_request`) are distinct CI, never a replacement. Order is kept. Pure.
 */
export function latestRuns<T extends RawRun>(runs: T[]): { effective: T[]; superseded: T[] } {
  const key = (r: T) => `${r.workflowDatabaseId ?? r.workflowName ?? r.name}\u0000${r.event ?? ""}`;
  const latest = new Map<string, T>();
  for (const r of runs) {
    const cur = latest.get(key(r));
    const newer =
      cur === undefined ||
      r.databaseId > cur.databaseId ||
      (r.databaseId === cur.databaseId && (r.createdAt ?? "") > (cur.createdAt ?? ""));
    if (newer) latest.set(key(r), r);
  }
  const effective = runs.filter((r) => latest.get(key(r)) === r);
  return { effective, superseded: runs.filter((r) => latest.get(key(r)) !== r) };
}

/** CI on exactly `head`: the latest run per workflow and trigger event (latestRuns). */
async function ciOn(exec: ExecFn, cwd: string, head: string): Promise<CiFacts> {
  const r = await exec(["gh", "run", "list", "--commit", head, "--json", RUN_FIELDS], { cwd });
  const raw = r.code === 0 ? (parseJson<RawRun[]>(r.stdout) ?? []) : [];
  const conclusion = (x: RawRun) => (x.conclusion === "" ? null : x.conclusion);
  const { effective: own, superseded } = latestRuns(
    raw.filter((x) => x.headSha === undefined || x.headSha === head),
  );
  const runs: CiRun[] = own.map((x) => ({
    id: x.databaseId,
    name: x.name,
    status: x.status,
    conclusion: conclusion(x),
    url: x.url,
  }));
  const failed = own.filter((x) => x.status === "completed" && FAILED.has(x.conclusion ?? ""));
  const state: CiState =
    runs.length === 0
      ? "none"
      : failed.length > 0
        ? "red"
        : runs.some((x) => x.status !== "completed")
          ? "running"
          : "green";
  const failedJobs: string[] = [];
  const jobSteps: { name: string; steps: string[] }[] = [];
  for (const run of failed) {
    const v = await exec(["gh", "run", "view", String(run.databaseId), "--json", "jobs"], { cwd });
    const jobs =
      parseJson<{
        jobs?: {
          name: string;
          conclusion: string;
          steps?: { name: string; conclusion: string }[];
        }[];
      }>(v.stdout)?.jobs ?? [];
    for (const j of jobs.filter((j) => FAILED.has(j.conclusion))) {
      failedJobs.push(`${run.workflowName ?? run.name} / ${j.name}`);
      // A cancelled run's steps say where the cancel landed, not what broke.
      if (run.conclusion === "cancelled") continue;
      jobSteps.push({
        name: j.name,
        steps: (j.steps ?? []).filter((s) => FAILED.has(s.conclusion)).map((s) => s.name),
      });
    }
  }
  return {
    state,
    runs,
    superseded: superseded.map((x) => ({
      id: x.databaseId,
      url: x.url,
      conclusion: conclusion(x),
    })),
    failed_jobs: failedJobs,
    infra: isInfraFailure(failed, jobSteps),
  };
}

/**
 * Why a red head looks infra-shaped (InfraReason), or null: a run never started (`startup`);
 * every failed run was cancelled — given effective runs only, nothing replaced it (`cancelled`);
 * every failed job of the other runs failed in a step about the runner, checkout or network
 * rather than in the project's own steps (`steps`). A cancel beside a failure in the project's
 * own steps is null: re-running the cancelled run cannot turn the head green.
 */
export function isInfraFailure(
  runs: { conclusion: string | null }[],
  failedJobs: { name: string; steps: string[] }[],
): InfraReason | null {
  if (runs.some((r) => r.conclusion === "startup_failure")) return "startup";
  if (runs.length > 0 && runs.every((r) => r.conclusion === "cancelled")) return "cancelled";
  if (
    failedJobs.length > 0 &&
    failedJobs.every((j) => j.steps.length > 0 && j.steps.every((s) => INFRA_STEP.test(s)))
  )
    return "steps";
  return null;
}

export type ArtifactOutcome =
  | { kind: "missing"; missing: "push" | "pr" | "base"; detail: string; event: NewEvent }
  | {
      kind: "ci_failed";
      decision: DecisionInput & { options: string[] };
      /** Facts kept on the decision (journal + topic). */
      data: Record<string, unknown>;
    }
  | { kind: "ci_pending"; state: "running" | "none"; head: string }
  /** No run on the head of a PR that conflicts with its base: GitHub will run none. */
  | { kind: "conflicting"; head: string; pr: { number: number; url: string } }
  | { kind: "verified"; event: NewEvent & { data: Record<string, unknown> } };

/**
 * `gh run view <id> --log-failed` of each failed run: the failing tests (failingTests) and the
 * logs' tail (each log headed `== <name> (run <id>) ==`), clipped to `ci_log_max_chars`. A log
 * that cannot be read is skipped.
 */
async function failedLogs(
  exec: ExecFn,
  cwd: string,
  runs: CiRun[],
): Promise<{ failing_tests: string[]; log: string }> {
  const tests: string[] = [];
  const logs: string[] = [];
  for (const run of failedRuns(runs)) {
    const r = await exec(["gh", "run", "view", String(run.id), "--log-failed"], { cwd });
    if (r.code !== 0) continue;
    logs.push(`== ${run.name} (run ${run.id}) ==\n${r.stdout.trimEnd()}`);
    for (const t of failingTests(r.stdout)) if (!tests.includes(t)) tests.push(t);
  }
  const log = logs.join("\n");
  return { failing_tests: tests, log: log.slice(-DAEMON_DEFAULTS.ci_log_max_chars) };
}

/** What a verification report means for the pipeline. Pure. */
export function artifactOutcome(
  task: TaskId,
  role: string,
  report: ArtifactReport,
): ArtifactOutcome {
  if (report.kind === "missing") {
    return {
      kind: "missing",
      missing: report.missing,
      detail: report.detail,
      event: {
        type: "alarm_raised",
        task,
        data: { alarm: "artifact_missing", missing: report.missing, role, detail: report.detail },
      },
    };
  }
  const { ci, pr, head } = report;
  if (ci.state === "red") {
    const failedRuns = ci.runs.filter(
      (r) => r.status === "completed" && FAILED.has(r.conclusion ?? ""),
    );
    const urls = failedRuns.map((r) => r.url);
    const jobs = ci.failed_jobs.length > 0 ? ci.failed_jobs.join(", ") : "(no job details)";
    const cancelled = failedRuns.filter((r) => r.conclusion === "cancelled").map((r) => r.url);
    const infra =
      ci.infra === "cancelled"
        ? cancelled.length === 1
          ? ` Run ${cancelled[0]} was cancelled and nothing replaced it: re-run it (or push again).`
          : ` Runs ${cancelled.join(" ")} were cancelled and nothing replaced them: re-run them (or push again).`
        : ci.infra !== null
          ? " This looks infra-shaped (runner lost, checkout or network error): check the hosting provider's status page first."
          : "";
    return {
      kind: "ci_failed",
      decision: {
        kind: "ci_failed",
        task,
        question: `CI failed on ${head.slice(0, 12)} (PR #${pr.number}): ${urls.join(" ")} — failed jobs: ${jobs}.${infra} volleyd never re-runs CI. fixup: a fixup agent at ${head.slice(0, 12)} with the CI result as its directive; re-verify: you fixed or re-ran it; or cancel?`,
        pointers: { pr: pr.url },
        options: ["fixup", "re-verify", "cancel"],
      },
      data: {
        head_sha: head,
        run_urls: urls,
        failed_jobs: ci.failed_jobs,
        failing_tests: ci.failing_tests ?? [],
        log: ci.log ?? "",
        ci_runs: ci.runs,
        infra: ci.infra !== null,
        infra_reason: ci.infra,
        ...(ci.superseded.length > 0
          ? { superseded_run_urls: ci.superseded.map((r) => r.url) }
          : {}),
        ...(report.touched !== undefined ? { touched: report.touched } : {}),
        role,
        pr: { number: pr.number, url: pr.url },
      },
    };
  }
  if (ci.state === "none" && pr.mergeable === "CONFLICTING")
    return { kind: "conflicting", head, pr: { number: pr.number, url: pr.url } };
  if (ci.state === "none" && pr.mergeable === "UNKNOWN")
    return { kind: "ci_pending", state: "running", head };
  if (ci.state === "running" || ci.state === "none")
    return { kind: "ci_pending", state: ci.state, head };
  return {
    kind: "verified",
    event: {
      type: "artifact_verified",
      task,
      data: {
        role,
        head_sha: head,
        branch: report.branch,
        pr: { number: pr.number, url: pr.url, head_sha: head, ci: "green" },
        ci_runs: ci.runs,
        ...(ci.superseded.length > 0 ? { ci_superseded: ci.superseded } : {}),
        ...(report.touched !== undefined ? { touched: report.touched } : {}),
      },
    },
  };
}

export interface RebaseCheck {
  /** origin/<release_branch> after fetching it. */
  release_sha: string;
  merge_base: string;
  /** Commits on the release branch the head does not contain. */
  behind: number;
}

/** Has the release branch moved past where `head` branched from it? */
export async function checkRebase(
  exec: ExecFn,
  o: { cwd: string; head: string; release_branch: string },
): Promise<RebaseCheck> {
  const git = (...args: string[]) => exec(["git", "-C", o.cwd, ...args]);
  const fetched = await git("fetch", "origin", o.release_branch);
  if (fetched.code !== 0)
    throw new Error(
      `git fetch origin ${o.release_branch} failed: ${(fetched.stderr || fetched.stdout).trim()}`,
    );
  const tip = line(
    (await git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${o.release_branch}`))
      .stdout,
  );
  if (tip === "") throw new Error(`origin/${o.release_branch} not found`);
  const mb = await git("merge-base", o.head, tip);
  const base = line(mb.stdout);
  if (mb.code !== 0 || base === "") throw new Error(`no merge-base of ${o.head} and ${tip}`);
  if (base === tip) return { release_sha: tip, merge_base: base, behind: 0 };
  const log = await git("log", "--oneline", `${base}..${tip}`);
  if (log.code !== 0)
    throw new Error(`git log ${base}..${tip} failed: ${(log.stderr || log.stdout).trim()}`);
  const behind = log.stdout.split("\n").filter((l) => l.trim() !== "").length;
  // The merge-base is not the tip, so the tip has commits the head lacks: none listed is no count.
  if (behind === 0) throw new Error(`inconsistent rebase check: ${base}..${tip} lists no commits`);
  return { release_sha: tip, merge_base: base, behind };
}

// ---------------------------------------------------------------------------------------------
// Merges outside GitHub's merge button (a local squash + push closes the PR with mergedAt: null)
// ---------------------------------------------------------------------------------------------

/** What the release branch says about a closed PR's gated head (probeLanded). */
export interface LandedFacts {
  /** The head is an ancestor of the release branch. */
  ancestor: boolean;
  /** The head's commits with no equivalent patch on the release branch (cherry-pick marks). */
  unmatched: string[];
  /**
   * The release branch's commits since it and the head forked, newest first. `patch`: the commit's
   * own diff is the PR's whole diff (probed only for a subject that names the PR).
   */
  subjects: { sha: string; subject: string; patch?: boolean }[];
}

export interface Landed {
  how: "ancestor" | "patch" | "subject";
  /** The commit that carries it: the head itself, the release tip, or the commit naming the PR. */
  sha: string;
}

/**
 * A release commit's subject names the PR the way GitHub's squash does: `(#<pr>)` at its end, and
 * it is not a revert. A subject that merely mentions the PR (`follow-up to (#7)`, `replaces (#7)
 * (#9)`, `Revert "… (#7)"`) does not. Pure.
 */
export function namesPr(subject: string, pr: number): boolean {
  return new RegExp(`\\(#${pr}\\)$`).test(subject.trim()) && !/^revert\b/i.test(subject.trim());
}

/**
 * Did `head` land on the release branch (at `releaseSha`) without GitHub's merge? It is an
 * ancestor; or every one of its commits has an equivalent patch there; or a release commit's
 * subject names the PR (namesPr, a squash's default) AND that commit's diff is the PR's whole
 * diff — a subject alone is never enough. Null: nothing says so. Pure.
 */
export function landed(
  f: LandedFacts,
  head: string,
  releaseSha: string,
  pr: number,
): Landed | null {
  if (f.ancestor) return { how: "ancestor", sha: head };
  if (f.unmatched.length === 0) return { how: "patch", sha: releaseSha };
  const named = f.subjects.find((c) => namesPr(c.subject, pr) && c.patch === true);
  return named !== undefined ? { how: "subject", sha: named.sha } : null;
}

type Git = (...a: string[]) => Promise<{ code: number; stdout: string }>;

/** Is commit `sha`'s own diff the whole diff of `head` since it forked from `sha`'s parent? */
async function isSquashOf(git: Git, head: string, sha: string): Promise<boolean> {
  const squash = await git("show", "--format=", sha);
  const base = line((await git("merge-base", head, `${sha}~1`)).stdout);
  const whole = base !== "" ? await git("diff", base, head) : null;
  return squash.code === 0 && whole?.code === 0 && samePatch(squash.stdout, whole.stdout);
}

/** The head-side commits of `<base>...<head>` that have no equivalent patch on the base side. */
async function unmatchedCommits(git: Git, base: string, head: string): Promise<string[]> {
  const r = await git("log", "--left-right", "--cherry-pick", "--format=%m%H", `${base}...${head}`);
  if (r.code !== 0) throw new Error(`git log ${base}...${head} exited ${r.code}`);
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith(">"))
    .map((l) => l.slice(1).trim());
}

/** Gather LandedFacts for `head` against `origin/<release_branch>` (read-only git). */
export async function probeLanded(
  exec: ExecFn,
  o: { cwd: string; head: string; release_branch: string; pr: number },
): Promise<LandedFacts & { release_sha: string }> {
  const git = (...args: string[]) => exec(["git", "-C", o.cwd, ...args]);
  const release = `origin/${o.release_branch}`;
  await git("fetch", "origin", o.release_branch);
  const tip = line(
    (await git("rev-parse", "--verify", "--quiet", `refs/remotes/${release}`)).stdout,
  );
  if (tip === "") throw new Error(`${release} not found`);
  const anc = await git("merge-base", "--is-ancestor", o.head, release);
  if (anc.code === 0) return { ancestor: true, unmatched: [], subjects: [], release_sha: tip };
  if (anc.code !== 1) throw new Error(`git merge-base --is-ancestor exited ${anc.code}`);
  const unmatched = await unmatchedCommits(git, release, o.head);
  const mb = line((await git("merge-base", o.head, release)).stdout);
  const log = await git("log", "--format=%H %s", mb !== "" ? `${mb}..${release}` : release);
  const subjects = log.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => ({ sha: l.slice(0, l.indexOf(" ")), subject: l.slice(l.indexOf(" ") + 1) }));
  for (const c of subjects)
    if (namesPr(c.subject, o.pr)) Object.assign(c, { patch: await isSquashOf(git, o.head, c.sha) });
  return { ancestor: false, unmatched, subjects, release_sha: tip };
}

/**
 * Two diffs carry the same change: equal once the blob ids (`index` lines) and hunk positions
 * (`@@ -a,b +c,d @@`) are dropped — what `git patch-id` compares, without its stdin. Pure.
 */
export function samePatch(a: string, b: string): boolean {
  const norm = (d: string) =>
    d
      .split("\n")
      .filter((l) => !l.startsWith("index "))
      .map((l) => (l.startsWith("@@") ? l.replace(/^@@ [^@]* @@/, "@@") : l))
      .join("\n")
      .trim();
  const x = norm(a);
  return x !== "" && x === norm(b);
}

export type OperatorMergeCheck =
  /** `sha`: the commit, resolved to its full sha. */
  { ok: true; how: "ancestor" | "patch" | "squash"; sha: string } | { ok: false; error: string };

/**
 * `volleyd merged --sha <sha>`: is `sha` on the release branch, and does it carry the gated
 * `head` — as an ancestor, as equivalent patches of every head commit, or as one squashed patch
 * equal to the PR's whole diff? Read-only git through the fenced exec.
 */
export async function verifyOperatorMerge(
  exec: ExecFn,
  o: { cwd: string; head: string; sha: string; release_branch: string },
): Promise<OperatorMergeCheck> {
  const git = (...args: string[]) => exec(["git", "-C", o.cwd, ...args]);
  const release = `origin/${o.release_branch}`;
  await git("fetch", "origin", o.release_branch);
  // A short sha is the same commit as its full one: compare (and record) the full sha.
  const full = await git("rev-parse", "--verify", "--quiet", `${o.sha}^{commit}`);
  const sha = full.code === 0 ? line(full.stdout) : "";
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, error: `${o.sha} is not a known commit` };
  const on = await git("merge-base", "--is-ancestor", sha, release);
  if (on.code !== 0) return { ok: false, error: `${o.sha} is not on ${release}` };
  if (sha === o.head || (await git("merge-base", "--is-ancestor", o.head, sha)).code === 0)
    return { ok: true, how: "ancestor", sha };
  if ((await unmatchedCommits(git, sha, o.head)).length === 0)
    return { ok: true, how: "patch", sha };
  if (await isSquashOf(git, o.head, sha)) return { ok: true, how: "squash", sha };
  return {
    ok: false,
    error: `${o.sha} does not contain the gated head ${o.head}'s changes (not an ancestor, no equivalent patches, not its squash)`,
  };
}

// ---------------------------------------------------------------------------------------------
// A PR head that moved after a gate: CI on the new head, what failed, what changed
// ---------------------------------------------------------------------------------------------

/** CI on exactly `head` (runs, aggregate state, failed job names), for a head the pipeline did not push. */
export async function ciReport(exec: ExecFn, cwd: string, head: string): Promise<CiFacts> {
  return ciOn(exec, cwd, head);
}

/** CI on exactly `head` and, when red, its failing tests and logs' tail (a blocked agent's PR head). */
export async function redHeadCi(exec: ExecFn, cwd: string, head: string): Promise<CiFacts> {
  const ci = await ciOn(exec, cwd, head);
  if (ci.state === "red") Object.assign(ci, await failedLogs(exec, cwd, ci.runs));
  return ci;
}

/** How many of the release branch's latest runs a classification reads. */
const RELEASE_RUNS = "20";

/**
 * The release branch's latest CI (a red head's classification): the latest run per workflow and
 * trigger event of its recent runs (latestRuns) and, when red, the tests failing there. `unknown`
 * when `gh run list` fails. Read-only.
 */
export async function probeReleaseCi(
  exec: ExecFn,
  o: { cwd: string; release_branch: string },
): Promise<{ state: CiState | "unknown"; failing_tests: string[] }> {
  const r = await exec(
    [
      "gh",
      "run",
      "list",
      "--branch",
      o.release_branch,
      "--limit",
      RELEASE_RUNS,
      "--json",
      RUN_FIELDS,
    ],
    { cwd: o.cwd },
  );
  const raw = r.code === 0 ? parseJson<RawRun[]>(r.stdout) : null;
  if (raw === null || !Array.isArray(raw)) return { state: "unknown", failing_tests: [] };
  const runs: CiRun[] = latestRuns(raw).effective.map((x) => ({
    id: x.databaseId,
    name: x.workflowName ?? x.name,
    status: x.status,
    conclusion: x.conclusion === "" ? null : x.conclusion,
    url: x.url,
  }));
  const failed = failedRuns(runs);
  const state: CiState =
    runs.length === 0
      ? "none"
      : failed.length > 0
        ? "red"
        : runs.some((x) => x.status !== "completed")
          ? "running"
          : "green";
  if (state !== "red") return { state, failing_tests: [] };
  return { state, failing_tests: (await failedLogs(exec, o.cwd, runs)).failing_tests };
}

/** The PR's changed files (`gh pr view <n> --json files`); null when they cannot be read. */
export async function prFiles(exec: ExecFn, cwd: string, pr: number): Promise<string[] | null> {
  const r = await exec(["gh", "pr", "view", String(pr), "--json", "files"], { cwd });
  return r.code === 0 ? parsePrFiles(r.stdout) : null;
}

/** The completed runs that failed a head. */
export const failedRuns = (runs: CiRun[]): CiRun[] =>
  runs.filter((r) => r.status === "completed" && FAILED.has(r.conclusion ?? ""));

const MAX_FAILING_TESTS = 20;

/**
 * Failing test ids in a `gh run view --log-failed` log (`<job>\t<step>\t<line>`): vitest's
 * `FAIL  <file> > <suite> > <name>` and bun's `(fail) <name>` lines, each once, in log order. Pure.
 */
export function failingTests(log: string): string[] {
  const out: string[] = [];
  for (const raw of log.split("\n")) {
    const text = (raw.split("\t").at(-1) ?? "").replace(/^\S*\d{2}:\d{2}:\d{2}\S*Z\s/, "").trim();
    const m = /^FAIL\s+(.+)$/.exec(text) ?? /^\(fail\)\s+(.+?)(\s+\[[\d.]+\s*m?s\])?$/.exec(text);
    const id = m?.[1]?.trim();
    if (id !== undefined && id !== "" && !out.includes(id)) out.push(id);
    if (out.length >= MAX_FAILING_TESTS) break;
  }
  return out;
}

/** What a moved PR head brings: CI on it (and, when red, the failing tests), and the diff. */
export interface MovedHeadFacts {
  ci: {
    state: CiState;
    runs: CiRun[];
    superseded: SupersededRun[];
    failed_jobs: string[];
    failing_tests: string[];
  };
  /** `git log --oneline <from>..<to>` and `git diff --stat <from> <to>`. */
  log: string;
  diffstat: string;
  /** Present when `to` is a merge of `from` and a commit on the release branch. */
  release_merge?: ReleaseMerge;
}

/**
 * A moved head that merges a release-branch commit (`parent`) into the gated head: the files the
 * move touched, the files the release branch changed since the PR branched from it, and whether
 * the first are all among the second (a conflict resolved inside such a file still counts).
 */
export interface ReleaseMerge {
  parent: string;
  moved_files: string[];
  release_files: string[];
  only_release: boolean;
}

const names = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** Is `to` a merge of `from` and a commit on `origin/<release>` only? Null: not such a merge. */
async function releaseMergeOf(
  git: (...args: string[]) => Promise<ExecResult>,
  o: { from: string; to: string; release_branch: string },
): Promise<ReleaseMerge | null> {
  const p = await git("log", "-n", "1", "--format=%P", o.to);
  const parents = p.code === 0 ? p.stdout.split(/\s+/).filter((x) => x !== "") : [];
  const parent = parents.find((x) => x !== o.from);
  if (parents.length !== 2 || !parents.includes(o.from) || parent === undefined) return null;
  await git("fetch", "origin", o.release_branch);
  const on = await git("merge-base", "--is-ancestor", parent, `origin/${o.release_branch}`);
  if (on.code !== 0) return null;
  const base = await git("merge-base", o.from, parent);
  if (base.code !== 0 || line(base.stdout) === "") return null;
  const moved = await git("diff", "--name-only", o.from, o.to);
  const release = await git("diff", "--name-only", line(base.stdout), parent);
  if (moved.code !== 0 || release.code !== 0) return null;
  const moved_files = names(moved.stdout);
  const release_files = names(release.stdout);
  return {
    parent,
    moved_files,
    release_files,
    only_release: moved_files.every((f) => release_files.includes(f)),
  };
}

/** Gather MovedHeadFacts (read-only git / gh through the fenced exec). */
export async function probeMovedHead(
  exec: ExecFn,
  o: { cwd: string; branch: string; from: string; to: string; release_branch?: string },
): Promise<MovedHeadFacts> {
  const git = (...args: string[]) => exec(["git", "-C", o.cwd, ...args]);
  await git("fetch", "origin", o.branch);
  const ci = await ciOn(exec, o.cwd, o.to);
  const tests = ci.state === "red" ? (await failedLogs(exec, o.cwd, ci.runs)).failing_tests : [];
  const log = await git("log", "--oneline", `${o.from}..${o.to}`);
  const stat = await git("diff", "--stat", o.from, o.to);
  const merge =
    o.release_branch !== undefined
      ? await releaseMergeOf(git, { from: o.from, to: o.to, release_branch: o.release_branch })
      : null;
  return {
    ci: {
      state: ci.state,
      runs: ci.runs,
      superseded: ci.superseded,
      failed_jobs: ci.failed_jobs,
      failing_tests: tests,
    },
    log: log.code === 0 ? log.stdout.trim() : "",
    diffstat: stat.code === 0 ? stat.stdout.replace(/^\n+/, "").trimEnd() : "",
    ...(merge !== null ? { release_merge: merge } : {}),
  };
}
