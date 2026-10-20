import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextSteer } from "../src/controls";
import { apply, emptyRecord, reduce, replay } from "../src/reducer";
import type { JournalEvent } from "../src/types";
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
