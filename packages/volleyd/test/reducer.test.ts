import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
