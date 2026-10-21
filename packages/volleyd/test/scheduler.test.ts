import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { MachineView, PlaceOptions } from "../src/placement";
import { type WaveRecord, replay } from "../src/reducer";
import {
  type Admission,
  admit,
  admitPlacing,
  criticalPaths,
  ready,
  spawnBudget,
} from "../src/scheduler";
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

  it("orders by critical path length first, then file overlap with active tasks, then id", () => {
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
    // Z leads a chain of 2, so it goes first; A/B/C tie on 1 and nothing is active yet, so the
    // tie falls through to id order.
    expect(ready(record(wave))).toEqual(["Z", "A", "B", "C"]);
    // With A admitted (active, touching src/shared.ts), B overlaps and sorts after C.
    const rec = record(wave, [{ type: "task_admitted", task: "A", data: {} }]);
    expect(ready(rec)).toEqual(["Z", "C", "B"]);
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
    expect(admit(["T1", "T2"], OPEN, ctx())).toEqual({ admit: ["T1", "T2"], reasons: [] });
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
    expect(none).toEqual({ admit: [], reasons: ["hard ceiling reached: 12/12 live agents"] });
  });

  it("never goes negative when the ceiling is lowered below live agents (no preemption)", () => {
    const r = admit(["T1"], OPEN, ctx({ live: 5, hardCeiling: 2 }));
    expect(r).toEqual({ admit: [], reasons: ["hard ceiling reached: 5/2 live agents"] });
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

  it("a closed gate (paused, kill switch, a global signal) admits nothing and holds nothing", () => {
    const r = run([view("box-a")], {}, { allow: 0, reasons: ["wave paused"] });
    expect(r).toMatchObject({ admit: [], held: {}, reasons: ["wave paused"] });
  });
});
