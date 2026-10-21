import { describe, expect, it } from "vitest";
import {
  type FixRequest,
  fixerFor,
  releasedBy,
  requestOf,
  slugOf,
} from "../src/autopilot/remediation";
import { type WaveRecord, replay } from "../src/reducer";
import type { JournalEvent, NewEvent, Wave } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

const wave = parseWaveFile(`wave: w1
repo: r
release_branch: release/w1
model: m
pipeline: [implement, [spec_review, quality_review], fixup, merge_ready]
tasks:
  T1: { issue: 41 }
  T3: { issue: 43, after: [T1] }
  T7: { issue: 47 }
`);

const TEST = "clock.test.ts > advance";
const HEAD = "9fd33a4c1b2e";

/** Build a record from un-sequenced events. */
function record(extra: NewEvent[] = [], w: Wave = wave): WaveRecord {
  const evs: NewEvent[] = [
    { type: "wave_submitted", data: { wave: w, owner: null } },
    ...w.task_order.map((id): NewEvent => ({ type: "task_queued", task: id, data: {} })),
    ...extra,
  ];
  return replay(
    evs.map((e, i): JournalEvent => ({ ...e, seq: i + 1, at: "2026-10-20T09:00:00.000Z" })),
  );
}

/** A task's implementer in step 0, its head red on a flake in `test`. */
const flaky = (task: string, test = TEST): NewEvent[] => [
  {
    type: "agent_spawned",
    task,
    data: { role: "implementer", agent_id: `w1-${task.toLowerCase()}-implementer-1` },
  },
  { type: "stage_entered", task, data: { stage: "implement" } },
  {
    type: "remediation_requested",
    task,
    data: {
      kind: "fix_flake",
      test,
      test_file: "test/clock.test.ts",
      head: HEAD,
      run_urls: ["https://example.test/runs/9"],
      for: task,
      role: "implementer",
    },
  },
];

/** The FixRequest of `flaky(task, test)`'s remediation_requested. */
const request = (task: string, test = TEST): FixRequest =>
  requestOf(flaky(task, test)[2] as NewEvent) as FixRequest;

describe("slugOf", () => {
  it("lowercases, turns every run of other characters into one dash, trims, prefixes fix-", () => {
    expect(slugOf(TEST)).toBe("fix-clock-test-ts-advance");
    expect(slugOf("  Test/Foo.test.ts > It Works!  ")).toBe("fix-test-foo-test-ts-it-works");
  });

  it("keeps at most 40 characters of the slug (no trailing dash)", () => {
    const s = slugOf(`${"a".repeat(39)} bcd`);
    expect(s).toBe(`fix-${"a".repeat(39)}`);
    expect(s.length - "fix-".length).toBeLessThanOrEqual(40);
  });

  it("de-duplicates with -2, -3 against taken ids", () => {
    expect(slugOf(TEST, new Set(["fix-clock-test-ts-advance"]))).toBe(
      "fix-clock-test-ts-advance-2",
    );
    expect(
      slugOf(TEST, new Set(["fix-clock-test-ts-advance", "fix-clock-test-ts-advance-2"])),
    ).toBe("fix-clock-test-ts-advance-3");
  });

  it("a test with no slug characters is still a task id", () => {
    expect(slugOf(">>>")).toBe("fix-test");
  });
});

describe("fixerFor (SPEC §4.6.16)", () => {
  it("no fixer yet: a synthetic task_queued for the test, for the requesting task", () => {
    const rec = record(flaky("T3"));
    const v = fixerFor(rec, request("T3"), 3);
    expect(v).toEqual({
      add: {
        type: "task_queued",
        task: "fix-clock-test-ts-advance",
        data: {
          issue: 0,
          synthetic: true,
          title: `Fix flaky test ${TEST}`,
          remediation: {
            kind: "fix_flake",
            test: TEST,
            test_file: "test/clock.test.ts",
            run_urls: ["https://example.test/runs/9"],
            for: ["T3"],
          },
        },
      },
    });
  });

  it("a second request for the same test reuses the fixer, and the reducer adds the task to `for`", () => {
    const first = record(flaky("T3"));
    const add = fixerFor(first, request("T3"), 3);
    if (!("add" in add)) throw new Error("expected add");
    const rec = record([...flaky("T3"), add.add, ...flaky("T7")]);
    expect(fixerFor(rec, request("T7"), 3)).toEqual({ reuse: "fix-clock-test-ts-advance" });
    const fixer = rec.wave?.tasks["fix-clock-test-ts-advance"];
    expect(fixer?.remediation?.for).toEqual(["T3", "T7"]);
    // The plan as submitted never has it.
    expect(rec.plan?.tasks["fix-clock-test-ts-advance"]).toBeUndefined();
    expect(rec.state?.spec?.tasks["fix-clock-test-ts-advance"]).toBeUndefined();
  });

  it("the fixer is a task like any other: wave pipeline, issue 0, no after, its test's file", () => {
    const first = record(flaky("T3"));
    const add = fixerFor(first, request("T3"), 3);
    if (!("add" in add)) throw new Error("expected add");
    const rec = record([...flaky("T3"), add.add]);
    const def = rec.wave?.tasks["fix-clock-test-ts-advance"];
    expect(def).toMatchObject({
      id: "fix-clock-test-ts-advance",
      issue: 0,
      title: `Fix flaky test ${TEST}`,
      after: [],
      stages: wave.stages,
      pipeline: wave.pipeline,
      model: "m",
      host: "local",
      files: ["test/clock.test.ts"],
      synthetic: true,
    });
    expect(rec.wave?.task_order.at(-1)).toBe("fix-clock-test-ts-advance");
    // It waits for nothing: what it fixes is not a flake it is parked on.
    expect(
      rec.state?.tasks.find((x) => x.id === "fix-clock-test-ts-advance")?.why_waiting,
    ).toBeUndefined();
    const t = rec.state?.tasks.find((x) => x.id === "fix-clock-test-ts-advance");
    expect(t).toMatchObject({
      issue: 0,
      stage: "queued",
      synthetic: true,
      remediation: { kind: "fix_flake", test: TEST, for: ["T3"] },
    });
  });

  it("a fourth distinct test at fix_flake_max 3 is over budget", () => {
    let extra: NewEvent[] = [];
    for (const [i, test] of ["a.test.ts > one", "b.test.ts > two", "c.test.ts > three"].entries()) {
      const task = ["T1", "T3", "T7"][i] as string;
      const rec = record([...extra, ...flaky(task, test)]);
      const v = fixerFor(rec, request(task, test), 3);
      if (!("add" in v)) throw new Error(`expected add for ${test}`);
      extra = [...extra, ...flaky(task, test), v.add];
    }
    const more = [
      ...extra,
      {
        type: "remediation_requested",
        task: "T1",
        data: { kind: "fix_flake", test: "d.test.ts > four", head: HEAD, role: "implementer" },
      } satisfies NewEvent,
    ];
    const rec = record(more);
    expect(fixerFor(rec, request("T1", "d.test.ts > four"), 3)).toEqual({
      over_budget: { key: "fix_flake_max", used: 3, max: 3 },
    });
    // The same test as an existing fixer is never over budget: it joins it.
    const again = record([...extra, ...flaky("T1", "b.test.ts > two")]);
    expect(fixerFor(again, request("T1", "b.test.ts > two"), 3)).toEqual({
      reuse: "fix-b-test-ts-two",
    });
  });

  it("a closed fixer, or the fixer's own head, is refused (the owner decides)", () => {
    const first = record(flaky("T3"));
    const add = fixerFor(first, request("T3"), 3);
    if (!("add" in add)) throw new Error("expected add");
    const closed = record([
      ...flaky("T3"),
      add.add,
      {
        type: "remediation_closed",
        task: "fix-clock-test-ts-advance",
        data: { kind: "fix_flake", test: TEST, outcome: "failed", why: "cancelled", released: [] },
      },
      ...flaky("T7"),
    ]);
    expect(fixerFor(closed, request("T7"), 3)).toMatchObject({
      refuse: expect.stringContaining("fix-clock-test-ts-advance"),
    });
    const own = record([...flaky("T3"), add.add, ...flaky("fix-clock-test-ts-advance")]);
    expect(fixerFor(own, request("fix-clock-test-ts-advance"), 3)).toMatchObject({
      refuse: expect.stringContaining("its own"),
    });
  });
});

describe("releasedBy and remediation_closed", () => {
  const twoBlocked = () => {
    const first = record(flaky("T3"));
    const add = fixerFor(first, request("T3"), 3);
    if (!("add" in add)) throw new Error("expected add");
    return [...flaky("T3"), add.add, ...flaky("T7")];
  };

  it("every task in `for` still parked on the test", () => {
    const rec = record(twoBlocked());
    expect(releasedBy(rec, "fix-clock-test-ts-advance")).toEqual(["T3", "T7"]);
  });

  it("not a task whose head moved off the flake, nor a cancelled one", () => {
    const rec = record([
      ...twoBlocked(),
      { type: "pr_head_moved", task: "T3", data: { from: HEAD, to: "f00" } },
      { type: "task_cancelled", task: "T7", data: {} },
    ]);
    expect(releasedBy(rec, "fix-clock-test-ts-advance")).toEqual([]);
  });

  it("landed: the released tasks' remediation is marked landed (gone from the state); the fixer keeps its outcome", () => {
    const rec = record([
      ...twoBlocked(),
      {
        type: "remediation_closed",
        task: "fix-clock-test-ts-advance",
        data: {
          kind: "fix_flake",
          test: TEST,
          outcome: "landed",
          released: ["T3", "T7"],
        },
      },
    ]);
    expect(rec.pipeline.T3?.remediation).toMatchObject({ test: TEST, landed: true });
    expect(rec.pipeline.T7?.remediation).toMatchObject({ test: TEST, landed: true });
    const t3 = rec.state?.tasks.find((t) => t.id === "T3");
    expect(t3?.remediation).toBeUndefined();
    expect(t3?.why_waiting).toBeUndefined();
    expect(rec.wave?.tasks["fix-clock-test-ts-advance"]?.remediation?.outcome).toBe("landed");
    expect(
      rec.state?.tasks.find((t) => t.id === "fix-clock-test-ts-advance")?.remediation?.outcome,
    ).toBe("landed");
  });

  it("a task_queued for a synthetic task survives a plan version that does not list it", () => {
    const next: Wave = { ...wave, version: 2 };
    const rec = record([
      ...twoBlocked(),
      { type: "wave_versioned", data: { version: 2, plan: next, wave: next } },
    ]);
    expect(rec.wave?.tasks["fix-clock-test-ts-advance"]?.synthetic).toBe(true);
    expect(rec.wave?.task_order).toContain("fix-clock-test-ts-advance");
  });
});
