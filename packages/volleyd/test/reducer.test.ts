import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextSteer } from "../src/controls";
import { apply, emptyRecord, reduce, replay } from "../src/reducer";
import type { JournalEvent } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { envelope, schemaErrors } from "./helpers/schema";

const events: JournalEvent[] = readFileSync(
  new URL("./fixtures/journal.jsonl", import.meta.url),
  "utf-8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

describe("reduce", () => {
  it("replays the fixture journal into a schema-valid wave state", () => {
    const state = reduce(events);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);

    expect(state.wave).toBe("2026-10-20-example");
    expect(state.owner).toBe("coordinator-ab12");
    expect(state.status).toBe("running");
    expect(state.updated_at).toBe(events.at(-1)?.at);
    expect(state.open_decisions).toEqual([]);
    expect(state.gates).toEqual([]);
    expect(state.spec?.tasks.T3).toEqual({ issue: 104, after: ["T1", "T2"] });
    expect(state.spec?.pipeline).toEqual([
      "implement",
      ["spec_review", "quality_review"],
      "fixup",
      "merge_ready",
    ]);

    const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
    expect(byId.T0).toMatchObject({
      stage: "done",
      agents: { implementer: "2026-10-20-example-t0-implementer-1" },
      pr: { number: 7, ci: "green" },
    });
    expect(byId.T0?.waiting_on).toBeUndefined();
    expect(byId.T1).toMatchObject({ stage: "queued", agents: {} });
    expect(byId.T1?.waiting_on).toBeUndefined();
    expect(byId.T3).toMatchObject({
      stage: "queued",
      waiting_on: ["T1", "T2"],
      why_waiting: "after: T1, T2",
    });
  });

  it("tracks gates and open decisions mid-wave", () => {
    // Stop right after decision_opened (T0 merge-ready, d1 open).
    const cut = events.findIndex((e) => e.type === "decision_opened");
    const state = reduce(events.slice(0, cut + 1));
    expect(state.gates).toEqual(["T0"]);
    expect(state.open_decisions).toEqual(["d1"]);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
  });

  it("is idempotent: re-applying an already-applied seq is a no-op", () => {
    const rec = replay(events);
    for (const e of events) {
      expect(apply(rec, e)).toBe(rec);
    }
    expect(replay([...events, ...events])).toEqual(rec);
    // Interleaved duplicates don't double-count admissions or spawns.
    const doubled = events.flatMap((e) => [e, e]);
    expect(replay(doubled)).toEqual(rec);
  });

  it("does not mutate the record it is given", () => {
    const first = replay(events.slice(0, 5));
    const copy = structuredClone(first);
    apply(first, events[5] as JournalEvent);
    expect(first).toEqual(copy);
  });

  it("tracks admissions and spawns for the scheduler", () => {
    const rec = replay(events);
    expect(rec.seq).toBe(events.length);
    expect(rec.admitted).toEqual(["T0", "T1"]);
    expect(rec.spawns).toBe(1);
  });

  it("tasks[].base_sha comes from agent_spawned, survives replay, and a start-ref spawn keeps it", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const base = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const more: JournalEvent[] = [
      {
        seq: last.seq + 1,
        at,
        type: "agent_spawned",
        task: "T1",
        data: {
          role: "implementer",
          agent_id: "2026-10-20-example-t1-implementer-1",
          base_sha: base,
        },
      },
      // A reviewer cut from the PR head (a pipeline start ref) names no release base.
      {
        seq: last.seq + 2,
        at,
        type: "agent_spawned",
        task: "T1",
        data: {
          role: "spec_reviewer",
          agent_id: "2026-10-20-example-t1-spec_reviewer-1",
          start: "f".repeat(40),
        },
      },
    ];
    const state = reduce([...events, ...more]);
    const t1 = state.tasks.find((t) => t.id === "T1");
    expect(t1?.base_sha).toBe(base);
    expect(state.tasks.find((t) => t.id === "T2")?.base_sha).toBeUndefined();
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
    // Replayed (twice over, as after a restart) it is the same.
    const all = [...events, ...more];
    expect(replay([...all, ...all]).state?.tasks.find((t) => t.id === "T1")?.base_sha).toBe(base);
  });

  it("throws when the journal has no wave_submitted", () => {
    expect(() => reduce([])).toThrow(/wave_submitted/);
    expect(emptyRecord().state).toBeNull();
  });

  it("a config_changed event never touches a wave's overrides (they change only by wave_versioned)", () => {
    const base = replay(events);
    const seq = base.seq + 1;
    const next = apply(base, {
      seq,
      at: "2026-10-20T12:00:00.000Z",
      type: "config_changed",
      data: { overrides: { hard_ceiling: 99 } },
    });
    expect(next.overrides).toEqual(base.overrides);
    expect(next.state?.status).toBe(base.state?.status);
  });

  it("applies wave status events", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const paused = reduce([...events, { seq: last.seq + 1, at, type: "wave_paused", data: {} }]);
    expect(paused.status).toBe("paused");
    const stopped = reduce([
      ...events,
      { seq: last.seq + 1, at, type: "wave_paused", data: {} },
      { seq: last.seq + 2, at, type: "wave_resumed", data: {} },
      { seq: last.seq + 3, at, type: "task_cancelled", task: "T3", data: {} },
      { seq: last.seq + 4, at, type: "owner_claimed", data: { owner: "coordinator-cd34" } },
    ]);
    expect(stopped.status).toBe("running");
    expect(stopped.owner).toBe("coordinator-cd34");
    expect(stopped.tasks.find((t) => t.id === "T3")?.stage).toBe("cancelled");
  });

  it("queues steers per task: steering_sent with the same id or steering_dropped empties it", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    let seq = last.seq;
    const ev = (type: JournalEvent["type"], data: Record<string, unknown>): JournalEvent => ({
      seq: ++seq,
      at,
      type,
      task: "T1",
      data,
    });
    const queued = (id: string, n: number, extra: Record<string, unknown> = {}) =>
      ev("steering_queued", { message_id: id, seq: n, text: `t${n}`, by: "coord", ...extra });
    let rec = replay([...events, queued("m1", 1)]);
    expect(rec.queued_steers.T1).toEqual([
      { message_id: "m1", seq: 1, text: "t1", by: "coord", at },
    ]);
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.queued_steers).toBe(1);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // Queued and delivered steers share one numbering per task.
    expect(nextSteer(rec, "T1")).toEqual({ seq: 2, supersedes: "m1" });
    rec = apply(rec, queued("m2", 2, { supersedes: "m1", role: "fixup" }));
    expect(rec.queued_steers.T1?.map((q) => q.message_id)).toEqual(["m1", "m2"]);
    expect(rec.queued_steers.T1?.[1]).toMatchObject({ role: "fixup", supersedes: "m1" });

    // The first is delivered: off the queue, and the numbering stays at the latest (2).
    rec = apply(
      rec,
      ev("steering_sent", { type: "steering", message_id: "m1", seq: 1, queued: true }),
    );
    expect(rec.queued_steers.T1?.map((q) => q.message_id)).toEqual(["m2"]);
    expect(nextSteer(rec, "T1")).toEqual({ seq: 3, supersedes: "m2" });

    rec = apply(rec, ev("steering_dropped", { message_ids: ["m2"], reason: "task cancelled" }));
    expect(rec.queued_steers.T1).toBeUndefined();
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.queued_steers).toBeUndefined();
  });

  it("a cancelled task drops its queue", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const rec = replay([
      ...events,
      {
        seq: last.seq + 1,
        at,
        type: "steering_queued",
        task: "T1",
        data: { message_id: "m1", seq: 1, text: "x", by: "coord" },
      },
      { seq: last.seq + 2, at, type: "task_cancelled", task: "T1", data: {} },
    ]);
    expect(rec.queued_steers.T1).toBeUndefined();
  });
});

describe("task_placed (SPEC §4.6.15)", () => {
  const wave = parseWaveFile(
    "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\nplacement: auto\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n",
  );
  const AT = "2026-10-19T10:00:00.000Z";
  const base: JournalEvent[] = [
    { seq: 1, at: AT, type: "wave_submitted", data: { wave } },
    { seq: 2, at: AT, type: "task_queued", task: "T1", data: { issue: 1 } },
    { seq: 3, at: AT, type: "task_queued", task: "T2", data: { issue: 2 } },
  ];
  const candidates = [
    { host: "box-a", score: 0.81, line: "load 3.2 on 16 cores · 1/4 agents · 71% mem · usage 34%" },
    {
      host: "control",
      score: 0.63,
      line: "load 6.0 on 8 cores · 2/12 agents · 40% mem · usage 34%",
    },
    { host: "box-b", score: null, line: "ineligible: draining" },
  ];
  const placedA: JournalEvent = {
    seq: 4,
    at: AT,
    type: "task_placed",
    task: "T1",
    data: { task: "T1", host: "box-a", score: 0.81, candidates, by: "auto" },
  };
  const placedLocal: JournalEvent = {
    seq: 5,
    at: AT,
    type: "task_placed",
    task: "T2",
    data: { task: "T2", host: "control", local: true, score: 0.63, candidates, by: "auto" },
  };

  it("is a wave event whose data validates against the schema", () => {
    for (const e of [placedA, placedLocal]) {
      expect(
        schemaErrors(
          "wave-event.schema.json",
          envelope("_waves/events", e.type, {
            wave: "w1",
            seq: e.seq,
            at: e.at,
            task: e.task,
            data: e.data,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("fills tasks[].placement, sets the task's host, and replays idempotently by seq", () => {
    const rec = replay([...base, placedA, placedLocal]);
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(t1?.placement).toEqual({
      host: "box-a",
      by: "auto",
      score: 0.81,
      decided_at: AT,
      candidates,
    });
    // The effective plan now runs T1 on box-a and T2 on the supervisor's own machine: every
    // later role (reviewers, fixup, rebase) reads its host from there.
    expect(rec.wave?.tasks.T1?.host).toBe("box-a");
    expect(rec.wave?.tasks.T2?.host).toBe("local");
    // The submitted plan keeps `auto`.
    expect(rec.plan?.tasks.T1?.host).toBe("auto");
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // Re-applying the same event is a no-op.
    expect(apply(rec, placedA)).toBe(rec);
  });

  it("a re-placement (by: decision) carries from; a cancelled task is placed afresh when re-queued", () => {
    let rec = replay([...base, placedA]);
    rec = apply(rec, {
      seq: 5,
      at: AT,
      type: "task_placed",
      task: "T1",
      data: { task: "T1", host: "box-b", score: 0.5, candidates, by: "decision", from: "box-a" },
    });
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.placement).toMatchObject({
      host: "box-b",
      by: "decision",
    });
    expect(rec.wave?.tasks.T1?.host).toBe("box-b");
    rec = apply(rec, { seq: 6, at: AT, type: "task_cancelled", task: "T1", data: {} });
    rec = apply(rec, { seq: 7, at: AT, type: "task_queued", task: "T1", data: { issue: 1 } });
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.placement).toBeUndefined();
    expect(rec.wave?.tasks.T1?.host).toBe("auto");
  });

  it("a new plan version keeps the placement of a task that is still auto", () => {
    let rec = replay([...base, placedA]);
    const v2 = { ...wave, version: 2 };
    rec = apply(rec, { seq: 5, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    expect(rec.wave?.tasks.T1?.host).toBe("box-a");
    expect(rec.wave?.tasks.T2?.host).toBe("auto");
  });
});
