import { describe, expect, it } from "vitest";
import {
  POLICY_TABLE,
  type PolicyContext,
  QUESTION_ANSWER,
  evaluate,
  renderPolicyTable,
} from "../src/autopilot/policy";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { DecisionKind, DecisionRecord } from "../src/decisions";
import type { AutopilotConfig, TaskState } from "../src/types";

const AP: AutopilotConfig = CONFIG_DEFAULTS.autopilot;

/** A decision record as the reducer keeps it, with the daemon's extra facts. */
function rec(
  kind: DecisionKind,
  options: string[] | undefined,
  extra: Record<string, unknown> = {},
): DecisionRecord {
  return {
    decision_id: `${kind.replaceAll("_", "-")}-1`,
    wave: "w1",
    task: "T1",
    kind,
    question: "?",
    pointers: {},
    opened_at: "2026-10-20T00:00:00.000Z",
    ...(options !== undefined ? { options } : {}),
    ...extra,
  } as DecisionRecord;
}

const TASK: TaskState = {
  id: "T1",
  issue: 1,
  stage: "awaiting_decision",
  agents: { implementer: "w1-t1-implementer-1", spec_reviewer: "w1-t1-spec-reviewer-1" },
};

function ctx(over: Partial<PolicyContext> = {}, used: Record<string, number> = {}): PolicyContext {
  return { autopilot: AP, used: (k) => used[k] ?? 0, task: TASK, ...over };
}

const answerOf = (v: ReturnType<typeof evaluate>) => ("answer" in v ? v.answer : undefined);
const whyOf = (v: ReturnType<typeof evaluate>) => ("escalate" in v ? v.escalate : undefined);

describe("evaluate: the policy table, row by row", () => {
  it("spawn_failed while the daemon still retries: retry now, no budget", () => {
    const d = rec("spawn_failed", ["retry now", "stop task"], {
      pipeline: { on: "spawn_failed", role: "implementer" },
    });
    const v = evaluate(d, ctx({ task: { ...TASK, next_retry_at: "2026-10-20T00:01:00.000Z" } }));
    expect(answerOf(v)).toBe("retry now");
    expect("budget" in v ? v.budget : undefined).toBeUndefined();
  });

  it("spawn_failed with retries stopped: escalates budget_exhausted", () => {
    const d = rec("spawn_failed", ["retry now", "stop task"], { stopped: true });
    expect(whyOf(evaluate(d, ctx({ task: { ...TASK, next_retry_at: null } })))).toBe(
      "budget_exhausted",
    );
  });

  for (const kind of ["hooks_auth_failed", "mcp_not_registered", "unknown_screen"] as const) {
    it(`${kind} with a relaunch marker: relaunch, under relaunch_max per task/role`, () => {
      const d = rec(kind, ["relaunch", "cancel"], {
        pipeline: { on: "relaunch", role: "implementer", attempt: 1 },
      });
      const v = evaluate(d, ctx());
      expect(answerOf(v)).toBe("relaunch");
      expect("budget" in v && v.budget).toEqual({
        key: "relaunch_max:T1/implementer",
        used: 1,
        max: 1,
      });
      // The second relaunch of the same task/role is the owner's.
      const again = evaluate(d, ctx({}, { "relaunch_max:T1/implementer": 1 }));
      expect(whyOf(again)).toBe("budget_exhausted");
      expect("budget" in again && again.budget).toEqual({
        key: "relaunch_max:T1/implementer",
        used: 1,
        max: 1,
      });
    });
  }

  for (const cls of ["hooks_silent", "screen_static"]) {
    it(`unknown_screen of class ${cls}: keep running`, () => {
      const d = rec("unknown_screen", ["keep running", "stop task"], {
        class: cls,
        agent_id: "w1-t1-implementer-1",
      });
      expect(answerOf(evaluate(d, ctx()))).toBe("keep running");
    });
  }

  it("reviewers_disagree: blocker", () => {
    const d = rec("reviewers_disagree", ["blocker", "fine"], {
      pipeline: { on: "reviewers_disagree" },
    });
    expect(answerOf(evaluate(d, ctx()))).toBe("blocker");
  });

  it("answers with the option as the decision spells it", () => {
    const d = rec("reviewers_disagree", ["Blocker", "fine"], {
      pipeline: { on: "reviewers_disagree" },
    });
    expect(answerOf(evaluate(d, ctx()))).toBe("Blocker");
  });

  it("agent_stalled asked once: nudge again, under nudge_max per run", () => {
    const d = rec("agent_stalled", ["nudge again", "stop task"], {
      class: "agent_stalled",
      asked: 1,
      agent_id: "w1-t1-implementer-1",
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("nudge again");
    expect("budget" in v && v.budget).toEqual({
      key: "nudge_max:T1/implementer/w1-t1-implementer-1",
      used: 1,
      max: 1,
    });
    expect(whyOf(evaluate(d, ctx({}, { "nudge_max:T1/implementer/w1-t1-implementer-1": 1 })))).toBe(
      "budget_exhausted",
    );
  });

  it("agent_stalled asked again: respawn, under respawn_max per task/role", () => {
    const d = rec("agent_stalled", ["nudge again", "respawn", "stop task"], {
      class: "agent_stalled",
      asked: 2,
      agent_id: "w1-t1-implementer-1",
      pipeline: { on: "liveness", role: "implementer", agent_id: "w1-t1-implementer-1" },
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("respawn");
    expect("budget" in v && v.budget).toEqual({
      key: "respawn_max:T1/implementer",
      used: 1,
      max: 1,
    });
    expect(whyOf(evaluate(d, ctx({}, { "respawn_max:T1/implementer": 1 })))).toBe(
      "budget_exhausted",
    );
    // A stall decision from before respawn was offered: never an answer it does not offer.
    expect(whyOf(evaluate({ ...d, options: ["nudge again", "stop task"] }, ctx()))).toBe(
      "no_policy",
    );
  });

  it("agent_blocked on verify (an unverifiable done): respawn, under respawn_max per task/role", () => {
    const d = rec("agent_blocked", ["respawn", "re-verify", "cancel"], {
      pipeline: { on: "verify", role: "fixup", agent_id: "w1-t1-fixup-1" },
    });
    const v = evaluate(d, ctx());
    expect(v).toMatchObject({ answer: "respawn", policy: "agent_blocked/respawn-unverifiable" });
    expect("budget" in v && v.budget).toEqual({ key: "respawn_max:T1/fixup", used: 1, max: 1 });
    expect(whyOf(evaluate(d, ctx({}, { "respawn_max:T1/fixup": 1 })))).toBe("budget_exhausted");
  });

  it("ci_failed on the role's own change: fixup, under ci_fixup_max per task", () => {
    const own = { pipeline: { on: "ci_failed", role: "implementer", head: "a".repeat(40) } };
    const opts = ["fixup", "re-verify", "cancel"];
    // Until A3 classifies a red head, every red head that is not infra-shaped is the change's.
    const d = rec("ci_failed", opts, { ...own, infra: false });
    const v = evaluate(d, ctx());
    expect(v).toMatchObject({ answer: "fixup", policy: "ci_failed/fixup-own-change" });
    expect("budget" in v && v.budget).toEqual({ key: "ci_fixup_max:T1", used: 1, max: 2 });
    expect(whyOf(evaluate(d, ctx({}, { "ci_fixup_max:T1": 2 })))).toBe("budget_exhausted");
    expect(
      answerOf(
        evaluate(
          rec("ci_failed", opts, { ...own, classification: "own_change", infra: true }),
          ctx(),
        ),
      ),
    ).toBe("fixup");
    // Infra-shaped, or classified otherwise (A3): the owner's.
    expect(whyOf(evaluate(rec("ci_failed", opts, { ...own, infra: true }), ctx()))).toBe(
      "no_policy",
    );
    expect(
      whyOf(
        evaluate(rec("ci_failed", opts, { ...own, infra: false, classification: "flake" }), ctx()),
      ),
    ).toBe("no_policy");
    // No CI run at all (ci_none) is never a fixup's job.
    const none = rec("ci_failed", ["accept", "cancel"], {
      pipeline: { on: "ci_none", role: "implementer" },
    });
    expect(whyOf(evaluate(none, ctx()))).toBe("no_policy");
  });

  it("ci_failed classified flake: `fix flake`, unless no fixer can take it (SPEC §4.6.16)", () => {
    const d = rec("ci_failed", ["fix flake", "fixup", "re-verify", "cancel"], {
      pipeline: { on: "ci_failed", role: "implementer", head: "a".repeat(40) },
      classification: "flake",
    });
    expect(answerOf(evaluate(d, ctx()))).toBe("fix flake");
    expect(answerOf(evaluate(d, ctx({ fixer: { reuse: "fix-x" } })))).toBe("fix flake");
    const over = evaluate(
      d,
      ctx({ fixer: { over_budget: { key: "fix_flake_max", used: 3, max: 3 } } }),
    );
    expect(whyOf(over)).toBe("budget_exhausted");
    expect("budget" in over && over.budget).toEqual({ key: "fix_flake_max", used: 3, max: 3 });
    expect(whyOf(evaluate(d, ctx({ fixer: { refuse: "its fixer closed" } })))).toBe(
      "unattended_safety",
    );
  });

  it("agent_blocked_ci classified infra_incident: no row answers it, the owner decides", () => {
    const d = rec("agent_blocked", ["continue", "respawn", "cancel"], {
      pipeline: { on: "agent_blocked_ci", role: "implementer", head: "a".repeat(40) },
      classification: "infra_incident",
    });
    expect(whyOf(evaluate(d, ctx()))).toBe("no_policy");
  });

  it("ci_failed classified infra_incident (asked past incident_wait_max_s): escalates budget_exhausted", () => {
    const d = rec("ci_failed", ["fixup", "re-verify", "cancel"], {
      pipeline: { on: "ci_failed", role: "implementer", head: "a".repeat(40) },
      classification: "infra_incident",
      infra: true,
    });
    const v = evaluate(d, ctx());
    expect(v).toMatchObject({ policy: "ci_failed/infra-incident" });
    expect(whyOf(v)).toBe("budget_exhausted");
  });

  it("agent_blocked by a failed agent: respawn, under respawn_max per task/role", () => {
    const d = rec("agent_blocked", ["respawn", "cancel"], {
      pipeline: { on: "agent_failed", role: "implementer" },
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("respawn");
    expect("budget" in v && v.budget).toEqual({
      key: "respawn_max:T1/implementer",
      used: 1,
      max: 1,
    });
    expect(whyOf(evaluate(d, ctx({}, { "respawn_max:T1/implementer": 1 })))).toBe(
      "budget_exhausted",
    );
  });

  it("agent_blocked of class respawn_needed (gone after a restart): respawn", () => {
    const d = rec("agent_blocked", ["respawn", "stop task"], {
      class: "respawn_needed",
      agent_id: "w1-t1-implementer-1",
      role: "implementer",
    });
    expect(answerOf(evaluate(d, ctx()))).toBe("respawn");
  });

  for (const on of ["review_result", "fixup_result"]) {
    it(`agent_blocked on ${on}: respawn (never skip a review)`, () => {
      const opts = on === "review_result" ? ["respawn", "skip"] : ["skip", "respawn", "cancel"];
      const d = rec("agent_blocked", opts, { pipeline: { on, role: "spec_reviewer" } });
      const v = evaluate(d, ctx());
      expect(answerOf(v)).toBe("respawn");
      expect("budget" in v && v.budget && v.budget.key).toBe("respawn_max:T1/spec_reviewer");
    });
  }

  it("agent_blocked on merge_ready_invariant: rereview, under rereview_max per task", () => {
    const d = rec("agent_blocked", ["rereview", "cancel"], {
      pipeline: { on: "merge_ready_invariant", head: "abc" },
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("rereview");
    expect("budget" in v && v.budget).toEqual({ key: "rereview_max:T1", used: 1, max: 2 });
    expect(whyOf(evaluate(d, ctx({}, { "rereview_max:T1": 2 })))).toBe("budget_exhausted");
  });

  it("agent_blocked by an agent's own blocked status: no_policy (the owner reads the reason)", () => {
    const d = rec("agent_blocked", ["continue", "respawn", "cancel"], {
      pipeline: { on: "agent_blocked", role: "implementer" },
    });
    expect(whyOf(evaluate(d, ctx()))).toBe("no_policy");
  });

  it("agent_question, within question_max per run: the unattended answer, under question_max", () => {
    const d = rec("agent_question", undefined, {
      class: "agent_question",
      agent_id: "w1-t1-implementer-1",
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe(QUESTION_ANSWER);
    expect(QUESTION_ANSWER).toMatch(/^Proceed with your best judgement/);
    expect("budget" in v && v.budget && v.budget.key).toBe(
      "question_max:T1/implementer/w1-t1-implementer-1",
    );
    expect(
      whyOf(evaluate(d, ctx({}, { "question_max:T1/implementer/w1-t1-implementer-1": 1 }))),
    ).toBe("budget_exhausted");
  });

  it("spawn_budget_exhausted within budget_raise_max × the derived budget: raise by n", () => {
    const d = rec("spawn_budget_exhausted", ["raise by 3", "cancel"], { used: 12, budget: 12 });
    const v = evaluate(d, ctx({ derived_budget: 12 }));
    expect(answerOf(v)).toBe("raise by 3");
    expect("budget" in v && v.budget).toEqual({ key: "budget_raise_max", used: 15, max: 24 });
  });

  it("spawn_budget_exhausted past budget_raise_max × the derived budget: budget_exhausted", () => {
    const d = rec("spawn_budget_exhausted", ["raise by 3", "cancel"], { used: 23, budget: 23 });
    const v = evaluate(d, ctx({ derived_budget: 12 }));
    expect(whyOf(v)).toBe("budget_exhausted");
    expect("budget" in v && v.budget).toEqual({ key: "budget_raise_max", used: 23, max: 24 });
  });

  it("machine_down offering re-place: re-place queued tasks", () => {
    const d = rec("machine_down", ["wait", "re-place queued tasks", "cancel"], { task: null });
    expect(answerOf(evaluate({ ...d, task: null }, ctx({ task: undefined })))).toBe(
      "re-place queued tasks",
    );
  });

  it("account_limit with a suggested account: move the wave there", () => {
    const d = rec("account_limit", ["move wave w1 to work", "not now"], {
      acct: "primary",
      suggested: "work",
    });
    expect(answerOf(evaluate({ ...d, task: null }, ctx({ task: undefined })))).toBe(
      "move wave w1 to work",
    );
  });

  it("account_limit with no suggestion: wait (the decision's `not now`)", () => {
    const d = rec("account_limit", ["not now"], { acct: "primary", suggested: null });
    expect(answerOf(evaluate({ ...d, task: null }, ctx({ task: undefined })))).toBe("not now");
  });

  it("agent_account_limit with a suggestion: move the agent, under account_move_max per task role", () => {
    const d = rec("agent_account_limit", ["move w1-t1-implementer-1 to work", "not now"], {
      agent_id: "w1-t1-implementer-1",
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      suggested: "work",
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("move w1-t1-implementer-1 to work");
    expect("policy" in v && v.policy).toBe("agent_account_limit/move");
    expect("budget" in v && v.budget).toEqual({
      key: "account_move_max:T1/implementer",
      used: 1,
      max: 2,
    });
    // the third move of the role: the owner's
    expect(whyOf(evaluate(d, ctx({}, { "account_move_max:T1/implementer": 2 })))).toBe(
      "budget_exhausted",
    );
  });

  it("agent_account_limit with no suggestion: wait (not now)", () => {
    const d = rec("agent_account_limit", ["not now"], {
      agent_id: "w1-t1-implementer-1",
      role: "implementer",
      acct: "primary",
      suggested: null,
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("not now");
    expect("rationale" in v && v.rationale).toBe(
      "no other login on the machine has room; the agent finishes where it is and the window resets",
    );
  });

  it("account_limit/wait explains the balanced wait", () => {
    const d = rec("account_limit", ["not now"], { acct: "primary", suggested: null });
    const v = evaluate({ ...d, task: null }, ctx({ task: undefined }));
    expect("rationale" in v && v.rationale).toBe(
      "no account on the machine has headroom; new agents take the one with the most room; wait for the reset",
    );
  });

  it("pr_head_moved by a green release-only merge: accept", () => {
    const d = rec("pr_head_moved", ["rereview", "fixup", "accept", "cancel"], {
      pipeline: { on: "pr_head_moved", head: "b", from: "a" },
      ci: "green",
      directive: { ci: "green", release_merge: { only_release: true, moved_files: [] } },
    });
    expect(answerOf(evaluate(d, ctx()))).toBe("accept");
  });

  it("pr_head_moved otherwise: rereview, under rereview_max per task", () => {
    const d = rec("pr_head_moved", ["rereview", "fixup", "cancel"], {
      pipeline: { on: "pr_head_moved", head: "b", from: "a" },
      ci: "red",
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("rereview");
    expect("budget" in v && v.budget && v.budget.key).toBe("rereview_max:T1");
  });

  it("pr_head_moved without rereview offered: no_policy", () => {
    const d = rec("pr_head_moved", ["fixup", "cancel"], {
      pipeline: { on: "pr_head_moved", head: "b", from: "a" },
      ci: "red",
    });
    expect(whyOf(evaluate(d, ctx()))).toBe("no_policy");
  });

  it("wave_complete: acknowledged", () => {
    const d = rec("wave_complete", ["acknowledged"]);
    expect(answerOf(evaluate({ ...d, task: null }, ctx({ task: undefined })))).toBe("acknowledged");
  });

  it("merge_conflict: a fresh rebase agent, under respawn_max per task/role, then the owner", () => {
    const d = rec("merge_conflict", ["respawn", "manual", "cancel"], {
      pipeline: { on: "merge_conflict", role: "rebase" },
      agent_id: "w1-t1-rebase-1",
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("respawn");
    expect("policy" in v && v.policy).toBe("merge_conflict/respawn");
    expect("budget" in v && v.budget).toEqual({ key: "respawn_max:T1/rebase", used: 1, max: 1 });
    expect(whyOf(evaluate(d, ctx({}, { "respawn_max:T1/rebase": 1 })))).toBe("budget_exhausted");
  });

  it("merge_refused past the transient ladder: retry, under merge_transient_retry_max per task (#445)", () => {
    const d = rec("merge_refused", ["retry", "manual", "cancel"], {
      pipeline: { on: "merge_refused", head: "a".repeat(40) },
      reason: "transient",
      transient_attempts: 5,
    });
    const v = evaluate(d, ctx());
    expect(answerOf(v)).toBe("retry");
    expect("policy" in v && v.policy).toBe("merge_refused/transient");
    expect("budget" in v && v.budget).toEqual({
      key: "merge_transient_retry_max:T1",
      used: 1,
      max: 1,
    });
    expect(whyOf(evaluate(d, ctx({}, { "merge_transient_retry_max:T1": 1 })))).toBe(
      "budget_exhausted",
    );
  });

  it("merge_refused for required checks: still the owner's (no_policy)", () => {
    const d = rec("merge_refused", ["retry", "manual", "cancel"], { reason: "checks" });
    expect(whyOf(evaluate(d, ctx()))).toBe("no_policy");
  });

  for (const kind of ["ci_failed", "pr_closed", "remote_repo_missing"] as const) {
    it(`${kind}: no_policy`, () => {
      expect(whyOf(evaluate(rec(kind, ["accept", "cancel"]), ctx()))).toBe("no_policy");
    });
  }
});

describe("evaluate: guards", () => {
  it("never gives an answer the decision does not offer", () => {
    const d = rec("reviewers_disagree", ["fine"]);
    expect(whyOf(evaluate(d, ctx()))).toBe("no_policy");
  });

  it("owner_only wins over any rule", () => {
    const d = rec("reviewers_disagree", ["blocker", "fine"]);
    const v = evaluate(
      d,
      ctx({ autopilot: { ...AP, owner_only: [...AP.owner_only, "reviewers_disagree"] } }),
    );
    expect(whyOf(v)).toBe("owner_only");
    for (const kind of ["plan_change", "repo_untrusted", "model_switch"] as const) {
      expect(whyOf(evaluate(rec(kind, ["keep", "cancel"]), ctx()))).toBe("owner_only");
    }
  });

  it("release_go and stage_go are owner_only by default, and no rule answers them without it", () => {
    for (const kind of ["release_go", "stage_go"] as const) {
      expect(whyOf(evaluate(rec(kind, ["go", "hold"]), ctx()))).toBe("owner_only");
      const bare = ctx({ autopilot: { ...AP, owner_only: [] } });
      expect(whyOf(evaluate(rec(kind, ["go", "hold"]), bare))).toBe("no_policy");
    }
  });

  it("disabled: answers nothing and escalates nothing", () => {
    const v = evaluate(rec("reviewers_disagree", ["blocker", "fine"]), {
      ...ctx(),
      autopilot: { ...AP, enabled: false },
    });
    expect(v).toEqual({ off: true });
  });

  it("an answer carries its policy, rationale and evidence", () => {
    const d = rec("agent_blocked", ["respawn", "cancel"], {
      pipeline: { on: "agent_failed", role: "implementer" },
    });
    const v = evaluate(d, ctx());
    expect(v).toMatchObject({
      policy: "agent_blocked/respawn-failed",
      evidence: { pipeline: { on: "agent_failed", role: "implementer" } },
    });
    expect("rationale" in v && v.rationale.length).toBeGreaterThan(0);
  });

  it("every rule has a unique policy id", () => {
    const ids = POLICY_TABLE.map((r) => r.policy);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderPolicyTable", () => {
  it("one row per rule (after the owner_only row), with the effective budgets", () => {
    const rows = renderPolicyTable(POLICY_TABLE, { ...AP, relaunch_max: 3 });
    expect(rows).toHaveLength(POLICY_TABLE.length + 1);
    expect(rows[0]).toMatchObject({ policy: "owner_only", answer: "escalate owner_only" });
    const relaunch = rows.find((r) => r.policy === "relaunch/bad-launch");
    expect(relaunch).toMatchObject({
      kind: "hooks_auth_failed, mcp_not_registered, unknown_screen",
      answer: "relaunch",
      budget: "relaunch_max per <task>/<role>",
      max: 3,
    });
    const raise = rows.find((r) => r.policy === "spawn_budget_exhausted/raise");
    expect(raise?.max).toBe(2);
    expect(rows.find((r) => r.policy === "reviewers_disagree/blocker")?.max).toBeNull();
  });
});
