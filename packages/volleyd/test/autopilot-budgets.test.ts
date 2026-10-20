import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { budgetUsed } from "../src/autopilot/budgets";
import { evaluate } from "../src/autopilot/policy";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { normalizeRecord, replay } from "../src/reducer";
import type { JournalEvent } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";

const fixture: JournalEvent[] = readFileSync(
  new URL("./fixtures/journal.jsonl", import.meta.url),
  "utf-8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

// T1 is queued in the fixture: a decision on it parks it.
const base = fixture.slice(0, 11);
let seq = base.at(-1)?.seq ?? 0;
const at = "2026-10-20T09:30:00.000Z";
const ev = (type: JournalEvent["type"], data: Record<string, unknown>, task = "T1") =>
  ({ seq: ++seq, at, type, task, data }) as JournalEvent;

const relaunchMarker = { on: "relaunch", role: "implementer", attempt: 1 };
const opened = (id: string) =>
  ev("decision_opened", {
    decision_id: id,
    kind: "hooks_auth_failed",
    question: "relaunch?",
    options: ["relaunch", "cancel"],
    pipeline: relaunchMarker,
  });
const autoResolved = (id: string, used: number) =>
  ev("decision_auto_resolved", {
    decision_id: id,
    kind: "hooks_auth_failed",
    policy: "relaunch/bad-launch",
    answer: "relaunch",
    rationale: "one relaunch fixes a bad launch",
    evidence: { pipeline: relaunchMarker },
    budget: { key: "relaunch_max:T1/implementer", used, max: 1 },
  });
const resolved = (id: string) =>
  ev("decision_resolved", { decision_id: id, answer: "relaunch", by: "volleyd" });

describe("budgets", () => {
  seq = base.at(-1)?.seq ?? 0;
  const first = [opened("d-a"), autoResolved("d-a", 1), resolved("d-a")];
  const rec = replay([...base, ...first]);

  it("budgetUsed counts decision_auto_resolved events by budget key", () => {
    expect(budgetUsed(rec, "relaunch_max:T1/implementer")).toBe(1);
    expect(budgetUsed(rec, "relaunch_max:T2/implementer")).toBe(0);
  });

  it("a second relaunch of the same task/role at max 1 escalates budget_exhausted", () => {
    const again = replay([opened("d-b")], rec);
    const d = again.decisions["d-b"];
    if (d === undefined) throw new Error("d-b not opened");
    const v = evaluate(d, {
      autopilot: CONFIG_DEFAULTS.autopilot,
      used: (k) => budgetUsed(again, k),
      task: again.state?.tasks.find((t) => t.id === "T1"),
    });
    expect(v).toMatchObject({
      escalate: "budget_exhausted",
      budget: { key: "relaunch_max:T1/implementer", used: 1, max: 1 },
    });
  });

  it("a raise by n past budget_raise_max × the derived budget escalates", () => {
    const d = {
      decision_id: "d-raise",
      wave: "w1",
      task: null,
      kind: "spawn_budget_exhausted" as const,
      question: "?",
      pointers: {},
      opened_at: at,
      options: ["raise by 2", "cancel"],
      used: 10,
      budget: 10,
    };
    const ap = { ...CONFIG_DEFAULTS.autopilot, budget_raise_max: 1.1 };
    expect(evaluate(d, { autopilot: ap, used: () => 0, derived_budget: 10 })).toMatchObject({
      escalate: "budget_exhausted",
      budget: { key: "budget_raise_max", used: 10, max: 11 },
    });
  });
});

describe("reducer: autopilot events", () => {
  it("decision_auto_resolved then decision_resolved: a resolved decision, auto_resolved 1", () => {
    seq = base.at(-1)?.seq ?? 0;
    const rec = replay([...base, opened("d-a"), autoResolved("d-a", 1), resolved("d-a")]);
    expect(rec.decisions["d-a"]?.resolved).toMatchObject({ answer: "relaunch", by: "volleyd" });
    expect(rec.state?.open_decisions).toEqual([]);
    expect(rec.autopilot).toEqual({
      resolved: 1,
      escalated: 0,
      budgets: { "relaunch_max:T1/implementer": { used: 1, max: 1 } },
    });
    expect(rec.state?.autopilot).toEqual({
      enabled: true,
      auto_resolved: 1,
      escalated: 0,
      budgets: { "relaunch_max:T1/implementer": { used: 1, max: 1 } },
    });
    const state = rec.state;
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
  });

  it("decision_escalated: escalated 1, the decision stays open and remembers why", () => {
    seq = base.at(-1)?.seq ?? 0;
    const rec = replay([
      ...base,
      opened("d-a"),
      ev("decision_escalated", { decision_id: "d-a", kind: "hooks_auth_failed", why: "no_policy" }),
    ]);
    expect(rec.state?.open_decisions).toEqual(["d-a"]);
    expect(rec.autopilot?.escalated).toBe(1);
    expect(rec.state?.autopilot?.escalated).toBe(1);
    expect(rec.decisions["d-a"]?.escalated).toEqual({ why: "no_policy" });
  });

  it("a wave without autopilot events carries no autopilot block (older states unchanged)", () => {
    expect(replay(base).state?.autopilot).toBeUndefined();
  });

  it("snapshots from before the field normalise", () => {
    const { autopilot: _a, ...old } = replay(base);
    expect(normalizeRecord(old).autopilot).toEqual({ resolved: 0, escalated: 0, budgets: {} });
  });
});
