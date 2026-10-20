import {
  type ArtifactReport,
  type CiRun,
  type CiState,
  type Landed,
  type MovedHeadFacts,
  type OperatorMergeCheck,
  type RebaseCheck,
  type ReleaseMerge,
  type SupersededRun,
  artifactOutcome,
  checkRebase,
  ciStateOf,
  landed,
  probeLanded,
  probeMovedHead,
  verifyArtifacts,
  verifyOperatorMerge,
} from "./artifacts";
import type { Role } from "./brief";
import { systemClock } from "./clock";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput, DecisionRecord } from "./decisions";
import { type EvidenceInput, markEvidenceStale, writeEvidence } from "./evidence";
import type { ExecFn, ExecOptions, ExecResult } from "./exec";
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
}

export interface MovedHead {
  from: string;
  to: string;
  during: TaskStage;
  /** Its pr_head_moved decision is open. */
  asked?: boolean;
}

/** A moved head's fixup directive (kept on the pr_head_moved decision as `directive`). */
export interface Directive {
  from: string;
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
    | "ci_failed"
    | "ci_none"
    | "review_result"
    | "fixup_result"
    | "agent_failed"
    | "agent_blocked"
    | "reviewers_disagree"
    | "merge_ready_invariant"
    | "relaunch"
    | "spawn_failed"
    | "pr_closed"
    | "pr_head_moved";
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
        spawned_seq: ev.seq,
      };
      if (role === "implementer" && typeof d.branch === "string") p.branch = d.branch;
      break;
    case "stage_entered":
      p.why = typeof d.why === "string" ? d.why : undefined;
      if (Array.isArray(d.roles)) {
        p.step = d.step as number;
        p.roles = (d.roles as unknown[]).filter(isRole);
        p.rebasing = d.rebase === true;
        p.branch_update = p.rebasing && d.branch_update === "merge" ? "merge" : undefined;
        p.rereview = [];
        if (typeof d.review_round === "number") p.round = d.review_round;
        for (const r of p.roles) delete p.runs[r];
      } else if (d.stage === "implement") {
        // Journaled by the spawn itself, after its agent_spawned: keep that run.
        const i = ctx.stages.findIndex((g) => g.includes("implement"));
        p.step = i >= 0 ? i : 0;
        p.roles = ["implementer"];
        p.rebasing = false;
        p.branch_update = undefined;
      }
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
      if (role === "merged") {
        // Where the release branch moved to; never the PR head (a squash or rebase merge is not it).
        const sha = [d.merge_sha, d.sha].find((x) => typeof x === "string");
        p.merged_sha = (sha as string | undefined) ?? null;
        p.merged_seq = ev.seq;
      }
      if (role === "gate" && typeof d.head_sha === "string") {
        p.gated = p.gated ?? [];
        if (p.gated.at(-1) !== d.head_sha) p.gated.push(d.head_sha);
      }
      if (role === "fixup") p.directive = undefined;
      if (!isRole(role)) break;
      const run = p.runs[role];
      const from = p.head;
      if (run !== undefined) {
        run.accepted = true;
        if (PUBLISHING_ROLES.has(role) && typeof d.head_sha === "string") run.head = d.head_sha;
      }
      if (typeof d.head_sha === "string") p.head = d.head_sha;
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
      if (run !== undefined && run.agent_id === d.agent_id && d.status !== "superseded") {
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
      if (typeof d.from === "string" && typeof d.to === "string")
        p.moved = { from: d.from, to: d.to, during: d.during as TaskStage };
      if (p.pr === undefined && typeof d.pr === "string" && typeof d.pr_number === "number")
        p.pr = { number: d.pr_number, url: d.pr };
      break;
    case "ci_pending":
      if ((isRole(role) || role === "moved") && typeof d.sha === "string")
        p.ci_hold = {
          role,
          sha: d.sha,
          checks: d.checks as CiHold["checks"],
          next_poll_at: String(d.next_poll_at),
          ...(d.pr !== undefined ? { pr: d.pr as NonNullable<CiHold["pr"]> } : {}),
        };
      break;
    case "ci_green":
    case "decision_opened":
    case "task_cancelled":
      // Settled, or someone is asked about it: the hold is over.
      p.ci_hold = undefined;
      if (ev.type === "task_cancelled") p.moved = undefined;
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
        } else if (
          isAnswer(answer, "cancel") ||
          (isAnswer(answer, "accept") && (ctx.decision?.options ?? []).includes("accept"))
        )
          // accept: the head moves with the artifact_verified onResolved journals next.
          p.moved = undefined;
      }
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
  /** The `branch_update` tunable now (absent: rebase): read when a rebase step starts. */
  branch_update?: BranchUpdate;
  /** How review results treat public hygiene (absent: p1): reviews.ts parseReviewResult. */
  hygiene?: HygieneLevel;
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
      what: "verify" | "check_rebase" | "check_merged" | "watch_head" | "check_landed" | "moved_ci";
      role?: Role;
      agent_id?: string;
      message: string;
      timed_out: boolean;
    }
  | { kind: "decision_resolved"; decision: DecisionRecord };

/** CI on a merged head that is not the gated one; `unknown` when it could not be read. */
export type MergedCi = CiState | "unknown";

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
  /** At the gate: has a human merged the PR? (volleyd only ever reads this.) */
  | { kind: "check_merged" }
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
      if (v.stage === "cancelled" || v.stage === "merge_ready" || ev.head !== v.p.head) return [];
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
  if (role === undefined) return [];
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
    // Not through the gate: merged at another head, or before the task reached merge_ready.
    const other = merged !== undefined && merged !== head;
    const unverified = other || v.stage !== "merge_ready";
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
  return [];
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
  const waiting =
    ci.state === "running" ||
    (ci.state === "none" && ev.waited_ms < DAEMON_DEFAULTS.ci_none_grace_ms);
  if (waiting) return holdFor(v, "moved", ev.to, ci.runs, ev.pr, ev.at);
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
    // Merged mid-pipeline: whoever is still at work on it stops.
    ...Object.values(v.p.runs).flatMap(retireIfLive),
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
          marker: { on: "verify", role: ev.role },
          decision: {
            kind: "agent_blocked",
            task: v.task,
            question: `${roleLabel(v.p, ev.role)} ${run.agent_id} reported done, but its ${out.missing} is missing (${out.detail}). Fix it by hand and answer re-verify, or cancel the task.`,
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
        const touched = ev.report.kind === "ok" ? ev.report.touched : undefined;
        return [
          ...retireIfLive(run),
          {
            kind: "decide",
            marker: {
              on: "ci_none",
              role: ev.role,
              head: out.head,
              ...(touched !== undefined ? { touched } : {}),
            },
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
      // The pushed work is in place; CI is re-checked on later ticks. The agent is done — the
      // hold is the pipeline's, and it says so (once per change of head or counts).
      return [...ciPending(v, ev, out.head), ...retireIfLive(run)];
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

/** The `ci_pending` event for a verification whose CI is still running (or has no run yet). */
function ciPending(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "verified" }>,
  head: string,
): PipelineAction[] {
  if (ev.report.kind !== "ok") return [];
  const { number, url } = ev.report.pr;
  return holdFor(v, ev.role, head, ev.report.ci.runs, { number, url }, ev.at);
}

/** Journal `ci_pending` for `role`'s head (once per change of head or counts). */
function holdFor(
  v: PipelineView,
  role: Role | "moved",
  head: string,
  runs: CiRun[],
  pr: { number: number; url: string },
  at: number | undefined,
): PipelineAction[] {
  const checks = { done: runs.filter((r) => r.status === "completed").length, total: runs.length };
  const hold = v.p.ci_hold;
  if (
    hold?.role === role &&
    hold.sha === head &&
    hold.checks.done === checks.done &&
    hold.checks.total === checks.total
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
        },
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

/**
 * A role's agent is blocked: ask the owner. Nothing is retired (the agent may be waiting on its
 * mailbox); `continue` waits for its next status, `respawn` relaunches the role.
 */
function onBlocked(
  v: PipelineView,
  ev: Extract<PipelineEvent, { kind: "agent_blocked" }>,
): PipelineAction[] {
  const run = v.p.runs[ev.role];
  if (run === undefined || run.agent_id !== ev.agent_id || run.accepted || v.stage === "cancelled")
    return [];
  const label = roleLabel(v.p, ev.role);
  const max = DAEMON_DEFAULTS.blocked_reason_max_chars;
  // By code point, so a clip never splits a surrogate pair.
  const chars = Array.from(ev.reason);
  const reason = chars.length > max ? `${chars.slice(0, max).join("")}…` : ev.reason;
  return [
    {
      kind: "decide",
      marker: { on: "agent_blocked", role: ev.role },
      decision: {
        kind: "agent_blocked",
        task: v.task,
        question: `${ev.agent_id} (${label}) is blocked: ${reason}. continue: you steered it and it goes on; respawn the ${label}; or cancel the task?`,
        options: ["continue", "respawn", "cancel"],
      },
      data: {
        agent_id: ev.agent_id,
        reason: ev.reason,
        payload: ev.payload,
        ...(ev.at !== undefined ? { status_at: ev.at } : {}),
      },
    },
  ];
}

/** A role as the owner reads it: the rebase role of a merge-mode step is the merge it runs. */
const roleLabel = (p: TaskPipeline, role: Role): string =>
  role === "rebase" && p.branch_update === "merge" ? "merge (branch update)" : role;

/** The prefix a re-ask puts before the original question (dropped before it is asked again). */
const ASKED_AGAIN = /^".*?" (is not one of|needs the commit that carries it:) [^.]*\. /;

function onResolved(v: PipelineView, d: DecisionRecord): PipelineAction[] {
  const m = (d as { pipeline?: PipelineMarker }).pipeline;
  const answer = d.resolved?.answer ?? "";
  if (m === undefined || d.task !== v.task) return [];
  // Merged meanwhile (`volleyd merged`, GitHub): no answer brings a done task back.
  if (v.stage === "done") return [];
  if (m.on === "relaunch") return onRelaunchResolved(v, d, m, answer);
  if (isAnswer(answer, "cancel")) {
    // A blocked agent is still live (SPEC §5.2): it is stopped with the task.
    const blocked = m.on === "agent_blocked" && m.role !== undefined ? v.p.runs[m.role] : undefined;
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
    case "ci_failed":
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
    case "agent_blocked": {
      // continue: the owner steered it by hand; its next status is handled as usual.
      if (isAnswer(answer, "continue")) return [];
      const agent = (d as { agent_id?: unknown }).agent_id;
      if (role === undefined || typeof agent !== "string") return [];
      if (isAnswer(answer, "respawn")) {
        // It went on and was accepted before the answer (steered by hand): keep that work.
        if (run !== undefined && run.agent_id === agent)
          return run.accepted || run.retired !== undefined
            ? []
            : [{ kind: "relaunch", role, agent_id: agent }];
        // A newer run of the role already replaced it: only make sure the old agent is gone.
        return [{ kind: "retire", agent_id: agent, status: "relaunched" }];
      }
      return reask();
    }
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
 * retires it and blocks the task with the decision text. Anything else is asked again.
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
  return [
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
    },
  ];
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
  // volleyd never merges; a gated task becomes done once a human has merged its PR.
  if (v.stage === "merge_ready" && p.pr !== undefined) return [{ kind: "check_merged" }];
  if (IDLE.has(v.stage) || p.step < 0) return [];
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
    // Retired without being accepted: its CI was pending. Re-check (the driver rate-limits).
    else if (!run.accepted && run.retired === "done" && PUBLISHING_ROLES.has(r))
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
    return toGate(v);
  }
  return enter(v, p.step + 1);
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
  const merge = v.branch_update === "merge";
  // spawnFor reads the step's mode, which the stage_entered below fixes.
  const after: PipelineView = { ...v, p: { ...v.p, branch_update: merge ? "merge" : undefined } };
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
  const lines = [
    "# Directive: the PR head moved",
    "",
    `The PR head moved from \`${short(d.from)}\` to \`${short(d.to)}\` outside the pipeline, after a gate (\`${short(d.from)}..${short(d.to)}\`). This worktree starts at the new head. This directive is your first job.`,
    "",
    `## CI on ${short(d.to)}: ${d.ci}`,
    "",
  ];
  if (d.ci === "red") {
    lines.push("Failed jobs:", "", ...d.failed_jobs.map((j) => `- ${j}`), "");
    lines.push(
      "Failing tests:",
      "",
      ...(d.failing_tests.length > 0
        ? d.failing_tests.map((t) => `- \`${t}\``)
        : ["- (none found in the logs: read the failed jobs)"]),
      "",
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
    `## What changed ${short(d.from)}..${short(d.to)}`,
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

/**
 * `.volley/rebase.md` under `branch_update: merge`: bring the PR branch up to date by merging the
 * release branch in, and publish it with a normal push (no force-push of any kind).
 */
function renderMergeMd(c: BriefCtx): string {
  return [
    "# Merge",
    "",
    `\`${c.release_branch}\` moved since \`${c.pr_branch}\` branched from it. This worktree starts at the PR head \`${c.head}\`.`,
    "",
    `    git fetch origin ${c.release_branch}`,
    `    git merge --no-edit origin/${c.release_branch}`,
    "    # resolve conflicts, keep the PR's intent; commit the merge; run the repository's gates",
    `    git push origin HEAD:${c.pr_branch}`,
    "",
    `That push moves \`${c.pr_branch}\` forward: its new head must descend from \`${c.head}\`. Never rewrite the branch's history. PR: ${c.pr_url}.`,
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
  now?: () => number;
  log?: (line: string) => void;
}

/** A pipeline git / gh call that hit its hard timeout: "not verified yet", never an alarm. */
class IoTimeout extends Error {}

/**
 * What the daemon checks before a pipeline role spawn (the implementer's spawn is admitted per
 * task by the scheduler): the kill switch, the wave running, T5's admission verdict and the
 * wave's spawn budget. Null: spawn now; a reason: hold it (the next tick asks again). Pure.
 */
export function roleSpawnHold(o: {
  killSwitch: boolean;
  running: boolean;
  admission: number;
  reasons?: string[];
  used: number;
  budget: number;
}): string | null {
  if (o.killSwitch) return "kill switch engaged";
  if (!o.running) return "wave not running";
  if (o.admission < 1) return `admission closed: ${(o.reasons ?? []).join(", ") || "no capacity"}`;
  if (o.used >= o.budget) return `spawn budget exhausted (${o.used}/${o.budget})`;
  return null;
}

/** The merge-nudge re-check's rate-limit key: outside `<task>/`, so `forget` keeps it. */
const nudgeKey = (task: TaskId) => `merge_nudge:${task}`;

/** Executes the interpreter's actions for one wave. Call it from one serial queue. */
export class PipelineDriver {
  /** Last level-triggered re-check per `<task>/<what>` (verify, check_rebase, check_merged). */
  private readonly lastCheck = new Map<string, number>();
  /** Alarms already journaled by this driver (each condition is alarmed once per process). */
  private readonly alarmed = new Set<string>();
  /** When each `<task>/<head>` was first seen with no CI run at all. */
  private readonly noCiSince = new Map<string, number>();
  /** Checks whose I/O is running beside the queue, by `<task>/<what>[/<agent>]`; one per key. */
  private readonly inflight = new Set<string>();
  /** Every check until its result has been folded back in (what `settled` waits for). */
  private readonly chains = new Set<Promise<void>>();
  /** Merged `<task>#<pr>` whose nudges this process has sent (or found none left to send). */
  private readonly nudgesDone = new Set<string>();

  constructor(
    private readonly wave: WaveId,
    private readonly deps: PipelineDeps,
  ) {}

  private now(): number {
    // real clock: the default when the daemon injects no clock
    return (this.deps.now ?? systemClock.now)();
  }

  /** The task's fenced exec with the pipeline's hard timeout; a timeout throws `IoTimeout`. */
  private io(task: TaskId): ExecFn {
    const exec = this.deps.execFor?.(task) ?? this.deps.exec;
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
    return {
      task,
      stages: wt.stages,
      stage: t.stage,
      release_branch: rec.state.release_branch,
      p: rec.pipeline[task] ?? emptyPipeline(),
      ...(this.deps.branchUpdate !== undefined ? { branch_update: this.deps.branchUpdate() } : {}),
      ...(this.deps.hygiene !== undefined ? { hygiene: this.deps.hygiene() } : {}),
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
  }

  /** Resolves once no check is running beside the queue (tests; a graceful stop). */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains]);
  }

  /** Drop a finished task's rate-limit and no-CI bookkeeping (the maps stay bounded). */
  private forget(task: TaskId): void {
    for (const m of [this.lastCheck, this.noCiSince])
      for (const k of m.keys()) if (k.startsWith(`${task}/`)) m.delete(k);
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
        case "decide":
          await this.deps.decide(a.decision, { ...(a.data ?? {}), pipeline: a.marker });
          progressed = true;
          break;
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
          if (this.inflight.has(key) || (!eventDriven && !this.due(key))) break;
          this.lastCheck.set(key, this.now());
          this.beside(task, key, { what: "verify", role: a.role, agent_id: agent }, () =>
            this.verify(task, a.role, agent, a.result),
          );
          break;
        }
        case "check_rebase": {
          const v = this.view(task);
          const key = `${task}/check_rebase`;
          if (v?.p.head === undefined || this.inflight.has(key)) break;
          if (!eventDriven && !this.due(`${task}/check_rebase/${v.p.head}`)) break;
          this.beside(task, key, { what: "check_rebase" }, () => this.gateCheck(v));
          break;
        }
        case "check_merged": {
          const v = this.view(task);
          const key = `${task}/check_merged`;
          if (v?.p.pr === undefined || this.inflight.has(key) || !this.due(key)) break;
          this.beside(
            task,
            key,
            { what: "check_merged" },
            () => this.mergeCheck(v),
            (ev) => this.supersedeOnMerge(task, ev),
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
          if (v?.p.moved === undefined || this.inflight.has(key)) break;
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
    let report = await verifyArtifacts(this.io(task), {
      cwd: run.worktree,
      branch: v.p.branch,
      release_branch: v.release_branch,
      ...(since !== undefined ? { since } : {}),
      ...(run.adopt === true ? { adopt: true } : {}),
    });
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
    if (report.kind === "ok" && report.ci.state === "none") {
      const key = `${task}/${report.head}`;
      const first = this.noCiSince.get(key) ?? this.now();
      this.noCiSince.set(key, first);
      waited = this.now() - first;
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
   * Beside the queue, before the gate: the PR is still at the verified head (`gh pr view`), and
   * the release branch has not moved past it; plus each fixup's diffstat for the evidence.
   */
  private async gateCheck(v: PipelineView): Promise<PipelineEvent> {
    const { p } = v;
    const io = this.io(v.task);
    const head = p.head as string;
    const cwd = this.headWorktree(p);
    if (cwd === undefined) throw new Error("no worktree at the PR head");
    if (p.pr !== undefined) {
      const r = await io(
        ["gh", "pr", "view", String(p.pr.number), "--json", "headRefOid,state,baseRefName"],
        { cwd },
      );
      const pr = r.code === 0 ? parsePrView(r.stdout) : null;
      if (pr === null) throw new Error(`gh pr view ${p.pr.number} failed: ${r.stderr.trim()}`);
      if (typeof pr.headRefOid === "string" && pr.headRefOid !== head)
        return { kind: "head_moved", expected: head, actual: pr.headRefOid };
    }
    const check = await checkRebase(io, {
      cwd,
      head,
      release_branch: v.release_branch,
    });
    const diffstats: Record<string, string> = {};
    if (check.behind === 0) {
      for (const f of p.fixups) {
        if (f.from === undefined || f.worktree === undefined) continue;
        const r = await io(["git", "-C", f.worktree, "diff", "--stat", f.from, f.to]);
        // trimEnd only: the first line's leading space is part of git's column alignment.
        if (r.code === 0) diffstats[`${f.from}..${f.to}`] = r.stdout.replace(/^\n+/, "").trimEnd();
      }
    }
    return { kind: "rebase_checked", head, check, diffstats };
  }

  /** Beside the queue, at the gate: the PR as GitHub has it now (read-only; volleyd never merges). */
  private async mergeCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const pr = v.p.pr;
    if (pr === undefined) return null;
    const cwd = this.headWorktree(v.p);
    const r = await this.io(v.task)(
      [
        "gh",
        "pr",
        "view",
        String(pr.number),
        "--json",
        "state,mergedAt,mergeCommit,baseRefName,headRefOid",
      ],
      cwd !== undefined ? { cwd } : {},
    );
    const view = r.code === 0 ? parsePrView(r.stdout) : null;
    if (view === null) return null;
    const merged = view.headRefOid;
    if (view.state === "MERGED" && typeof merged === "string" && merged !== v.p.head)
      return { kind: "merge_checked", view, merged_ci: await this.ciOf(v.task, cwd, merged) };
    return { kind: "merge_checked", view };
  }

  /**
   * On the queue, before a merged PR is handled: close the task's open decisions as
   * `superseded_by_merge` (the reducer keeps a parked task parked on a stage change).
   */
  private async supersedeOnMerge(task: TaskId, ev: PipelineEvent): Promise<void> {
    const v = this.view(task);
    if (ev.kind !== "merge_checked" || v === null || v.p.pr === undefined) return;
    if (v.stage === "done" || v.stage === "cancelled") return;
    if (ev.view.state !== "MERGED" || ev.view.baseRefName !== v.release_branch) return;
    const at = ev.view.mergeCommit?.oid?.slice(0, 7) ?? "an unknown commit";
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
    const cwd = this.headWorktree(v.p);
    const p: Promise<void> = this.io(task)(
      ["gh", "pr", "view", String(pr.number), "--json", "files"],
      cwd !== undefined ? { cwd } : {},
    )
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
    const cwd = this.headWorktree(v.p);
    if (pr === undefined || head === undefined) return null;
    if (cwd === undefined) throw new Error("no worktree to check the closed PR's head from");
    const f = await probeLanded(this.io(v.task), {
      cwd,
      head,
      release_branch: v.release_branch,
      pr: pr.number,
    });
    const l = landed(f, head, f.release_sha, pr.number);
    return {
      kind: "landed_checked",
      head,
      landed: l,
      ...(l !== null && l.sha !== head ? { merged_ci: await this.ciOf(v.task, cwd, l.sha) } : {}),
    };
  }

  /** Beside the queue, at a review gate: the PR's head as GitHub has it now. */
  private async headCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const pr = v.p.pr;
    if (pr === undefined) return null;
    const cwd = this.headWorktree(v.p);
    const r = await this.io(v.task)(
      ["gh", "pr", "view", String(pr.number), "--json", "headRefOid,state"],
      cwd !== undefined ? { cwd } : {},
    );
    const view = r.code === 0 ? parsePrView(r.stdout) : null;
    if (view?.state !== "OPEN" || typeof view.headRefOid !== "string") return null;
    return { kind: "pr_head", head: view.headRefOid, expected: v.p.head as string };
  }

  /** Beside the queue: CI on a moved head, its failing tests, and the diff from the gated head. */
  private async movedCheck(v: PipelineView): Promise<PipelineEvent | null> {
    const { moved, pr, branch } = v.p;
    const cwd = this.headWorktree(v.p);
    if (moved === undefined || pr === undefined) return null;
    if (branch === undefined || cwd === undefined)
      throw new Error("no PR branch / worktree to check the moved head from");
    const facts = await probeMovedHead(this.io(v.task), {
      cwd,
      branch,
      from: moved.from,
      to: moved.to,
      release_branch: v.release_branch,
    });
    const key = `${v.task}/${moved.to}`;
    let waited = 0;
    if (facts.ci.state === "none") {
      const first = this.noCiSince.get(key) ?? this.now();
      this.noCiSince.set(key, first);
      waited = this.now() - first;
    }
    return {
      kind: "moved_ci",
      to: moved.to,
      facts,
      pr: { number: pr.number, url: pr.url },
      at: this.now(),
      waited_ms: waited,
    };
  }

  /** CI on a merged commit other than the gated head; `unknown` when it cannot be read. */
  async ciOf(task: TaskId, cwd: string | undefined, sha: string): Promise<MergedCi> {
    try {
      return await ciStateOf(this.io(task), cwd ?? ".", sha);
    } catch {
      return "unknown";
    }
  }

  /** The worktree the task's PR head is checked out in (pipeline git / gh calls run there). */
  headCwd(task: TaskId): string | undefined {
    const v = this.view(task);
    return v === null ? undefined : this.headWorktree(v.p);
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
    const cwd = this.headWorktree(v.p);
    if (cwd === undefined)
      return { ok: false, error: `task '${task}' has no worktree at its head` };
    const r = await verifyOperatorMerge(this.io(task), {
      cwd,
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

  /** Write the evidence package and enter merge_ready. volleyd never merges. */
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

function parsePrView(text: string): PrView | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as PrView) : null;
  } catch {
    return null;
  }
}
