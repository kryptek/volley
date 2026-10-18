import {
  type ArtifactReport,
  type CiRun,
  type RebaseCheck,
  artifactOutcome,
  checkRebase,
  verifyArtifacts,
} from "./artifacts";
import type { Role } from "./brief";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput, DecisionRecord } from "./decisions";
import { type EvidenceInput, writeEvidence } from "./evidence";
import type { ExecFn } from "./exec";
import type { WaveRecord } from "./reducer";
import {
  type FixupResult,
  REVIEWER_ROLES,
  type ReviewResult,
  type ReviewerRole,
  answerIsFine,
  disagreementDecision,
  findDisagreements,
  fixupItems,
  isReviewerRole,
  parseFixupResult,
  parseReviewResult,
  renderFindingsMd,
} from "./reviews";
import type { JournalEvent, NewEvent, PipelineStage, TaskId, TaskStage, WaveId } from "./types";

/**
 * The pipeline: drives a task through its stage groups — implement → [spec_review ∥
 * quality_review] → fixup → merge_ready by default — with every role's `done` checked before it
 * counts. Three layers:
 *
 *   - `reducePipeline` folds journal events into a task's `TaskPipeline` (the reducer calls it),
 *     so the pipeline's position survives a restart like everything else in the journal;
 *   - `next(view, event)` is the pure interpreter: an observation in, actions out (journal an
 *     event, spawn a role, verify artifacts, steer, open a decision, retire, check the release
 *     branch, write the evidence and gate);
 *   - `PipelineDriver` executes those actions through injected deps (the daemon wires its own).
 *
 * volleyd never merges: no action merges, pushes or re-runs CI, and the only commands the
 * driver runs are the read-only verbs of artifacts.ts (test/no-merge.test.ts holds this).
 */

/** Stage → the role that runs it. */
export const STAGE_ROLE: Partial<Record<PipelineStage, Role>> = {
  implement: "implementer",
  spec_review: "spec_reviewer",
  quality_review: "quality_reviewer",
  fixup: "fixup",
};

const ROLE_STAGE: Record<Role, TaskStage> = {
  implementer: "implement",
  spec_reviewer: "spec_review",
  quality_reviewer: "quality_review",
  fixup: "fixup",
  // The rebase is a fix-up of the branch; the closed stage enum has no stage of its own for it.
  rebase: "fixup",
};

/** Roles whose `done` claims pushed commits on the PR branch (checked by artifacts.ts). */
const PUBLISHING_ROLES: ReadonlySet<Role> = new Set(["implementer", "fixup", "rebase"]);

/** One role's agent in the current step. */
export interface RoleRun {
  agent_id: string;
  worktree?: string;
  /** The ref the role's worktree was cut from (reviewers: the reviewed head). */
  start?: string;
  /** Pipeline steers sent to this run, by reason (each reason is steered at most once). */
  steers: Partial<Record<SteerReason, number>>;
  /** Its work was verified (publishing roles) or its review result recorded (reviewers). */
  accepted: boolean;
  /** Its `agent_retired` status, once retired. */
  retired?: string;
}

export interface StoredReview {
  round: number;
  head: string;
  result: ReviewResult;
}

/** A task's position in its pipeline, reduced from the journal. */
export interface TaskPipeline {
  /** Index into the task's stage groups; -1 until the implementer starts. */
  step: number;
  /** The roles of the current step. */
  roles: Role[];
  /** The current step is a rebase onto the moved release branch. */
  rebasing: boolean;
  runs: Partial<Record<Role, RoleRun>>;
  /** The PR's head branch (the implementer's). */
  branch?: string;
  /** The latest verified head and its PR / CI runs. */
  head?: string;
  pr?: { number: number; url: string };
  ci?: "green" | "none";
  ci_runs?: CiRun[];
  /** Review rounds started (the first review step is round 1; a re-review starts the next). */
  round: number;
  reviews: Partial<Record<ReviewerRole, StoredReview>>;
  /** Every file each reviewer has flagged, over all rounds. */
  flagged: Partial<Record<ReviewerRole, string[]>>;
  /** Every fixup that ran, oldest first, with the review round it worked from. */
  fixups: { round: number; from?: string; to: string; result?: FixupResult; worktree?: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
  /** Reviewers to re-run because the last rebase touched files they flagged. */
  rereview: ReviewerRole[];
  /** The owner's answer to a `reviewers_disagree` decision, for the round it was asked in. */
  disagreement?: { round: number; answer: string };
}

export type SteerReason = "artifacts" | "result";

/** What a pipeline decision is about; kept on the decision as `pipeline`. */
export interface PipelineMarker {
  on: "verify" | "ci_failed" | "ci_none" | "review_result" | "agent_failed" | "reviewers_disagree";
  role?: Role;
  head?: string;
}

export const emptyPipeline = (): TaskPipeline => ({
  step: -1,
  roles: [],
  rebasing: false,
  runs: {},
  round: 0,
  reviews: {},
  flagged: {},
  fixups: [],
  rebases: [],
  rereview: [],
});

const isRole = (r: unknown): r is Role => typeof r === "string" && r in ROLE_STAGE;

/**
 * Fold one journal event into a task's pipeline. Pure; mutates and returns `p` (the reducer
 * passes its own clone). `stages` is the task's stage groups; `decision` the record of a
 * `decision_resolved` event.
 */
export function reducePipeline(
  p: TaskPipeline,
  ev: JournalEvent,
  ctx: { stages: PipelineStage[][]; decision?: DecisionRecord },
): TaskPipeline {
  const d = ev.data;
  const role = d.role;
  switch (ev.type) {
    case "agent_spawned":
      if (!isRole(role)) break;
      p.runs[role] = {
        agent_id: d.agent_id as string,
        ...(typeof d.worktree === "string" ? { worktree: d.worktree } : {}),
        ...(typeof d.start === "string" ? { start: d.start } : {}),
        steers: {},
        accepted: false,
      };
      if (role === "implementer" && typeof d.branch === "string") p.branch = d.branch;
      break;
    case "stage_entered":
      if (Array.isArray(d.roles)) {
        p.step = d.step as number;
        p.roles = (d.roles as unknown[]).filter(isRole);
        p.rebasing = d.rebase === true;
        p.rereview = [];
        if (typeof d.review_round === "number") p.round = d.review_round;
        for (const r of p.roles) delete p.runs[r];
      } else if (d.stage === "implement") {
        // Journaled by the spawn itself, after its agent_spawned: keep that run.
        const i = ctx.stages.findIndex((g) => g.includes("implement"));
        p.step = i >= 0 ? i : 0;
        p.roles = ["implementer"];
        p.rebasing = false;
      }
      break;
    case "steering_sent": {
      const reason = d.reason as SteerReason | undefined;
      const run = isRole(role) ? p.runs[role] : undefined;
      if (reason !== undefined && run !== undefined && run.agent_id === d.agent_id) {
        run.steers[reason] = (run.steers[reason] ?? 0) + 1;
      }
      break;
    }
    case "artifact_verified": {
      if (!isRole(role)) break;
      const run = p.runs[role];
      if (run !== undefined) run.accepted = true;
      if (typeof d.head_sha === "string") p.head = d.head_sha;
      const pr = d.pr as { number: number; url: string; ci?: string } | undefined;
      if (pr !== undefined) {
        p.pr = { number: pr.number, url: pr.url };
        p.ci = pr.ci === "none" ? "none" : "green";
      }
      if (Array.isArray(d.ci_runs)) p.ci_runs = d.ci_runs as CiRun[];
      if (isReviewerRole(role) && d.review !== undefined) {
        const result = d.review as ReviewResult;
        p.reviews[role] = { round: p.round, head: run?.start ?? p.head ?? "", result };
        p.flagged[role] = [
          ...new Set([...(p.flagged[role] ?? []), ...result.findings.map((f) => f.file)]),
        ];
      } else if (role === "fixup" && typeof d.head_sha === "string") {
        p.fixups.push({
          round: p.round,
          ...(run?.start !== undefined ? { from: run.start } : {}),
          to: d.head_sha,
          ...(d.result !== undefined ? { result: d.result as FixupResult } : {}),
          ...(run?.worktree !== undefined ? { worktree: run.worktree } : {}),
        });
      } else if (role === "rebase" && typeof d.head_sha === "string") {
        const touched = Array.isArray(d.touched) ? (d.touched as string[]) : [];
        p.rebases.push({
          ...(run?.start !== undefined ? { from: run.start } : {}),
          to: d.head_sha,
          touched,
        });
        p.rereview = REVIEWER_ROLES.filter((r) =>
          (p.flagged[r] ?? []).some((f) => touched.includes(f)),
        );
      }
      break;
    }
    case "agent_retired": {
      const run = isRole(role) ? p.runs[role] : undefined;
      if (run !== undefined && run.agent_id === d.agent_id && d.status !== "superseded") {
        run.retired = String(d.status);
      }
      break;
    }
    case "decision_resolved": {
      const m = (ctx.decision as { pipeline?: PipelineMarker } | undefined)?.pipeline;
      if (m?.on === "reviewers_disagree")
        p.disagreement = { round: p.round, answer: String(d.answer) };
      break;
    }
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------------------------

export interface PipelineView {
  task: TaskId;
  stages: PipelineStage[][];
  stage: TaskStage;
  release_branch: string;
  p: TaskPipeline;
}

export type PipelineEvent =
  /** Re-evaluate: a step's roles may all be accepted, a spawn may need retrying. */
  | { kind: "advance" }
  /** A role's agent published a terminal status; `result` is its retained `result` payload. */
  | {
      kind: "agent_done";
      role: Role;
      agent_id: string;
      status: "done" | "failed";
      result?: unknown;
    }
  /** Artifacts verified for `role`; `waited_ms` is how long this head has had no CI run. */
  | {
      kind: "verified";
      role: Role;
      report: ArtifactReport;
      result?: FixupResult;
      waited_ms?: number;
    }
  | { kind: "rebase_checked"; check: RebaseCheck }
  | { kind: "decision_resolved"; decision: DecisionRecord };

export interface SpawnStart {
  /** The commit the role's worktree is cut from. */
  ref: string;
  /** Detached HEAD (reviewers: read-only), else a fresh branch from `ref`. */
  detach: boolean;
}

export type PipelineAction =
  | { kind: "journal"; event: NewEvent }
  | { kind: "spawn"; role: Role; start?: SpawnStart; files: Record<string, string> }
  | { kind: "verify"; role: Role; result?: FixupResult }
  | { kind: "steer"; role: Role; agent_id: string; reason: SteerReason; text: string }
  | {
      kind: "decide";
      decision: DecisionInput;
      marker: PipelineMarker;
      data?: Record<string, unknown>;
    }
  | { kind: "retire"; agent_id: string }
  | { kind: "check_rebase" }
  /** At the gate: has a human merged the PR? (volleyd only ever reads this.) */
  | { kind: "check_merged" }
  | { kind: "gate"; check: RebaseCheck };

/** Stages in which the pipeline does nothing for the task. */
const IDLE: ReadonlySet<TaskStage> = new Set([
  "queued",
  "awaiting_decision",
  "merge_ready",
  "done",
  "blocked",
  "cancelled",
]);

/** The pure interpreter: what to do about `ev` given the task's current view. */
export function next(v: PipelineView, ev: PipelineEvent): PipelineAction[] {
  switch (ev.kind) {
    case "advance":
      return advance(v);
    case "agent_done":
      return onDone(v, ev);
    case "verified":
      return onVerified(v, ev);
    case "rebase_checked":
      if (v.stage === "cancelled" || v.stage === "merge_ready") return [];
      return ev.check.behind === 0 ? [{ kind: "gate", check: ev.check }] : enterRebase(v);
    case "decision_resolved":
      return onResolved(v, ev.decision);
  }
}

const retireIfLive = (run: RoleRun | undefined): PipelineAction[] =>
  run !== undefined && run.retired === undefined
    ? [{ kind: "retire", agent_id: run.agent_id }]
    : [];

function onDone(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "agent_done" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  // A stale agent (superseded, or already accepted): only make sure it is retired.
  if (
    run === undefined ||
    run.agent_id !== ev.agent_id ||
    run.accepted ||
    v.stage === "cancelled"
  ) {
    return [{ kind: "retire", agent_id: ev.agent_id }];
  }
  if (ev.status === "failed") {
    return [
      { kind: "retire", agent_id: ev.agent_id },
      {
        kind: "decide",
        marker: { on: "agent_failed", role: ev.role },
        decision: {
          kind: "agent_blocked",
          task: v.task,
          question: `${ev.agent_id} (${ev.role}) failed. Respawn the ${ev.role}, or cancel the task?`,
          options: ["respawn", "cancel"],
        },
      },
    ];
  }
  if (isReviewerRole(ev.role)) {
    const review = parseReviewResult(ev.result);
    if (review === null) {
      if ((run.steers.result ?? 0) < 1) {
        return [
          {
            kind: "steer",
            role: ev.role,
            agent_id: ev.agent_id,
            reason: "result",
            text: 'Your done arrived without a parseable review result. Publish it first — vol_publish(channel="result", type="review", payload={ "findings": [{ "severity": "P1"|"P2"|"P3", "file": "<path>", "line": <n>, "text": "<finding>" }], "verdict": "approve"|"changes_requested" }) — then publish done again.',
          },
        ];
      }
      return [
        { kind: "retire", agent_id: ev.agent_id },
        {
          kind: "decide",
          marker: { on: "review_result", role: ev.role },
          decision: {
            kind: "agent_blocked",
            task: v.task,
            question: `${ev.agent_id} (${ev.role}) finished twice without a parseable review result. Respawn the reviewer, or skip this review?`,
            options: ["respawn", "skip"],
          },
        },
      ];
    }
    return [
      {
        kind: "journal",
        event: {
          type: "artifact_verified",
          task: v.task,
          data: { role: ev.role, agent_id: ev.agent_id, review, head_sha: run.start ?? v.p.head },
        },
      },
      { kind: "retire", agent_id: ev.agent_id },
    ];
  }
  if (PUBLISHING_ROLES.has(ev.role)) {
    const fixup = ev.role === "fixup" ? parseFixupResult(ev.result) : null;
    return [{ kind: "verify", role: ev.role, ...(fixup !== null ? { result: fixup } : {}) }];
  }
  return [{ kind: "retire", agent_id: ev.agent_id }];
}

function onVerified(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "verified" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  if (run === undefined || run.accepted || v.stage === "cancelled") return [];
  const out = artifactOutcome(v.task, ev.role, ev.report);
  const head = ev.report.kind === "ok" ? ev.report.head : undefined;
  switch (out.kind) {
    case "missing": {
      if (run.retired === undefined && (run.steers.artifacts ?? 0) < 1) {
        return [
          { kind: "journal", event: out.event },
          {
            kind: "steer",
            role: ev.role,
            agent_id: run.agent_id,
            reason: "artifacts",
            text: `volleyd could not verify your work: ${out.detail}. Push \`${v.p.branch ?? "your branch"}\` and make sure an open PR from it targets \`${v.release_branch}\` (gh pr create --base ${v.release_branch}), then publish done again.`,
          },
        ];
      }
      return [
        { kind: "journal", event: out.event },
        ...retireIfLive(run),
        {
          kind: "decide",
          marker: { on: "verify", role: ev.role },
          decision: {
            kind: "agent_blocked",
            task: v.task,
            question: `${ev.role} ${run.agent_id} reported done, but its ${out.missing} is missing (${out.detail}). Fix it by hand and answer re-verify, or cancel the task.`,
            options: ["re-verify", "cancel"],
          },
        },
      ];
    }
    case "ci_failed":
      return [
        ...retireIfLive(run),
        {
          kind: "decide",
          marker: { on: "ci_failed", role: ev.role, ...(head !== undefined ? { head } : {}) },
          decision: out.decision,
          data: out.data,
        },
      ];
    case "ci_pending": {
      const grace = ev.waited_ms !== undefined && ev.waited_ms >= DAEMON_DEFAULTS.ci_none_grace_ms;
      if (out.state === "none" && grace) {
        return [
          ...retireIfLive(run),
          {
            kind: "decide",
            marker: { on: "ci_none", role: ev.role, head: out.head },
            decision: {
              kind: "ci_failed",
              task: v.task,
              question: `No CI run exists for ${out.head.slice(0, 12)} after ${Math.round((ev.waited_ms ?? 0) / 60_000)} min. Check the repository's workflows (and the hosting provider's status page). Accept the head without CI, or cancel?`,
              ...(ev.report.kind === "ok" ? { pointers: { pr: ev.report.pr.url } } : {}),
              options: ["accept", "cancel"],
            },
          },
        ];
      }
      // The pushed work is in place; CI is re-checked on later ticks. The agent is done.
      return retireIfLive(run);
    }
    case "verified":
      return [
        {
          kind: "journal",
          event: {
            ...out.event,
            data: {
              ...out.event.data,
              agent_id: run.agent_id,
              ...(ev.result !== undefined ? { result: ev.result } : {}),
            },
          },
        },
        ...retireIfLive(run),
      ];
  }
}

function onResolved(v: PipelineView, d: DecisionRecord): PipelineAction[] {
  const m = (d as { pipeline?: PipelineMarker }).pipeline;
  const answer = d.resolved?.answer ?? "";
  if (m === undefined || d.task !== v.task) return [];
  if (/\bcancel/i.test(answer)) {
    return [
      {
        kind: "journal",
        event: {
          type: "task_cancelled",
          task: v.task,
          data: { by: d.resolved?.by, decision_id: d.decision_id },
        },
      },
    ];
  }
  const role = m.role;
  const run = role !== undefined ? v.p.runs[role] : undefined;
  switch (m.on) {
    case "verify":
    case "ci_failed":
      return role !== undefined ? [{ kind: "verify", role }] : [];
    case "ci_none":
      if (role === undefined || run === undefined || !/accept/i.test(answer)) return [];
      return [
        {
          kind: "journal",
          event: {
            type: "artifact_verified",
            task: v.task,
            data: {
              role,
              agent_id: run.agent_id,
              head_sha: m.head,
              branch: v.p.branch,
              ...(v.p.pr !== undefined ? { pr: { ...v.p.pr, head_sha: m.head, ci: "none" } } : {}),
              ci_runs: [],
              accepted_by: d.resolved?.by,
            },
          },
        },
      ];
    case "review_result":
      if (role === undefined) return [];
      if (/respawn/i.test(answer)) return [spawnFor(v, role)];
      return [
        {
          kind: "journal",
          event: {
            type: "artifact_verified",
            task: v.task,
            data: {
              role,
              ...(run !== undefined ? { agent_id: run.agent_id } : {}),
              review: {
                findings: [],
                verdict: "approve",
                summary: `review skipped by ${d.resolved?.by}`,
              },
            },
          },
        },
      ];
    case "agent_failed":
      return role !== undefined ? [spawnFor(v, role)] : [];
    case "reviewers_disagree":
      return [];
  }
}

/** The spawn for `role` in the current step: reviewers at the head (detached), others from it. */
function spawnFor(v: PipelineView, role: Role): PipelineAction {
  const head = v.p.head;
  if (role === "implementer" || head === undefined) return { kind: "spawn", role, files: {} };
  const base = {
    pr_branch: v.p.branch ?? "",
    pr_url: v.p.pr?.url ?? "",
    head,
    release_branch: v.release_branch,
  };
  if (isReviewerRole(role)) {
    return {
      kind: "spawn",
      role,
      start: { ref: head, detach: true },
      files: { "review.md": renderReviewMd(role, base) },
    };
  }
  if (role === "fixup") {
    const items = fixupItems(roundReviews(v.p), { notBlockers: answeredNotBlockers(v.p) });
    return {
      kind: "spawn",
      role,
      start: { ref: head, detach: false },
      files: {
        "findings.md": renderFindingsMd(items, base),
        "findings.json": `${JSON.stringify(items, null, 2)}\n`,
      },
    };
  }
  return {
    kind: "spawn",
    role,
    start: { ref: head, detach: false },
    files: { "rebase.md": renderRebaseMd(base) },
  };
}

/** The reviews of the latest round — what the next fixup works from. */
function roundReviews(p: TaskPipeline): Partial<Record<ReviewerRole, ReviewResult>> {
  const out: Partial<Record<ReviewerRole, ReviewResult>> = {};
  for (const r of REVIEWER_ROLES) {
    const rv = p.reviews[r];
    if (rv !== undefined && rv.round === p.round) out[r] = rv.result;
  }
  return out;
}

function answeredNotBlockers(p: TaskPipeline) {
  const answered = p.disagreement !== undefined && p.disagreement.round === p.round;
  return answered && answerIsFine(p.disagreement?.answer ?? "")
    ? findDisagreements(roundReviews(p))
    : [];
}

function advance(v: PipelineView): PipelineAction[] {
  const { p } = v;
  // volleyd never merges; a gated task becomes done once a human has merged its PR.
  if (v.stage === "merge_ready" && p.pr !== undefined) return [{ kind: "check_merged" }];
  if (IDLE.has(v.stage) || p.step < 0) return [];
  const pending: PipelineAction[] = [];
  for (const r of p.roles) {
    const run = p.runs[r];
    // A spawn that has not happened yet (budget, admission, a refused launch): retry it.
    if (run === undefined) pending.push(spawnFor(v, r));
    // Retired without being accepted: its CI was pending. Re-check (the driver rate-limits).
    else if (!run.accepted && run.retired === "done" && PUBLISHING_ROLES.has(r))
      pending.push({ kind: "verify", role: r });
  }
  if (pending.length > 0 || p.roles.some((r) => p.runs[r]?.accepted !== true)) return pending;
  if (p.rebasing) {
    if (p.rereview.length > 0) {
      const i = v.stages.findIndex((g) =>
        g.some((s) => p.rereview.includes(STAGE_ROLE[s] as ReviewerRole)),
      );
      if (i >= 0) return enterStep(v, i, p.rereview);
    }
    return [{ kind: "check_rebase" }];
  }
  return enter(v, p.step + 1);
}

/** Enter stage group `i` (skipping what has nothing to do); the end of the pipeline is the gate. */
function enter(v: PipelineView, i: number): PipelineAction[] {
  const group = v.stages[i];
  if (group === undefined || group.includes("merge_ready")) return [{ kind: "check_rebase" }];
  const roles = group.flatMap((s) => (s === "implement" ? [] : [STAGE_ROLE[s] as Role]));
  if (roles.length === 0) return enter(v, i + 1);
  if (roles.includes("fixup")) {
    const reviews = roundReviews(v.p);
    const ds = findDisagreements(reviews);
    const answered = v.p.disagreement !== undefined && v.p.disagreement.round === v.p.round;
    if (ds.length > 0 && !answered) {
      return [
        {
          kind: "decide",
          marker: { on: "reviewers_disagree" },
          decision: disagreementDecision(v.task, ds),
        },
      ];
    }
    // Nothing to fix: skip the fixup (it would only spend a spawn).
    if (roles.length === 1 && fixupItems(reviews).length === 0) return enter(v, i + 1);
  }
  return enterStep(v, i, roles);
}

function enterStep(v: PipelineView, i: number, roles: Role[]): PipelineAction[] {
  const reviewing = roles.some(isReviewerRole);
  const stage = ROLE_STAGE[roles[0] as Role];
  // spawnFor reads the round the step starts (fixup: the round it fixes).
  const after: PipelineView = { ...v, p: { ...v.p, round: reviewing ? v.p.round + 1 : v.p.round } };
  return [
    {
      kind: "journal",
      event: {
        type: "stage_entered",
        task: v.task,
        data: {
          stage,
          step: i,
          roles,
          ...(roles.length > 1 ? { group: roles.map((r) => ROLE_STAGE[r]) } : {}),
          ...(reviewing ? { review_round: after.p.round } : {}),
        },
      },
    },
    ...roles.map((r) => spawnFor(after, r)),
  ];
}

function enterRebase(v: PipelineView): PipelineAction[] {
  return [
    {
      kind: "journal",
      event: {
        type: "stage_entered",
        task: v.task,
        data: { stage: ROLE_STAGE.rebase, step: v.p.step, roles: ["rebase"], rebase: true },
      },
    },
    spawnFor(v, "rebase"),
  ];
}

interface BriefCtx {
  pr_branch: string;
  pr_url: string;
  head: string;
  release_branch: string;
}

/** `.volley/review.md`: what to review (the PR's diff at one head) and how to report. */
function renderReviewMd(role: ReviewerRole, c: BriefCtx): string {
  const what =
    role === "spec_reviewer"
      ? "the diff against the plan in `ISSUE.md`"
      : "the diff itself (correctness, tests, error handling, readability)";
  return [
    "# What to review",
    "",
    `PR: ${c.pr_url} (branch \`${c.pr_branch}\`). This worktree is a detached checkout of exactly \`${c.head}\`.`,
    "",
    `Review ${what}:`,
    "",
    `    git diff origin/${c.release_branch}...${c.head}`,
    "",
    "Report through the result contract in your brief (`result` channel, type `review`) before your `done`.",
    "",
  ].join("\n");
}

/** `.volley/rebase.md`: bring the PR branch up to date with the release branch. */
function renderRebaseMd(c: BriefCtx): string {
  return [
    "# Rebase",
    "",
    `\`${c.release_branch}\` moved since \`${c.pr_branch}\` branched from it. This worktree starts at the PR head \`${c.head}\`.`,
    "",
    `    git fetch origin ${c.release_branch}`,
    `    git rebase origin/${c.release_branch}`,
    "    # resolve conflicts, keep the PR's intent; run the repository's gates",
    `    git push --force-with-lease=${c.pr_branch}:${c.head} origin HEAD:${c.pr_branch}`,
    "",
    `That lease-guarded push to \`${c.pr_branch}\` is the one force-push this role may do. PR: ${c.pr_url}.`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

export interface PipelineDeps {
  /** The fenced exec (read-only verbs only are used). */
  exec: ExecFn;
  /** $VOLLEYD_HOME: evidence goes to `<home>/waves/<wave>/evidence/`. */
  home: string;
  /** The wave's current record (re-read after every journal append). */
  record: () => WaveRecord;
  journal: (ev: NewEvent) => Promise<unknown>;
  /** Start a role's agent (may refuse silently: the next advance retries). */
  spawn: (
    task: TaskId,
    role: Role,
    req: { start?: SpawnStart; files: Record<string, string> },
  ) => Promise<unknown>;
  steer: (
    task: TaskId,
    role: Role,
    agentId: string,
    text: string,
    reason: SteerReason,
  ) => Promise<unknown>;
  /** Open a decision; `extra` facts (the `pipeline` marker) are kept on it. */
  decide: (input: DecisionInput, extra: Record<string, unknown>) => Promise<unknown>;
  retire: (agentId: string) => Promise<unknown>;
  now?: () => number;
}

/** Executes the interpreter's actions for one wave. Call it from one serial queue. */
export class PipelineDriver {
  /** Last level-triggered re-check per `<task>/<what>` (verify, check_rebase). */
  private readonly lastCheck = new Map<string, number>();
  /** Gated tasks whose PR was closed unmerged (alarmed once per process). */
  private readonly closedAlarmed = new Set<TaskId>();
  /** When each head was first seen with no CI run at all. */
  private readonly noCiSince = new Map<string, number>();

  constructor(
    private readonly wave: WaveId,
    private readonly deps: PipelineDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The task's view, or null when the task is not in the wave (or not running). */
  view(task: TaskId): PipelineView | null {
    const rec = this.deps.record();
    const t = rec.state?.tasks.find((x) => x.id === task);
    const wt = rec.wave?.tasks[task];
    if (rec.state == null || t === undefined || wt === undefined) return null;
    return {
      task,
      stages: wt.stages,
      stage: t.stage,
      release_branch: rec.state.release_branch,
      p: rec.pipeline[task] ?? emptyPipeline(),
    };
  }

  /** Handle one observation, then advance until the task settles. */
  async handle(task: TaskId, ev: PipelineEvent): Promise<void> {
    const v = this.view(task);
    if (v === null) return;
    await this.run(task, next(v, ev), ev.kind !== "advance");
    // Each round of actions changes the record; a step's last acceptance enters the next step.
    for (let i = 0; i < DAEMON_DEFAULTS.pipeline_max_advances; i++) {
      const w = this.view(task);
      if (w === null) return;
      const acts = next(w, { kind: "advance" });
      if (acts.length === 0) return;
      const progressed = await this.run(task, acts, false);
      if (!progressed) return;
    }
  }

  /** The level-triggered tick for every task (retries spawns, re-checks pending CI). */
  async tick(): Promise<void> {
    for (const t of this.deps.record().state?.tasks ?? [])
      await this.handle(t.id, { kind: "advance" });
  }

  /** Execute actions; returns whether any changed state (so advancing again can make progress). */
  private async run(
    task: TaskId,
    actions: PipelineAction[],
    eventDriven: boolean,
  ): Promise<boolean> {
    let progressed = false;
    for (const a of actions) {
      switch (a.kind) {
        case "journal":
          await this.deps.journal(a.event);
          progressed = true;
          break;
        case "spawn":
          await this.deps.spawn(task, a.role, {
            ...(a.start !== undefined ? { start: a.start } : {}),
            files: a.files,
          });
          break;
        case "steer": {
          await this.deps.steer(task, a.role, a.agent_id, a.text, a.reason);
          progressed = true;
          break;
        }
        case "decide":
          await this.deps.decide(a.decision, { ...(a.data ?? {}), pipeline: a.marker });
          progressed = true;
          break;
        case "retire":
          await this.deps.retire(a.agent_id);
          progressed = true;
          break;
        case "verify": {
          // Rate-limit per agent: a new run of the role is checked at once.
          const key = `${task}/verify/${this.view(task)?.p.runs[a.role]?.agent_id}`;
          if (!eventDriven && !this.due(key)) break;
          this.lastCheck.set(key, this.now());
          const ev = await this.verify(task, a.role, a.result);
          if (ev !== null) {
            const v = this.view(task);
            if (v !== null && (await this.run(task, next(v, ev), true))) progressed = true;
          }
          break;
        }
        case "check_rebase": {
          const v = this.view(task);
          if (!eventDriven && !this.due(`${task}/check_rebase/${v?.p.head}`)) break;
          const cwd = v !== null ? this.headWorktree(v.p) : undefined;
          if (v === null || cwd === undefined || v.p.head === undefined) break;
          const check = await checkRebase(this.deps.exec, {
            cwd,
            head: v.p.head,
            release_branch: v.release_branch,
          });
          if (await this.run(task, next(v, { kind: "rebase_checked", check }), true))
            progressed = true;
          break;
        }
        case "check_merged": {
          const v = this.view(task);
          if (v?.p.pr === undefined || !this.due(`${task}/check_merged`)) break;
          if (await this.checkMerged(task, v)) progressed = true;
          break;
        }
        case "gate":
          await this.gate(task, a.check);
          progressed = true;
          break;
      }
    }
    return progressed;
  }

  /** Level-triggered checks run at most once per `ci_poll_ms`. */
  private due(key: string): boolean {
    const now = this.now();
    const last = this.lastCheck.get(key);
    if (last !== undefined && now - last < DAEMON_DEFAULTS.ci_poll_ms) return false;
    this.lastCheck.set(key, now);
    return true;
  }

  /** The worktree whose HEAD is the PR head: the last publishing role's. */
  private headWorktree(p: TaskPipeline): string | undefined {
    for (const r of ["rebase", "fixup", "implementer"] as const) {
      const run = p.runs[r];
      if (run?.accepted && run.worktree !== undefined) return run.worktree;
    }
    return p.runs.implementer?.worktree;
  }

  private async verify(
    task: TaskId,
    role: Role,
    result?: FixupResult,
  ): Promise<PipelineEvent | null> {
    const v = this.view(task);
    const run = v?.p.runs[role];
    if (v === null || run?.worktree === undefined || v.p.branch === undefined) return null;
    const report = await verifyArtifacts(this.deps.exec, {
      cwd: run.worktree,
      branch: v.p.branch,
      release_branch: v.release_branch,
      ...(role === "rebase" && run.start !== undefined ? { since: run.start } : {}),
    });
    let waited: number | undefined;
    if (report.kind === "ok" && report.ci.state === "none") {
      const since = this.noCiSince.get(report.head) ?? this.now();
      this.noCiSince.set(report.head, since);
      waited = this.now() - since;
    }
    return {
      kind: "verified",
      role,
      report,
      ...(result !== undefined ? { result } : {}),
      ...(waited !== undefined ? { waited_ms: waited } : {}),
    };
  }

  /**
   * Read the gated PR's state (`gh pr view`). Merged into the release branch → journal the merge
   * and enter `done`, which releases the task's dependents. Closed unmerged → one alarm.
   */
  private async checkMerged(task: TaskId, v: PipelineView): Promise<boolean> {
    const pr = v.p.pr;
    if (pr === undefined) return false;
    const cwd = this.headWorktree(v.p);
    const r = await this.deps.exec(
      ["gh", "pr", "view", String(pr.number), "--json", "state,mergedAt,mergeCommit,baseRefName"],
      cwd !== undefined ? { cwd } : {},
    );
    if (r.code !== 0) return false;
    let view: {
      state?: string;
      mergedAt?: string | null;
      mergeCommit?: { oid?: string } | null;
      baseRefName?: string;
    };
    try {
      view = JSON.parse(r.stdout);
    } catch {
      return false;
    }
    if (view.state === "MERGED" && view.baseRefName === v.release_branch) {
      await this.deps.journal({
        type: "artifact_verified",
        task,
        data: {
          role: "merged",
          pr: { number: pr.number, url: pr.url, head_sha: v.p.head, ci: v.p.ci ?? "green" },
          merge_sha: view.mergeCommit?.oid ?? null,
          merged_at: view.mergedAt ?? null,
        },
      });
      await this.deps.journal({
        type: "stage_entered",
        task,
        data: { stage: "done", merged: true },
      });
      return true;
    }
    if (view.state === "CLOSED" && !this.closedAlarmed.has(task)) {
      this.closedAlarmed.add(task);
      await this.deps.journal({
        type: "alarm_raised",
        task,
        data: { alarm: "pr_closed_unmerged", pr: pr.url },
      });
    }
    return false;
  }

  /** Write the evidence package and enter merge_ready. volleyd never merges. */
  private async gate(task: TaskId, check: RebaseCheck): Promise<void> {
    const rec = this.deps.record();
    const v = this.view(task);
    if (v === null) return;
    const { p } = v;
    const { head, pr } = p;
    if (head === undefined || pr === undefined) return;
    const fixups: EvidenceInput["fixups"] = [];
    for (const f of p.fixups) {
      const r =
        f.from !== undefined && f.worktree !== undefined
          ? await this.deps.exec(["git", "-C", f.worktree, "diff", "--stat", f.from, f.to])
          : null;
      const { worktree: _w, ...rest } = f;
      fixups.push({
        ...rest,
        ...(r !== null && r.code === 0 ? { diffstat: r.stdout.trim() } : {}),
      });
    }
    const input: EvidenceInput = {
      wave: this.wave,
      task,
      issue: rec.wave?.tasks[task]?.issue ?? 0,
      pr,
      head,
      branch: p.branch ?? "",
      release_branch: v.release_branch,
      ci: p.ci ?? "green",
      ci_runs: p.ci_runs ?? [],
      reviews: p.reviews,
      fixups,
      rebases: p.rebases,
      release: check,
      generated_at: new Date(this.now()).toISOString(),
    };
    const paths = writeEvidence(this.deps.home, input);
    await this.deps.journal({
      type: "artifact_verified",
      task,
      data: {
        role: "gate",
        evidence_path: paths.md,
        evidence_json: paths.json,
        head_sha: head,
        pr: { number: pr.number, url: pr.url, head_sha: head, ci: p.ci ?? "green" },
        release_sha: check.release_sha,
        behind: check.behind,
      },
    });
    await this.deps.journal({ type: "stage_entered", task, data: { stage: "merge_ready" } });
  }
}
