import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { MachineView, PlaceOptions } from "../src/placement";
import { type WaveRecord, replay } from "../src/reducer";
import {
  type Admission,
  admit,
  admitPlacing,
  budgetRaise,
  clusterRoom,
  clusterRooms,
  criticalPaths,
  ready,
  spawnBudget,
  spawnsOutstanding,
} from "../src/scheduler";
import { churnCause, repeatsRun } from "../src/spawn-class";
import type { JournalEvent, NewEvent, Wave } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

const epic = parseWaveFile(
  readFileSync(new URL("./fixtures/example.yaml", import.meta.url), "utf-8"),
);

/** Build a record from un-sequenced events. */
function record(wave: Wave, extra: NewEvent[] = []): WaveRecord {
  const evs: NewEvent[] = [
    { type: "wave_submitted", data: { wave, owner: null } },
    ...wave.task_order.map((id): NewEvent => ({ type: "task_queued", task: id, data: {} })),
    ...extra,
  ];
  return replay(
    evs.map((e, i): JournalEvent => ({ ...e, seq: i + 1, at: "2026-10-20T09:00:00.000Z" })),
  );
}

const done = (task: string): NewEvent[] => [
  { type: "task_admitted", task, data: {} },
  {
    type: "agent_spawned",
    task,
    data: { role: "implementer", agent_id: `${task.toLowerCase()}-1` },
  },
  { type: "stage_entered", task, data: { stage: "done" } },
];

const OPEN = { allow: Number.POSITIVE_INFINITY, reasons: [] };
const ctx = (over: Partial<Parameters<typeof admit>[2]> = {}) => ({
  live: 0,
  hardCeiling: 12,
  spawnsUsed: 0,
  spawnBudget: 12,
  ...over,
});

describe("criticalPaths", () => {
  it("counts the longest downstream chain, including the task itself", () => {
    expect(criticalPaths(epic)).toEqual({ T0: 3, T1: 2, T2: 2, T3: 1 });
  });
});

describe("ready", () => {
  it("is [T0] for a fresh epic wave", () => {
    expect(ready(record(epic))).toEqual(["T0"]);
  });

  it("is [T1, T2] once T0 is done (critical-path tie → id order)", () => {
    expect(ready(record(epic, done("T0")))).toEqual(["T1", "T2"]);
  });

  it("excludes admitted tasks and tasks already past queued", () => {
    const rec = record(epic, [...done("T0"), { type: "task_admitted", task: "T1", data: {} }]);
    expect(ready(rec)).toEqual(["T2"]);
  });

  it("orders by critical path length first, then id (the cluster cap replaces file overlap)", () => {
    const wave = parseWaveFile(`wave: w2
repo: r
release_branch: release/w2
model: m
pipeline: [implement]
tasks:
  A: { issue: 1, files: [src/shared.ts] }
  B: { issue: 2, files: [src/shared.ts] }
  C: { issue: 3, files: [src/other.ts] }
  Z: { issue: 4 }
  Y: { issue: 5, after: [Z] }
`);
    // Z leads a chain of 2, so it goes first; A/B/C tie on 1, so the tie falls through to id order.
    expect(ready(record(wave))).toEqual(["Z", "A", "B", "C"]);
    // A shared files hint with an active task no longer reorders: B stays ahead of C.
    const rec = record(wave, [{ type: "task_admitted", task: "A", data: {} }]);
    expect(ready(rec)).toEqual(["Z", "B", "C"]);
  });
});

describe("the cluster cap (#384)", () => {
  const capped = (id: string, issue: number) =>
    `  ${id}: { issue: ${issue}, files: [src/hot.ts], plan: { cluster: A, by: cap, why: "capped: shares src/hot.ts" } }\n`;
  const wave = parseWaveFile(
    `wave: wc\nrepo: r\nrelease_branch: release/wc\nmodel: m\npipeline: [implement, spec_review, merge_ready]\ntasks:\n${capped("i315", 315)}${capped("i317", 317)}${capped("i318", 318)}${capped("i322", 322)}${capped("i323", 323)}  u1: { issue: 1, files: [src/other.ts] }\n  u2: { issue: 2, files: [src/other.ts] }\n`,
  );
  const planned: NewEvent = {
    type: "wave_planned",
    data: { clusters: wave.overlap_plan?.clusters ?? [] },
  };
  const rec = (extra: NewEvent[] = []) => record(wave, [planned, ...extra]);
  const at = (task: string, stage: string): NewEvent[] => [
    { type: "task_admitted", task, data: {} },
    { type: "agent_spawned", task, data: { role: "implementer", agent_id: `${task}-1` } },
    { type: "stage_entered", task, data: { stage } },
  ];
  const run = (r: WaveRecord, over: Partial<Parameters<typeof admit>[2]> = {}) =>
    admit(ready(r), OPEN, ctx({ clusters: clusterRooms(r), ...over }));

  it("the plan caps cluster A at 4", () => {
    expect(wave.overlap_plan?.clusters[0]?.strategy.cap).toBe(4);
  });

  it("admits four of five ready members and holds the fifth, saying which four are in flight", () => {
    const r = run(rec());
    expect(r.admit).toEqual(["i315", "i317", "i318", "i322", "u1", "u2"]);
    expect(r.held).toEqual({ i323: "cluster A: 4 in flight (i315, i317, i318, i322)" });
  });

  it("clusterRoom counts members between implement and fixup; merge_ready, done and queued hold none", () => {
    expect(clusterRoom(rec(), "A")).toBe(4);
    const busy = rec([
      ...at("i315", "implement"),
      ...at("i317", "fixup"),
      ...at("i318", "merge_ready"),
    ]);
    expect(clusterRoom(busy, "A")).toBe(2);
    // An admitted member not spawned yet already holds its slot.
    expect(clusterRoom(rec([{ type: "task_admitted", task: "i322", data: {} }]), "A")).toBe(3);
    // Unknown cluster or no cap: unbounded.
    expect(clusterRoom(rec(), "B")).toBe(Number.POSITIVE_INFINITY);
  });

  it("a member at merge_ready frees its slot", () => {
    const full = rec(["i315", "i317", "i318", "i322"].flatMap((id) => at(id, "implement")));
    expect(run(full).admit).toEqual(["u1", "u2"]);
    expect(run(full).held).toEqual({ i323: "cluster A: 4 in flight (i315, i317, i318, i322)" });
    const freed = rec([
      ...["i315", "i317", "i318"].flatMap((id) => at(id, "implement")),
      ...at("i322", "merge_ready"),
    ]);
    expect(run(freed).admit).toEqual(["i323", "u1", "u2"]);
    expect(run(freed).held).toEqual({});
  });

  it("a member blocked before implement holds no slot; one blocked after it does", () => {
    const before: NewEvent[] = [
      { type: "task_admitted", task: "i315", data: {} },
      { type: "stage_entered", task: "i315", data: { stage: "blocked", why: "x" } },
    ];
    expect(clusterRoom(rec(before), "A")).toBe(4);
    const after: NewEvent[] = [
      ...at("i315", "implement"),
      { type: "stage_entered", task: "i315", data: { stage: "blocked", why: "x" } },
    ];
    expect(clusterRoom(rec(after), "A")).toBe(3);
  });

  it("on hold the cap is 1 and gated members hold slots too; train keeps the cap", () => {
    const strat = (to: string): NewEvent => ({
      type: "cluster_strategy_changed",
      data: { cluster: "A", from: "cap", to, why: "churn" },
    });
    const gated = [...at("i315", "merge_ready")];
    expect(clusterRoom(rec([...gated, strat("hold")]), "A")).toBe(0);
    expect(run(rec([...gated, strat("hold")])).held).toEqual({
      i317: "cluster A (hold): 1 in flight or gated (i315)",
      i318: "cluster A (hold): 1 in flight or gated (i315)",
      i322: "cluster A (hold): 1 in flight or gated (i315)",
      i323: "cluster A (hold): 1 in flight or gated (i315)",
    });
    expect(clusterRoom(rec([...gated, strat("train")]), "A")).toBe(4);
    expect(clusterRoom(rec([...gated, strat("hold"), strat("cap")]), "A")).toBe(4);
  });

  it("a member trimmed by the allowance takes no slot, so no member is held in its name", () => {
    const two = rec(["i315", "i317"].flatMap((id) => at(id, "implement")));
    const r = run(two);
    expect(r.admit).toContain("i318");
    const one = admit(ready(two), { allow: 1, reasons: [] }, ctx({ clusters: clusterRooms(two) }));
    expect(one.admit).toEqual(["i318"]);
    expect(one.held).toEqual({});
    const three = rec(["i315", "i317", "i318"].flatMap((id) => at(id, "implement")));
    const r3 = admit(
      ready(three),
      { allow: 1, reasons: [] },
      ctx({ clusters: clusterRooms(three) }),
    );
    expect(r3.admit).toEqual(["i322"]);
    expect(r3.held).toEqual({ i323: "cluster A: 4 in flight (i315, i317, i318, i322)" });
  });

  it("tasks without a cluster are unaffected, and no cluster info admits as before", () => {
    const r = admit(ready(rec()), OPEN, ctx());
    expect(r.admit).toHaveLength(7);
    expect(r.held).toEqual({});
  });

  it("admitPlacing holds a member with no room before placing it", () => {
    const r = rec();
    const view: MachineView = {
      name: "control",
      local: true,
      record: {
        name: "control",
        os: "linux",
        cores: 16,
        tunnel: "local",
        load: [1, 1, 1],
        agents: 0,
        memory: { total_mb: 65536, available_pct: 70 },
        last_seen: "2026-10-19T09:00:00.000Z",
      },
      ready: true,
      reasons: [],
      drain: false,
      max_agents: 10,
      agents: 0,
      heavy: {},
      usage_pct: null,
      held: [],
    };
    const p = admitPlacing(
      ready(r),
      wave,
      { machines: [view], reservations: {} },
      {
        placement: CONFIG_DEFAULTS.placement,
        warn_at_pct: CONFIG_DEFAULTS.claude.warn_at_pct,
        localName: "control",
      },
      OPEN,
      () => OPEN,
      { ...ctx(), clusters: clusterRooms(r) },
    );
    expect(p.admit.map((a) => a.id)).toEqual(["i315", "i317", "i318", "i322", "u1", "u2"]);
    expect(p.held).toEqual({ i323: "cluster A: 4 in flight (i315, i317, i318, i322)" });
    expect(p.snapshot.reservations).toEqual({ control: 6 });
  });
});

describe("synthetic tasks (a flake's fixer, SPEC §4.6.16)", () => {
  const fixer: NewEvent = {
    type: "task_queued",
    task: "fix-clock-test-ts-advance",
    data: {
      issue: 0,
      synthetic: true,
      title: "Fix flaky test clock.test.ts > advance",
      remediation: {
        kind: "fix_flake",
        test: "clock.test.ts > advance",
        test_file: "test/clock.test.ts",
        run_urls: [],
        for: ["T3"],
      },
    },
  };

  it("criticalPaths treats a synthetic task as the longest path", () => {
    const rec = record(epic, [fixer]);
    const cp = criticalPaths(rec.wave as Wave);
    expect(cp["fix-clock-test-ts-advance"]).toBe(4);
    expect(cp.T0).toBe(3);
  });

  it("is first in ready() regardless of file order, with no `after`", () => {
    expect(ready(record(epic, [fixer]))).toEqual(["fix-clock-test-ts-advance", "T0"]);
  });

  it("counts against the hard ceiling like any task", () => {
    const r = admit(ready(record(epic, [fixer])), OPEN, ctx({ live: 11 }));
    expect(r.admit).toEqual(["fix-clock-test-ts-advance"]);
    expect(r.reasons).toEqual(["hard ceiling reached: 12/12 live agents"]);
  });
});

describe("admit", () => {
  it("admits everything ready when nothing limits it", () => {
    expect(admit(["T1", "T2"], OPEN, ctx())).toEqual({
      admit: ["T1", "T2"],
      held: {},
      reasons: [],
    });
  });

  it("admits only one with allow: 1, in ready order", () => {
    const r = admit(["T1", "T2"], { allow: 1, reasons: ["memory pressure warn"] }, ctx());
    expect(r.admit).toEqual(["T1"]);
    expect(r.reasons).toEqual(["memory pressure warn"]);
  });

  it("stops at the hard ceiling with a reason", () => {
    const r = admit(["T1", "T2"], OPEN, ctx({ live: 11 }));
    expect(r.admit).toEqual(["T1"]);
    expect(r.reasons).toEqual(["hard ceiling reached: 12/12 live agents"]);
    const none = admit(["T1"], OPEN, ctx({ live: 12 }));
    expect(none).toEqual({
      admit: [],
      held: {},
      reasons: ["hard ceiling reached: 12/12 live agents"],
    });
  });

  it("never goes negative when the ceiling is lowered below live agents (no preemption)", () => {
    const r = admit(["T1"], OPEN, ctx({ live: 5, hardCeiling: 2 }));
    expect(r).toEqual({ admit: [], held: {}, reasons: ["hard ceiling reached: 5/2 live agents"] });
  });

  it("stops at the wave's spawn budget with a reason", () => {
    const r = admit(["T1", "T2"], OPEN, ctx({ spawnsUsed: 11, spawnBudget: 12 }));
    expect(r.admit).toEqual(["T1"]);
    expect(r.reasons).toEqual(["spawn budget exhausted: 12/12 spawns"]);
  });
});

describe("spawnBudget", () => {
  const wave3 = (pipeline: string) =>
    parseWaveFile(
      `wave: w3\nrepo: /r\nrelease_branch: release/w3\nmodel: claude-opus-5-5\npipeline: ${pipeline}\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n  T3: { issue: 3 }\n`,
    );
  it("a 3-task wave on the default pipeline (4 roles a task) gets every role plus retry headroom", () => {
    // 3 tasks × 4 roles = 12 spawns with zero retries; + 50% headroom = 18. Never 3 × 3 = 9.
    const w = wave3("[implement, [spec_review, quality_review], fixup, merge_ready]");
    expect(spawnBudget(w, 3)).toBe(18);
    expect(spawnBudget(w, 3)).toBeGreaterThanOrEqual(12);
  });
  it("a small pipeline still gets at least two retries", () => {
    expect(spawnBudget(wave3("[implement, merge_ready]"), 1)).toBe(5);
  });
  it("the multiplier is an override upwards; the wave's spawn_budget is the hard override", () => {
    const w = wave3("[implement, [spec_review, quality_review], fixup, merge_ready]");
    expect(spawnBudget(w, 10)).toBe(30);
    expect(spawnBudget({ ...w, spawn_budget: 5 }, 3)).toBe(5);
    expect(spawnBudget(epic, 3)).toBeGreaterThanOrEqual(12);
  });
});

describe("spawnsOutstanding (#315)", () => {
  const wave5 = parseWaveFile(
    `wave: w5\nrepo: /r\nrelease_branch: release/w5\nmodel: m\npipeline: [implement, spec_review, merge_ready]\nspawn_budget: 12\ntasks:\n${[1, 2, 3, 4, 5].map((i) => `  T${i}: { issue: ${i} }\n`).join("")}`,
  );
  /** A task whose implementer finished and whose reviewer's spawn is still to come. */
  const inReview = (task: string): NewEvent[] => [
    { type: "task_admitted", task, data: {} },
    { type: "agent_spawned", task, data: { role: "implementer", agent_id: `${task}-i` } },
    { type: "stage_entered", task, data: { stage: "spec_review" } },
  ];

  it("counts each unfinished task's stages still to spawn, plus one fixup allowance each", () => {
    const rec = record(wave5, wave5.task_order.flatMap(inReview));
    // 5 tasks × (spec_review + a fixup allowance)
    expect(spawnsOutstanding(wave5, rec)).toBe(10);
  });

  it("a queued task counts its whole pipeline; a finished or cancelled one counts nothing", () => {
    const rec = record(wave5, [
      ...inReview("T1"),
      { type: "stage_entered", task: "T1", data: { stage: "done" } },
      { type: "task_cancelled", task: "T2", data: { by: "t", why: "x" } },
    ]);
    // T3..T5 queued: implement + spec_review + fixup allowance = 3 each
    expect(spawnsOutstanding(wave5, rec)).toBe(9);
  });

  it("a stage whose agent is spawned already is not counted again", () => {
    const rec = record(wave5, [
      ...inReview("T1"),
      { type: "agent_spawned", task: "T1", data: { role: "spec_reviewer", agent_id: "T1-s" } },
    ]);
    // T1: the fixup allowance only; T2..T5: 3 each
    expect(spawnsOutstanding(wave5, rec)).toBe(1 + 12);
  });
});

describe("budgetRaise (#315)", () => {
  it("is what the wave still needs, at least a quarter of the derived budget, within the raise cap", () => {
    expect(budgetRaise({ outstanding: 10, derived: 12, used: 12, raiseMax: 2 })).toBe(10);
    expect(budgetRaise({ outstanding: 1, derived: 12, used: 12, raiseMax: 2 })).toBe(3);
    expect(budgetRaise({ outstanding: 40, derived: 12, used: 12, raiseMax: 2 })).toBe(12);
  });
  it("never offers less than 1, even past the cap (the owner may still raise)", () => {
    expect(budgetRaise({ outstanding: 10, derived: 12, used: 24, raiseMax: 2 })).toBe(10);
    expect(budgetRaise({ outstanding: 0, derived: 1, used: 1, raiseMax: 2 })).toBe(1);
  });
});

describe("admitPlacing (a wave that places its tasks)", () => {
  const w = parseWaveFile(
    "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\nplacement: auto\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n  T3: { issue: 3 }\n",
  );
  const view = (name: string, over: Partial<MachineView> = {}): MachineView => ({
    name,
    local: name === "control",
    record: {
      name,
      os: "linux",
      cores: 16,
      tunnel: name === "control" ? "local" : "up",
      load: [1, 1, 1],
      agents: 0,
      memory: { total_mb: 65536, available_pct: 70 },
      last_seen: "2026-10-19T09:00:00.000Z",
    },
    ready: true,
    reasons: [],
    drain: false,
    max_agents: 4,
    agents: 0,
    heavy: {},
    usage_pct: null,
    held: [],
    ...over,
  });
  const O: PlaceOptions = {
    placement: CONFIG_DEFAULTS.placement,
    warn_at_pct: CONFIG_DEFAULTS.claude.warn_at_pct,
    localName: "control",
  };
  const OPEN: Admission = { allow: Number.POSITIVE_INFINITY, reasons: [] };
  const CTX = { live: 0, hardCeiling: 10, spawnsUsed: 0, spawnBudget: 10 };
  const run = (
    machines: MachineView[],
    over: Partial<typeof CTX> = {},
    gate: Admission = OPEN,
    hostGate = (_: string): Admission => OPEN,
  ) =>
    admitPlacing(["T1", "T2", "T3"], w, { machines, reservations: {} }, O, gate, hostGate, {
      ...CTX,
      ...over,
    });

  it("admits each ready task on its machine, reserving as it goes", () => {
    const r = run([view("box-a", { max_agents: 1 }), view("box-b", { max_agents: 2 })]);
    expect(r.admit.map((a) => [a.id, a.placement.host, a.placed])).toEqual([
      ["T1", "box-a", true],
      ["T2", "box-b", true],
      ["T3", "box-b", true],
    ]);
    expect(r).toMatchObject({ held: {}, reasons: [], budget: false });
    expect(r.snapshot.reservations).toEqual({ "box-a": 1, "box-b": 2 });
  });

  it("stops at the hard ceiling, with the reason", () => {
    const r = run([view("box-a")], { live: 8 });
    expect(r.admit.map((a) => a.id)).toEqual(["T1", "T2"]);
    expect(r.reasons).toEqual(["hard ceiling reached: 10/10 live agents"]);
  });

  it("stops when the spawn budget is spent, and says the budget held it", () => {
    const r = run([view("box-a")], { spawnsUsed: 9 });
    expect(r.admit.map((a) => a.id)).toEqual(["T1"]);
    expect(r).toMatchObject({ budget: true, reasons: ["spawn budget exhausted: 10/10 spawns"] });
  });

  it("a held task does not block the tasks after it", () => {
    // box-a has one slot; T1 takes it, T2 finds no eligible machine, T3 too: then box-b recovers.
    const r = run([view("box-a", { max_agents: 1 })]);
    expect(r.admit.map((a) => a.id)).toEqual(["T1"]);
    expect(r.held).toEqual({
      T2: "no eligible machine: box-a: 1/1 agents (max_agents)",
      T3: "no eligible machine: box-a: 1/1 agents (max_agents)",
    });
    // A peer whose own admission holds starts: held with its reason, and the next task still goes.
    const held = run([view("box-a")], {}, OPEN, (h) =>
      h === "box-a" ? { allow: 0, reasons: ["box-a: load 2.00 per core (max 1.5)"] } : OPEN,
    );
    expect(held.admit).toEqual([]);
    expect(held.held.T1).toBe("box-a: load 2.00 per core (max 1.5)");
  });

  it("the supervisor's own machine is admitted by the wave's verdict, its allowance counted down", () => {
    const r = run([view("control")], {}, { allow: 2, reasons: [] });
    expect(r.admit.map((a) => [a.id, a.placement.host])).toEqual([
      ["T1", "control"],
      ["T2", "control"],
    ]);
    expect(r.held.T3).toBe("control: no start allowed now");
  });

  it("the wave's slug passes through to placement: a machine without its clone holds the task (#436)", () => {
    const repos = (state: "ready" | "absent") => ({
      "a/a":
        state === "ready" ? { state, path: "/path/to/a", reasons: [] } : { state, reasons: ["x"] },
    });
    const machines = [
      view("box-a", { repos: repos("absent") }),
      view("box-b", { repos: repos("ready"), max_agents: 1 }),
    ];
    const r = admitPlacing(
      ["T1", "T2"],
      w,
      { machines, reservations: {} },
      { ...O, waveSlug: "a/a" },
      OPEN,
      () => OPEN,
      CTX,
    );
    expect(r.admit.map((a) => [a.id, a.placement.host])).toEqual([["T1", "box-b"]]);
    expect(r.held.T2).toBe("no eligible machine: box-a: no ready clone of a/a (absent: x)");
  });

  it("a closed gate (paused, kill switch, a global signal) admits nothing and holds nothing", () => {
    const r = run([view("box-a")], {}, { allow: 0, reasons: ["wave paused"] });
    expect(r).toMatchObject({ admit: [], held: {}, reasons: ["wave paused"] });
  });
});

describe("spawn classification: productive or churn (#387)", () => {
  const at = "2026-10-20T09:00:00.000Z";
  const log = (evs: NewEvent[]): JournalEvent[] => evs.map((e, i) => ({ ...e, seq: i + 1, at }));
  const spawned = (task: string, role: string, n = 1): NewEvent => ({
    type: "agent_spawned",
    task,
    data: { role, agent_id: `w1-${task.toLowerCase()}-${role}-${n}` },
  });
  const step = (task: string, roles: string[], extra: Record<string, unknown> = {}): NewEvent => ({
    type: "stage_entered",
    task,
    data: { stage: roles[0], step: 1, roles, ...extra },
  });

  it("a rebase is a branch update and an integrator a train, whatever came before", () => {
    expect(churnCause({ role: "rebase" })).toBe("branch_update");
    expect(churnCause({ role: "integrator" })).toBe("train");
  });

  it("a review round a branch update caused is a re-review; one findings caused is productive", () => {
    expect(churnCause({ role: "spec_reviewer", cause: "rereview" })).toBe("rereview");
    expect(churnCause({ role: "fixup", cause: "rereview" })).toBe("rereview");
    expect(churnCause({ role: "spec_reviewer" })).toBeNull();
    // A fixup of the findings, and the reviewers' next round after it: productive.
    expect(churnCause({ role: "fixup" })).toBeNull();
    expect(churnCause({ role: "implementer" })).toBeNull();
  });

  it("a relaunch, respawn or retry of the same role in the same step is a retry", () => {
    expect(churnCause({ role: "implementer", retry: true })).toBe("retry");
    expect(churnCause({ role: "spec_reviewer", retry: true })).toBe("retry");
    // A role that churns anyway keeps its own cause.
    expect(churnCause({ role: "rebase", retry: true })).toBe("branch_update");
  });

  it("repeatsRun: an earlier spawn of the role since its step started", () => {
    const first = log([
      spawned("T1", "implementer"),
      { type: "stage_entered", task: "T1", data: { stage: "implement" } },
    ]);
    expect(repeatsRun(first, "T1", "implementer")).toBe(true);
    expect(repeatsRun(first, "T2", "implementer")).toBe(false);
    expect(repeatsRun([], "T1", "implementer")).toBe(false);
    // The review step: each reviewer's first run is not a repeat, a second one is.
    const review = log([
      spawned("T1", "implementer"),
      step("T1", ["spec_reviewer", "quality_reviewer"]),
      spawned("T1", "spec_reviewer"),
    ]);
    expect(repeatsRun(review, "T1", "spec_reviewer")).toBe(true);
    expect(repeatsRun(review, "T1", "quality_reviewer")).toBe(false);
    // The next round's step starts the role afresh.
    const round2 = log([
      ...review.map(({ seq: _s, at: _a, ...e }) => e as NewEvent),
      step("T1", ["fixup"]),
      spawned("T1", "fixup"),
      step("T1", ["spec_reviewer"]),
    ]);
    expect(repeatsRun(round2, "T1", "spec_reviewer")).toBe(false);
    // The release train's stages are not pipeline steps: never a repeat here.
    expect(repeatsRun(log([spawned("_release", "release")]), "_release", "release")).toBe(false);
  });
});
