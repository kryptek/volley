import { type DecisionKind, type DecisionRecord, raiseBy } from "../decisions";
import type { AutopilotConfig, TaskState } from "../types";
import { budgetKey, markerOf } from "./budgets";
import type { FixerVerdict } from "./remediation";

/**
 * The autopilot policy table (SPEC §4.6.16): the routine decisions volleyd answers itself, as
 * data. Pure: the decision record, the effective `autopilot` config and the budgets already used
 * come in as arguments; nothing here reads or writes anything.
 *
 * Rules are evaluated in order; the first whose kind and `when` match wins. An answer the decision
 * does not offer is never given (the rule escalates `no_policy`), and a kind in
 * `autopilot.owner_only` is always the owner's, whatever a rule says.
 */

/** Why a decision is left for the owner (journaled as `decision_escalated.why`). */
export type EscalateWhy = "owner_only" | "no_policy" | "budget_exhausted" | "unattended_safety";

/** A remediation budget: its key in the wave, the answers (or spawns) used and its maximum. */
export interface Budget {
  key: string;
  used: number;
  max: number;
}

/** The remediation budgets counted per wave and key (config `autopilot.<name>`). */
export type CountedBudget =
  | "relaunch_max"
  | "nudge_max"
  | "respawn_max"
  | "rereview_max"
  | "question_max"
  | "ci_fixup_max"
  | "account_move_max"
  | "merge_transient_retry_max";

/** What a counted budget is per: the task, one role of it, or one run (`<task>/<role>/<attempt>`). */
export type BudgetScope = "task" | "task_role" | "run";

export interface PolicyContext {
  autopilot: AutopilotConfig;
  /** Automatic answers already given under a budget key in the wave (budgets.ts budgetUsed). */
  used: (key: string) => number;
  /** The decision's task in the wave state (absent for a wave-level decision). */
  task?: TaskState | undefined;
  /** spawn_budget_exhausted: the wave's derived spawn budget, before any raise. */
  derived_budget?: number | undefined;
  /** A flake's red head: what a fix_flake request gets (remediation.ts fixerFor). */
  fixer?: FixerVerdict | undefined;
}

export type Verdict =
  | { off: true }
  | {
      answer: string;
      policy: string;
      rationale: string;
      evidence: Record<string, unknown>;
      budget?: Budget;
    }
  | { escalate: EscalateWhy; policy?: string; budget?: Budget };

/** A decision record with the daemon's extra facts (pipeline marker, class, agent, …). */
type Facts = DecisionRecord & Record<string, unknown>;

/** A rule's own outcome before the shared guards: an answer, or an escalation. */
type Outcome = { answer: string; budget?: Budget } | { escalate: EscalateWhy; budget?: Budget };

export interface PolicyRule {
  /** `<kind>/<slug>`: what `decision_auto_resolved.policy` names. */
  policy: string;
  kinds: readonly DecisionKind[];
  /** The condition as `volleyd policy` prints it. */
  condition: string;
  when?: (d: Facts, ctx: PolicyContext) => boolean;
  /** The answer (a function when it depends on the decision); null: the rule escalates. */
  answer: string | ((d: Facts, ctx: PolicyContext) => string) | null;
  /** The answer as `volleyd policy` prints it, when `answer` is a function. */
  answer_label?: string;
  /** What a rule with no answer escalates as (default `no_policy`). */
  escalate?: EscalateWhy;
  budget?: { name: CountedBudget; per: BudgetScope };
  /** A rule that checks its own budget (spawn_budget_exhausted's raise, a flake's fixers). */
  decide?: (d: Facts, ctx: PolicyContext, answer: string) => Outcome;
  /** The budget a `decide` rule checks, as `volleyd policy` prints it, and its tunable. */
  decide_budget?: { label: string; name: "budget_raise_max" | "fix_flake_max" };
  rationale: string;
}

/** What a hand coordinator answered an unattended agent's question. */
export const QUESTION_ANSWER =
  "Proceed with your best judgement and the issue as written; you are running unattended. If you truly cannot continue, publish blocked with the reason.";

/** The `budget_raise_max` budget key (one per wave). */
export const RAISE_BUDGET_KEY = "budget_raise_max";

const on = (d: Facts): unknown => markerOf(d)?.on;
const onOneOf =
  (...ons: string[]) =>
  (d: Facts): boolean =>
    ons.includes(String(on(d)));

/** A red head's decision: a ci_failed, or a blocked agent's on a red PR head (`agent_blocked_ci`). */
const onRedHead = onOneOf("ci_failed", "agent_blocked_ci");

/** spawn_failed: the daemon's automatic retries have stopped (`spawn_retry_max`). */
const retriesStopped = (d: Facts, ctx: PolicyContext): boolean =>
  d.stopped === true || ctx.task?.next_retry_at === null;

/** `raise by <n>` as the decision offers it, or null. */
function offeredRaise(d: Facts): { answer: string; n: number } | null {
  for (const o of d.options ?? []) {
    const n = raiseBy(o);
    if (n !== null) return { answer: o, n };
  }
  return null;
}

export const POLICY_TABLE: readonly PolicyRule[] = [
  {
    policy: "spawn_failed/retrying",
    kinds: ["spawn_failed"],
    condition: "next_retry_at !== null (the daemon still retries)",
    when: (d, ctx) => !retriesStopped(d, ctx),
    answer: "retry now",
    rationale: "the daemon retries with backoff; the question is informational",
  },
  {
    policy: "spawn_failed/retries-stopped",
    kinds: ["spawn_failed"],
    condition: "retries stopped (next_retry_at === null)",
    when: retriesStopped,
    answer: null,
    escalate: "budget_exhausted",
    rationale: "spawn_retry_max is the budget",
  },
  {
    policy: "relaunch/bad-launch",
    kinds: ["hooks_auth_failed", "mcp_not_registered", "unknown_screen"],
    condition: 'pipeline.on === "relaunch"',
    when: onOneOf("relaunch"),
    answer: "relaunch",
    budget: { name: "relaunch_max", per: "task_role" },
    rationale: "one relaunch fixes a bad launch; a second needs eyes",
  },
  {
    policy: "unknown_screen/alive",
    kinds: ["unknown_screen"],
    condition: "class: hooks_silent or screen_static (liveness)",
    when: (d) => d.class === "hooks_silent" || d.class === "screen_static",
    answer: "keep running",
    rationale: "the agent is alive; the LWT or its status has the last word",
  },
  {
    policy: "reviewers_disagree/blocker",
    kinds: ["reviewers_disagree"],
    condition: "always",
    answer: "blocker",
    rationale: "the fixup applies it; the P1 reviewer's view costs one fixup, never a bad merge",
  },
  {
    policy: "agent_stalled/nudge",
    kinds: ["agent_stalled"],
    condition: "asked === 1",
    when: (d) => d.asked === 1,
    answer: "nudge again",
    budget: { name: "nudge_max", per: "run" },
    rationale: "one more nudge",
  },
  {
    policy: "agent_stalled/respawn",
    kinds: ["agent_stalled"],
    condition: "asked > 1",
    when: (d) => typeof d.asked === "number" && d.asked > 1,
    answer: "respawn",
    budget: { name: "respawn_max", per: "task_role" },
    rationale:
      "a second stall needs a fresh agent: an implementer continues its pushed branch and PR",
  },
  {
    policy: "agent_blocked/respawn-failed",
    kinds: ["agent_blocked"],
    condition: 'pipeline.on === "agent_failed" or class: respawn_needed',
    when: (d) => on(d) === "agent_failed" || d.class === "respawn_needed",
    answer: "respawn",
    budget: { name: "respawn_max", per: "task_role" },
    rationale: "a fresh agent picks the work up where the failed one left it",
  },
  {
    policy: "agent_blocked/respawn-unverifiable",
    kinds: ["agent_blocked"],
    condition: 'pipeline.on === "verify"',
    when: onOneOf("verify"),
    answer: "respawn",
    budget: { name: "respawn_max", per: "task_role" },
    rationale:
      "re-verifying a retired agent's missing work fails the same way; a fresh one finishes it",
  },
  {
    policy: "agent_blocked/respawn-result",
    kinds: ["agent_blocked"],
    condition: 'pipeline.on === "review_result" or "fixup_result"',
    when: onOneOf("review_result", "fixup_result"),
    answer: "respawn",
    budget: { name: "respawn_max", per: "task_role" },
    rationale: "a fresh agent publishes the result; skip would lose a review",
  },
  {
    policy: "agent_blocked/rereview-stale",
    kinds: ["agent_blocked"],
    condition: 'pipeline.on === "merge_ready_invariant"',
    when: onOneOf("merge_ready_invariant"),
    answer: "rereview",
    budget: { name: "rereview_max", per: "task" },
    rationale: "a re-review is the safe way past a stale review",
  },
  {
    policy: "agent_question/unattended",
    kinds: ["agent_question"],
    condition: "within question_max per run",
    answer: QUESTION_ANSWER,
    budget: { name: "question_max", per: "run" },
    rationale: "what a hand coordinator answered",
  },
  {
    policy: "spawn_budget_exhausted/raise",
    kinds: ["spawn_budget_exhausted"],
    condition: "used + n <= derived budget × budget_raise_max",
    when: (d) => offeredRaise(d) !== null,
    answer: (d) => offeredRaise(d)?.answer ?? "",
    answer_label: "raise by <n> (n from the option)",
    decide: (d, ctx, answer) => {
      const n = offeredRaise(d)?.n ?? 0;
      const used = typeof d.used === "number" ? d.used : 0;
      const derived = ctx.derived_budget ?? (typeof d.budget === "number" ? d.budget : Number.NaN);
      const max = Math.floor(derived * ctx.autopilot.budget_raise_max);
      if (!Number.isFinite(max)) return { escalate: "no_policy" };
      return used + n <= max
        ? { answer, budget: { key: RAISE_BUDGET_KEY, used: used + n, max } }
        : { escalate: "budget_exhausted", budget: { key: RAISE_BUDGET_KEY, used, max } };
    },
    decide_budget: { label: `${RAISE_BUDGET_KEY} (× derived budget)`, name: "budget_raise_max" },
    rationale: "retries are the normal cost of a long wave",
  },
  {
    policy: "machine_down/re-place",
    kinds: ["machine_down"],
    condition: "re-place queued tasks offered",
    answer: "re-place queued tasks",
    rationale: "nothing is lost by re-placing a queued task",
  },
  {
    policy: "agent_account_limit/move",
    kinds: ["agent_account_limit"],
    condition: "suggested !== null",
    when: (d) => typeof d.suggested === "string" && d.suggested !== "",
    answer: (d) => `move ${String(d.agent_id)} to ${String(d.suggested)}`,
    answer_label: "move <agent> to <suggested>",
    budget: { name: "account_move_max", per: "task_role" },
    rationale:
      "the account is at the warn level and another login on the machine has room; the move restarts the session with a resume note",
  },
  {
    policy: "agent_account_limit/wait",
    kinds: ["agent_account_limit"],
    condition: "suggested === null",
    answer: "not now",
    rationale:
      "no other login on the machine has room; the agent finishes where it is and the window resets",
  },
  {
    policy: "account_limit/move",
    kinds: ["account_limit"],
    condition: "suggested !== null",
    when: (d) => typeof d.suggested === "string" && d.suggested !== "",
    answer: (d) => `move wave ${d.wave} to ${String(d.suggested)}`,
    answer_label: "move wave <wave> to <suggested>",
    rationale: "the daemon suggested a healthy account",
  },
  {
    policy: "account_limit/wait",
    kinds: ["account_limit"],
    condition: "suggested === null",
    answer: "not now",
    rationale:
      "no account on the machine has headroom; new agents take the one with the most room; wait for the reset",
  },
  {
    policy: "pr_head_moved/accept",
    kinds: ["pr_head_moved"],
    condition: "a green merge of the release branch only (accept offered)",
    when: (d) => {
      const merge = (d.directive as { release_merge?: { only_release?: unknown } } | undefined)
        ?.release_merge;
      return d.ci === "green" && merge?.only_release === true;
    },
    answer: "accept",
    rationale: "a release-branch merge into the PR is not new code",
  },
  {
    policy: "pr_head_moved/rereview",
    kinds: ["pr_head_moved"],
    condition: "otherwise (rereview offered)",
    answer: "rereview",
    budget: { name: "rereview_max", per: "task" },
    rationale: "nobody reviewed the new head",
  },
  {
    policy: "wave_complete/acknowledge",
    kinds: ["wave_complete"],
    condition: "always",
    answer: "acknowledged",
    rationale: "the end of a wave needs no answer; the owner reads its outcome",
  },
  {
    policy: "ci_failed/fixup-own-change",
    kinds: ["ci_failed", "agent_blocked"],
    condition:
      'pipeline.on === "ci_failed" or "agent_blocked_ci", and classification: own_change (unclassified ci_failed: infra === false)',
    when: (d) =>
      onRedHead(d) &&
      (d.classification === "own_change" ||
        (on(d) === "ci_failed" && d.classification === undefined && d.infra === false)),
    answer: "fixup",
    budget: { name: "ci_fixup_max", per: "task" },
    rationale: "a fixup agent with the CI result as its directive is what a person would do",
  },
  {
    policy: "ci_failed/fix-flake",
    kinds: ["ci_failed", "agent_blocked"],
    condition:
      'pipeline.on === "ci_failed" or "agent_blocked_ci", and classification: flake (no fixer can take it: escalate)',
    when: (d) => onRedHead(d) && d.classification === "flake",
    answer: "fix flake",
    // No fixer can take it (autopilot.fix_flake_max reached, its fixer closed): the owner's.
    decide: (_d, ctx, answer) => {
      const f = ctx.fixer;
      if (f !== undefined && "over_budget" in f)
        return { escalate: "budget_exhausted", budget: f.over_budget };
      if (f !== undefined && "refuse" in f) return { escalate: "unattended_safety" };
      return { answer };
    },
    decide_budget: { label: "fix_flake_max per <wave> (fixers)", name: "fix_flake_max" },
    rationale:
      "a test the PR does not touch gets a dedicated fixer, never a re-run or a wider scope",
  },
  {
    policy: "ci_failed/infra-incident",
    kinds: ["ci_failed"],
    condition:
      "classification: infra_incident (asked only once autopilot.incident_wait_max_s passed)",
    when: (d) => on(d) === "ci_failed" && d.classification === "infra_incident",
    answer: null,
    escalate: "budget_exhausted",
    rationale: "the incident outlasted the wait: the owner decides; volleyd never re-runs CI",
  },
  {
    policy: "ci_failed/owner",
    kinds: ["ci_failed"],
    condition: "otherwise (ci_none included)",
    answer: null,
    rationale: "a red head no rule routes and a repository without workflows are the owner's",
  },
  {
    policy: "merge_conflict/respawn",
    kinds: ["merge_conflict"],
    condition: "within respawn_max per task/role",
    answer: "respawn",
    budget: { name: "respawn_max", per: "task_role" },
    rationale:
      "a fresh rebase (or merge) agent retries the update; a conflict it cannot resolve either is the owner's",
  },
  {
    policy: "merge_refused/draft",
    kinds: ["merge_refused"],
    condition:
      "the last refusal: the PR is a draft (reason: draft) and marking it ready has not failed (no ready_failed)",
    when: (d) => d.reason === "draft" && d.ready_failed !== true,
    answer: "retry",
    rationale:
      "a draft is marked ready and merged once the CI that starts then passes; a retry does exactly that",
  },
  {
    policy: "merge_refused/transient",
    kinds: ["merge_refused"],
    condition:
      "the last refusal was transient (reason: transient) and the backoff ladder is spent (transient_attempts)",
    when: (d) => d.reason === "transient" && typeof d.transient_attempts === "number",
    answer: "retry",
    budget: { name: "merge_transient_retry_max", per: "task" },
    rationale:
      "GitHub was busy or unreachable, not refusing the change: a retry starts the backoff ladder again; a refusal that outlasts it twice is the owner's",
  },
  {
    policy: "pr/owner",
    kinds: ["pr_closed", "remote_repo_missing"],
    condition: "always",
    answer: null,
    rationale: "where the work went, or a clone that is missing, is the owner's call",
  },
  {
    policy: "terminal/owner",
    kinds: ["terminal_status_lost"],
    condition: "always",
    answer: null,
    rationale:
      "a status the supervisor could not hand over even on recovery: the owner checks the work",
  },
];

/** The facts a rule looked at, journaled as `decision_auto_resolved.evidence`. */
const EVIDENCE = [
  "pipeline",
  "class",
  "asked",
  "agent_id",
  "role",
  "stopped",
  "suggested",
  "acct",
  "pct",
  "ci",
  "infra",
  "classification",
  "used",
  "budget",
  "host",
] as const;

function evidenceOf(d: Facts, ctx: PolicyContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EVIDENCE) if (d[k] !== undefined) out[k] = d[k];
  if (ctx.task?.next_retry_at !== undefined) out.next_retry_at = ctx.task.next_retry_at;
  if (d.options !== undefined) out.options = d.options;
  return out;
}

/** The option the decision offers for `answer`, as it spells it (`answer`, for free text). */
const offered = (d: DecisionRecord, answer: string): string | undefined =>
  d.options === undefined
    ? answer
    : d.options.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());

/** The table's answer for a decision, its escalation, or `{ off }` when autopilot is disabled. */
export function evaluate(
  d: DecisionRecord,
  ctx: PolicyContext,
  rules: readonly PolicyRule[] = POLICY_TABLE,
): Verdict {
  if (!ctx.autopilot.enabled) return { off: true };
  if (ctx.autopilot.owner_only.includes(d.kind)) return { escalate: "owner_only" };
  const f = d as Facts;
  const rule = rules.find((r) => r.kinds.includes(d.kind) && (r.when?.(f, ctx) ?? true));
  if (rule === undefined) return { escalate: "no_policy" };
  const { policy } = rule;
  if (rule.answer === null) return { escalate: rule.escalate ?? "no_policy", policy };
  const asked = typeof rule.answer === "function" ? rule.answer(f, ctx) : rule.answer;
  const answer = asked === "" ? undefined : offered(d, asked);
  if (answer === undefined) return { escalate: "no_policy", policy };
  let outcome: Outcome = { answer };
  if (rule.decide !== undefined) outcome = rule.decide(f, ctx, answer);
  else if (rule.budget !== undefined) {
    const key = budgetKey(rule.budget, d, ctx.task);
    const max = ctx.autopilot[rule.budget.name];
    const used = ctx.used(key);
    outcome =
      used < max
        ? { answer, budget: { key, used: used + 1, max } }
        : { escalate: "budget_exhausted", budget: { key, used, max } };
  }
  if ("escalate" in outcome) return { ...outcome, policy };
  return {
    answer: outcome.answer,
    policy,
    rationale: rule.rationale,
    evidence: evidenceOf(f, ctx),
    ...(outcome.budget !== undefined ? { budget: outcome.budget } : {}),
  };
}

/** One row of `volleyd policy`. */
export interface PolicyRow {
  policy: string;
  kind: string;
  condition: string;
  answer: string;
  /** `<budget> per <scope>`, or null for a rule with none. */
  budget: string | null;
  max: number | null;
  rationale: string;
}

const SCOPE_LABEL: Record<BudgetScope, string> = {
  task: "<task>",
  task_role: "<task>/<role>",
  run: "<task>/<role>/<attempt>",
};

/** The effective table as rows: the owner_only row first, then each rule with its budget's max. */
export function renderPolicyTable(rules: readonly PolicyRule[], cfg: AutopilotConfig): PolicyRow[] {
  const owner: PolicyRow = {
    policy: "owner_only",
    kind: cfg.owner_only.join(", "),
    condition: "always",
    answer: "escalate owner_only",
    budget: null,
    max: null,
    rationale: "autopilot.owner_only: only the owner answers these",
  };
  return [
    owner,
    ...rules.map((r): PolicyRow => {
      const own = r.decide_budget;
      return {
        policy: r.policy,
        kind: r.kinds.join(", "),
        condition: r.condition,
        answer:
          r.answer === null
            ? `escalate ${r.escalate ?? "no_policy"}`
            : typeof r.answer === "string"
              ? r.answer
              : (r.answer_label ?? r.policy),
        budget:
          own !== undefined
            ? own.label
            : r.budget !== undefined
              ? `${r.budget.name} per ${SCOPE_LABEL[r.budget.per]}`
              : null,
        max: own !== undefined ? cfg[own.name] : r.budget !== undefined ? cfg[r.budget.name] : null,
        rationale: r.rationale,
      };
    }),
  ];
}
