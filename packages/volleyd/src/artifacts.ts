import type { DecisionInput } from "./decisions";
import type { ExecFn } from "./exec";
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

export interface PrRef {
  number: number;
  url: string;
  head_sha: string;
  base: string;
}

export type ArtifactReport =
  | { kind: "missing"; missing: "push" | "pr" | "base"; detail: string }
  | {
      kind: "ok";
      head: string;
      branch: string;
      pr: PrRef;
      ci: { state: CiState; runs: CiRun[]; failed_jobs: string[]; infra: boolean };
      touched?: string[];
    };

const PR_FIELDS = "number,url,headRefName,baseRefName,headRefOid";
const RUN_FIELDS = "databaseId,name,workflowName,status,conclusion,url,headSha";

/** Run conclusions that fail a head. */
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);
/** Run conclusions that are the CI provider's problem, not the code's. */
const INFRA_CONCLUSIONS = new Set(["cancelled", "startup_failure"]);
/** Failed steps that point at the runner or the network rather than the code. */
const INFRA_STEP = /checkout|set up job|runner|network|connection|timed? ?out while|fetch/i;

const line = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";

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
  };

  const ci = await ciOn(exec, spec.cwd, head);
  // GitHub has not caught up with the push yet: the PR's checks are not this head's.
  if (pr.headRefOid !== head) ci.state = ci.state === "red" ? "red" : "running";
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

/** CI on exactly `head`: its runs, the aggregate state, failed job names, infra-shaped or not. */
async function ciOn(
  exec: ExecFn,
  cwd: string,
  head: string,
): Promise<{ state: CiState; runs: CiRun[]; failed_jobs: string[]; infra: boolean }> {
  const r = await exec(["gh", "run", "list", "--commit", head, "--json", RUN_FIELDS], { cwd });
  const raw =
    r.code === 0
      ? (parseJson<
          {
            databaseId: number;
            name: string;
            workflowName?: string;
            status: string;
            conclusion: string | null;
            url: string;
            headSha?: string;
          }[]
        >(r.stdout) ?? [])
      : [];
  const own = raw.filter((x) => x.headSha === undefined || x.headSha === head);
  const runs: CiRun[] = own.map((x) => ({
    id: x.databaseId,
    name: x.name,
    status: x.status,
    conclusion: x.conclusion === "" ? null : x.conclusion,
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
      jobSteps.push({
        name: j.name,
        steps: (j.steps ?? []).filter((s) => FAILED.has(s.conclusion)).map((s) => s.name),
      });
    }
  }
  return { state, runs, failed_jobs: failedJobs, infra: isInfraFailure(failed, jobSteps) };
}

/**
 * Infra-shaped: the run was cancelled or never started, or every failed job failed in a step
 * about the runner, checkout or network rather than in the project's own steps.
 */
export function isInfraFailure(
  runs: { conclusion: string | null }[],
  failedJobs: { name: string; steps: string[] }[],
): boolean {
  if (runs.some((r) => INFRA_CONCLUSIONS.has(r.conclusion ?? ""))) return true;
  return (
    failedJobs.length > 0 &&
    failedJobs.every((j) => j.steps.length > 0 && j.steps.every((s) => INFRA_STEP.test(s)))
  );
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
  | { kind: "verified"; event: NewEvent & { data: Record<string, unknown> } };

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
    const infra = ci.infra
      ? " This looks infra-shaped (runner lost, cancelled, checkout or network error): check the hosting provider's status page first."
      : "";
    return {
      kind: "ci_failed",
      decision: {
        kind: "ci_failed",
        task,
        question: `CI failed on ${head.slice(0, 12)} (PR #${pr.number}): ${urls.join(" ")} — failed jobs: ${jobs}.${infra} volleyd never re-runs CI; fix or re-run it, then answer re-verify (or cancel).`,
        pointers: { pr: pr.url },
        options: ["re-verify", "cancel"],
      },
      data: { head_sha: head, run_urls: urls, failed_jobs: ci.failed_jobs, infra: ci.infra, role },
    };
  }
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
  await git("fetch", "origin", o.release_branch);
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
  const behind = log.stdout.split("\n").filter((l) => l.trim() !== "").length;
  return { release_sha: tip, merge_base: base, behind: Math.max(behind, 1) };
}
