import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type WaveRecord, replay } from "../src/reducer";
import { admit, criticalPaths, ready, spawnBudget } from "../src/scheduler";
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
