import {
  type ArtifactOutcome,
  type ArtifactReport,
  type CiRun,
  type CiState,
  type GitAt,
  type Landed,
  type MovedHeadFacts,
  type OperatorMergeCheck,
  type RateLimited,
  type RebaseCheck,
  type ReleaseMerge,
  type RunsVia,
  type SupersededRun,
  artifactOutcome,
  checkRebase,
  ciReport,
  failedRuns,
  landed,
  prFiles,
  probeLanded,
  probeMovedHead,
  probeReleaseCi,
  redHeadCi,
  verifyArtifacts,
  verifyOperatorMerge,
} from "./artifacts";
import { type ClassifyResult, classify } from "./autopilot/ci-classify";
import { type GithubStatus, STATUS_UNKNOWN } from "./autopilot/github-status";
import { type RefusalReason, isRefusalReason, mergePr } from "./autopilot/merge";
import { type QueueEntry, nextToMerge, queueOf, refusalEndsTurn } from "./autopilot/merge-queue";
import type { Role } from "./brief";
import { systemClock } from "./clock";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "./config-defaults";
import {
  type DecisionInput,
  type DecisionKind,
  type DecisionRecord,
  ITS_RUNNING,
} from "./decisions";
import { type EvidenceInput, markEvidenceStale, writeEvidence } from "./evidence";
import type { ExecFn, ExecOptions, ExecResult } from "./exec";
import { type MergeToken, mintMergeToken } from "./fence";
import { type RunningImplementer, nudgeTargets, nudgeText, parsePrFiles } from "./overlap";
import { isRespawnAnswer } from "./recovery";
import type { WaveRecord } from "./reducer";
import {
  type Disagreement,
  type FixupResult,
  type HygieneLevel,
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
  resultSteerText,
} from "./reviews";
import type {
  BranchUpdate,
  JournalEvent,
  NewEvent,
  NudgeOnMerge,
  PipelineStage,
  TaskId,
  TaskStage,
  WaveId,
} from "./types";
import { BLOCKED_ALARM } from "./watchdog";
import { expandHome } from "./worktree";

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
 *     Its git / gh calls are hard-timed-out and run beside the daemon's serial queue: their
 *     results come back as events through `deps.enqueue`, so a hung network call never holds up
 *     control ops or shutdown.
 *
 * volleyd never pushes or re-runs CI, and merges only under autopilot merging (`merge: auto`,
 * SPEC §4.6.17): the one `merge` action, with the gate's MergeToken, runs exactly
 * `gh pr merge <n> --squash --match-head-commit <gated head>` (src/autopilot/merge.ts). Every
 * other command the driver runs is a read-only verb of artifacts.ts (test/no-merge.test.ts).
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
  // The release train's role (SPEC §4.6.19): never in a task's pipeline (isRole excludes it).
  release: "done",
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
  /** The head its verification accepted (publishing roles). */
  head?: string;
  /** Its `agent_retired` status, once retired. */
  retired?: string;
  /** The fixup's reported result, kept from its retire so a later verification still has it. */
  result?: FixupResult;
  /** The PR moved past this run's verified head: re-verify the PR branch's head as it is now. */
  adopt?: boolean;
  /** The journal seq of its `agent_spawned` (a merge after it is one its base lacks). */
  spawned_seq?: number;
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
  /**
   * The rebase step merges the release branch in instead (`branch_update: merge`, fixed when the
   * step started): a normal push, and its head must descend from the step's start.
   */
  branch_update?: "merge" | undefined;
  /** The rebase step was entered because GitHub reported the PR CONFLICTING (`pr_conflicting`). */
  conflicting?: true | undefined;
  runs: Partial<Record<Role, RoleRun>>;
  /** The PR's head branch (the implementer's). */
  branch?: string;
  /** The latest verified head and its PR / CI runs. */
  head?: string;
  pr?: { number: number; url: string };
  ci?: "green" | "none";
  ci_runs?: CiRun[];
  /** Runs on `head` that a newer run of the same workflow and event replaced. */
  ci_superseded?: SupersededRun[] | undefined;
  /** Review rounds started (the first review step is round 1; a re-review starts the next). */
  round: number;
  reviews: Partial<Record<ReviewerRole, StoredReview>>;
  /** Every file each reviewer has flagged, over all rounds. */
  flagged: Partial<Record<ReviewerRole, string[]>>;
  /** Every fixup that ran, oldest first, with the review round it worked from. */
  fixups: { round: number; from?: string; to: string; result?: FixupResult; worktree?: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
  /**
   * Heads pushed to the PR outside the pipeline after a verification. `accepted_by`: the owner
   * answered a pr_head_moved decision with `fixup`, or with `accept` for a merge of the release
   * branch only (`how: release_merge`, `parent`: the release commit merged), so the reviews of
   * `from` still hold for `to`.
   */
  moves: {
    from: string;
    to: string;
    touched: string[];
    accepted_by?: string;
    how?: "release_merge";
    parent?: string;
  }[];
  /** Reviewers to re-run because the last rebase touched files they flagged. */
  rereview: ReviewerRole[];
  /** The owner's answer to a `reviewers_disagree` decision, for the round it was asked in. */
  disagreement?: { round: number; answer: string; by?: string };
  /** Why the task is `blocked` (its stage_entered's `why`), while it is. */
  why?: string | undefined;
  /** Alarms raised on the task that still hold, by alarm name (alarm_cleared drops one). */
  alarms: Record<string, Record<string, unknown>>;
  /** The pipeline holds for CI on a role's pushed head (its latest `ci_pending`), until it settles. */
  ci_hold?: CiHold | undefined;
  /** The PR head moved after a gate (`pr_head_moved`), until the owner's answer. */
  moved?: MovedHead | undefined;
  /** A moved head answered `accept`, until the accept's verification moves the task's head there. */
  accepting?: string | undefined;
  /** Every head the task was gated at (evidence head history). */
  gated: string[];
  /** What the next fixup must do about a moved head (the CI failure, the diff), until it is verified. */
  directive?: Directive | undefined;
  /** The commit the task's PR merged as (its `artifact_verified { role: merged }`), once merged. */
  merged_sha?: string | null;
  /** The journal seq of that `artifact_verified { role: merged }`: who was cut before it. */
  merged_seq?: number;
  /** Merge nudges this task's implementers got, as `<agent_id>#<merged PR>` (one each). */
  nudged?: string[];
  /** Autopilot merges GitHub refused at the current gated head (`merge_refused` alarms). */
  merge_refusals?: number;
  /**
   * The reason of the last of those refusals (absent for one journaled before reasons were
   * recorded). Unlike `alarms.merge_refused`, a late refusal of an older head never sets it.
   */
  merge_refusal_reason?: RefusalReason | undefined;
  /** Extra attempts the owner granted (`merge_refused` answered `retry`). */
  merge_retries?: number;
  /** The owner answered a `merge_refused` decision `manual`: a human merges this task. */
  merge_manual?: boolean;
  /** When the task entered the merge queue (`merge_queued`), until it left it (`merge_dequeued`). */
  queued_at?: string | undefined;
  /** volleyd's `gh pr merge` for the task is running (`merge_started`, until its outcome). */
  merge_inflight?: boolean | undefined;
  /** A remediation requested for the task's red head (a flake's fixer), until the head moves on. */
  remediation?: Remediation | undefined;
  /**
   * A branch update that takes a landed flake fix (`stage_entered { fix_landed }`): `next`, the
   * flake stopped a step that still has steps after it; `gate`, it stopped a pre-gate update.
   */
  fix_resume?: "next" | "gate" | undefined;
}

/** A `remediation_requested` that still holds: a flake on `role`'s red `head` awaits its fixer. */
export interface Remediation {
  kind: "fix_flake";
  test: string;
  test_file: string | null;
  head: string;
  role: Role;
  since: string;
  /** Its fixer merged (`remediation_closed { outcome: landed }`): the next advance takes the fix. */
  landed?: true;
}

export interface MovedHead {
  from: string;
  to: string;
  during: TaskStage;
  /** Its pr_head_moved decision is open. */
  asked?: boolean;
}

/**
 * A fixup's directive: a moved head's (kept on the pr_head_moved decision as `directive`), or CI
 * failed on the pipeline's own head (`from` absent; journaled on the fixup's `stage_entered`).
 */
export interface Directive {
  /** The head the move started from; absent for a CI failure on the role's own head. */
  from?: string;
  to: string;
  ci: CiState;
  failed_jobs: string[];
  failing_tests: string[];
  log: string;
  diffstat: string;
  runs: CiRun[];
  /** Runs on `to` that a newer run of the same workflow and event replaced (evidence only). */
  superseded?: SupersededRun[];
  /** The owner chose `fixup`: the fixup works from this directive only (no review findings). */
  only?: boolean;
  /** The move merges a release-branch commit into `from` (probeMovedHead). */
  release_merge?: ReleaseMerge;
}

/** A `ci_pending` event's facts: whose head, how far its runs are, when it is checked again. */
export interface CiHold {
  /** The role whose pushed head is held; `moved` for a head pushed outside the pipeline. */
  role: Role | "moved";
  sha: string;
  checks: { done: number; total: number };
  next_poll_at: string;
  pr?: { number: number; url: string };
  /**
   * An infra incident hold (a red head classified `infra_incident`): what it is and since when.
   * `ci_unreadable`: GitHub's answer about the head's runs could not be read (`error`).
   */
  reason?: "infra_incident" | "ci_unreadable";
  incident?: string;
  since?: string;
  error?: string;
}

export type SteerReason = "artifacts" | "result" | "merge_nudge";

/**
 * What a pipeline decision is about; kept on the decision as `pipeline`. The single mechanism
 * by which a decision's answer reaches its consumer: every decision whose answer the pipeline
 * acts on carries one. Spawn-type decisions (spawn.ts: hooks_auth_failed, mcp_not_registered,
 * unknown_screen; the daemon's spawn_failed) carry `relaunch` / `spawn_failed` with the run they
 * are about (`wave`, `task`, `role`, `attempt`, `agent_id`).
 */
export interface PipelineMarker {
  on:
    | "verify"
    | "liveness"
    | "ci_failed"
    | "ci_none"
    | "review_result"
    | "fixup_result"
    | "agent_failed"
    | "agent_blocked"
    | "agent_blocked_ci"
    | "reviewers_disagree"
    | "merge_ready_invariant"
    | "relaunch"
    | "spawn_failed"
    | "pr_closed"
    | "pr_head_moved"
    | "merge_refused"
    | "merge_conflict";
  role?: Role;
  head?: string;
  /** ci_none on a rebase: the files it changed, for the re-review rule if the head is accepted. */
  touched?: string[];
  /** pr_head_moved: the head the gate saw (`head` is the one it moved to). */
  from?: string;
  /** Spawn-type decisions: the run they are about. */
  wave?: WaveId;
  task?: TaskId;
  attempt?: number;
  agent_id?: string;
}

/** Decisions whose `respawn` answer replaces the role's run (the next advance spawns it). */
const RESPAWNABLE: ReadonlySet<PipelineMarker["on"]> = new Set([
  "agent_failed",
  "review_result",
  "fixup_result",
]);

/** Answers are free text: only an exact option (case and surrounding space aside) counts. */
/** The answer volleyd closes a task's open decisions with when its PR is seen merged. */
export const SUPERSEDED_BY_MERGE = "superseded_by_merge";

export const isAnswer = (answer: string, option: string): boolean =>
  answer.trim().toLowerCase() === option;

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
  moves: [],
  rereview: [],
  alarms: {},
  gated: [],
});

const isRole = (r: unknown): r is Role =>
  typeof r === "string" && r !== "release" && r in ROLE_STAGE;

/** The pipeline at its implement step, keeping the implementer's run. */
function enterImplement(p: TaskPipeline, stages: PipelineStage[][]): void {
  const i = stages.findIndex((g) => g.includes("implement"));
  p.step = i >= 0 ? i : 0;
  p.roles = ["implementer"];
  p.rebasing = false;
  p.branch_update = undefined;
  p.conflicting = undefined;
}

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
        spawned_seq: ev.seq,
      };
      if (role === "implementer" && typeof d.branch === "string") p.branch = d.branch;
      // The implementer launched but the pipeline never started: spawn.ts journals
      // stage_entered { implement } only on attempt 1, so a task whose first launches failed
      // starts here (#409), as that event would have started it.
      if (role === "implementer" && p.step < 0) enterImplement(p, ctx.stages);
      break;
    case "stage_entered":
      p.why = typeof d.why === "string" ? d.why : undefined;
      if (Array.isArray(d.roles)) {
        // A flake's fix taken (landedFix), or a conflicting PR brought up to date (onVerified):
        // where the pipeline goes on once the update is verified. Read before p.rebasing is
        // overwritten below: a parked pre-gate update resumes at the gate.
        p.fix_resume =
          typeof d.fix_landed === "string" || d.conflicting === true
            ? p.rebasing
              ? "gate"
              : "next"
            : undefined;
        p.step = d.step as number;
        p.roles = (d.roles as unknown[]).filter(isRole);
        p.rebasing = d.rebase === true;
        p.branch_update = p.rebasing && d.branch_update === "merge" ? "merge" : undefined;
        p.conflicting = p.rebasing && d.conflicting === true ? true : undefined;
        p.rereview = [];
        if (typeof d.review_round === "number") p.round = d.review_round;
        if (typeof d.directive === "object" && d.directive !== null) ciFixupEntered(p, d);
        for (const r of p.roles) delete p.runs[r];
        p.remediation = undefined;
      } else if (d.stage === "implement") {
        // Journaled by the spawn itself, after its agent_spawned: keep that run.
        enterImplement(p, ctx.stages);
      }
      break;
    case "merge_queued":
      p.queued_at = ev.at;
      break;
    case "merge_dequeued":
      p.queued_at = undefined;
      break;
    case "merge_started":
      p.merge_inflight = true;
      break;
    case "merged_by_supervisor":
    case "merge_ended":
      p.merge_inflight = undefined;
      break;
    case "merge_nudge_sent":
      if (typeof d.agent_id === "string" && typeof d.merged_pr === "number")
        p.nudged = [...(p.nudged ?? []), `${d.agent_id}#${d.merged_pr}`];
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
      if (p.ci_hold?.role === role) p.ci_hold = undefined;
      if (p.remediation?.role === role) p.remediation = undefined;
      if (role === "merged") {
        // Where the release branch moved to; never the PR head (a squash or rebase merge is not it).
        const sha = [d.merge_sha, d.sha].find((x) => typeof x === "string");
        p.merged_sha = (sha as string | undefined) ?? null;
        p.merged_seq = ev.seq;
      }
      if (role === "gate" && typeof d.head_sha === "string") {
        p.gated = p.gated ?? [];
        if (p.gated.at(-1) !== d.head_sha) {
          p.gated.push(d.head_sha);
          // A new gated head: GitHub's refusals of the old one say nothing about it.
          p.merge_refusals = 0;
          p.merge_refusal_reason = undefined;
          p.merge_retries = 0;
        }
      }
      if (role === "fixup") p.directive = undefined;
      if (!isRole(role)) break;
      const run = p.runs[role];
      const from = p.head;
      if (run !== undefined) {
        run.accepted = true;
        if (PUBLISHING_ROLES.has(role) && typeof d.head_sha === "string") run.head = d.head_sha;
      }
      // A review of a head an accepted release merge already moved on from holds at the moved head
      // (reviewHolds): it does not take the task's head back (#270).
      if (typeof d.head_sha === "string" && !(isReviewerRole(role) && acceptedFrom(p, d.head_sha)))
        p.head = d.head_sha;
      // The accepted head reached, or the head went elsewhere first: either way the wait is over.
      if (p.head !== from) p.accepting = undefined;
      const pr = d.pr as { number: number; url: string; ci?: string } | undefined;
      // The merge record describes the commit that merged (its own CI): not the pipeline's head.
      if (pr !== undefined && d.role !== "merged") {
        p.pr = { number: pr.number, url: pr.url };
        p.ci = pr.ci === "none" ? "none" : "green";
      }
      if (Array.isArray(d.ci_runs)) {
        p.ci_runs = d.ci_runs as CiRun[];
        if (Array.isArray(d.ci_superseded)) p.ci_superseded = d.ci_superseded as SupersededRun[];
        else p.ci_superseded = undefined;
      }
      if (d.adopted === true) {
        // A head pushed outside the pipeline, re-verified: not another fixup or rebase.
        if (run !== undefined) run.adopt = false;
        if (from !== undefined && typeof d.head_sha === "string") {
          const touched = Array.isArray(d.touched) ? (d.touched as string[]) : [];
          // A pr_head_moved answered `accept`: the owner took a merge of the release branch.
          const mv = d.move as { how?: string; parent?: string; touched?: string[] } | undefined;
          const accepted = mv?.how === "release_merge" && typeof d.accepted_by === "string";
          p.moves.push({
            from,
            to: d.head_sha,
            touched: accepted ? (mv.touched ?? []) : touched,
            ...(accepted
              ? {
                  accepted_by: d.accepted_by as string,
                  how: "release_merge" as const,
                  ...(typeof mv.parent === "string" ? { parent: mv.parent } : {}),
                }
              : {}),
          });
        }
      } else if (isReviewerRole(role) && d.review !== undefined) {
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
          ...(d.result !== undefined
            ? { result: d.result as FixupResult }
            : run?.result !== undefined
              ? { result: run.result }
              : {}),
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
      // A spawn retry's `superseded` (superseded_by its next attempt) is not the run's end; a
      // merge's is (mergedActions).
      const replaced = d.status === "superseded" && d.superseded_by !== undefined;
      if (run !== undefined && run.agent_id === d.agent_id && !replaced) {
        run.retired = String(d.status);
        // The retained result goes with the retire: a fixup verified later (CI pending at its
        // done, a re-verify answer, an accepted no-CI head) still reports how it resolved things.
        const result = role === "fixup" ? parseFixupResult(d.result) : null;
        if (result !== null) run.result = result;
      }
      break;
    }
    case "relaunched":
      // The old agent is retired (the delete path ran first): the next advance spawns the role
      // at the next attempt. Only the run it names, never a newer one.
      if (isRole(role) && p.runs[role]?.agent_id === d.from_agent) delete p.runs[role];
      break;
    case "pr_head_moved":
      if (typeof d.from === "string" && typeof d.to === "string") {
        p.moved = { from: d.from, to: d.to, during: d.during as TaskStage };
        // The flake was on the old head: the new one is verified on its own.
        if (p.remediation?.head === d.from) p.remediation = undefined;
      }
      if (p.pr === undefined && typeof d.pr === "string" && typeof d.pr_number === "number")
        p.pr = { number: d.pr_number, url: d.pr };
      break;
    case "ci_pending":
      // CI is running (or held) again for the role: its head is not a parked flake any more, and
      // the hold's re-polls must not be skipped for a fixer.
      if (p.remediation?.role === role) p.remediation = undefined;
      if ((isRole(role) || role === "moved") && typeof d.sha === "string")
        p.ci_hold = {
          role,
          sha: d.sha,
          checks: d.checks as CiHold["checks"],
          next_poll_at: String(d.next_poll_at),
          ...(d.pr !== undefined ? { pr: d.pr as NonNullable<CiHold["pr"]> } : {}),
          ...(d.reason === "infra_incident"
            ? {
                reason: "infra_incident" as const,
                ...(typeof d.incident === "string" ? { incident: d.incident } : {}),
                ...(typeof d.since === "string" ? { since: d.since } : {}),
              }
            : {}),
          ...(d.reason === "ci_unreadable"
            ? { reason: "ci_unreadable" as const, error: String(d.error ?? "") }
            : {}),
        };
      break;
    case "pr_conflicting": {
      // GitHub runs no CI on the head: no hold. The update step starts from it (never verified).
      p.ci_hold = undefined;
      // A fixup's head is still its fixup: the reviews it fixed hold through the update after it.
      const run = role === "fixup" ? p.runs.fixup : undefined;
      if (run !== undefined && typeof d.head === "string")
        p.fixups.push({
          round: p.round,
          ...(run.start !== undefined ? { from: run.start } : {}),
          to: d.head,
          ...(run.result !== undefined ? { result: run.result } : {}),
          ...(run.worktree !== undefined ? { worktree: run.worktree } : {}),
        });
      if (typeof d.head === "string") p.head = d.head;
      if (p.pr === undefined && typeof d.pr === "object" && d.pr !== null)
        p.pr = d.pr as { number: number; url: string };
      break;
    }
    case "remediation_requested":
      if (d.kind === "fix_flake" && isRole(role) && typeof d.head === "string")
        p.remediation = {
          kind: "fix_flake",
          test: String(d.test),
          test_file: typeof d.test_file === "string" ? d.test_file : null,
          head: d.head,
          role,
          since: ev.at,
        };
      break;
    case "ci_green":
    case "decision_opened":
    case "task_cancelled":
      // Settled, or someone is asked about it: the hold is over.
      p.ci_hold = undefined;
      if (ev.type === "task_cancelled") {
        p.moved = undefined;
        p.accepting = undefined;
        p.remediation = undefined;
        p.merge_inflight = undefined;
      }
      if (
        ev.type === "decision_opened" &&
        p.moved !== undefined &&
        (d.pipeline as PipelineMarker | undefined)?.on === "pr_head_moved"
      )
        p.moved.asked = true;
      break;
    case "alarm_cleared":
      if (typeof d.alarm === "string" && p.alarms !== undefined) delete p.alarms[d.alarm];
      break;
    case "alarm_raised": {
      if (typeof d.alarm === "string") p.alarms = { ...p.alarms, [d.alarm]: d };
      // Only a refusal of the current gated head counts: a late one for an older head says nothing.
      if (d.alarm === "merge_refused" && d.head === p.gated?.at(-1)) {
        p.merge_refusals = (p.merge_refusals ?? 0) + 1;
        p.merge_refusal_reason = isRefusalReason(d.reason) ? d.reason : undefined;
      }
      // volleyd's merge ended without merging (refused, or `gh` could not run).
      if (d.alarm === "merge_refused" || (d.alarm === "pipeline_error" && d.check === "merge"))
        p.merge_inflight = undefined;
      // The PR is no longer at the verified head: that role's acceptance no longer holds.
      const run = d.alarm === "pr_head_moved" && isRole(role) ? p.runs[role] : undefined;
      if (run !== undefined) {
        run.accepted = false;
        run.adopt = true;
      }
      break;
    }
    case "decision_resolved": {
      const m = (ctx.decision as { pipeline?: PipelineMarker } | undefined)?.pipeline;
      const answer = String(d.answer ?? "");
      if (m?.on === "merge_refused" && isAnswer(answer, "retry"))
        p.merge_retries = (p.merge_retries ?? 0) + 1;
      if ((m?.on === "merge_refused" || m?.on === "merge_conflict") && isAnswer(answer, "manual"))
        p.merge_manual = true;
      if (m?.on === "reviewers_disagree")
        p.disagreement = {
          round: p.round,
          answer,
          ...(typeof d.by === "string" ? { by: d.by } : {}),
        };
      // A respawn replaces the run; advance spawns the role again (and retries a held spawn).
      // `respawn on <machine>` (F6) too: the daemon re-placed the task there first.
      if (
        m !== undefined &&
        RESPAWNABLE.has(m.on) &&
        isRole(m.role) &&
        isRespawnAnswer(answer, ctx.decision?.options ?? [])
      )
        delete p.runs[m.role];
      if (m?.on === "pr_head_moved" && p.moved !== undefined && m.head === p.moved.to) {
        const fixup = isAnswer(answer, "fixup");
        // Only an answer the decision offered (onResolved re-asks any other): a rereview of a
        // red head with no fixup stage after it is not offered, and leaves the move to answer.
        const offered = (ctx.decision?.options ?? []).includes("rereview");
        if (fixup || (offered && isAnswer(answer, "rereview"))) {
          const dir = (ctx.decision as { directive?: Directive } | undefined)?.directive;
          p.moves.push({
            from: p.moved.from,
            to: p.moved.to,
            touched: [],
            ...(fixup && typeof d.by === "string" ? { accepted_by: d.by } : {}),
          });
          p.head = p.moved.to;
          if (dir !== undefined) {
            p.directive = { ...dir, ...(fixup ? { only: true } : {}) };
            p.ci = dir.ci === "none" ? "none" : "green";
            p.ci_runs = dir.runs;
            p.ci_superseded = dir.superseded;
          }
          p.moved = undefined;
        } else if (isAnswer(answer, "cancel")) p.moved = undefined;
        else if (isAnswer(answer, "accept") && (ctx.decision?.options ?? []).includes("accept")) {
          // accept: the head moves with the artifact_verified onResolved journals next.
          p.accepting = p.moved.to;
          p.moved = undefined;
        }
      }
      break;
    }
  }
  return p;
}

/**
 * A CI fixup's `stage_entered` (`directive`, `red`: the role whose head CI failed and where its
 * run started): the red head becomes the task's head, and a fixup or rebase head is chained like
 * an accepted one, so the reviews the red head descends from still hold (mergeReadyCheck).
 */
function ciFixupEntered(p: TaskPipeline, d: Record<string, unknown>): void {
  const dir = d.directive as Directive;
  const red = d.red as { role?: unknown; from?: unknown; touched?: unknown } | undefined;
  const from = typeof red?.from === "string" ? red.from : undefined;
  if (from !== undefined && red?.role === "fixup") {
    const result = p.runs.fixup?.result;
    p.fixups.push({
      round: p.round,
      from,
      to: dir.to,
      ...(result !== undefined ? { result } : {}),
      ...(p.runs.fixup?.worktree !== undefined ? { worktree: p.runs.fixup.worktree } : {}),
    });
  } else if (from !== undefined && red?.role === "rebase") {
    const touched = Array.isArray(red.touched) ? (red.touched as string[]) : [];
    p.rebases.push({ from, to: dir.to, touched });
  }
  p.directive = dir;
  p.head = dir.to;
  const pr = d.pr as { number?: unknown; url?: unknown } | undefined;
  if (p.pr === undefined && typeof pr?.number === "number" && typeof pr.url === "string")
    p.pr = { number: pr.number, url: pr.url };
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
  /** The `branch_update` tunable now (absent: rebase): read when a rebase step starts. */
  branch_update?: BranchUpdate;
  /** How review results treat public hygiene (absent: p1): reviews.ts parseReviewResult. */
  hygiene?: HygieneLevel;
  /** The wave's effective merge mode for this task (absent: manual, a human merges). */
  merge?: "auto" | "manual";
  /** The gate's MergeToken for the current head (process-local: kept on the driver). */
  merge_token?: MergeToken;
  /** `autopilot.merge_retry_max`: refusals before the owner is asked (absent: the default). */
  merge_retry_max?: number;
  /** `autopilot.incident_wait_max_s`: how long an infra incident is waited out (absent: the default). */
  incident_wait_max_s?: number;
  /**
   * The task holds its release branch's merge turn (the merge queue, driver-local): `check` while
   * it is checked against (or brought up to date with) the release branch, `go` once it is gated
   * up to date with a MergeToken. Only `go` merges.
   */
  merge_turn?: "check" | "go";
  /**
   * When volleyd last heard from an agent in a way that shows a spawn decision of `kind` is moot
   * (epoch ms; null: never): `it's running` checks it against the decision's `opened_at` (#402).
   */
  heard_from?: (agent_id: string, kind: DecisionKind) => number | null;
  /** Now (epoch ms), for how long ago that was. */
  now?: number;
}

/** A blocked agent's status, while its red PR head is classified (onBlocked). */
export interface BlockedStatus {
  reason: string;
  payload: unknown;
  /** The status envelope's `wall_time`. */
  status_at?: string;
}

/** A verification report that found the PR (`ok`). */
export type OkReport = Extract<ArtifactReport, { kind: "ok" }>;

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
      /** Why a `failed` one ended, when the daemon stopped it (F6: its machine is being removed). */
      why?: string;
    }
  /**
   * A role's agent published `blocked` (SPEC §5.1): it may stay alive awaiting guidance (§5.2), so
   * nothing is retired. `reason` is `blockedReason(payload)`; `payload` the status payload.
   */
  | {
      kind: "agent_blocked";
      role: Role;
      agent_id: string;
      reason: string;
      payload: unknown;
      /** The status envelope's `wall_time`: kept on the decision (a re-delivery is not re-asked). */
      at?: string;
    }
  /** Artifacts verified for `role`'s run `agent_id`; `waited_ms`: how long this head has had no CI run. */
  | {
      kind: "verified";
      role: Role;
      agent_id: string;
      report: ArtifactReport;
      result?: FixupResult;
      waited_ms?: number;
      /** When the check ran (epoch ms on the driver's clock): the next one is a ci_poll_ms on. */
      at?: number;
    }
  /** Before the gate: the release branch checked at `head`; `diffstats` per fixup `from..to`. */
  | { kind: "rebase_checked"; head: string; check: RebaseCheck; diffstats: Record<string, string> }
  /** Before the gate: the PR's head is not the verified one (someone pushed after it). */
  | { kind: "head_moved"; expected: string; actual: string }
  /** At the gate: the PR as `gh pr view` reports it (`merged_ci`: CI of a head other than the gated one). */
  | { kind: "merge_checked"; view: PrView; merged_ci?: MergedCi }
  /** At the gate, the PR closed unmerged: did `head` land on the release branch anyway? */
  | { kind: "landed_checked"; head: string; landed: Landed | null; merged_ci?: MergedCi }
  /** At a review gate: the PR's head as GitHub has it now (`expected`: the head when asked). */
  | { kind: "pr_head"; head: string; expected: string }
  /** The moved head's CI (and, settled, the facts the pr_head_moved decision carries). */
  | {
      kind: "moved_ci";
      to: string;
      facts: MovedHeadFacts;
      pr: { number: number; url: string };
      at: number;
      waited_ms: number;
    }
  /** `volleyd merged --sha`: the owner's merge outside GitHub, verified (verifyOperatorMerge). */
  /** `head`: the gated head the merge was verified against (stale if the task's head moved since). */
  | {
      kind: "operator_merged";
      sha: string;
      by: string;
      how: string;
      head: string;
      merged_ci?: MergedCi;
    }
  /** A pipeline git / gh check failed (`timed_out`: the hard timeout fired). */
  | {
      kind: "io_failed";
      what:
        | "verify"
        | "check_rebase"
        | "check_merged"
        | "watch_head"
        | "check_landed"
        | "moved_ci"
        | "merge"
        | "classify";
      role?: Role;
      agent_id?: string;
      message: string;
      timed_out: boolean;
    }
  | { kind: "decision_resolved"; decision: DecisionRecord }
  /**
   * A red head classified (ci-classify.ts): `report` is the red head's (null: a blocked agent's PR
   * head is not red, or has no PR, and `result` is null too); `blocked`, for a blocked agent's.
   */
  | {
      kind: "ci_classified";
      role: Role;
      agent_id: string;
      report: OkReport | null;
      result: ClassifyResult | null;
      at: number;
      blocked?: BlockedStatus;
    }
  /**
   * Autopilot merging: GitHub merged `head` (the token's) as `sha` (null: not read back); `by`:
   * the owner who asked for it (`volleyd merge`), absent for the merge queue's own merge.
   */
  | { kind: "supervisor_merged"; sha: string | null; head: string; by?: string }
  /** Autopilot merging: `gh pr merge` exited non-zero for `head` (moved, checks, protection). */
  | { kind: "merge_refused"; stderr: string; head: string; reason?: RefusalReason }
  /**
   * Self-healing CI (SPEC §4.6.16): the fixer of the flake `test` merged and released the task
   * (`remediation_closed`): it takes the fix from the release branch and is verified again.
   */
  | { kind: "fix_landed"; test: string };

/** CI on a merged head that is not the gated one; `unknown` when it could not be read. */
export type MergedCi = CiState;

export interface PrView {
  state?: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  baseRefName?: string;
  headRefOid?: string | null;
}

export interface SpawnStart {
  /** The commit the role's worktree is cut from. */
  ref: string;
  /** Detached HEAD (reviewers: read-only), else a fresh branch from `ref`. */
  detach: boolean;
}

export type PipelineAction =
  | { kind: "journal"; event: NewEvent }
  | {
      kind: "spawn";
      role: Role;
      start?: SpawnStart;
      files: Record<string, string>;
      branch_update?: "merge";
    }
  | { kind: "verify"; role: Role; result?: FixupResult }
  /**
   * Classify a red head before anyone is asked: the PR's files, the release branch's CI, GitHub's
   * status page (`report`: the red verification; `blocked`: a blocked agent's, whose PR head the
   * driver reads itself).
   */
  | {
      kind: "classify_ci";
      role: Role;
      agent_id: string;
      report?: OkReport;
      blocked?: BlockedStatus;
    }
  /** Journal an alarm once per driver (`key`): repeats of the same condition stay quiet. */
  | { kind: "alarm"; key: string; event: NewEvent }
  | { kind: "steer"; role: Role; agent_id: string; reason: SteerReason; text: string }
  | {
      kind: "decide";
      decision: DecisionInput;
      marker: PipelineMarker;
      data?: Record<string, unknown>;
    }
  /** Retire an agent; `status` is a DAEMON_ENDED one for an agent that never ended itself. */
  | { kind: "retire"; agent_id: string; status?: string }
  /** Replace `agent_id` (a spawn decision's run): retire it, journal `relaunched`. */
  | { kind: "relaunch"; role: Role; agent_id: string }
  | { kind: "check_rebase" }
  /** At the gate: has the PR merged (by a human, or GitHub after a refused autopilot merge)? */
  | { kind: "check_merged" }
  /** Autopilot merging: merge the gated PR at exactly the token's head (src/autopilot/merge.ts). */
  | { kind: "merge"; token: MergeToken }
  /** The PR closed unmerged: look for its head on the release branch (read-only git). */
  | { kind: "check_landed" }
  /** At a review gate: read the PR's head (rate-limited to ci_poll_ms). */
  | { kind: "watch_head" }
  /** The PR head moved: CI on the new head, its failures and the diff (rate-limited). */
  | { kind: "check_moved_ci" }
  /** The PR head moved after the gate: mark the evidence package stale. */
  | { kind: "evidence_stale"; from: string; to: string }
  /** The task's PR merged: nudge the wave's running implementers it overlaps (SPEC §4.6.15). */
  | { kind: "merge_nudge" }
  | { kind: "gate"; check: RebaseCheck; diffstats: Record<string, string> };

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
    case "agent_blocked":
      return onBlocked(v, ev);
    case "verified":
      return onVerified(v, ev);
    case "rebase_checked":
      // Merged meanwhile (`volleyd merge` during the merge turn's check): nothing to update.
      if (v.stage === "cancelled" || v.stage === "done" || ev.head !== v.p.head) return [];
      // Gated already: only the task holding the merge turn is checked again, so it merges up to
      // date with the release branch (re-gated, which re-mints a token a restart lost), or is
      // brought up to date first (a release branch that moved is rebased onto).
      if (v.stage === "merge_ready" && v.merge_turn === undefined) return [];
      return ev.check.behind === 0 ? guardedGate(v, ev) : enterRebase(v);
    case "head_moved":
      return onHeadMoved(v, ev);
    case "merge_checked":
      return onMergeChecked(v, ev);
    case "landed_checked":
      return onLandedChecked(v, ev);
    case "pr_head":
      return ev.expected === v.p.head ? onPrHead(v, ev.head) : [];
    case "moved_ci":
      return onMovedCi(v, ev);
    case "operator_merged":
      return onOperatorMerged(v, ev);
    case "io_failed":
      return onIoFailed(v, ev);
    case "decision_resolved":
      return onResolved(v, ev.decision);
    case "ci_classified":
      return onClassified(v, ev);
    case "supervisor_merged":
      return onSupervisorMerged(v, ev);
    case "merge_refused":
      return onMergeRefused(v, ev);
    case "fix_landed":
      // Its parked flake is this test's: the next advance takes the fix (landedFix).
      return v.p.remediation?.test === ev.test ? advance(v) : [];
  }
}

/** The outcome of the merge_ready invariant for a task (`mergeReadyCheck`). */
export type MergeReadyCheck =
  | { ok: true; skippedByPlan: boolean }
  | { ok: false; head?: string; missing: ReviewerRole[]; stale: ReviewerRole[] };

/**
 * The merge_ready invariant: every reviewer role in the task's pipeline has a stored review with
 * a verdict that holds for the current head — a review of the head itself, or of a head the
 * current one descends from only through fixups that worked from that review's round or later
 * (they ran after it), rebases, and heads pushed outside the pipeline that the owner accepted
 * without a re-review (a `pr_head_moved` answered `fixup`, or `accept` for a merge of the release
 * branch only: `moves[].accepted_by`, kept in the evidence; SPEC §4.6.8). Any other outside
 * push (`moves`) was reviewed by nobody. A pipeline without review stages passes, as
 * `skippedByPlan`: the wave file said so.
 */
export function mergeReadyCheck(stages: PipelineStage[][], p: TaskPipeline): MergeReadyCheck {
  const planned = REVIEWER_ROLES.filter((r) =>
    stages.some((g) => g.some((s) => STAGE_ROLE[s] === r)),
  );
  if (planned.length === 0) return { ok: true, skippedByPlan: true };
  const missing = planned.filter((r) => p.reviews[r]?.result.verdict === undefined);
  const stale = planned.filter((r) => {
    const rv = p.reviews[r];
    return rv?.result.verdict !== undefined && !reviewHolds(p, rv);
  });
  if (p.head === undefined || missing.length > 0 || stale.length > 0)
    return { ok: false, ...(p.head !== undefined ? { head: p.head } : {}), missing, stale };
  return { ok: true, skippedByPlan: false };
}

/** Does `rv` still hold at the current head (see mergeReadyCheck)? */
function reviewHolds(p: TaskPipeline, rv: StoredReview): boolean {
  const seen = new Set<string>();
  let head = p.head;
  while (head !== undefined && !seen.has(head)) {
    if (head === rv.head) return true;
    seen.add(head);
    const to = head;
    const fixup = p.fixups.find((f) => f.to === to && f.round >= rv.round);
    head =
      fixup?.from ??
      p.rebases.find((r) => r.to === to)?.from ??
      // A head moved outside the pipeline that the owner sent straight to a fixup, or accepted as
      // a merge of the release branch only (SPEC §4.6.8: a merge of it keeps the reviews).
      p.moves.find((m) => m.to === to && m.accepted_by !== undefined)?.from;
  }
  return false;
}

/** Did the current head get here from `sha` through moves accepted as release merges only? */
function acceptedFrom(p: TaskPipeline, sha: string): boolean {
  const seen = new Set<string>();
  let head = p.head;
  while (head !== undefined && !seen.has(head)) {
    seen.add(head);
    const to = head;
    head = p.moves.find(
      (m) => m.to === to && m.how === "release_merge" && m.accepted_by !== undefined,
    )?.from;
    if (head === sha) return true;
  }
  return false;
}

/**
 * A merge_ready invariant violation: an alarm, and a decision for the owner (`rereview` runs the
 * missing / stale reviewers at the current head; `cancel`). Never a gate: volleyd never gates
 * around a missing review. A task already parked on a decision gets the alarm only.
 */
function invariantViolation(
  v: PipelineView,
  c: Extract<MergeReadyCheck, { ok: false }>,
): PipelineAction[] {
  const alarm: PipelineAction = {
    kind: "alarm",
    key: `${v.task}/merge_ready_invariant/${v.p.head}`,
    event: {
      type: "alarm_raised",
      task: v.task,
      data: {
        alarm: "merge_ready_invariant",
        ...(c.head !== undefined ? { head: c.head } : {}),
        missing: c.missing,
        stale: c.stale,
      },
    },
  };
  if (v.stage === "awaiting_decision") return [alarm];
  const at = c.head !== undefined ? c.head.slice(0, 12) : "no verified head";
  const why = [
    ...(c.missing.length > 0 ? [`no review from ${c.missing.join(", ")}`] : []),
    ...(c.stale.length > 0 ? [`${c.stale.join(", ")} reviewed an older head`] : []),
  ].join("; ");
  return [
    alarm,
    {
      kind: "decide",
      marker: { on: "merge_ready_invariant", ...(c.head !== undefined ? { head: c.head } : {}) },
      decision: {
        kind: "agent_blocked",
        task: v.task,
        question: `merge_ready is blocked at ${at}: ${why} (e.g. a push outside the pipeline). rereview: run those reviewers at the current head; or cancel the task?`,
        ...(v.p.pr !== undefined ? { pointers: { pr: v.p.pr.url } } : {}),
        options: ["rereview", "cancel"],
      },
    },
  ];
}

/** The end of the pipeline: the rebase check and gate when the invariant holds (no polling else). */
function toGate(v: PipelineView): PipelineAction[] {
  const c = mergeReadyCheck(v.stages, v.p);
  return c.ok ? [{ kind: "check_rebase" }] : invariantViolation(v, c);
}

/** The gate, behind the merge_ready invariant (see invariantViolation). */
function guardedGate(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "rebase_checked" }>,
): PipelineAction[] {
  const gate: PipelineAction = { kind: "gate", check: ev.check, diffstats: ev.diffstats };
  const c = mergeReadyCheck(v.stages, v.p);
  if (!c.ok) return invariantViolation(v, c);
  if (!c.skippedByPlan) return [gate];
  return [
    {
      kind: "alarm",
      key: `${v.task}/reviews_skipped_by_plan`,
      event: { type: "alarm_raised", task: v.task, data: { alarm: "reviews_skipped_by_plan" } },
    },
    gate,
  ];
}

/** The publishing role whose verification produced the current head. */
export function headRole(p: TaskPipeline): Role | undefined {
  return [...PUBLISHING_ROLES].find(
    (r) => p.runs[r]?.accepted === true && p.runs[r]?.head === p.head,
  );
}

function onHeadMoved(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "head_moved" }>,
): PipelineAction[] {
  const role = headRole(v.p);
  if (v.stage === "cancelled" || v.stage === "merge_ready" || ev.expected !== v.p.head) return [];
  // The gate's head check saw this move first (pr_head_moved): its decision, asked or answered
  // `accept`, handles it. A plain re-verify here would land before the accept's and record the
  // move as one that voids the reviews (#271).
  // An accept whose verification never lands leaves `accepting` set; the merge check's own
  // p.head comparison still sees that head, so nothing is lost.
  if (role === undefined || v.p.moved !== undefined || v.p.accepting === ev.actual) return [];
  return [
    {
      kind: "journal",
      event: {
        type: "alarm_raised",
        task: v.task,
        data: { alarm: "pr_head_moved", role, expected: ev.expected, actual: ev.actual },
      },
    },
    { kind: "verify", role },
  ];
}

function onMergeChecked(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "merge_checked" }>,
): PipelineAction[] {
  const { view } = ev;
  const { pr, head } = v.p;
  if (v.stage === "done" || v.stage === "cancelled" || pr === undefined) return [];
  // A human merged the PR, in whatever stage the task is (its open decisions were closed first).
  if (view.state === "MERGED" && view.baseRefName === v.release_branch) {
    const merged = typeof view.headRefOid === "string" ? view.headRefOid : undefined;
    // Not through the gate: merged at another head, or before the task was gated at it. A merge at
    // the current gated head while a later step runs (a branch update or fixup that has not
    // pushed, or a task the owner sent back to verify again at that head) is verified (#311).
    const other = merged !== undefined && merged !== head;
    const atGated = head !== undefined && v.p.gated.at(-1) === head;
    // Off merge_ready the merged head must be read as the gated one: a branch update's agent may
    // have pushed and merged a head volleyd has not seen yet.
    const unverified = other || (v.stage !== "merge_ready" && !(atGated && merged === head));
    return [
      ...(unverified
        ? [
            {
              kind: "journal" as const,
              event: {
                type: "alarm_raised" as const,
                task: v.task,
                data: {
                  alarm: "merged_unverified_head",
                  pr: pr.url,
                  gated: head ?? null,
                  merged,
                },
              },
            },
          ]
        : []),
      ...mergedActions(
        v,
        { merge_sha: view.mergeCommit?.oid ?? null, merged_at: view.mergedAt ?? null },
        other ? { sha: merged, ci: ev.merged_ci ?? "unknown" } : undefined,
      ),
    ];
  }
  if (v.stage !== "merge_ready") return [];
  // Closed unmerged on GitHub — but a local squash + push closes it that way too.
  if (view.state === "CLOSED") return [{ kind: "check_landed" }];
  // Still open, at another head than the gate saw (e.g. the release branch merged into it).
  if (typeof view.headRefOid === "string" && head !== undefined && view.headRefOid !== head)
    return headMovedAtGate(v, view.headRefOid);
  // Open at the gated head, and GitHub refused every autopilot merge allowed: the owner decides.
  return mergeExhausted(v) ? mergeRefusedDecision(v) : [];
}

// --- Autopilot merging (SPEC §4.6.17) ---

/** volleyd merges this task itself: `merge: auto` and the owner did not take it back. */
const autoMergeOn = (v: PipelineView): boolean =>
  v.merge === "auto" && v.p.merge_manual !== true && v.p.head !== undefined;

/** Refusals allowed at this gated head before the owner is asked (retries add one each). */
const mergeAttempts = (v: PipelineView): number =>
  (v.merge_retry_max ?? CONFIG_DEFAULTS.autopilot.merge_retry_max) + (v.p.merge_retries ?? 0);

const mergeExhausted = (v: PipelineView): boolean =>
  autoMergeOn(v) && (v.p.merge_refusals ?? 0) >= mergeAttempts(v);

/** At merge_ready under `merge: auto` with no MergeToken for the head: the gate re-mints it. */
function remintWanted(v: PipelineView): boolean {
  const t = v.merge_token;
  return (
    autoMergeOn(v) &&
    !mergeExhausted(v) &&
    (t === undefined || t.head !== v.p.head || t.pr !== v.p.pr?.number)
  );
}

/**
 * The merge verb at the gate: only for the task the merge queue gave the turn, once its turn's
 * rebase check found it up to date and the gate (re-)minted its token.
 */
function autoMerge(v: PipelineView): PipelineAction[] {
  if (v.merge_turn !== "go" || !autoMergeOn(v) || mergeExhausted(v) || remintWanted(v)) return [];
  return [{ kind: "merge", token: v.merge_token as MergeToken }];
}

/** GitHub merged the gated head for volleyd: journaled as merged_by_supervisor, then merged. */
function onSupervisorMerged(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "supervisor_merged" }>,
): PipelineAction[] {
  const { pr, head } = v.p;
  if (v.stage === "done" || v.stage === "cancelled" || pr === undefined || ev.head !== head)
    return [];
  return [
    {
      kind: "journal",
      event: {
        type: "merged_by_supervisor",
        task: v.task,
        data: {
          task: v.task,
          pr: pr.number,
          head,
          merge_sha: ev.sha,
          by: "volleyd",
          ...(ev.by !== undefined ? { requested_by: ev.by } : {}),
        },
      },
    },
    ...mergedActions(v, { via: "supervisor", merge_sha: ev.sha }),
  ];
}

/**
 * GitHub refused the merge (`gh` exit ≠ 0): alarmed, and the PR read at once as today (someone
 * else may have merged it, or its head moved); that read asks the owner once the refusals reach
 * `autopilot.merge_retry_max` (onMergeChecked). Never forced.
 */
function onMergeRefused(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "merge_refused" }>,
): PipelineAction[] {
  const pr = v.p.pr;
  if (v.stage === "done" || v.stage === "cancelled" || pr === undefined) return [];
  return [
    {
      kind: "journal",
      event: {
        type: "alarm_raised",
        task: v.task,
        data: {
          alarm: "merge_refused",
          pr: pr.url,
          head: ev.head,
          stderr: ev.stderr,
          // Absent: refusalEndsTurn reads it as `behind`, like a refusal journaled before reasons.
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          attempt: (v.p.merge_refusals ?? 0) + 1,
        },
      },
    },
    { kind: "check_merged" },
  ];
}

function mergeRefusedDecision(v: PipelineView): PipelineAction[] {
  const pr = v.p.pr;
  const head = v.p.head;
  if (pr === undefined || head === undefined) return [];
  const last = String(v.p.alarms?.merge_refused?.stderr ?? "").slice(
    0,
    DAEMON_DEFAULTS.decision_output_chars,
  );
  const why = `GitHub refused to merge PR #${pr.number} at ${head.slice(0, 12)} ${v.p.merge_refusals ?? 0} time(s)${last !== "" ? ` (last: ${last})` : ""}`;
  return [
    // Escalated: the task leaves the gate (a decision cannot park a gated task) until answered.
    {
      kind: "journal",
      event: { type: "stage_entered", task: v.task, data: { stage: "blocked", why } },
    },
    {
      kind: "decide",
      marker: { on: "merge_refused", head },
      decision: {
        kind: "merge_refused",
        task: v.task,
        question: `${why}. retry: try the merge once more; manual: a human merges this PR (volleyd waits at the gate); or cancel the task?`,
        pointers: { pr: pr.url },
        options: ["retry", "manual", "cancel"],
      },
    },
  ];
}

/** Stages in which the PR head is watched for pushes outside the pipeline (merge_ready aside). */
const WATCHED: ReadonlySet<TaskStage> = new Set(["spec_review", "quality_review"]);

/** At a review gate, GitHub reports the PR at `head`. */
function onPrHead(v: PipelineView, head: string): PipelineAction[] {
  const { p } = v;
  if (p.moved !== undefined || p.head === undefined || head === p.head || !WATCHED.has(v.stage))
    return [];
  // A role of this step is publishing (its push is the pipeline's own): not a move.
  if (p.roles.some((r) => PUBLISHING_ROLES.has(r))) return [];
  return headMovedAtGate(v, head);
}

/**
 * The PR head moved to `to` while the task sat at a gate: journal it, invalidate the gate (at
 * merge_ready the task leaves it and its evidence is stale; nothing downstream is admitted), then
 * the CI on the new head is awaited before the owner is asked (movedAdvance).
 */
function headMovedAtGate(
  v: PipelineView,
  to: string,
  from = v.p.head as string,
  heldPr?: { number: number; url: string },
): PipelineAction[] {
  const gate = v.stage === "merge_ready";
  const pr = v.p.pr ?? heldPr;
  return [
    {
      kind: "journal",
      event: {
        type: "pr_head_moved",
        task: v.task,
        data: {
          from,
          to,
          during: v.stage,
          ...(pr !== undefined ? { pr: pr.url } : {}),
          // A move in the implementer's CI hold: the PR the hold was on (none verified yet).
          ...(v.p.pr === undefined && pr !== undefined ? { pr_number: pr.number } : {}),
        },
      },
    },
    ...(gate
      ? [
          { kind: "evidence_stale" as const, from, to },
          {
            kind: "journal" as const,
            event: {
              type: "stage_entered" as const,
              task: v.task,
              data: { stage: "fixup", gate_invalidated: true, from, to },
            },
          },
        ]
      : []),
  ];
}

/** While a moved head's decision is not asked yet: keep checking CI on it. */
function movedAdvance(v: PipelineView): PipelineAction[] {
  return v.p.moved?.asked === true ? [] : [{ kind: "check_moved_ci" }];
}

/** The reviewer roles the task's pipeline plans, and the first group that runs them. */
function reviewStep(stages: PipelineStage[][]): { i: number; roles: Role[] } | null {
  const i = stages.findIndex((g) => g.some((s) => isReviewerRole(STAGE_ROLE[s] as Role)));
  if (i < 0) return null;
  const roles = (stages[i] ?? []).flatMap((s) => {
    const r = STAGE_ROLE[s];
    return r !== undefined && isReviewerRole(r) ? [r] : [];
  });
  return { i, roles };
}

/** CI on the moved head: still running → visible hold; settled → the pr_head_moved decision. */
function onMovedCi(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "moved_ci" }>,
): PipelineAction[] {
  const m = v.p.moved;
  if (m === undefined || m.to !== ev.to || m.asked === true) return [];
  const ci = ev.facts.ci;
  // Unreadable CI (`unknown`) is re-polled like running CI: never a decision.
  const waiting =
    ci.state === "running" ||
    ci.state === "unknown" ||
    (ci.state === "none" && ev.waited_ms < DAEMON_DEFAULTS.ci_none_grace_ms);
  if (waiting)
    return holdFor(
      v,
      "moved",
      ev.to,
      ci.runs,
      ev.pr,
      ev.at,
      ci.state === "unknown" ? (ci.error ?? "") : undefined,
    );
  const at = (x: string) => x.slice(0, 7);
  const failure =
    ci.state === "red"
      ? ` — failed jobs: ${ci.failed_jobs.join(", ") || "(no job details)"}; failing tests: ${ci.failing_tests.join(", ") || "(none found in the logs)"}`
      : "";
  // A red head only reaches the gate through a fixup: rereview needs a fixup stage after it.
  const hasFixup = v.stages.some((g) => g.includes("fixup"));
  const review = ci.state === "red" && !hasFixup ? null : reviewStep(v.stages);
  const merge = ev.facts.release_merge;
  // A green merge of the release branch only keeps the reviews: the owner may take it as it is.
  const acceptable = ci.state === "green" && merge?.only_release === true;
  const directive: Directive = {
    from: m.from,
    to: m.to,
    ci: ci.state,
    failed_jobs: ci.failed_jobs,
    failing_tests: ci.failing_tests,
    log: ev.facts.log,
    diffstat: ev.facts.diffstat,
    runs: ci.runs,
    ...(ci.superseded.length > 0 ? { superseded: ci.superseded } : {}),
    ...(merge !== undefined ? { release_merge: merge } : {}),
  };
  const accept = acceptable
    ? `accept: the move is a merge of ${v.release_branch} only (files: ${merge.moved_files.join(", ") || "none"}; they may carry content resolved by hand, which no reviewer saw), so the reviews of ${at(m.from)} hold; the gate again at ${at(m.to)}; `
    : "";
  return [
    {
      kind: "decide",
      marker: { on: "pr_head_moved", head: m.to, from: m.from },
      decision: {
        kind: "pr_head_moved",
        task: v.task,
        question: `PR #${ev.pr.number}'s head moved from ${at(m.from)} to ${at(m.to)} outside the pipeline (during ${m.during}); CI on ${at(m.to)} is ${ci.state}${failure}. The reviews saw ${at(m.from)}. ${review !== null ? "rereview: the reviewers again on the new head, then the fixup and the gate; " : ""}fixup: a fixup agent on ${at(m.to)} with the CI result and the ${at(m.from)}..${at(m.to)} diff as its directive, then the gate; ${accept}or cancel?`,
        pointers: { pr: ev.pr.url },
        options: [
          ...(review !== null ? ["rereview"] : []),
          "fixup",
          ...(acceptable ? ["accept"] : []),
          "cancel",
        ],
      },
      data: {
        from: m.from,
        to: m.to,
        ci: ci.state,
        failed_jobs: ci.failed_jobs,
        failing_tests: ci.failing_tests,
        run_urls: ci.runs.map((r) => r.url),
        directive,
      },
    },
  ];
}

/**
 * The task is merged: its PR's head is on the release branch (`extra`: how it is known). Any
 * alarm that said otherwise (`pr_closed_unmerged`) is cleared; dependents follow `done`. When
 * the commit that merged is not the gated head (`merged`), the record — and the task's PR —
 * describe that commit and its own CI (`unknown`: not read), never the gated head's.
 */
function mergedActions(
  v: PipelineView,
  extra: Record<string, unknown>,
  merged?: { sha: string; ci: MergedCi },
): PipelineAction[] {
  const { pr, head } = v.p;
  if (pr === undefined) return [];
  const other = merged !== undefined && merged.sha !== head ? merged : undefined;
  const prOf =
    other === undefined
      ? { number: pr.number, url: pr.url, head_sha: head, ci: v.p.ci ?? "green" }
      : {
          number: pr.number,
          url: pr.url,
          head_sha: other.sha,
          ...(other.ci !== "unknown" ? { ci: other.ci } : {}),
        };
  return [
    ...(v.p.alarms?.pr_closed_unmerged !== undefined
      ? [
          {
            kind: "journal" as const,
            event: {
              type: "alarm_cleared" as const,
              task: v.task,
              data: {
                alarm: "pr_closed_unmerged",
                why: "the PR's head landed on the release branch",
              },
            },
          },
        ]
      : []),
    {
      kind: "journal",
      event: {
        type: "artifact_verified",
        task: v.task,
        data: {
          role: "merged",
          pr: prOf,
          head_sha: head,
          ...(other !== undefined
            ? { gated_head_sha: head, merged_head_sha: other.sha, merged_ci: other.ci }
            : {}),
          ...extra,
        },
      },
    },
    // Merged mid-pipeline: whoever is still at work on it stops (a branch update or fixup of a
    // head that merged is superseded by the merge).
    ...Object.entries(v.p.runs).flatMap(([role, run]) =>
      retireIfLive(run, role === "rebase" || role === "fixup" ? "superseded" : undefined),
    ),
    {
      kind: "journal",
      event: { type: "stage_entered", task: v.task, data: { stage: "done", merged: true } },
    },
    { kind: "merge_nudge" },
  ];
}

/** A closed PR's head found on the release branch → merged; not found → ask (pr_closed). */
function onLandedChecked(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "landed_checked" }>,
): PipelineAction[] {
  const pr = v.p.pr;
  if (v.stage !== "merge_ready" || pr === undefined || ev.head !== v.p.head) return [];
  if (ev.landed !== null)
    return mergedActions(
      v,
      { via: "outside_github", how: ev.landed.how, sha: ev.landed.sha },
      { sha: ev.landed.sha, ci: ev.merged_ci ?? "unknown" },
    );
  const at = ev.head.slice(0, 12);
  const why = `PR #${pr.number} was closed without a merge, and ${v.release_branch} does not contain ${at} (no ancestor, no equivalent patches, no commit naming #${pr.number})`;
  return [
    // A closed PR is no gate: the task leaves merge_ready until the owner says what happened.
    {
      kind: "journal",
      event: { type: "stage_entered", task: v.task, data: { stage: "blocked", why } },
    },
    {
      kind: "decide",
      marker: { on: "pr_closed", head: ev.head },
      decision: {
        kind: "pr_closed",
        task: v.task,
        question: `${why}. landed: it is merged some other way (\`volleyd merged\` with its sha verifies and records where); abandoned: cancel the task?`,
        pointers: { pr: pr.url },
        options: ["landed", "abandoned"],
      },
    },
  ];
}

/** `volleyd merged`: verified by the driver before this event; journal it, then merged. */
function onOperatorMerged(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "operator_merged" }>,
): PipelineAction[] {
  if (v.stage === "done" || v.stage === "cancelled" || v.p.pr === undefined) return [];
  // Verified against a head the task has since moved off: that check says nothing about this one.
  if (ev.head !== v.p.head) return [];
  return [
    {
      kind: "journal",
      event: {
        type: "merged_by_operator",
        task: v.task,
        data: { by: ev.by, sha: ev.sha, head: v.p.head, how: ev.how },
      },
    },
    ...mergedActions(
      v,
      { via: "operator", sha: ev.sha, how: ev.how, by: ev.by },
      { sha: ev.sha, ci: ev.merged_ci ?? "unknown" },
    ),
  ];
}

function onIoFailed(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "io_failed" }>,
): PipelineAction[] {
  const out: PipelineAction[] = [];
  if (ev.what === "verify" && ev.role !== undefined) {
    const run = v.p.runs[ev.role];
    if (run === undefined || run.agent_id !== ev.agent_id || run.accepted) return [];
    // Not verified yet. The agent's claim stands; a later tick re-checks it.
    out.push(...retireIfLive(run));
  }
  // volleyd's merge ended without an outcome (a timeout, or `gh` could not run): not in flight.
  if (ev.what === "merge" && v.p.merge_inflight === true)
    out.push({
      kind: "journal",
      event: {
        type: "merge_ended",
        task: v.task,
        data: { task: v.task, why: ev.timed_out ? "timed_out" : "failed" },
      },
    });
  // A timeout is the network's problem and resolves itself; anything else is worth one alarm.
  if (!ev.timed_out) {
    out.push({
      kind: "alarm",
      key: `${v.task}/pipeline_error/${ev.what}/${ev.message}`,
      event: {
        type: "alarm_raised",
        task: v.task,
        data: {
          alarm: "pipeline_error",
          check: ev.what,
          ...(ev.role !== undefined ? { role: ev.role } : {}),
          message: ev.message,
        },
      },
    });
  }
  return out;
}

const retireIfLive = (run: RoleRun | undefined, status?: string): PipelineAction[] =>
  run !== undefined && run.retired === undefined
    ? [{ kind: "retire", agent_id: run.agent_id, ...(status !== undefined ? { status } : {}) }]
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
  if (ev.status === "failed" && mergeConflict(v, ev.role))
    return [
      { kind: "retire", agent_id: ev.agent_id },
      mergeConflictDecision(v, ev.agent_id, ev.why ?? "failed"),
    ];
  if (ev.status === "failed") {
    return [
      { kind: "retire", agent_id: ev.agent_id },
      {
        kind: "decide",
        marker: { on: "agent_failed", role: ev.role },
        decision: {
          kind: "agent_blocked",
          task: v.task,
          question: `${ev.agent_id} (${roleLabel(v.p, ev.role)}) ${ev.why ?? "failed"}. Respawn the ${roleLabel(v.p, ev.role)}, or cancel the task?`,
          options: ["respawn", "cancel"],
        },
      },
    ];
  }
  if (isReviewerRole(ev.role)) {
    const review = parseReviewResult(ev.result, v.hygiene ?? "p1");
    if (review === null) {
      if ((run.steers.result ?? 0) < 1) {
        return [
          {
            kind: "steer",
            role: ev.role,
            agent_id: ev.agent_id,
            reason: "result",
            text: resultSteerText(v.hygiene ?? "p1"),
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
  if (ev.role === "fixup") {
    const fixup = parseFixupResult(ev.result);
    if (fixup !== null) return [{ kind: "verify", role: ev.role, result: fixup }];
    // The evidence's "how each P1 was resolved" comes from this result: ask for it once.
    if ((run.steers.result ?? 0) < 1) {
      return [
        {
          kind: "steer",
          role: ev.role,
          agent_id: ev.agent_id,
          reason: "result",
          text: 'Your done arrived without a parseable fixup result. Publish it first — vol_publish(channel="result", type="fixup", payload={ "resolved": [{ "finding": "S1", "how": "<what you changed, or why not>" }] }) — then publish done again.',
        },
      ];
    }
    return [
      { kind: "retire", agent_id: ev.agent_id },
      {
        kind: "decide",
        marker: { on: "fixup_result", role: ev.role },
        decision: {
          kind: "agent_blocked",
          task: v.task,
          question: `${ev.agent_id} (fixup) finished twice without a parseable fixup result. skip: verify its pushed work anyway (its findings stay unresolved in the evidence); respawn: a fresh fixup; or cancel the task?`,
          options: ["skip", "respawn", "cancel"],
        },
      },
    ];
  }
  if (PUBLISHING_ROLES.has(ev.role)) return [{ kind: "verify", role: ev.role }];
  return [{ kind: "retire", agent_id: ev.agent_id }];
}

function onVerified(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "verified" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  if (run === undefined || run.agent_id !== ev.agent_id || run.accepted || v.stage === "cancelled")
    return [];
  const out = artifactOutcome(v.task, ev.role, ev.report);
  const head = ev.report.kind === "ok" ? ev.report.head : undefined;
  // In the CI hold of a role that is done (its push is in), the PR branch moved: a push from
  // outside the pipeline, the same as at any other gate.
  const hold = v.p.ci_hold;
  if (
    ev.report.kind === "missing" &&
    ev.report.remote_head !== undefined &&
    hold?.role === ev.role &&
    run.retired === "done" &&
    v.p.moved === undefined &&
    !v.p.rebasing &&
    ev.report.remote_head !== hold.sha
  )
    return headMovedAtGate(v, ev.report.remote_head, v.p.head ?? hold.sha, hold.pr);
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
            text:
              ev.report.kind === "missing" && ev.report.rewritten_from !== undefined
                ? rewrittenSteer(
                    out.detail,
                    ev.report.rewritten_from,
                    v.p.branch ?? "the PR branch",
                    v.release_branch,
                  )
                : missingSteer(
                    ev.role,
                    out.detail,
                    v.p.branch ?? "the PR branch",
                    v.release_branch,
                    v.p.branch_update,
                  ),
          },
        ];
      }
      return [
        { kind: "journal", event: out.event },
        ...retireIfLive(run),
        {
          kind: "decide",
          marker: { on: "verify", role: ev.role, agent_id: run.agent_id },
          decision: {
            kind: "agent_blocked",
            task: v.task,
            question: `${roleLabel(v.p, ev.role)} ${run.agent_id} reported done, but its ${out.missing} is missing (${out.detail}). respawn: a fresh ${roleLabel(v.p, ev.role)} continues the work (an implementer, its pushed branch and PR); re-verify: you fixed it by hand; or cancel the task?`,
            options: ["respawn", "re-verify", "cancel"],
          },
        },
      ];
    }
    case "ci_failed":
      // Classified before anyone is asked (onClassified): own change, flake or infra incident.
      // artifactOutcome yields ci_failed only for an ok report (a missing artifact is `missing`).
      return [
        ...retireIfLive(run),
        {
          kind: "classify_ci" as const,
          role: ev.role,
          agent_id: run.agent_id,
          report: ev.report as OkReport,
        },
      ];
    case "ci_pending":
      return noCiYet(v, ev, run, out.state, out.head);
    case "conflicting": {
      // An update step's own head that still conflicts is not updated again (that could loop):
      // it waits like any head with no CI, and the owner is asked once the grace has passed.
      if (ev.role === "rebase") return noCiYet(v, ev, run, "none", out.head);
      // GitHub runs no CI on a PR that conflicts with its base: bring it up to date now, at the
      // head the agent pushed (never verified), as a behind > 0 rebase check would.
      const [entered, spawn] = enterRebase(
        { ...v, p: { ...v.p, head: out.head, pr: v.p.pr ?? out.pr } },
        { conflicting: true },
      );
      return [
        {
          kind: "journal",
          event: {
            type: "pr_conflicting",
            task: v.task,
            data: {
              role: ev.role,
              pr: out.pr,
              head: out.head,
              release_branch: v.release_branch,
            },
          },
        },
        ...retireIfLive(run),
        ...(entered !== undefined ? [entered] : []),
        ...(spawn !== undefined ? [spawn] : []),
      ];
    }
    case "verified":
      return [
        ...(v.p.ci_hold?.role === ev.role
          ? [
              {
                kind: "journal" as const,
                event: {
                  type: "ci_green" as const,
                  task: v.task,
                  data: { role: ev.role, sha: head, from_checks: v.p.ci_hold.checks },
                },
              },
            ]
          : []),
        {
          kind: "journal",
          event: {
            ...out.event,
            data: {
              ...out.event.data,
              agent_id: run.agent_id,
              ...(ev.result !== undefined ? { result: ev.result } : {}),
              ...(run.adopt === true ? { adopted: true } : {}),
            },
          },
        },
        ...retireIfLive(run),
      ];
  }
}

/** A pushed head CI has not settled on (running, or no run yet: the owner is asked after the grace). */
function noCiYet(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "verified" }>,
  run: RoleRun,
  state: "running" | "none" | "unknown",
  head: string,
): PipelineAction[] {
  const grace = ev.waited_ms !== undefined && ev.waited_ms >= DAEMON_DEFAULTS.ci_none_grace_ms;
  if (state === "none" && grace) {
    const touched = ev.report.kind === "ok" ? ev.report.touched : undefined;
    const minutes = Math.round((ev.waited_ms ?? 0) / 60_000);
    // Only an update step's own head gets here conflicting: that, not the workflows, is the cause.
    const question =
      ev.report.kind === "ok" && ev.report.pr.mergeable === "CONFLICTING"
        ? `The PR still conflicts with ${v.release_branch} at ${head.slice(0, 12)} after its branch-update step, so no CI has run for ${minutes} min. Resolve the conflict and push, then accept the head without CI, or cancel?`
        : `No CI run exists for ${head.slice(0, 12)} after ${minutes} min. Check the repository's workflows (and the hosting provider's status page). Accept the head without CI, or cancel?`;
    return [
      ...retireIfLive(run),
      {
        kind: "decide",
        marker: {
          on: "ci_none",
          role: ev.role,
          head,
          ...(touched !== undefined ? { touched } : {}),
        },
        decision: {
          kind: "ci_failed",
          task: v.task,
          question,
          ...(ev.report.kind === "ok" ? { pointers: { pr: ev.report.pr.url } } : {}),
          options: ["accept", "cancel"],
        },
      },
    ];
  }
  // The pushed work is in place; CI is re-checked on later ticks. The agent is done — the
  // hold is the pipeline's, and it says so (once per change of head or counts).
  return [...ciPending(v, ev, head), ...retireIfLive(run)];
}

/** The `ci_pending` event for a verification whose CI is still running (or has no run yet). */
function ciPending(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "verified" }>,
  head: string,
): PipelineAction[] {
  if (ev.report.kind !== "ok") return [];
  const { number, url } = ev.report.pr;
  const ci = ev.report.ci;
  const unreadable = ci.state === "unknown" ? (ci.error ?? "") : undefined;
  return holdFor(v, ev.role, head, ci.runs, { number, url }, ev.at, unreadable);
}

/**
 * Journal `ci_pending` for `role`'s head (once per change of head, counts or readability; an
 * unreadable answer's error text, which may carry request ids, is not a change).
 * `unreadable`: the runs could not be read (why): the hold says `reason: ci_unreadable`.
 */
function holdFor(
  v: PipelineView,
  role: Role | "moved",
  head: string,
  runs: CiRun[],
  pr: { number: number; url: string },
  at: number | undefined,
  unreadable?: string,
): PipelineAction[] {
  const checks = { done: runs.filter((r) => r.status === "completed").length, total: runs.length };
  const hold = v.p.ci_hold;
  const reason = unreadable !== undefined ? "ci_unreadable" : undefined;
  if (
    hold?.role === role &&
    hold.sha === head &&
    hold.reason === reason &&
    (unreadable !== undefined ||
      (hold.checks.done === checks.done && hold.checks.total === checks.total))
  )
    return [];
  return [
    {
      kind: "journal",
      event: {
        type: "ci_pending",
        task: v.task,
        data: {
          role,
          sha: head,
          checks,
          ...(at !== undefined
            ? { next_poll_at: new Date(at + DAEMON_DEFAULTS.ci_poll_ms).toISOString() }
            : {}),
          pr,
          ...(unreadable !== undefined ? { reason: "ci_unreadable", error: unreadable } : {}),
        },
      },
    },
  ];
}

/** The answer that takes a flake's dedicated fixer: never a re-run. */
export const FIX_FLAKE = "fix flake";

/** volleyd's answer to a red head's open decision once its flake's fixer merged (SPEC §4.6.16). */
export const FIX_LANDED = "fix landed";

/**
 * A red head classified (SPEC §4.6.16). `own_change`: the ci_failed decision (fixup first). `flake`:
 * `remediation_requested { kind: fix_flake }`, then ci_failed offering `fix flake` first.
 * `infra_incident`: a CI hold (`ci_pending { reason: infra_incident }`) re-checked every
 * ci_poll_ms, until `autopilot.incident_wait_max_s` has passed: then ci_failed. A blocked agent's
 * red PR head is routed the same way (`agent_blocked_ci`).
 */
function onClassified(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "ci_classified" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  if (run === undefined || run.agent_id !== ev.agent_id || run.accepted) return [];
  if (v.stage === "cancelled" || v.stage === "done") return [];
  if (ev.blocked !== undefined) {
    // It ended meanwhile: its status is handled as usual.
    if (run.retired !== undefined) return [];
    return ev.report === null || ev.result === null
      ? blockedDecision(v, ev.role, ev.agent_id, ev.blocked)
      : blockedCi(v, ev.role, ev.agent_id, ev.blocked, ev.report, ev.result);
  }
  // Someone is asked about the task already: a later re-check classifies the head again.
  if (v.stage === "awaiting_decision" || ev.report === null || ev.result === null) return [];
  const out = artifactOutcome(v.task, ev.role, ev.report);
  if (out.kind !== "ci_failed") return [];
  const r = ev.result;
  const head = ev.report.head;
  const marker: PipelineMarker = { on: "ci_failed", role: ev.role, agent_id: ev.agent_id, head };
  const data = { ...out.data, classification: r.classification, evidence: r.evidence };
  switch (r.classification) {
    case "own_change":
      return [{ kind: "decide", marker, decision: out.decision, data }];
    case "flake":
      return [
        ...flakeRequest(v, ev.role, head, r, out.data),
        {
          kind: "decide",
          marker,
          decision: {
            ...out.decision,
            question: flakeQuestion(v, ev.report, r, out.data),
            options: [FIX_FLAKE, "fixup", "re-verify", "cancel"],
          },
          data,
        },
      ];
    case "infra_incident":
      return infraHold(v, ev, ev.report, r, out, marker, data);
  }
}

/** Run URLs on a ci_failed decision's facts. */
const runUrls = (data: Record<string, unknown>): string[] =>
  Array.isArray(data.run_urls) ? (data.run_urls as string[]) : [];

/** Journal `remediation_requested { kind: fix_flake }` for a flake (once per head and test). */
function flakeRequest(
  v: PipelineView,
  role: Role,
  head: string,
  r: ClassifyResult,
  data: Record<string, unknown>,
): PipelineAction[] {
  const f = r.flake;
  if (f === undefined) return [];
  const had = v.p.remediation;
  if (had?.head === head && had.test === f.test) return [];
  return [
    {
      kind: "journal",
      event: {
        type: "remediation_requested",
        task: v.task,
        data: {
          kind: "fix_flake",
          test: f.test,
          test_file: f.test_file,
          tests: f.tests,
          head,
          run_urls: runUrls(data),
          for: v.task,
          role,
          release_ci: r.evidence.release_ci.state,
        },
      },
    },
  ];
}

function flakeQuestion(
  v: PipelineView,
  report: OkReport,
  r: ClassifyResult,
  data: Record<string, unknown>,
): string {
  const at = report.head.slice(0, 12);
  const test = r.flake?.test ?? "a test";
  const file = r.flake?.test_file ?? "its file";
  const release =
    r.evidence.release_ci.state === "red" ? `; ${v.release_branch} is red on it too` : "";
  return `CI failed on ${at} (PR #${report.pr.number}): ${runUrls(data).join(" ")} — ${test} fails, and the PR does not touch ${file}${release}: a flake. volleyd never re-runs CI. fix flake: a dedicated fixer for the test (requested); fixup: a fixup agent at ${at} with the CI result as its directive; re-verify: you fixed it; or cancel?`;
}

/** An infra incident: hold the task in CI and re-check; past the wait budget, ask. */
function infraHold(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "ci_classified" }>,
  report: OkReport,
  r: ClassifyResult,
  out: Extract<ArtifactOutcome, { kind: "ci_failed" }>,
  marker: PipelineMarker,
  data: Record<string, unknown>,
): PipelineAction[] {
  const head = report.head;
  const hold = v.p.ci_hold;
  const same = hold?.reason === "infra_incident" && hold.role === ev.role && hold.sha === head;
  const since = same && hold.since !== undefined ? hold.since : new Date(ev.at).toISOString();
  const maxS = v.incident_wait_max_s ?? CONFIG_DEFAULTS.autopilot.incident_wait_max_s;
  const waited = ev.at - Date.parse(since);
  const incident = r.incident ?? "infra-shaped failure";
  if (waited >= maxS * 1000) {
    const at = head.slice(0, 12);
    return [
      {
        kind: "decide",
        marker,
        decision: {
          ...out.decision,
          question: `CI on ${at} (PR #${report.pr.number}) has been red with an infra incident (${incident}) for ${Math.round(waited / 60_000)} min: ${runUrls(out.data).join(" ")}. volleyd never re-runs CI. fixup: a fixup agent at ${at} with the CI result as its directive; re-verify: it cleared, or you re-ran it; or cancel?`,
          options: ["fixup", "re-verify", "cancel"],
        },
        data: { ...data, incident, incident_since: since },
      },
    ];
  }
  if (same && hold.incident === incident) return [];
  const runs = report.ci.runs;
  return [
    {
      kind: "journal",
      event: {
        type: "ci_pending",
        task: v.task,
        data: {
          role: ev.role,
          sha: head,
          checks: {
            done: runs.filter((x) => x.status === "completed").length,
            total: runs.length,
          },
          next_poll_at: new Date(ev.at + DAEMON_DEFAULTS.ci_poll_ms).toISOString(),
          pr: { number: report.pr.number, url: report.pr.url },
          reason: "infra_incident",
          incident,
          since,
        },
      },
    },
  ];
}

/** A blocked agent whose PR head is red: its decision, routed like a ci_failed (`agent_blocked_ci`). */
function blockedCi(
  v: PipelineView,
  role: Role,
  agentId: string,
  b: BlockedStatus,
  report: OkReport,
  r: ClassifyResult,
): PipelineAction[] {
  const out = artifactOutcome(v.task, role, report);
  if (out.kind !== "ci_failed") return blockedDecision(v, role, agentId, b);
  const label = roleLabel(v.p, role);
  const at = report.head.slice(0, 12);
  const flake = r.classification === "flake";
  const what =
    r.classification === "own_change"
      ? "the PR's own change (fixup: a fixup agent at the red head, this agent stopped)"
      : flake
        ? `a flake in ${r.flake?.test ?? "a test"} the PR does not touch (fix flake: a dedicated fixer, requested)`
        : `an infra incident (${r.incident ?? "infra-shaped failure"}): wait for it to clear`;
  const options = flake
    ? [FIX_FLAKE, "fixup", "continue", "respawn", "cancel"]
    : r.classification === "own_change"
      ? ["fixup", "continue", "respawn", "cancel"]
      : ["continue", "respawn", "cancel"];
  return [
    ...(flake ? flakeRequest(v, role, report.head, r, out.data) : []),
    {
      kind: "decide",
      marker: { on: "agent_blocked_ci", role, head: report.head, agent_id: agentId },
      decision: {
        kind: "agent_blocked",
        task: v.task,
        question: `${agentId} (${label}) is blocked: ${clipReason(b.reason)}. CI on its PR head ${at} (PR #${report.pr.number}) is red: ${runUrls(out.data).join(" ")} — ${what}. volleyd never re-runs CI. continue: you steered it and it goes on; respawn the ${label}; or cancel the task?`,
        pointers: { pr: report.pr.url },
        options,
      },
      data: {
        ...out.data,
        classification: r.classification,
        evidence: r.evidence,
        ...blockedFacts(agentId, b),
      },
    },
  ];
}

/** The missing-artifact steer: what this role publishes, and where. */
function missingSteer(
  role: Role,
  detail: string,
  branch: string,
  release: string,
  update?: "merge",
): string {
  const what =
    role === "implementer"
      ? `Push \`${branch}\` and make sure an open PR from it targets \`${release}\` (gh pr create --base ${release})`
      : role === "fixup"
        ? `Publish your commits to the PR branch as \`.volley/findings.md\` says (git push origin HEAD:${branch})`
        : update === "merge"
          ? `Publish the merged branch as \`.volley/rebase.md\` says (merge, never rebase; a normal push to ${branch}, never a force-push)`
          : `Publish the rebased branch as \`.volley/rebase.md\` says (its lease-guarded push to ${branch})`;
  return `volleyd could not verify your work: ${detail}. ${what}, then publish done again.`;
}

/**
 * A merge-mode update whose push rewrote the PR history (it does not descend from the step's
 * start): rebuild the merge on top of that start, merge the rewritten branch in so nothing it
 * carries is lost, and push forward. Never a force-push.
 */
function rewrittenSteer(detail: string, start: string, branch: string, release: string): string {
  return `volleyd could not verify your work: ${detail}. Do not force-push. Rebuild the merge on the PR history: \`git fetch origin && git checkout -B fix ${start} && git merge --no-edit origin/${release} && git merge --no-edit origin/${branch}\`, then \`git push origin HEAD:${branch}\` (a normal push), then publish done again.`;
}

/** What a blocked agent says is in its way: `reason`, else `summary`, else `text`. */
export function blockedReason(payload: unknown): string {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  for (const k of ["reason", "summary", "text"]) {
    const x = p[k];
    if (typeof x === "string" && x.trim() !== "") return x;
  }
  return "(no reason given)";
}

/** The `why` of a blocked alarm on a cancelled task: the one case that is not a stale run. */
export const BLOCKED_TASK_CANCELLED = "the task is cancelled";

/**
 * A role's agent is blocked: ask the owner. Nothing is retired (the agent may be waiting on its
 * mailbox); `continue` waits for its next status, `respawn` relaunches the role.
 */
function onBlocked(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "agent_blocked" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  const why =
    run === undefined || run.agent_id !== ev.agent_id
      ? `not the ${ev.role}'s current run`
      : run.accepted
        ? `the ${ev.role}'s run is already accepted`
        : v.stage === "cancelled"
          ? BLOCKED_TASK_CANCELLED
          : undefined;
  // Never silent: the alarm says why the pipeline asks nothing (the daemon asks instead).
  if (why !== undefined)
    return [
      {
        kind: "alarm",
        key: `${BLOCKED_ALARM}/${ev.agent_id}/${ev.at ?? ""}`,
        event: {
          type: "alarm_raised",
          task: v.task,
          data: {
            alarm: BLOCKED_ALARM,
            agent_id: ev.agent_id,
            role: ev.role,
            why,
            ...(ev.at !== undefined ? { status_at: ev.at } : {}),
          },
        },
      },
    ];
  const blocked: BlockedStatus = {
    reason: ev.reason,
    payload: ev.payload,
    ...(ev.at !== undefined ? { status_at: ev.at } : {}),
  };
  if (mergeConflict(v, ev.role))
    return [
      {
        ...mergeConflictDecision(v, ev.agent_id, `is blocked: ${clipReason(ev.reason)}`),
        data: blockedFacts(ev.agent_id, blocked),
      },
    ];
  // About a failing test, with a PR branch to look at: is its head red, and whose is it?
  if (CI_REASON.test(ev.reason) && v.p.branch !== undefined)
    return [{ kind: "classify_ci", role: ev.role, agent_id: ev.agent_id, blocked }];
  return blockedDecision(v, ev.role, ev.agent_id, blocked);
}

/** A blocked agent's reason that is about a failing test or CI (its PR head is classified first). */
const CI_REASON = /\b(tests?|specs?)\b|\.(test|spec)\.[cm]?[jt]sx?\b|\bCI\b|\bflak(e|y)\b/i;

/** The plain `agent_blocked` decision: continue, respawn or cancel. */
function blockedDecision(
  v: PipelineView,
  role: Role,
  agentId: string,
  b: BlockedStatus,
): PipelineAction[] {
  const label = roleLabel(v.p, role);
  return [
    {
      kind: "decide",
      marker: { on: "agent_blocked", role },
      decision: {
        kind: "agent_blocked",
        task: v.task,
        question: `${agentId} (${label}) is blocked: ${clipReason(b.reason)}. continue: you steered it and it goes on; respawn the ${label}; or cancel the task?`,
        options: ["continue", "respawn", "cancel"],
      },
      data: blockedFacts(agentId, b),
    },
  ];
}

/** A blocked agent's reason clipped for a question, by code point (never splits a surrogate pair). */
function clipReason(reason: string): string {
  const max = DAEMON_DEFAULTS.blocked_reason_max_chars;
  const chars = Array.from(reason);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : reason;
}

/** What a blocked agent's decision keeps (`status_at`: a re-delivered status is not re-asked). */
const blockedFacts = (agentId: string, b: BlockedStatus): Record<string, unknown> => ({
  agent_id: agentId,
  reason: b.reason,
  payload: b.payload,
  ...(b.status_at !== undefined ? { status_at: b.status_at } : {}),
});

/**
 * Under autopilot merging, a rebase (or merge) agent that cannot bring a queued task's branch up
 * to date — it publishes `blocked`, or fails — is a merge conflict (SPEC §4.6.17). A rebase
 * before the gate (the task was never queued) is an ordinary blocked agent.
 */
const mergeConflict = (v: PipelineView, role: Role): boolean =>
  role === "rebase" && v.p.rebasing && v.merge === "auto" && v.p.queued_at !== undefined;

function mergeConflictDecision(
  v: PipelineView,
  agentId: string,
  what: string,
): Extract<PipelineAction, { kind: "decide" }> {
  const label = roleLabel(v.p, "rebase");
  return {
    kind: "decide",
    marker: { on: "merge_conflict", role: "rebase" },
    decision: {
      kind: "merge_conflict",
      task: v.task,
      question: `${agentId} (${label}) ${what}: the branch could not be brought up to date with ${v.release_branch}. respawn: a fresh ${label} agent; manual: a person resolves and merges this PR (it leaves the merge queue and waits at the gate); or cancel the task?`,
      ...(v.p.pr !== undefined ? { pointers: { pr: v.p.pr.url } } : {}),
      options: ["respawn", "manual", "cancel"],
    },
    data: { agent_id: agentId },
  };
}

/** A role as the owner reads it: the rebase role of a merge-mode step is the merge it runs. */
const roleLabel = (p: TaskPipeline, role: Role): string =>
  role === "rebase" && p.branch_update === "merge" ? "merge (branch update)" : role;

/** The prefix a re-ask puts before the original question (dropped before it is asked again). */
const ASKED_AGAIN =
  /^(".*?" (is not one of|needs the commit that carries it:) [^.]*|no live agent found for \S+ \([^)]*\))\. /;

function onResolved(v: PipelineView, d: DecisionRecord): PipelineAction[] {
  const m = (d as { pipeline?: PipelineMarker }).pipeline;
  const answer = d.resolved?.answer ?? "";
  if (m === undefined || d.task !== v.task) return [];
  // Merged meanwhile (`volleyd merged`, GitHub): no answer brings a done task back.
  if (v.stage === "done") return [];
  if (m.on === "relaunch") return onRelaunchResolved(v, d, m, answer);
  // A stall's answers other than respawn are the daemon's: it stops the task on `stop task` and
  // types anything else (a free-text `cancel` too) to the agent, which stays live.
  if (isAnswer(answer, "cancel") && m.on !== "liveness") {
    // A blocked agent is still live (SPEC §5.2): it is stopped with the task.
    const blocked =
      (m.on === "agent_blocked" || m.on === "agent_blocked_ci" || m.on === "merge_conflict") &&
      m.role !== undefined
        ? v.p.runs[m.role]
        : undefined;
    const agent = (d as { agent_id?: unknown }).agent_id;
    return [
      ...(blocked !== undefined && blocked.agent_id === agent && blocked.retired === undefined
        ? [{ kind: "retire" as const, agent_id: blocked.agent_id, status: "stopped" }]
        : []),
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
  /** Not one of the options: ask again rather than guess (nothing destructive happens). */
  const reask = (): PipelineAction[] => [
    {
      kind: "decide",
      marker: m,
      decision: {
        kind: d.kind,
        task: v.task,
        question: `"${answer}" is not one of ${(d.options ?? []).join(" / ")}. ${d.question.replace(ASKED_AGAIN, "")}`,
        pointers: d.pointers,
        ...(d.options !== undefined ? { options: d.options } : {}),
      },
      // The facts the answer acts on (a pr_head_moved's directive) carry over to the new ask.
      data: decisionFacts(d),
    },
  ];
  switch (m.on) {
    case "verify":
      if (role !== undefined && isRespawnAnswer(answer, d.options))
        return respawnRun(v, role, m.agent_id ?? run?.agent_id);
      // Anything but cancel re-verifies: the non-destructive default.
      return role !== undefined ? [{ kind: "verify", role }] : [];
    case "liveness":
      // A stalled agent: respawn replaces it; any other answer is the daemon's (it steers it).
      if (role === undefined || !isRespawnAnswer(answer, d.options)) return [];
      // Ended meanwhile (its status is handled as usual): nothing to replace.
      if (run !== undefined && run.agent_id === m.agent_id && run.retired !== undefined) return [];
      return respawnRun(v, role, m.agent_id);
    case "ci_failed":
      if (role !== undefined && isAnswer(answer, "fixup") && (d.options ?? []).includes("fixup"))
        return ciFixup(v, d, m);
      // The flake's fixer was requested (remediation_requested): the task waits for it.
      if (isAnswer(answer, FIX_FLAKE) && (d.options ?? []).includes(FIX_FLAKE)) return [];
      // volleyd's answer once the fixer merged: the fix_landed step updates the branch.
      if (isAnswer(answer, FIX_LANDED)) return [];
      // Anything but cancel re-verifies: the non-destructive default.
      return role !== undefined ? [{ kind: "verify", role }] : [];
    case "ci_none":
      if (role === undefined || run === undefined) return [];
      if (!isAnswer(answer, "accept")) return reask();
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
              ...(m.touched !== undefined ? { touched: m.touched } : {}),
              ...(run.adopt === true ? { adopted: true } : {}),
              accepted_by: d.resolved?.by,
            },
          },
        },
      ];
    case "review_result":
      if (role === undefined) return [];
      // respawn: the reducer dropped the run; advance spawns it (retrying a held spawn).
      if (isRespawnAnswer(answer, d.options)) return [];
      if (!isAnswer(answer, "skip")) return reask();
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
    case "fixup_result":
      if (role === undefined || isRespawnAnswer(answer, d.options)) return [];
      return isAnswer(answer, "skip") ? [{ kind: "verify", role }] : reask();
    case "agent_failed":
      return isRespawnAnswer(answer, d.options) ? [] : reask();
    case "agent_blocked_ci": {
      // Routed like a ci_failed: a CI fixup at the red head, or the flake's fixer (the task parks
      // for it); either way the blocked agent is stopped. continue / respawn as for any blocked agent.
      const offered = d.options ?? [];
      const agent = (d as { agent_id?: unknown }).agent_id;
      const live = run !== undefined && run.agent_id === agent && run.retired === undefined;
      // `fix landed` (volleyd, once the flake's fixer merged): stopped, then the branch update.
      if (
        (isAnswer(answer, FIX_FLAKE) && offered.includes(FIX_FLAKE)) ||
        isAnswer(answer, FIX_LANDED)
      )
        return live ? [{ kind: "retire" as const, agent_id: run.agent_id, status: "stopped" }] : [];
      if (role !== undefined && isAnswer(answer, "fixup") && offered.includes("fixup")) {
        const fix = ciFixup(v, d, m);
        if (fix.length === 0) return [];
        return [
          ...(live ? [{ kind: "retire" as const, agent_id: run.agent_id, status: "stopped" }] : []),
          ...fix,
        ];
      }
      return blockedAnswer(v, d, role, run, answer, reask);
    }
    case "agent_blocked":
      return blockedAnswer(v, d, role, run, answer, reask);
    case "pr_head_moved": {
      // The reducer moved the task's head to the new one and kept the directive.
      const live = REVIEWER_ROLES.flatMap((r) => {
        const run = v.p.runs[r];
        return run !== undefined && !run.accepted ? retireIfLive(run) : [];
      });
      if (isAnswer(answer, "fixup")) {
        const i = v.stages.findIndex((g) => g.includes("fixup"));
        return [...live, ...enterStep(v, i >= 0 ? i : Math.max(v.p.step, 0), ["fixup"])];
      }
      if (isAnswer(answer, "accept") && (d.options ?? []).includes("accept"))
        return acceptReleaseMerge(v, d, m);
      const review = reviewStep(v.stages);
      // Offered only when the decision listed it (a red head needs a fixup stage after it).
      if (isAnswer(answer, "rereview") && review !== null && (d.options ?? []).includes("rereview"))
        return [...live, ...enterStep(v, review.i, review.roles)];
      return reask();
    }
    case "pr_closed":
      // A closed, unmerged PR never counts as landed on an answer alone: where it landed is
      // verified by `volleyd merged --sha`, which answers this decision once it has.
      if (isAnswer(answer, "landed"))
        return [
          {
            kind: "decide",
            marker: m,
            decision: {
              kind: d.kind,
              task: v.task,
              question: `"landed" needs the commit that carries it: run \`volleyd merged <wave> ${v.task} --sha <sha>\`, which verifies the sha is on the release branch and carries the gated head, records the merge and answers this. ${d.question.replace(ASKED_AGAIN, "")}`,
              pointers: d.pointers,
              ...(d.options !== undefined ? { options: d.options } : {}),
            },
          },
        ];
      if (isAnswer(answer, "abandoned"))
        return [
          {
            kind: "journal",
            event: {
              type: "task_cancelled",
              task: v.task,
              data: { by: d.resolved?.by, decision_id: d.decision_id, why: "PR abandoned" },
            },
          },
        ];
      return reask();
    case "reviewers_disagree":
    case "spawn_failed":
      // spawn_failed: the daemon's resolveNow acts on it (retry now / stop task).
      return [];
    case "merge_refused":
      // Back to the gate; retry: one more attempt at the task's next merge turn (the reducer
      // granted it), manual: a human merges it (the reducer took it out of autopilot merging).
      if (!isAnswer(answer, "retry") && !isAnswer(answer, "manual")) return reask();
      return [
        {
          kind: "journal",
          event: { type: "stage_entered", task: v.task, data: { stage: "merge_ready" } },
        },
      ];
    case "merge_conflict": {
      const agent = (d as { agent_id?: unknown }).agent_id;
      const live = run !== undefined && run.agent_id === agent && !run.accepted;
      // respawn: a fresh rebase (or merge) agent at the next attempt.
      if (isRespawnAnswer(answer, d.options))
        return live ? [{ kind: "relaunch", role: "rebase", agent_id: run.agent_id }] : [];
      if (!isAnswer(answer, "manual")) return reask();
      // manual: a person merges the PR; the task waits at the gate (the reducer took it out of
      // the merge queue) and its update stops.
      return [
        ...(live && run.retired === undefined
          ? [{ kind: "retire" as const, agent_id: run.agent_id, status: "stopped" }]
          : []),
        {
          kind: "journal",
          event: { type: "stage_entered", task: v.task, data: { stage: "merge_ready" } },
        },
      ];
    }
    case "merge_ready_invariant": {
      if (!isAnswer(answer, "rereview")) return reask();
      const c = mergeReadyCheck(v.stages, v.p);
      // Holds again (nothing to re-run): the next advance gates.
      if (c.ok) return [];
      const roles = REVIEWER_ROLES.filter((r) => c.missing.includes(r) || c.stale.includes(r));
      const i = v.stages.findIndex((g) =>
        g.some((s) => roles.includes(STAGE_ROLE[s] as ReviewerRole)),
      );
      return i >= 0 ? enterStep(v, i, roles) : [];
    }
  }
}

/** A blocked agent's decision answered: continue (steered by hand), respawn, else asked again. */
function blockedAnswer(
  v: PipelineView,
  d: DecisionRecord,
  role: Role | undefined,
  run: RoleRun | undefined,
  answer: string,
  reask: () => PipelineAction[],
): PipelineAction[] {
  // continue: the owner steered it by hand; its next status is handled as usual.
  if (isAnswer(answer, "continue")) return [];
  const agent = (d as { agent_id?: unknown }).agent_id;
  if (role === undefined || typeof agent !== "string") return [];
  if (isAnswer(answer, "respawn")) {
    // Ended meanwhile (its status is handled as usual): nothing to replace.
    if (run !== undefined && run.agent_id === agent && run.retired !== undefined) return [];
    return respawnRun(v, role, agent);
  }
  return reask();
}

/**
 * Replace `agent`'s run of `role` (its session is stopped first: the relaunch's retire): the next
 * advance spawns the role at the next attempt. Work accepted before the answer (it went on, or was
 * steered by hand) is kept; a newer run already in its place only needs the old agent gone.
 */
function respawnRun(v: PipelineView, role: Role, agent: string | undefined): PipelineAction[] {
  const run = v.p.runs[role];
  if (agent === undefined) return [];
  if (run !== undefined && run.agent_id === agent)
    return run.accepted ? [] : [{ kind: "relaunch", role, agent_id: agent }];
  return [{ kind: "retire", agent_id: agent, status: "relaunched" }];
}

/**
 * A ci_failed answered `fixup`: a fixup at the red head, with the CI result as its only job
 * (`Directive`, `only`). The step is the current one, so the stage groups go on from where the red
 * head's role was: CI red on the implementer's first head reaches the reviews after the fixup;
 * on a fixup's or rebase's head, the gate (their reviews hold: ciFixupEntered).
 */
function ciFixup(v: PipelineView, d: DecisionRecord, m: PipelineMarker): PipelineAction[] {
  const x = d as unknown as Record<string, unknown>;
  const role = m.role;
  const head = m.head;
  const run = role !== undefined ? v.p.runs[role] : undefined;
  // Verified meanwhile (a re-run turned it green), or the role relaunched (a new run): the red
  // head is no longer the task's.
  if (role === undefined || head === undefined || run?.accepted === true) return [];
  if (m.agent_id !== undefined && run?.agent_id !== m.agent_id) return [];
  const strings = (k: string): string[] =>
    Array.isArray(x[k])
      ? (x[k] as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
  const directive: Directive = {
    to: head,
    ci: "red",
    failed_jobs: strings("failed_jobs"),
    failing_tests: strings("failing_tests"),
    log: typeof x.log === "string" ? x.log : "",
    // No move to summarise: the red head is the role's own (renderCiDirectiveMd omits it).
    diffstat: "",
    runs: Array.isArray(x.ci_runs) ? (x.ci_runs as CiRun[]) : [],
    only: true,
  };
  const start = role !== "implementer" ? v.p.runs[role]?.start : undefined;
  const touched = Array.isArray(x.touched) ? (x.touched as string[]) : undefined;
  const red = {
    role,
    ...(start !== undefined ? { from: start } : {}),
    ...(touched !== undefined ? { touched } : {}),
  };
  const pr = x.pr as { number: number; url: string } | undefined;
  const after: PipelineView = {
    ...v,
    p: { ...v.p, head, directive, ...(v.p.pr === undefined && pr !== undefined ? { pr } : {}) },
  };
  return enterStep(after, Math.max(v.p.step, 0), ["fixup"], {
    directive,
    red,
    ...(pr !== undefined ? { pr } : {}),
  });
}

/**
 * A pr_head_moved answered `accept` (offered only for a green merge of the release branch only):
 * the role whose head the gate saw is verified again at the moved head, with the move and who
 * accepted it; the reviews of `from` hold at `to` (mergeReadyCheck), so the next advance goes on
 * to the rebase check and the gate at `to`.
 */
function acceptReleaseMerge(
  v: PipelineView,
  d: DecisionRecord,
  m: PipelineMarker,
): PipelineAction[] {
  const dir = (d as { directive?: Directive }).directive;
  const merge = dir?.release_merge;
  const from = m.from ?? dir?.from;
  const to = m.head ?? dir?.to;
  const role = headRole(v.p) ?? lastPublisher(v.p);
  const run = role !== undefined ? v.p.runs[role] : undefined;
  // Without who accepted, the reducer would record a move that voids the reviews at the gate.
  const by = d.resolved?.by;
  if (
    merge === undefined ||
    from === undefined ||
    to === undefined ||
    run === undefined ||
    by === undefined
  )
    return [];
  return [
    {
      kind: "journal",
      event: {
        type: "artifact_verified",
        task: v.task,
        data: {
          role,
          agent_id: run.agent_id,
          head_sha: to,
          branch: v.p.branch,
          ...(v.p.pr !== undefined ? { pr: { ...v.p.pr, head_sha: to, ci: "green" } } : {}),
          ci_runs: dir?.runs ?? [],
          ...(dir?.superseded !== undefined ? { ci_superseded: dir.superseded } : {}),
          adopted: true,
          accepted_by: by,
          move: {
            from,
            to,
            how: "release_merge",
            parent: merge.parent,
            touched: merge.moved_files,
          },
        },
      },
    },
  ];
}

/** The publishing role whose run started last (a moved head with no verified role to carry it). */
function lastPublisher(p: TaskPipeline): Role | undefined {
  return [...PUBLISHING_ROLES]
    .filter((r) => p.runs[r] !== undefined)
    .sort((a, b) => (p.runs[b]?.spawned_seq ?? 0) - (p.runs[a]?.spawned_seq ?? 0))[0];
}

/** Facts kept on a decision beside its payload (decisions.ts decisionPayload drops them). */
const FACT_KEYS = [
  "from",
  "to",
  "ci",
  "failed_jobs",
  "failing_tests",
  "run_urls",
  "directive",
  "agent_id",
];

function decisionFacts(d: DecisionRecord): Record<string, unknown> {
  const x = d as unknown as Record<string, unknown>;
  return Object.fromEntries(FACT_KEYS.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
}

/**
 * A spawn-type decision answered: `relaunch` retires the agent through the delete path and the
 * next advance spawns the same role at the next attempt (the reducer dropped the run); `cancel`
 * retires it and blocks the task with the decision text; `it's running` closes it touching
 * nothing when the agent is live — still the role's run, and heard from since the decision
 * opened — and otherwise asks again, saying so (#402). Anything else is asked again.
 */
function onRelaunchResolved(
  v: PipelineView,
  d: DecisionRecord,
  m: PipelineMarker,
  answer: string,
): PipelineAction[] {
  if (!isRole(m.role) || m.agent_id === undefined) return [];
  if (isAnswer(answer, "relaunch")) {
    // A newer run of the role already replaced it: only make sure the old agent is gone.
    const run = v.p.runs[m.role];
    if (run !== undefined && run.agent_id !== m.agent_id)
      return [{ kind: "retire", agent_id: m.agent_id, status: "relaunched" }];
    return [{ kind: "relaunch", role: m.role, agent_id: m.agent_id }];
  }
  if (isAnswer(answer, ITS_RUNNING)) {
    const run = v.p.runs[m.role];
    const heard = v.heard_from?.(m.agent_id, d.kind) ?? null;
    const current = run?.agent_id === m.agent_id && run.retired === undefined;
    if (current && heard !== null && heard >= Date.parse(d.opened_at)) return [];
    const ago = heard === null ? "never" : `${agoText((v.now ?? heard) - heard)} ago`;
    return [askRelaunchAgain(v, d, m, `no live agent found for ${m.agent_id} (last heard ${ago})`)];
  }
  if (isAnswer(answer, "cancel")) {
    return [
      { kind: "retire", agent_id: m.agent_id, status: "stopped" },
      {
        kind: "journal",
        event: {
          type: "stage_entered",
          task: v.task,
          data: {
            stage: "blocked",
            why: `${d.kind} cancelled by ${d.resolved?.by}: ${d.question}`,
            decision_id: d.decision_id,
          },
        },
      },
    ];
  }
  return [askRelaunchAgain(v, d, m, `"${answer}" is not one of ${(d.options ?? []).join(" / ")}`)];
}

/** A spawn-type decision asked again, `why` first; its answers and the agent it is about carry over. */
function askRelaunchAgain(
  v: PipelineView,
  d: DecisionRecord,
  m: PipelineMarker,
  why: string,
): PipelineAction {
  return {
    kind: "decide",
    marker: m,
    decision: {
      kind: d.kind,
      task: v.task,
      question: `${why}. ${d.question.replace(ASKED_AGAIN, "")}`,
      pointers: d.pointers,
      ...(d.options !== undefined ? { options: d.options } : {}),
      ...(d.option_help !== undefined ? { option_help: d.option_help } : {}),
    },
    data: decisionFacts(d),
  };
}

/** A duration as the owner reads it: `40 s`, `6 min`, `3 h`. */
function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/** The spawn for `role` in the current step: reviewers at the head (detached), others from it. */
function spawnFor(v: PipelineView, role: Role): PipelineAction {
  const head = v.p.head;
  if (role === "implementer") return { kind: "spawn", role, files: {} };
  if (head === undefined) {
    // Unreachable with today's wave grammar: a non-implementer role before any verified head.
    return {
      kind: "alarm",
      key: `${v.task}/no_verified_head/${role}`,
      event: { type: "alarm_raised", task: v.task, data: { alarm: "no_verified_head", role } },
    };
  }
  const base = {
    pr_branch: v.p.branch ?? "",
    pr_url: v.p.pr?.url ?? "",
    head,
    release_branch: v.release_branch,
    ...(role === "rebase" && v.p.conflicting === true ? { conflicting: true as const } : {}),
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
    const d = v.p.directive;
    const items =
      d?.only === true
        ? []
        : fixupItems(roundReviews(v.p), { notBlockers: answeredNotBlockers(v.p) });
    return {
      kind: "spawn",
      role,
      start: { ref: head, detach: false },
      files: {
        "findings.md": `${d !== undefined ? renderDirectiveMd(d) : ""}${renderFindingsMd(items, base)}`,
        "findings.json": `${JSON.stringify(items, null, 2)}\n`,
      },
    };
  }
  if (v.p.branch_update === "merge") {
    return {
      kind: "spawn",
      role,
      start: { ref: head, detach: false },
      files: { "rebase.md": renderMergeMd(base) },
      branch_update: "merge",
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
const roundReviews = (p: TaskPipeline) => reviewsOfRound(p, p.round);

function reviewsOfRound(
  p: TaskPipeline,
  round: number,
): Partial<Record<ReviewerRole, ReviewResult>> {
  const out: Partial<Record<ReviewerRole, ReviewResult>> = {};
  for (const r of REVIEWER_ROLES) {
    const rv = p.reviews[r];
    if (rv !== undefined && rv.round === round) out[r] = rv.result;
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
  // The PR head moved after a gate: nothing moves on until its CI and the owner's answer.
  if (p.moved !== undefined && v.stage !== "cancelled" && v.stage !== "done")
    return movedAdvance(v);
  // A gated task becomes done once its PR merged: by volleyd under `merge: auto` (at its merge
  // turn), else a human.
  if (v.stage === "merge_ready" && p.pr !== undefined)
    return [...autoMerge(v), { kind: "check_merged" }];
  if (IDLE.has(v.stage) || p.step < 0) return [];
  // The flake's fixer merged: update the branch from the release branch first.
  if (p.remediation?.landed === true) return landedFix(v, p.remediation);
  // While reviews run at the verified head, a push to the PR outside the pipeline is watched for.
  const watch: PipelineAction[] =
    WATCHED.has(v.stage) && !p.rebasing && p.pr !== undefined && p.head !== undefined
      ? [{ kind: "watch_head" }]
      : [];
  const pending: PipelineAction[] = [];
  for (const r of p.roles) {
    const run = p.runs[r];
    // A spawn that has not happened yet (budget, admission, a refused launch): retry it.
    if (run === undefined) pending.push(spawnFor(v, r));
    // Retired without being accepted: its CI was pending. Re-check (the driver rate-limits);
    // a red head awaiting its flake's fixer is the fixer's, not a re-check's.
    else if (
      !run.accepted &&
      run.retired === "done" &&
      PUBLISHING_ROLES.has(r) &&
      p.remediation?.role !== r
    )
      pending.push({ kind: "verify", role: r });
  }
  if (pending.length > 0 || p.roles.some((r) => p.runs[r]?.accepted !== true))
    return [...pending, ...watch];
  if (p.rebasing) {
    if (p.rereview.length > 0) {
      const i = v.stages.findIndex((g) =>
        g.some((s) => p.rereview.includes(STAGE_ROLE[s] as ReviewerRole)),
      );
      if (i >= 0) return enterStep(v, i, p.rereview);
    }
    // A flake's fix taken mid-pipeline: on from the step it stopped (its reviews still to run).
    return p.fix_resume === "next" ? enter(v, p.step + 1) : toGate(v);
  }
  return enter(v, p.step + 1);
}

/**
 * The flake's fix landed on the release branch (SPEC §4.6.16): the branch-update step, started
 * at the red head the flake parked (never verified, so not `p.head`), takes it under the wave's
 * `branch_update`; its head is then verified (CI) like any rebase.
 */
function landedFix(v: PipelineView, r: Remediation): PipelineAction[] {
  const [entered, spawn] = enterRebase({ ...v, p: { ...v.p, head: r.head } });
  if (entered?.kind !== "journal" || spawn === undefined) return [];
  return [
    {
      ...entered,
      event: { ...entered.event, data: { ...entered.event.data, fix_landed: r.test } },
    },
    spawn,
  ];
}

/** Enter stage group `i` (skipping what has nothing to do); the end of the pipeline is the gate. */
function enter(v: PipelineView, i: number): PipelineAction[] {
  const group = v.stages[i];
  if (group === undefined || group.includes("merge_ready")) return toGate(v);
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
    // Nothing to fix: skip the fixup (it would only spend a spawn) — unless a moved head's CI
    // failed: its directive is the fixup's job.
    const red = v.p.directive?.ci === "red";
    if (roles.length === 1 && fixupItems(reviews).length === 0 && !red) return enter(v, i + 1);
  }
  return enterStep(v, i, roles);
}

function enterStep(
  v: PipelineView,
  i: number,
  roles: Role[],
  extra: Record<string, unknown> = {},
): PipelineAction[] {
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
          ...extra,
        },
      },
    },
    ...roles.map((r) => spawnFor(after, r)),
  ];
}

/** `conflicting`: GitHub reported the PR CONFLICTING (`pr_conflicting`); the step's brief says so. */
function enterRebase(v: PipelineView, o: { conflicting?: true } = {}): PipelineAction[] {
  const merge = v.branch_update === "merge";
  // spawnFor reads the step's mode, which the stage_entered below fixes.
  const after: PipelineView = {
    ...v,
    p: { ...v.p, branch_update: merge ? "merge" : undefined, conflicting: o.conflicting },
  };
  return [
    {
      kind: "journal",
      event: {
        type: "stage_entered",
        task: v.task,
        data: {
          stage: ROLE_STAGE.rebase,
          step: v.p.step,
          roles: ["rebase"],
          rebase: true,
          // The mode is the step's from here on: a config change reaches the next step only.
          ...(merge ? { branch_update: "merge" } : {}),
          ...(o.conflicting === true ? { conflicting: true } : {}),
        },
      },
    },
    spawnFor(after, "rebase"),
  ];
}

/**
 * The directive section that opens `.volley/findings.md` when the PR head moved after a gate:
 * what moved, CI on the new head (failed jobs, failing tests) and the diff. Pure.
 */
function renderDirectiveMd(d: Directive): string {
  const short = (x: string) => x.slice(0, 12);
  if (d.ci === "red" && d.from === undefined) return renderCiDirectiveMd(d);
  const from = d.from ?? "";
  const lines = [
    "# Directive: the PR head moved",
    "",
    `The PR head moved from \`${short(from)}\` to \`${short(d.to)}\` outside the pipeline, after a gate (\`${short(from)}..${short(d.to)}\`). This worktree starts at the new head. This directive is your first job.`,
    "",
    `## CI on ${short(d.to)}: ${d.ci}`,
    "",
  ];
  if (d.ci === "red") {
    lines.push(...failureMd(d));
    lines.push(
      'Make CI green on this head without undoing what the new commits intend. Publish your result with `{ "finding": "CI", "how": "…" }` among `resolved`.',
      "",
    );
  } else {
    lines.push(
      'CI is not failing. Check the new commits against the plan and the reviews below, fix what they broke, and publish `{ "finding": "MOVE", "how": "…" }` among `resolved`.',
      "",
    );
  }
  lines.push(
    `## What changed ${short(from)}..${short(d.to)}`,
    "",
    "```",
    d.log || "(no log)",
    "",
    d.diffstat || "(no diffstat)",
    "```",
    "",
    "",
  );
  return lines.join("\n");
}

/** A red directive's failed jobs and failing tests. */
function failureMd(d: Directive): string[] {
  return [
    "Failed jobs:",
    "",
    ...(d.failed_jobs.length > 0
      ? d.failed_jobs.map((j) => `- ${j}`)
      : ["- (no job details: open the runs)"]),
    "",
    "Failing tests:",
    "",
    ...(d.failing_tests.length > 0
      ? d.failing_tests.map((t) => `- \`${t}\``)
      : ["- (none found in the logs: read the failed jobs)"]),
    "",
  ];
}

/** The directive section for CI red on the pipeline's own head (a ci_failed answered `fixup`). */
function renderCiDirectiveMd(d: Directive): string {
  const at = d.to.slice(0, 12);
  return [
    "# Directive: CI failed on your head",
    "",
    `CI failed on \`${at}\`, the PR head the pipeline pushed. This worktree starts at that head. Making CI green on it is your only job: the reviews' findings were handled before (or are reviewed after you).`,
    "",
    `## CI on ${at}: red`,
    "",
    ...failedRuns(d.runs).map((r) => `- ${r.name}: ${r.conclusion ?? r.status} (${r.url})`),
    ...(failedRuns(d.runs).length > 0 ? [""] : []),
    ...failureMd(d),
    "## The failed runs' log (its tail)",
    "",
    "```",
    d.log || "(no log: read the runs with `gh run view <id> --log-failed`)",
    "```",
    "",
    'Fix the cause without undoing what the PR intends, run the repository\'s gates, push to the PR branch, and publish your result with `{ "finding": "CI", "how": "…" }` among `resolved`.',
    "",
    "",
  ].join("\n");
}

interface BriefCtx {
  pr_branch: string;
  pr_url: string;
  head: string;
  release_branch: string;
  /** The update step is for a PR GitHub reports CONFLICTING. */
  conflicting?: true;
}

/** The line that opens an update step's `.volley/rebase.md` for a conflicting PR, or none. */
const conflictLines = (c: BriefCtx): string[] =>
  c.conflicting === true
    ? [
        `GitHub reports that the PR conflicts with \`${c.release_branch}\`: it runs no CI on it until the conflicts are resolved and pushed.`,
        "",
      ]
    : [];

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
    ...conflictLines(c),
    `\`${c.release_branch}\` moved since \`${c.pr_branch}\` branched from it. This worktree starts at the PR head \`${c.head}\`.`,
    "",
    `    git fetch origin ${c.release_branch}`,
    `    git rebase origin/${c.release_branch}`,
    "    # resolve conflicts, keep the PR's intent; run the repository's gates",
    `    git push --force-with-lease=${c.pr_branch}:${c.head} origin HEAD:${c.pr_branch}`,
    "",
    `That lease-guarded push to \`${c.pr_branch}\` is the one force-push this role may do. PR: ${c.pr_url}.`,
    "",
    "A conflict you cannot resolve without changing what the PR does: push nothing, and publish `blocked` with the conflicting files in `reason` (the owner decides).",
    "",
  ].join("\n");
}

/**
 * `.volley/rebase.md` under `branch_update: merge`: bring the PR branch up to date by merging the
 * release branch in, and publish it with a normal push (no force-push of any kind).
 */
function renderMergeMd(c: BriefCtx): string {
  return [
    "# Merge",
    "",
    ...conflictLines(c),
    `\`${c.release_branch}\` moved since \`${c.pr_branch}\` branched from it. This worktree starts at the PR head \`${c.head}\`.`,
    "",
    `    git fetch origin ${c.release_branch}`,
    `    git merge --no-edit origin/${c.release_branch}`,
    "    # resolve conflicts, keep the PR's intent; commit the merge; run the repository's gates",
    `    git push origin HEAD:${c.pr_branch}`,
    "",
    `That push moves \`${c.pr_branch}\` forward: its new head must descend from \`${c.head}\`. Never rewrite the branch's history. PR: ${c.pr_url}.`,
    "",
    "A conflict you cannot resolve without changing what the PR does: push nothing, and publish `blocked` with the conflicting files in `reason` (the owner decides).",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

export interface PipelineDeps {
  /** The fenced exec (read-only verbs only are used; the driver adds the hard timeout). */
  exec: ExecFn;
  /** The exec for one task's worktrees when they live elsewhere (a remote host); default `exec`. */
  execFor?: (task: TaskId) => ExecFn;
  /**
   * True when a task's recorded worktree is gone (`volleyd cleanup`, a crash): its git checks run
   * in the repo root instead. Default: never gone.
   */
  worktreeGone?: (task: TaskId, path: string) => boolean;
  /** $VOLLEYD_HOME: evidence goes to `<home>/waves/<wave>/evidence/`. */
  home: string;
  /** The wave's current record (re-read after every journal append). */
  record: () => WaveRecord;
  journal: (ev: NewEvent) => Promise<unknown>;
  /** Start a role's agent (may refuse silently: the next advance retries). */
  spawn: (
    task: TaskId,
    role: Role,
    req: { start?: SpawnStart; files: Record<string, string>; branch_update?: "merge" },
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
  /**
   * Resolve every open decision of `task` with `answer` (by volleyd), on the queue: a PR merged
   * on GitHub closes them before the task leaves for `done` (a parked task stays parked else).
   */
  resolveOpen: (task: TaskId, answer: string, rationale: string) => Promise<unknown>;
  /** Retire an agent (`status`: a DAEMON_ENDED one when it never ended itself; default done). */
  retire: (agentId: string, status?: string) => Promise<unknown>;
  /** The agent id and attempt the next spawn of `role` on `task` takes. */
  nextAgent: (task: TaskId, role: Role) => { agent_id: string; attempt: number };
  /**
   * Run `fn` on the caller's serial queue (the daemon's). Git / gh checks run beside the queue
   * and hand their results back through this, so the queue never waits on the network.
   */
  enqueue: (fn: () => Promise<void>) => Promise<void>;
  /** The wave's `placement.nudge_on_merge` (read at each merge); default the config default. */
  nudgeOnMerge?: () => NudgeOnMerge;
  /** The wave's effective `branch_update` tunable (default: rebase). */
  branchUpdate?: () => BranchUpdate;
  /** The wave's hygiene level (default: p1). */
  hygiene?: () => HygieneLevel;
  /** The wave's effective `merge` mode (wave file, else `autopilot.merge`); default manual. */
  mergeMode?: () => "auto" | "manual";
  /** The wave's `autopilot.merge_retry_max` (default: the config default). */
  mergeRetryMax?: () => number;
  /** The wave's `autopilot.incident_wait_max_s` (default: the config default). */
  incidentWaitMaxS?: () => number;
  /** The wave's `ci_rate_limit_backoff_ms` (default: the config default). */
  ciRateLimitBackoffMs?: () => number;
  /** GitHub's status page, cached (github-status.ts); absent: not read (unknown, never an incident). */
  statusPage?: () => Promise<GithubStatus>;
  /** The wave's `autopilot.delete_branch` (default: false). */
  deleteBranch?: () => boolean;
  /**
   * The merge turn of a release branch (`<repo>#<release_branch>`), shared by every wave on this
   * daemon: `acquire` succeeds when the branch is free or already held by `key`
   * (`<wave>/<task>`). Default: a lock of this driver's own.
   */
  releaseLock?: ReleaseLock;
  /** When volleyd last heard from an agent, for a spawn decision of `kind` (PipelineView.heard_from). */
  heardFrom?: (agent_id: string, kind: DecisionKind) => number | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ReleaseLock {
  acquire(branch: string, key: string): boolean;
  release(branch: string, key: string): void;
  /** Who holds the branch now (`<wave>/<task>`), if anyone. */
  holder?(branch: string): string | undefined;
}

/** A release lock over one map (the daemon's, or a driver's own). */
export function releaseLockOn(held: Map<string, string>): ReleaseLock {
  return {
    acquire: (branch, key) => {
      const k = held.get(branch);
      if (k !== undefined && k !== key) return false;
      held.set(branch, key);
      return true;
    },
    release: (branch, key) => {
      if (held.get(branch) === key) held.delete(branch);
    },
    holder: (branch) => held.get(branch),
  };
}

/** A pipeline git / gh call that hit its hard timeout: "not verified yet", never an alarm. */
class IoTimeout extends Error {}

/**
 * What the daemon checks before a pipeline role spawn (the implementer's spawn is admitted per
 * task by the scheduler): the kill switch, the wave running, T5's admission verdict, the hard
 * ceiling (`live`: the agents running or starting, no held slot) and the wave's spawn budget.
 * Null: spawn now; a reason: hold it (the next tick asks again). Pure.
 */
export function roleSpawnHold(o: {
  killSwitch: boolean;
  running: boolean;
  admission: number;
  reasons?: string[];
  live?: number;
  ceiling?: number;
  used: number;
  budget: number;
}): string | null {
  if (o.killSwitch) return "kill switch engaged";
  if (!o.running) return "wave not running";
  if (o.admission < 1) return `admission closed: ${(o.reasons ?? []).join(", ") || "no capacity"}`;
  if (o.live !== undefined && o.ceiling !== undefined && o.live >= o.ceiling)
    return `hard ceiling reached (${o.live}/${o.ceiling})`;
  if (o.used >= o.budget) return `spawn budget exhausted (${o.used}/${o.budget})`;
  return null;
}

/** The merge-nudge re-check's rate-limit key: outside `<task>/`, so `forget` keeps it. */
const nudgeKey = (task: TaskId) => `merge_nudge:${task}`;

/**
 * A decision asked once until its answer is handled (PipelineDriver.asking): a merge_ready
 * invariant breach, per head (its alarm's key).
 */
function askKey(task: TaskId, m: PipelineMarker | undefined): string | undefined {
  return m?.on === "merge_ready_invariant" ? `${task}/merge_ready_invariant/${m.head}` : undefined;
}

/** Executes the interpreter's actions for one wave. Call it from one serial queue. */
export class PipelineDriver {
  /** Last level-triggered re-check per `<task>/<what>` (verify, check_rebase, check_merged). */
  private readonly lastCheck = new Map<string, number>();
  /** Alarms already journaled by this driver (each condition is alarmed once per process). */
  private readonly alarmed = new Set<string>();
  /** When each `<task>/<head>` was first seen with no CI run at all. */
  private readonly noCiSince = new Map<string, number>();
  /**
   * GitHub's rate limit on the wave repo, kept per wave (this driver): no CI call before `retry_at`. `task`: the one
   * whose probe met it, which carries the `github_rate_limited` alarm until a probe succeeds.
   */
  private readonly ciBackoff = new Map<string, { retry_at: number; task: TaskId }>();
  /** Checks whose I/O is running beside the queue, by `<task>/<what>[/<agent>]`; one per key. */
  private readonly inflight = new Set<string>();
  /** Every check until its result has been folded back in (what `settled` waits for). */
  private readonly chains = new Set<Promise<void>>();
  /** Merged `<task>#<pr>` whose nudges this process has sent (or found none left to send). */
  private readonly nudgesDone = new Set<string>();
  /**
   * The MergeToken each gated task's gate minted (process-local: a restart re-runs the gate's
   * checks to mint it again). Only `gate()` adds one.
   */
  private readonly mergeTokens = new Map<TaskId, MergeToken>();
  /** The head a MergeToken could not be minted for, per task: that head is a human's to merge. */
  private readonly mintFailed = new Map<TaskId, string>();
  /**
   * The merge queue's turn in this wave (SPEC §4.6.17): the task holding its release branch's
   * lock, the refusals it had when it took the turn, and whether its rebase check found it up to
   * date (then the gate re-minted its token and it may merge), and its turn checks that failed
   * in a row.
   */
  private turn:
    | { task: TaskId; branch: string; refusals: number; fresh: boolean; failures: number }
    | undefined;
  /**
   * Tasks that gave up the turn after `merge_turn_check_failures_max` failed turn checks: passed
   * over (with the tasks after them) while another queued task can take the turn.
   */
  private readonly passedOver = new Set<TaskId>();
  private readonly lock: ReleaseLock;
  /** Tasks whose `gh pr merge` this driver runs (from `merge_started` until its outcome is in). */
  private readonly merging = new Set<TaskId>();
  /**
   * The merge_ready invariant decisions this driver asked (`askKey`) whose answer it has not
   * handled yet. Autopilot answers one inside `decide`, but the answer reaches the pipeline later,
   * on the queue: until then the task is not parked, and the advances after the decide would ask
   * again for the same head, spending a re-review each (#269).
   */
  private readonly asking = new Set<string>();

  constructor(
    private readonly wave: WaveId,
    private readonly deps: PipelineDeps,
  ) {
    this.lock = deps.releaseLock ?? releaseLockOn(new Map());
  }

  private now(): number {
    // real clock: the default when the daemon injects no clock
    return (this.deps.now ?? systemClock.now)();
  }

  /** The task's fenced exec with the pipeline's hard timeout; a timeout throws `IoTimeout`. */
  private io(task: TaskId): ExecFn {
    return this.timed(this.deps.execFor?.(task) ?? this.deps.exec);
  }

  /** `exec` with the pipeline's hard timeout: a call past it throws `IoTimeout`. */
  private timed(exec: ExecFn): ExecFn {
    return async (argv, opts: ExecOptions = {}): Promise<ExecResult> => {
      const r = await exec(argv, { timeoutMs: DAEMON_DEFAULTS.pipeline_io_ms, ...opts });
      if (r.timedOut) throw new IoTimeout(`${argv.slice(0, 3).join(" ")} timed out`);
      return r;
    };
  }

  /** The task's view, or null when the task is not in the wave (or not running). */
  view(task: TaskId): PipelineView | null {
    const rec = this.deps.record();
    const t = rec.state?.tasks.find((x) => x.id === task);
    const wt = rec.wave?.tasks[task];
    if (rec.state == null || t === undefined || wt === undefined) return null;
    const token = this.mergeTokens.get(task);
    return {
      task,
      stages: wt.stages,
      stage: t.stage,
      release_branch: rec.state.release_branch,
      p: rec.pipeline[task] ?? emptyPipeline(),
      ...(this.deps.branchUpdate !== undefined ? { branch_update: this.deps.branchUpdate() } : {}),
      ...(this.deps.hygiene !== undefined ? { hygiene: this.deps.hygiene() } : {}),
      merge: this.mintFailed.get(task) === rec.pipeline[task]?.head ? "manual" : this.mergeMode(),
      ...(token !== undefined ? { merge_token: token } : {}),
      ...(this.deps.mergeRetryMax !== undefined
        ? { merge_retry_max: this.deps.mergeRetryMax() }
        : {}),
      ...(this.deps.incidentWaitMaxS !== undefined
        ? { incident_wait_max_s: this.deps.incidentWaitMaxS() }
        : {}),
      ...(this.turn?.task === task ? { merge_turn: this.turn.fresh ? "go" : "check" } : {}),
      ...(this.deps.heardFrom !== undefined ? { heard_from: this.deps.heardFrom } : {}),
      now: this.now(),
    };
  }

  /** The merge mode the pipeline acts on: the wave file's `merge:`, else `autopilot.merge`. */
  private mergeMode(): "auto" | "manual" {
    return this.deps.mergeMode?.() ?? "manual";
  }

  /** Handle one observation, then advance until the task settles. */
  async handle(task: TaskId, ev: PipelineEvent): Promise<void> {
    const v = this.view(task);
    if (v === null) return;
    // Its answer is handled now: a re-ask, or a later breach, asks again.
    if (ev.kind === "decision_resolved") {
      const key = askKey(task, (ev.decision as { pipeline?: PipelineMarker }).pipeline);
      if (key !== undefined) this.asking.delete(key);
    }
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

  /**
   * The level-triggered tick for every task (retries spawns, re-checks pending CI, sees merges).
   * One task's error is one `pipeline_error` alarm; the other tasks still get their tick.
   */
  async tick(): Promise<void> {
    for (const t of this.deps.record().state?.tasks ?? []) {
      if (t.stage === "done" || t.stage === "cancelled") {
        this.forget(t.id);
        if (t.stage === "done")
          await this.renudge(t.id).catch((e: unknown) => this.alarmError(t.id, "merge_nudge", e));
        continue;
      }
      try {
        await this.handle(t.id, { kind: "advance" });
        // A human may merge the PR in any stage (merge_ready's advance asks for this too).
        const w = this.view(t.id);
        if (w !== null && w.p.pr !== undefined && w.stage !== "done" && w.stage !== "cancelled")
          await this.run(t.id, [{ kind: "check_merged" }], false);
      } catch (e) {
        await this.alarmError(t.id, "tick", e);
      }
    }
    await this.mergeNext().catch((e: unknown) =>
      this.deps.log?.(`pipeline ${this.wave} merge queue: ${String(e)}`),
    );
  }

  // --- The merge queue (SPEC §4.6.17) ---

  /** The release branch's lock name: `<repo>#<release_branch>`. */
  private branchKey(): string | null {
    const s = this.deps.record().state;
    return s == null ? null : `${s.repo}#${s.release_branch}`;
  }

  /**
   * One step of the merge queue, from the tick: tasks that are gated under `merge: auto` enter
   * the queue, tasks that merged, were cancelled or went to a human leave it; then the turn
   * holder keeps the release branch until it merged (or was refused, or waits for an answer),
   * and the next task takes the turn: an event-driven rebase check, so it is brought up to date
   * with the release branch first if it is behind, then merged once it gates again.
   */
  async mergeNext(): Promise<void> {
    const branch = this.branchKey();
    if (branch === null) return;
    // A merge journaled as started that no driver here runs (the daemon restarted): it ended.
    for (const t of this.deps.record().state?.tasks ?? []) {
      if (this.view(t.id)?.p.merge_inflight !== true || this.merging.has(t.id)) continue;
      await this.deps.journal({
        type: "merge_ended",
        task: t.id,
        data: { task: t.id, why: "interrupted" },
      });
    }
    for (const t of this.deps.record().state?.tasks ?? []) {
      const v = this.view(t.id);
      if (v === null || v.p.queued_at === undefined) continue;
      const why =
        t.stage === "done"
          ? "merged"
          : t.stage === "cancelled"
            ? "cancelled"
            : v.merge !== "auto" || v.p.merge_manual === true
              ? "manual"
              : null;
      if (why !== null)
        await this.deps.journal({ type: "merge_dequeued", task: t.id, data: { task: t.id, why } });
    }
    for (const t of this.deps.record().state?.tasks ?? []) {
      const v = this.view(t.id);
      if (v === null || t.stage !== "merge_ready" || v.p.queued_at !== undefined) continue;
      if (!autoMergeOn(v) || v.p.pr === undefined) continue;
      // Its place, as the newest entry: "~" sorts after every ISO time (code-unit order).
      const rec = this.deps.record();
      const hyp = { ...rec, pipeline: { ...rec.pipeline, [t.id]: { ...v.p, queued_at: "~" } } };
      const position = queueOf(hyp).findIndex((e) => e.task === t.id) + 1;
      await this.deps.journal({
        type: "merge_queued",
        task: t.id,
        data: { task: t.id, position },
      });
    }
    const queue = queueOf(this.deps.record());
    const turn = this.turn;
    if (turn !== undefined) {
      const key = `${this.wave}/${turn.task}`;
      const v = this.view(turn.task);
      const stuck = turn.failures >= DAEMON_DEFAULTS.merge_turn_check_failures_max;
      const holds =
        v !== null &&
        queue.some((e) => e.task === turn.task) &&
        !((v.p.merge_refusals ?? 0) > turn.refusals && refusalEndsTurn(v.p)) &&
        v.stage !== "awaiting_decision" &&
        v.stage !== "blocked" &&
        turn.branch === branch &&
        !stuck;
      // acquire is idempotent for the holder: it only re-asserts the lock.
      if (holds && this.lock.acquire(branch, key)) {
        // The turn's rebase check did not come back usable (an error, a head that moved): again.
        if (v.stage === "merge_ready" && !turn.fresh && !this.merging.has(turn.task))
          await this.run(turn.task, [{ kind: "check_rebase" }], false);
        return;
      }
      this.lock.release(turn.branch, key);
      this.turn = undefined;
      if (stuck) this.passedOver.add(turn.task);
    }
    for (const t of this.passedOver)
      if (!queue.some((e) => e.task === t)) this.passedOver.delete(t);
    const n =
      nextToMerge({ [branch]: this.withoutPassedOver(queue) }, new Set()) ??
      nextToMerge({ [branch]: queue }, new Set());
    if (n === null || !this.lock.acquire(branch, `${this.wave}/${n.task}`)) return;
    const refusals = this.view(n.task)?.p.merge_refusals ?? 0;
    this.passedOver.delete(n.task);
    this.turn = { task: n.task, branch, refusals, fresh: false, failures: 0 };
    await this.run(n.task, [{ kind: "check_rebase" }], true);
  }

  /** The queue without the passed-over tasks and the tasks after them (they never go first). */
  private withoutPassedOver(queue: QueueEntry[]): QueueEntry[] {
    if (this.passedOver.size === 0) return queue;
    const wave = this.deps.record().wave;
    const skip = new Set(this.passedOver);
    // Queue order puts a task after the ones it comes after, so one pass is transitive.
    return queue.filter((e) => {
      if (wave?.tasks[e.task]?.after.some((d) => skip.has(d))) skip.add(e.task);
      return !skip.has(e.task);
    });
  }

  /**
   * The owner's `volleyd merge` (SPEC §4.6.17): merge one gated task now through the merge verb,
   * under `merge: manual` too, holding its release branch for the merge (refused while another
   * task holds it). The checks and the outcome run on the queue (`deps.enqueue`); the merge
   * itself beside it. Call it off the queue.
   */
  async mergeNow(
    task: TaskId,
    by: string,
  ): Promise<{ ok: true; merge_sha: string | null } | { ok: false; error: string }> {
    // undefined only when the queue dropped the check (the daemon stopped)
    const prep = (await this.onQueue(() => this.mergeNowPrep(task))) ?? "volleyd is stopping";
    if (typeof prep === "string") return { ok: false, error: prep };
    const { v, token, branch, own } = prep;
    let ev: PipelineEvent;
    try {
      ev = (await this.merge(v, token, by)) as PipelineEvent;
    } catch (e) {
      ev = {
        kind: "io_failed",
        what: "merge",
        message: e instanceof Error ? e.message : String(e),
        timed_out: e instanceof IoTimeout,
      };
    }
    await this.deps.enqueue(async () => {
      this.merging.delete(task);
      await this.supersedeOnMerge(task, ev);
      await this.handle(task, ev);
      if (!own) this.lock.release(branch, `${this.wave}/${task}`);
    });
    if (ev.kind === "supervisor_merged") return { ok: true, merge_sha: ev.sha };
    return {
      ok: false,
      error: `not merged: ${ev.kind === "merge_refused" ? ev.stderr : ev.kind === "io_failed" ? ev.message : ev.kind}`,
    };
  }

  /** Run `fn` on the queue and hand back its value (undefined when the queue dropped it). */
  private async onQueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    let out: T | undefined;
    await this.deps.enqueue(async () => {
      out = await fn();
    });
    return out;
  }

  /** mergeNow's checks, on the queue: the task, its gate, the release branch and the token. */
  private async mergeNowPrep(
    task: TaskId,
  ): Promise<{ v: PipelineView; token: MergeToken; branch: string; own: boolean } | string> {
    const v = this.view(task);
    if (v === null) return `unknown task '${task}'`;
    const { pr, head } = v.p;
    if (
      v.stage !== "merge_ready" ||
      pr === undefined ||
      head === undefined ||
      v.p.gated.at(-1) !== head
    )
      return `task '${task}' is not merge_ready`;
    if (this.merging.has(task)) return `a merge of task '${task}' is already running`;
    const branch = this.branchKey();
    if (branch === null) return `unknown task '${task}'`;
    const own = this.turn?.task === task;
    if (!this.lock.acquire(branch, `${this.wave}/${task}`))
      return `${this.lock.holder?.(branch) ?? "another task"} holds ${v.release_branch} (its merge-queue turn: it is brought up to date if it is behind, then merged); try again once it has merged or given up the turn`;
    const held = this.mergeTokens.get(task);
    const token =
      held !== undefined && held.head === head && held.pr === pr.number
        ? held
        : this.mintFor(task, pr.number, head, v);
    if (token === undefined) {
      if (!own) this.lock.release(branch, `${this.wave}/${task}`);
      return `no merge token can be minted for head ${head} (volleyd merges only an exact 40-hex head)`;
    }
    if (own && this.turn !== undefined) this.turn.fresh = false;
    this.merging.add(task);
    await this.deps.journal({
      type: "merge_started",
      task,
      data: { task, pr: token.pr, head: token.head },
    });
    return { v, token, branch, own };
  }

  /**
   * Give up this wave's merge turn (the wave stopped): the release branch is free again, once
   * no merge of this wave runs (the daemon calls it again on its next tick).
   */
  releaseTurn(): void {
    if (this.merging.size > 0) return;
    if (this.turn !== undefined)
      this.lock.release(this.turn.branch, `${this.wave}/${this.turn.task}`);
    this.turn = undefined;
  }

  /** Whether a blocked agent's red head is still being classified (its decision is to come). */
  classifying(task: TaskId, agentId: string): boolean {
    return this.inflight.has(`${task}/classify/blocked/${agentId}`);
  }

  /** Resolves once no check is running beside the queue (tests; a graceful stop). */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains]);
  }

  /** Drop a finished task's rate-limit and no-CI bookkeeping (the maps stay bounded). */
  private forget(task: TaskId): void {
    this.mergeTokens.delete(task);
    for (const m of [this.lastCheck, this.noCiSince])
      for (const k of m.keys()) if (k.startsWith(`${task}/`)) m.delete(k);
    for (const k of this.asking) if (k.startsWith(`${task}/`)) this.asking.delete(k);
  }

  private async alarmError(task: TaskId, what: string, e: unknown): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    this.deps.log?.(`pipeline ${this.wave}/${task} ${what}: ${message}`);
    const key = `${task}/pipeline_error/${what}/${message}`;
    if (this.alarmed.has(key)) return;
    this.alarmed.add(key);
    await this.deps
      .journal({
        type: "alarm_raised",
        task,
        data: { alarm: "pipeline_error", check: what, message },
      })
      .catch(() => {});
  }

  /**
   * Run one check beside the queue (at most one per key), then fold its event back in on the
   * queue. A rejection becomes an `io_failed` event (a timeout is flagged as such).
   */
  private beside(
    task: TaskId,
    key: string,
    fail: Omit<Extract<PipelineEvent, { kind: "io_failed" }>, "kind" | "message" | "timed_out">,
    check: () => Promise<PipelineEvent | null>,
    /** Run on the queue before the result is handled. */
    prelude?: (ev: PipelineEvent) => Promise<void>,
  ): void {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const p: Promise<void> = check()
      .then(
        (ev) => ev,
        (e: unknown): PipelineEvent => ({
          kind: "io_failed",
          ...fail,
          message: e instanceof Error ? e.message : String(e),
          timed_out: e instanceof IoTimeout,
        }),
      )
      .then(async (ev) => {
        // The I/O is done: the same check may start again (e.g. from this fold-back's advance).
        this.inflight.delete(key);
        if (ev === null) return;
        await this.deps.enqueue(async () => {
          try {
            await prelude?.(ev);
            await this.handle(task, ev);
          } catch (e) {
            await this.alarmError(task, fail.what, e);
          }
        });
      })
      .catch((e: unknown) => this.deps.log?.(`pipeline ${this.wave}/${task}: ${String(e)}`))
      .finally(() => this.chains.delete(p));
    this.chains.add(p);
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
        case "alarm":
          if (this.alarmed.has(a.key)) break;
          this.alarmed.add(a.key);
          await this.deps.journal(a.event);
          progressed = true;
          break;
        case "spawn":
          await this.deps.spawn(task, a.role, {
            ...(a.start !== undefined ? { start: a.start } : {}),
            files: a.files,
            ...(a.branch_update !== undefined ? { branch_update: a.branch_update } : {}),
          });
          break;
        case "steer": {
          await this.deps.steer(task, a.role, a.agent_id, a.text, a.reason);
          progressed = true;
          break;
        }
        case "decide": {
          const key = askKey(task, a.marker);
          if (key !== undefined && this.asking.has(key)) break;
          await this.deps.decide(a.decision, { ...(a.data ?? {}), pipeline: a.marker });
          if (key !== undefined) this.asking.add(key);
          progressed = true;
          break;
        }
        case "retire":
          await this.deps.retire(a.agent_id, a.status);
          progressed = true;
          break;
        case "relaunch": {
          // The old run's lock, login and retained records go first: the new attempt needs them.
          await this.deps.retire(a.agent_id, "relaunched");
          const next = this.deps.nextAgent(task, a.role);
          await this.deps.journal({
            type: "relaunched",
            task,
            data: {
              from_agent: a.agent_id,
              to_agent: next.agent_id,
              role: a.role,
              attempt: next.attempt,
            },
          });
          progressed = true;
          break;
        }
        case "verify": {
          const agent = this.view(task)?.p.runs[a.role]?.agent_id;
          if (agent === undefined) break;
          // Rate-limit per agent: a new run of the role is checked at once.
          const key = `${task}/verify/${agent}`;
          // Rate-limited: no CI call before retry_at, event-driven or not (a later tick verifies).
          if (this.inflight.has(key) || this.ciBackedOff()) break;
          if (!eventDriven && !this.due(key)) break;
          this.lastCheck.set(key, this.now());
          this.beside(task, key, { what: "verify", role: a.role, agent_id: agent }, () =>
            this.verify(task, a.role, agent, a.result),
          );
          break;
        }
        case "classify_ci": {
          // Event-driven (a verification or a blocked status just found it): one per task for a
          // red head, one per blocked agent (never dropped behind another).
          const key =
            a.blocked !== undefined ? `${task}/classify/blocked/${a.agent_id}` : `${task}/classify`;
          this.beside(task, key, { what: "classify", role: a.role, agent_id: a.agent_id }, () =>
            this.classifyCi(task, a),
          );
          break;
        }
        case "check_rebase": {
          const v = this.view(task);
          const key = `${task}/check_rebase`;
          if (v?.p.head === undefined || this.inflight.has(key)) break;
          if (!eventDriven && !this.due(`${task}/check_rebase/${v.p.head}`)) break;
          this.beside(
            task,
            key,
            { what: "check_rebase" },
            () => this.gateCheck(v),
            async (ev) => {
              // The merge turn's check: failures in a row pass the turn on (mergeNext).
              if (this.turn?.task === task)
                this.turn.failures = ev.kind === "io_failed" ? this.turn.failures + 1 : 0;
            },
          );
          break;
        }
        case "check_merged": {
          const v = this.view(task);
          const key = `${task}/check_merged`;
          // While volleyd's own merge runs, its result says what happened (merged or refused).
          if (v?.p.pr === undefined || this.inflight.has(key) || this.inflight.has(`${task}/merge`))
            break;
          // Event-driven (a refused merge): read the PR now; else at most once per ci_poll_ms.
          if (!eventDriven && !this.due(key)) break;
          if (eventDriven) this.lastCheck.set(key, this.now());
          this.beside(
            task,
            key,
            { what: "check_merged" },
            () => this.mergeCheck(v),
            (ev) => this.supersedeOnMerge(task, ev),
          );
          break;
        }
        case "merge": {
          // Beside the queue like every pipeline call; one attempt per ci_poll_ms (an answered
          // `retry` is event-driven: at once).
          const key = `${task}/merge`;
          if (this.inflight.has(key) || this.inflight.has(`${task}/check_merged`)) break;
          // The owner's `volleyd merge` of it is running (mergeNow): one `gh pr merge` at a time.
          if (this.merging.has(task)) break;
          if (!eventDriven && !this.due(key)) break;
          if (eventDriven) this.lastCheck.set(key, this.now());
          const v = this.view(task);
          if (v === null) break;
          // One attempt per up-to-date check: another needs the turn's rebase check again.
          if (this.turn?.task === task) this.turn.fresh = false;
          this.merging.add(task);
          await this.deps.journal({
            type: "merge_started",
            task,
            data: { task, pr: a.token.pr, head: a.token.head },
          });
          progressed = true;
          this.beside(
            task,
            key,
            { what: "merge" },
            () => this.merge(v, a.token),
            (ev) => {
              this.merging.delete(task);
              return this.supersedeOnMerge(task, ev);
            },
          );
          break;
        }
        case "watch_head": {
          const v = this.view(task);
          const key = `${task}/watch_head`;
          if (v?.p.pr === undefined || this.inflight.has(key) || !this.due(key)) break;
          this.beside(task, key, { what: "watch_head" }, () => this.headCheck(v));
          break;
        }
        case "check_moved_ci": {
          const v = this.view(task);
          const key = `${task}/moved_ci`;
          if (v?.p.moved === undefined || this.inflight.has(key) || this.ciBackedOff()) break;
          if (!this.due(`${key}/${v.p.moved.to}`)) break;
          this.beside(task, key, { what: "moved_ci" }, () => this.movedCheck(v));
          break;
        }
        case "merge_nudge":
          // A failure is retried by a later tick (`renudge`), no sooner than the re-check interval.
          this.due(nudgeKey(task));
          await this.nudgeMerged(task);
          break;
        case "evidence_stale":
          markEvidenceStale(this.deps.home, this.wave, task, {
            from: a.from,
            to: a.to,
            at: new Date(this.now()).toISOString(),
          });
          break;
        case "check_landed": {
          const v = this.view(task);
          const key = `${task}/check_landed`;
          if (v?.p.pr === undefined || v.p.head === undefined || this.inflight.has(key)) break;
          this.beside(task, key, { what: "check_landed" }, () => this.landedCheck(v));
          break;
        }
        case "gate":
          await this.gate(task, a.check, a.diffstats);
          progressed = true;
          break;
      }
    }
    return progressed;
  }

  /** The wave repo: the key of this wave's rate-limit backoff (another wave keeps its own). */
  private repoKey(): string {
    return this.deps.record().state?.repo ?? ".";
  }

  /**
   * Where a head's runs are read: the supervisor's own exec in the wave's repo root (ghCwd; one `gh api
   * …/actions/runs?head_sha=` GET, never sent to a paired machine); without a wave repo, the
   * task's `gh run list --commit`.
   */
  private runsVia(): RunsVia | undefined {
    const cwd = this.ghCwd();
    return cwd !== undefined ? { exec: this.timed(this.deps.exec), cwd } : undefined;
  }

  /** GitHub rate-limited the wave repo's last CI read and its backoff has not passed. */
  private ciBackedOff(): boolean {
    const b = this.ciBackoff.get(this.repoKey());
    return b !== undefined && this.now() < b.retry_at;
  }

  /**
   * Fold a CI read into the rate-limit backoff: a rate-limited answer backs the repo off for
   * max(`Retry-After`, `ci_rate_limit_backoff_ms`), journaling `github_rate_limited` once; a
   * readable answer ends it and clears the alarm. Another unreadable answer changes nothing.
   */
  private async noteCi(
    task: TaskId,
    ci: { state: CiState; error?: string; rate_limited?: RateLimited },
  ): Promise<void> {
    const repo = this.repoKey();
    const b = this.ciBackoff.get(repo);
    if (ci.rate_limited !== undefined) {
      const wait = Math.max(
        ci.rate_limited.retry_after_ms ?? 0,
        this.deps.ciRateLimitBackoffMs?.() ?? CONFIG_DEFAULTS.ci_rate_limit_backoff_ms,
      );
      const retryAt = this.now() + wait;
      this.ciBackoff.set(repo, { retry_at: retryAt, task: b?.task ?? task });
      if (b !== undefined) return;
      await this.deps.journal({
        type: "alarm_raised",
        task,
        data: {
          alarm: "github_rate_limited",
          retry_at: new Date(retryAt).toISOString(),
          message: `GitHub rate-limited CI reads (${ci.error ?? "rate limit"}); no CI call before ${new Date(retryAt).toISOString()}`,
        },
      });
      return;
    }
    if (ci.state === "unknown" || b === undefined) return;
    this.ciBackoff.delete(repo);
    await this.deps.journal({
      type: "alarm_cleared",
      task: b.task,
      data: { alarm: "github_rate_limited", why: "a CI read succeeded" },
    });
  }

  /** Level-triggered checks run at most once per `ci_poll_ms`. */
  private due(key: string): boolean {
    const now = this.now();
    const last = this.lastCheck.get(key);
    if (last !== undefined && now - last < DAEMON_DEFAULTS.ci_poll_ms) return false;
    this.lastCheck.set(key, now);
    return true;
  }

  /** The worktree whose HEAD is the PR head: the run that verified it, else the implementer's. */
  private headWorktree(p: TaskPipeline): string | undefined {
    const r = headRole(p);
    return (r !== undefined ? p.runs[r]?.worktree : undefined) ?? p.runs.implementer?.worktree;
  }

  /** The wave's repo root on this machine: where the pipeline's GitHub reads run. */
  private ghCwd(): string | undefined {
    const repo = this.deps.record().state?.repo;
    return repo != null ? expandHome(repo) : undefined;
  }

  /** `--repo <slug>` (host-qualified off github.com) when GitHub's slug was read; else none. */
  private repoArgs(): string[] {
    const gh = this.deps.record().state?.github;
    if (gh === undefined) return [];
    const host = URL.canParse(gh.url) ? new URL(gh.url).host : "github.com";
    return ["--repo", host === "github.com" ? gh.slug : `${host}/${gh.slug}`];
  }

  /**
   * The exec for a task's GitHub reads: every `gh` argv runs on this machine from the repo root
   * (ghCwd) with repoArgs, whatever `cwd` the caller passed — never in an agent's worktree, which
   * cleanup may have removed (a missing cwd fails the spawn: ENOENT). Any other argv goes to
   * `other` (default: the task's own exec). Without a repo root, everything goes to `other`
   * with the caller's cwd: unreachable from a wave file (the schema requires `repo`).
   * A `gh api` call gets no `--repo` (gh api rejects it; its endpoint names the repository).
   */
  private ghExec(task: TaskId, other: ExecFn = this.io(task)): ExecFn {
    const root = this.ghCwd();
    if (root === undefined) return other;
    const local = this.timed(this.deps.exec);
    return (argv, opts = {}) =>
      argv[0] === "gh"
        ? local(argv[1] === "api" ? argv : [...argv, ...this.repoArgs()], { ...opts, cwd: root })
        : other(argv, opts);
  }

  /**
   * Where a task's git checks run: the worktree at its PR head through the task's exec, or, once
   * that worktree is gone (or none was recorded), the repo root on this machine with the PR head
   * fetched there first (`refs/pull/<n>/head`, else its branch).
   */
  private gitAt(v: PipelineView): (GitAt & { exec: ExecFn }) | undefined {
    const wt = this.headWorktree(v.p);
    if (wt !== undefined && this.deps.worktreeGone?.(v.task, wt) !== true)
      return { exec: this.io(v.task), cwd: wt };
    const root = this.ghCwd();
    if (root === undefined) return undefined;
    const fetch = v.p.pr !== undefined ? `refs/pull/${v.p.pr.number}/head` : v.p.branch;
    return {
      exec: this.timed(this.deps.exec),
      cwd: root,
      ...(fetch !== undefined ? { fetch } : {}),
    };
  }

  /** Beside the queue: verify `role`'s run `agentId` (a moved PR: its branch head as it is). */
  private async verify(
    task: TaskId,
    role: Role,
    agentId: string,
    result?: FixupResult,
  ): Promise<PipelineEvent | null> {
    const v = this.view(task);
    const run = v?.p.runs[role];
    if (v === null || run?.agent_id !== agentId || run.worktree === undefined) return null;
    if (v.p.branch === undefined) return null;
    const since = run.adopt === true ? v.p.head : role === "rebase" ? run.start : undefined;
    const via = this.runsVia();
    // Its git checks run in the run's worktree; its `gh` reads from the repo root (ghExec).
    let report = await verifyArtifacts(this.ghExec(task), {
      cwd: run.worktree,
      branch: v.p.branch,
      release_branch: v.release_branch,
      ...(since !== undefined ? { since } : {}),
      ...(run.adopt === true ? { adopt: true } : {}),
      ...(via !== undefined ? { runs_via: via } : {}),
    });
    if (report.kind === "ok") await this.noteCi(task, report.ci);
    // A merge-mode update moves the branch forward: a head that does not descend from the step's
    // start was force-pushed (a rebase), which `branch_update: merge` forbids.
    if (
      report.kind === "ok" &&
      role === "rebase" &&
      v.p.branch_update === "merge" &&
      run.adopt !== true &&
      run.start !== undefined &&
      report.head !== run.start
    ) {
      const r = await this.io(task)([
        "git",
        "-C",
        run.worktree,
        "merge-base",
        "--is-ancestor",
        run.start,
        report.head,
      ]);
      if (r.code !== 0 && r.code !== 1)
        throw new Error(`git merge-base --is-ancestor failed: ${r.stderr.trim()}`);
      if (r.code === 1)
        report = {
          kind: "missing",
          missing: "push",
          detail: `origin/${v.p.branch} is ${report.head.slice(0, 12)}, which does not descend from ${run.start.slice(0, 12)} (the PR head this merge started at): the branch was rewritten, and branch_update: merge allows no force-push`,
          rewritten_from: run.start,
        };
    }
    let waited: number | undefined;
    // A conflicting PR gets no CI at all: its update step starts instead, with no clock.
    // (An update step's own conflicting head is not updated again: it waits, and is asked about.)
    if (
      report.kind === "ok" &&
      report.ci.state === "none" &&
      (report.pr.mergeable !== "CONFLICTING" || role === "rebase")
    ) {
      const key = `${task}/${report.head}`;
      const first = this.noCiSince.get(key) ?? this.now();
      this.noCiSince.set(key, first);
      waited = this.now() - first;
    } else if (report.kind === "ok" && report.ci.state === "unknown") {
      // Unreadable time is not no-CI time: a later `none` starts the clock over.
      this.noCiSince.delete(`${task}/${report.head}`);
    }
    return {
      kind: "verified",
      role,
      agent_id: agentId,
      report,
      ...(result !== undefined ? { result } : {}),
      ...(waited !== undefined ? { waited_ms: waited } : {}),
      at: this.now(),
    };
  }

  /**
   * Beside the queue: classify a red head (ci-classify.ts) from the PR's changed files, the release
   * branch's latest CI and GitHub's status page. A blocked agent's PR head is read here first (its
   * open PR, CI on its head): not red, or no PR, comes back with a null result.
   */
  private async classifyCi(
    task: TaskId,
    a: Extract<PipelineAction, { kind: "classify_ci" }>,
  ): Promise<PipelineEvent | null> {
    const v = this.view(task);
    if (v === null) return null;
    const exec = this.ghExec(task);
    const cwd = this.ghCwd();
    const base = { kind: "ci_classified" as const, role: a.role, agent_id: a.agent_id };
    const blocked = a.blocked !== undefined ? { blocked: a.blocked } : {};
    const unclassified = (): PipelineEvent => ({
      ...base,
      report: null,
      result: null,
      at: this.now(),
      ...blocked,
    });
    // A blocked agent is asked about whatever happens here: no repo to read from, or a failed
    // read, is the plain question. A verified red head with no repo is asked about nothing on
    // this pass: its run stays retired-done and unaccepted, so advance re-verifies it (a retry).
    if (cwd === undefined) return a.blocked !== undefined ? unclassified() : null;
    if (a.blocked !== undefined)
      return this.classifyRed(exec, cwd, v, base, a.report ?? null, blocked).catch(unclassified);
    return this.classifyRed(exec, cwd, v, base, a.report ?? null, blocked);
  }

  private async classifyRed(
    exec: ExecFn,
    cwd: string,
    v: PipelineView,
    base: { kind: "ci_classified"; role: Role; agent_id: string },
    given: OkReport | null,
    blocked: { blocked?: BlockedStatus },
  ): Promise<PipelineEvent> {
    const none = (): PipelineEvent => ({
      ...base,
      report: null,
      result: null,
      at: this.now(),
      ...blocked,
    });
    // Rate-limited: no CI call before retry_at; the head is re-verified, then classified, after it.
    if (this.ciBackedOff()) return none();
    const report = given ?? (await this.blockedHead(exec, cwd, v));
    if (report === null || report.ci.state !== "red") return none();
    const files = await prFiles(exec, cwd, report.pr.number);
    const release = await probeReleaseCi(exec, { cwd, release_branch: v.release_branch });
    await this.noteCi(v.task, release);
    // An unreadable release branch is no evidence either way: nothing is classified on it (the
    // head is re-verified and classified again later, like an infra hold's re-check).
    if (release.state === "unknown") return none();
    const status = (await this.deps.statusPage?.()) ?? STATUS_UNKNOWN;
    const result = classify({
      failing_tests: report.ci.failing_tests ?? [],
      pr_files: files,
      release,
      infra: report.ci.infra,
      status_page: status,
    });
    return { ...base, report, result, at: this.now(), ...blocked };
  }

  /** A blocked agent's PR (the task's open PR from its branch) and CI on its head, read-only. */
  private async blockedHead(exec: ExecFn, cwd: string, v: PipelineView): Promise<OkReport | null> {
    const branch = v.p.branch;
    if (branch === undefined) return null;
    const r = await exec(
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,headRefName,baseRefName,headRefOid",
      ],
      { cwd },
    );
    let list: { number: number; url: string; headRefName: string; headRefOid: string }[] = [];
    try {
      const parsed: unknown = r.code === 0 ? JSON.parse(r.stdout) : [];
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
    const pr = list.find((p) => p.headRefName === branch);
    if (
      pr === undefined ||
      typeof pr.number !== "number" ||
      typeof pr.url !== "string" ||
      typeof pr.headRefOid !== "string" ||
      pr.headRefOid === ""
    )
      return null;
    const ci = await redHeadCi(exec, cwd, pr.headRefOid, this.runsVia());
    await this.noteCi(v.task, ci);
    return {
      kind: "ok",
      head: pr.headRefOid,
      branch,
      pr: { number: pr.number, url: pr.url, head_sha: pr.headRefOid, base: v.release_branch },
      ci,
    };
  }

  /**
   * Beside the queue, before the gate: the PR is still at the verified head (`gh pr view`), and
   * the release branch has not moved past it; plus each fixup's diffstat for the evidence.
   */
  private async gateCheck(v: PipelineView): Promise<PipelineEvent> {
    const { p } = v;
    const io = this.io(v.task);
    const head = p.head as string;
    const at = this.gitAt(v);
    if (at === undefined) throw new Error("no worktree or repo root at the PR head");
    if (p.pr !== undefined) {
      const r = await this.ghExec(v.task)([
        "gh",
        "pr",
        "view",
        String(p.pr.number),
        "--json",
        "headRefOid,state,baseRefName",
      ]);
      const pr = r.code === 0 ? parsePrView(r.stdout) : null;
      if (pr === null) throw new Error(`gh pr view ${p.pr.number} failed: ${r.stderr.trim()}`);
      if (typeof pr.headRefOid === "string" && pr.headRefOid !== head)
        return { kind: "head_moved", expected: head, actual: pr.headRefOid };
      // `gh pr merge` merges into whatever the PR targets now: a retargeted PR never gates.
      if (pr.baseRefName !== v.release_branch)
        throw new Error(
          `PR #${p.pr.number} targets ${String(pr.baseRefName)}, not ${v.release_branch}`,
        );
    }
    const { exec: git, ...where } = at;
    const check = await checkRebase(git, { ...where, head, release_branch: v.release_branch });
    const diffstats: Record<string, string> = {};
    if (check.behind === 0) {
      for (const f of p.fixups) {
        if (f.from === undefined || f.worktree === undefined) continue;
        // Its own worktree while it is there; else where the gate's checks ran (head fetched).
        const r =
          this.deps.worktreeGone?.(v.task, f.worktree) === true
            ? await git(["git", "-C", where.cwd, "diff", "--stat", f.from, f.to])
            : await io(["git", "-C", f.worktree, "diff", "--stat", f.from, f.to]);
        // trimEnd only: the first line's leading space is part of git's column alignment.
        if (r.code === 0) diffstats[`${f.from}..${f.to}`] = r.stdout.replace(/^\n+/, "").trimEnd();
      }
    }
    return { kind: "rebase_checked", head, check, diffstats };
  }

  /** Beside the queue, at the gate: the PR as GitHub has it now (read-only; only autopilot merging merges, src/autopilot/merge.ts). */
  private async mergeCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const pr = v.p.pr;
    if (pr === undefined) return null;
    const r = await this.ghExec(v.task)([
      "gh",
      "pr",
      "view",
      String(pr.number),
      "--json",
      "state,mergedAt,mergeCommit,baseRefName,headRefOid",
    ]);
    const view = r.code === 0 ? parsePrView(r.stdout) : null;
    if (view === null) return null;
    const merged = view.headRefOid;
    if (view.state === "MERGED" && typeof merged === "string" && merged !== v.p.head)
      return { kind: "merge_checked", view, merged_ci: await this.ciOf(v.task, merged) };
    return { kind: "merge_checked", view };
  }

  /**
   * On the queue, before a merged PR is handled: close the task's open decisions as
   * `superseded_by_merge` (the reducer keeps a parked task parked on a stage change).
   */
  private async supersedeOnMerge(task: TaskId, ev: PipelineEvent): Promise<void> {
    const v = this.view(task);
    if (v === null || v.p.pr === undefined) return;
    if (v.stage === "done" || v.stage === "cancelled") return;
    let at: string;
    if (ev.kind === "supervisor_merged") {
      if (ev.head !== v.p.head) return;
      at = ev.sha?.slice(0, 7) ?? "an unknown commit";
    } else if (ev.kind === "merge_checked") {
      if (ev.view.state !== "MERGED" || ev.view.baseRefName !== v.release_branch) return;
      at = ev.view.mergeCommit?.oid?.slice(0, 7) ?? "an unknown commit";
    } else return;
    await this.deps.resolveOpen(
      task,
      SUPERSEDED_BY_MERGE,
      `PR #${v.p.pr.number} merged into ${v.release_branch} at ${at}`,
    );
  }

  // --- Merge nudge (SPEC §4.6.15): volleyd never rebases; it tells the implementers. ---

  /**
   * `task`'s PR merged: send one steering to each running implementer of the wave that
   * `placement.nudge_on_merge` picks (`files`: its files hints overlap the PR's changed files,
   * read with `gh pr view --json files` beside the queue; `all`; `off`: none), journaled as
   * `merge_nudge_sent`. At most one nudge per agent and merged PR, however often it is called.
   */
  async nudgeMerged(task: TaskId): Promise<void> {
    const mode = this.deps.nudgeOnMerge?.() ?? CONFIG_DEFAULTS.placement.nudge_on_merge;
    const v = this.view(task);
    const pr = v?.p.pr;
    if (v === null || pr === undefined || mode === "off") return;
    if (this.unnudged(task, pr.number).length === 0) return;
    if (mode === "all") {
      await this.sendNudges(task, pr, [], "all");
      return;
    }
    const key = `${task}/merge_nudge`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const p: Promise<void> = this.ghExec(task)([
      "gh",
      "pr",
      "view",
      String(pr.number),
      "--json",
      "files",
    ])
      .then((r) => {
        const files = r.code === 0 ? parsePrFiles(r.stdout) : null;
        if (files === null)
          throw new Error(
            `gh pr view ${pr.number} --json files: ${r.stderr.trim() || "no file list"}`,
          );
        return files;
      })
      .then(
        (files) => {
          this.inflight.delete(key);
          return this.deps.enqueue(() => this.sendNudges(task, pr, files, "files"));
        },
        async (e: unknown) => {
          this.inflight.delete(key);
          await this.deps.enqueue(() => this.alarmError(task, "merge_nudge", e));
        },
      )
      .catch((e: unknown) => this.deps.log?.(`pipeline ${this.wave}/${task}: ${String(e)}`))
      .finally(() => this.chains.delete(p));
    this.chains.add(p);
  }

  /**
   * A merged task's nudges that never went out (the daemon stopped before they were sent, or the
   * PR's file list could not be read): send them, once per re-check interval until they are.
   * Idempotent through `merge_nudge_sent`; what is left after a restart is re-read once.
   */
  private async renudge(task: TaskId): Promise<void> {
    const p = this.deps.record().pipeline[task];
    if (p?.merged_seq === undefined || p.pr === undefined) return;
    const done = `${task}#${p.pr.number}`;
    if (this.nudgesDone.has(done)) return;
    if (this.unnudged(task, p.pr.number).length === 0) {
      // No implementer cut before the merge is left to tell: none ever will be.
      this.nudgesDone.add(done);
      this.lastCheck.delete(nudgeKey(task));
      return;
    }
    if (this.due(nudgeKey(task))) await this.nudgeMerged(task);
  }

  /**
   * The wave's running implementers (other tasks) not yet nudged about merged PR `pr`, cut from
   * the release branch before the merge (one spawned after it already has it).
   */
  private unnudged(task: TaskId, pr: number): RunningImplementer[] {
    const rec = this.deps.record();
    const mergedSeq = rec.pipeline[task]?.merged_seq;
    return (rec.state?.tasks ?? []).flatMap((t) => {
      if (t.id === task || t.stage === "done" || t.stage === "cancelled") return [];
      const p = rec.pipeline[t.id];
      const run = p?.runs.implementer;
      if (run === undefined || run.retired !== undefined) return [];
      if (mergedSeq !== undefined && (run.spawned_seq ?? 0) > mergedSeq) return [];
      if ((p?.nudged ?? []).includes(`${run.agent_id}#${pr}`)) return [];
      return [{ task: t.id, agent_id: run.agent_id, files: rec.wave?.tasks[t.id]?.files ?? [] }];
    });
  }

  /** On the queue: steer and journal each nudge the merged PR's `files` call for. */
  private async sendNudges(
    task: TaskId,
    pr: { number: number; url: string },
    files: string[],
    mode: NudgeOnMerge,
  ): Promise<void> {
    const v = this.view(task);
    if (v === null) return;
    for (const n of nudgeTargets(this.unnudged(task, pr.number), files, mode)) {
      const text = nudgeText({
        release_branch: v.release_branch,
        sha: v.p.merged_sha ?? null,
        pr: pr.number,
        files: n.files,
      });
      await this.deps.steer(n.task, "implementer", n.agent_id, text, "merge_nudge");
      await this.deps.journal({
        type: "merge_nudge_sent",
        task: n.task,
        data: {
          task: n.task,
          agent_id: n.agent_id,
          merged_pr: pr.number,
          files: n.files,
          merged_task: task,
          pr_url: pr.url,
          ...(v.p.merged_sha != null ? { release_sha: v.p.merged_sha } : {}),
        },
      });
    }
    this.nudgesDone.add(`${task}#${pr.number}`);
  }

  /** Beside the queue: is the closed PR's head on the release branch anyway? */
  private async landedCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const { pr, head } = v.p;
    if (pr === undefined || head === undefined) return null;
    const at = this.gitAt(v);
    if (at === undefined)
      throw new Error("no worktree or repo root to check the closed PR's head from");
    const { exec: git, ...where } = at;
    const f = await probeLanded(git, {
      ...where,
      head,
      release_branch: v.release_branch,
      pr: pr.number,
    });
    const l = landed(f, head, f.release_sha, pr.number);
    return {
      kind: "landed_checked",
      head,
      landed: l,
      ...(l !== null && l.sha !== head ? { merged_ci: await this.ciOf(v.task, l.sha) } : {}),
    };
  }

  /** Beside the queue, at a review gate: the PR's head as GitHub has it now. */
  private async headCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const pr = v.p.pr;
    if (pr === undefined) return null;
    const r = await this.ghExec(v.task)([
      "gh",
      "pr",
      "view",
      String(pr.number),
      "--json",
      "headRefOid,state",
    ]);
    const view = r.code === 0 ? parsePrView(r.stdout) : null;
    if (view?.state !== "OPEN" || typeof view.headRefOid !== "string") return null;
    return { kind: "pr_head", head: view.headRefOid, expected: v.p.head as string };
  }

  /** Beside the queue: CI on a moved head, its failing tests, and the diff from the gated head. */
  private async movedCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const { moved, pr, branch } = v.p;
    if (moved === undefined || pr === undefined) return null;
    const at = this.gitAt(v);
    if (branch === undefined || at === undefined)
      throw new Error("no PR branch / worktree or repo root to check the moved head from");
    const { exec: git, ...where } = at;
    const via = this.runsVia();
    const facts = await probeMovedHead(this.ghExec(v.task, git), {
      ...where,
      branch,
      from: moved.from,
      to: moved.to,
      release_branch: v.release_branch,
      ...(via !== undefined ? { runs_via: via } : {}),
    });
    await this.noteCi(v.task, facts.ci);
    const key = `${v.task}/${moved.to}`;
    let waited = 0;
    if (facts.ci.state === "none") {
      const first = this.noCiSince.get(key) ?? this.now();
      this.noCiSince.set(key, first);
      waited = this.now() - first;
    } else if (facts.ci.state === "unknown") this.noCiSince.delete(key);
    return {
      kind: "moved_ci",
      to: moved.to,
      facts,
      pr: { number: pr.number, url: pr.url },
      at: this.now(),
      waited_ms: waited,
    };
  }

  /**
   * CI on a merged commit other than the gated head, read from the repo root; `unknown` when it
   * cannot be read (or there is no repo root).
   */
  async ciOf(task: TaskId, sha: string): Promise<MergedCi> {
    if (this.ciBackedOff()) return "unknown";
    const cwd = this.ghCwd();
    if (cwd === undefined) return "unknown";
    try {
      const ci = await ciReport(this.ghExec(task), cwd, sha, this.runsVia());
      await this.noteCi(task, ci);
      return ci.state;
    } catch {
      return "unknown";
    }
  }

  /**
   * `volleyd merged <wave> <task> --sha <sha>`: verify the owner's merge outside GitHub (read-only
   * git, off the serial queue). An ok is folded in by handing `operator_merged` to `handle`.
   */
  async verifyMerge(task: TaskId, sha: string): Promise<OperatorMergeCheck & { head?: string }> {
    const v = this.view(task);
    if (v === null) return { ok: false, error: `unknown task '${task}'` };
    const { pr, head } = v.p;
    if (v.stage === "done" || v.stage === "cancelled")
      return { ok: false, error: `task '${task}' is ${v.stage}` };
    if (pr === undefined || head === undefined)
      return { ok: false, error: `task '${task}' has no verified PR head yet` };
    const at = this.gitAt(v);
    if (at === undefined)
      return { ok: false, error: `task '${task}' has no worktree or repo root at its head` };
    const { exec: git, ...where } = at;
    const r = await verifyOperatorMerge(git, {
      ...where,
      head,
      sha,
      release_branch: v.release_branch,
    });
    return r.ok ? { ...r, head } : r;
  }

  /** The task's gated (verified) PR head. */
  headOf(task: TaskId): string | undefined {
    return this.view(task)?.p.head;
  }

  /** The gate's MergeToken; none (a human merges) for a head the fence cannot match exactly. */
  private mintFor(task: TaskId, pr: number, head: string, v: PipelineView): MergeToken | undefined {
    try {
      return mintMergeToken({ wave: this.wave, task, pr, head, release_branch: v.release_branch });
    } catch (e) {
      this.deps.log?.(`pipeline ${this.wave}/${task} merge token: ${String(e)}`);
      this.mintFailed.set(task, head);
      return undefined;
    }
  }

  /**
   * Autopilot merging: `gh pr merge` the token's PR at exactly its head (src/autopilot/merge.ts),
   * fenced by the token. Merged → `supervisor_merged`; refused → `merge_refused`.
   */
  private async merge(
    v: PipelineView,
    token: MergeToken,
    by?: string,
  ): Promise<PipelineEvent | null> {
    // A merge is the supervisor's act (its gh login, its MergeToken): it runs here, in the wave's
    // repo, whatever machine the task's agents ran on. A paired machine's fence never holds a
    // MergeToken, so a merge sent there would always be refused.
    const repo = this.deps.record().state?.repo;
    const r =
      repo != null
        ? await mergePr(
            this.timed(this.deps.exec),
            token,
            repo,
            this.deps.deleteBranch?.() ?? false,
          )
        : await mergePr(
            this.io(v.task),
            token,
            this.headWorktree(v.p),
            this.deps.deleteBranch?.() ?? false,
          );
    return r.ok
      ? {
          kind: "supervisor_merged",
          sha: r.merge_sha,
          head: token.head,
          ...(by !== undefined ? { by } : {}),
        }
      : { kind: "merge_refused", stderr: r.stderr, head: token.head, reason: r.reason };
  }

  /**
   * Write the evidence package and enter merge_ready; under `merge: auto` mint the MergeToken
   * for exactly this PR and head (the only place one is minted). Re-run at merge_ready (a
   * restart lost the token), it rewrites the evidence and mints again without re-entering.
   */
  private async gate(
    task: TaskId,
    check: RebaseCheck,
    diffstats: Record<string, string>,
  ): Promise<void> {
    const rec = this.deps.record();
    const v = this.view(task);
    if (v === null) return;
    const { p } = v;
    const { head, pr } = p;
    if (head === undefined || pr === undefined) return;
    // The invariant again, at the transition itself (next() alarms on a violation).
    if (!mergeReadyCheck(v.stages, p).ok) return;
    const fixups: EvidenceInput["fixups"] = p.fixups.map(({ worktree: _w, ...f }) => {
      const stat = f.from !== undefined ? diffstats[`${f.from}..${f.to}`] : undefined;
      return { ...f, ...(stat !== undefined ? { diffstat: stat } : {}) };
    });
    const ruled = p.disagreement;
    const notBlockers: Disagreement[] =
      ruled !== undefined && answerIsFine(ruled.answer)
        ? findDisagreements(reviewsOfRound(p, ruled.round))
        : [];
    const baseSha = rec.state?.tasks.find((t) => t.id === task)?.base_sha;
    const token = v.merge === "auto" ? this.mintFor(task, pr.number, head, v) : undefined;
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
      ...(p.ci_superseded !== undefined ? { ci_superseded: p.ci_superseded } : {}),
      reviews: p.reviews,
      fixups,
      rebases: p.rebases,
      moves: p.moves,
      head_history: [...new Set([...(p.gated ?? []), ...p.moves.map((m) => m.to), head])],
      ...(notBlockers.length > 0
        ? { not_blockers: notBlockers, ...(ruled?.by !== undefined ? { ruled_by: ruled.by } : {}) }
        : {}),
      ...(baseSha !== undefined ? { base_sha: baseSha } : {}),
      release: check,
      merge: token !== undefined ? "auto" : "manual",
      generated_at: new Date(this.now()).toISOString(),
    };
    const paths = writeEvidence(this.deps.home, input);
    // Usable only once the evidence that describes its head is written.
    if (token !== undefined) this.mergeTokens.set(task, token);
    // The merge turn's task, gated up to date with the release branch: it may merge now.
    if (token !== undefined && this.turn?.task === task) this.turn.fresh = true;
    if (v.stage === "merge_ready" && p.gated.at(-1) === head) return;
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

function parsePrView(text: string): PrView | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as PrView) : null;
  } catch {
    return null;
  }
}
