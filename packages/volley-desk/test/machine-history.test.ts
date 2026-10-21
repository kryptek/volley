import { describe, expect, it } from "vitest";
import { demoState } from "../src/store/fixtures";
import {
  HISTORY_MAX,
  HISTORY_MS,
  type MachineSample,
  mergeSamples,
  pushRecord,
} from "../src/store/machineHistory";
import { initialState, reduce, reduceAll, resync } from "../src/store/reducer";
import { NOW, machineMsg, machineRecord } from "./helpers/desk-msgs";

const S = 1000;
const at = (ms: number) => new Date(ms).toISOString();

describe("pushRecord: one machine's ring", () => {
  it("appends oldest first: load per core and memory used, as percentages", () => {
    let h = pushRecord(
      undefined,
      machineRecord({ cores: 16, load: [4, 1, 1], last_seen: at(NOW) }),
    );
    h = pushRecord(h, machineRecord({ cores: 16, load: [8, 1, 1], last_seen: at(NOW + 30 * S) }));
    expect(h).toEqual([
      { at: NOW, load: 25, mem: 29 },
      { at: NOW + 30 * S, load: 50, mem: 29 },
    ]);
  });

  it("keeps at most HISTORY_MAX samples, all within 10 minutes of the newest", () => {
    let h: MachineSample[] | undefined;
    for (let t = 0; t <= 12 * 60 * S; t += 30 * S) {
      h = pushRecord(h, machineRecord({ last_seen: at(NOW + t) }));
    }
    const ring = h ?? [];
    expect(ring.length).toBeLessThanOrEqual(HISTORY_MAX);
    const newest = ring[ring.length - 1]?.at ?? 0;
    expect(newest).toBe(NOW + 12 * 60 * S);
    for (const s of ring) expect(newest - s.at).toBeLessThanOrEqual(HISTORY_MS);
    expect(ring.map((s) => s.at)).toEqual([...ring.map((s) => s.at)].sort((a, b) => a - b));
  });

  it("a repeated last_seen (a redelivery, a reconnect's retained copy) adds nothing", () => {
    const r = machineRecord({ last_seen: at(NOW) });
    const h = pushRecord(pushRecord(undefined, r), r);
    expect(h).toHaveLength(1);
  });

  it("a down record adds nothing: it carries the LWT's stale values", () => {
    const h = pushRecord(undefined, machineRecord({ last_seen: at(NOW) }));
    expect(pushRecord(h, machineRecord({ tunnel: "down", last_seen: at(NOW + 90 * S) }))).toEqual(
      h,
    );
    expect(pushRecord(undefined, machineRecord({ tunnel: "down" }))).toEqual([]);
  });

  it("the supervisor's own (local) record is sampled", () => {
    expect(pushRecord(undefined, machineRecord({ tunnel: "local" }))).toHaveLength(1);
  });

  it("a record without memory has no memory reading", () => {
    const { memory: _, ...bare } = machineRecord();
    expect(pushRecord(undefined, bare)[0]?.mem).toBeNull();
  });
});

describe("mergeSamples", () => {
  it("dedupes by reading time, sorts oldest first and keeps the cap", () => {
    const s = (t: number): MachineSample => ({ at: NOW + t * S, load: t, mem: t });
    expect(mergeSamples([s(0), s(60)], [s(30), s(60)]).map((x) => x.at)).toEqual([
      NOW,
      NOW + 30 * S,
      NOW + 60 * S,
    ]);
    const many = Array.from({ length: 40 }, (_, i) => s(i * 10));
    const merged = mergeSamples([], many);
    expect(merged).toHaveLength(HISTORY_MAX);
    expect(merged[merged.length - 1]?.at).toBe(NOW + 390 * S);
  });
});

describe("the store's machineHistory", () => {
  it("each machine record grows its machine's ring; two machines never mix", () => {
    const state = reduceAll(initialState(), [
      machineMsg(machineRecord({ name: "box-a", last_seen: at(NOW) })),
      machineMsg(machineRecord({ name: "box-c", last_seen: at(NOW) })),
      machineMsg(machineRecord({ name: "box-a", last_seen: at(NOW + 30 * S) })),
    ]);
    expect(state.machineHistory?.["box-a"]).toHaveLength(2);
    expect(state.machineHistory?.["box-c"]).toHaveLength(1);
  });

  it("a record the store rejects adds nothing", () => {
    const state = reduce(
      initialState(),
      machineMsg(machineRecord({ name: "box-a" }), "box-a", "x"),
    );
    expect(state.machineHistory?.["box-a"]).toBeUndefined();
  });

  it("a cleared record (peer_remove) drops the machine's ring", () => {
    const state = reduceAll(initialState(), [
      machineMsg(machineRecord({ name: "box-a" })),
      machineMsg(null, "box-a"),
    ]);
    expect(state.machineHistory?.["box-a"]).toBeUndefined();
  });

  it("a resync keeps the rings; the replay's retained copy is not a second sample", () => {
    const rec = machineMsg(machineRecord({ name: "box-a" }));
    const state = reduce(resync(reduce(initialState(), rec)), rec);
    expect(state.machineHistory?.["box-a"]).toHaveLength(1);
  });

  it("the demo: one sample for studio and box-a, none for box-b (down)", () => {
    const h = demoState(NOW).machineHistory ?? {};
    expect(h.studio).toHaveLength(1);
    expect(h["box-a"]).toHaveLength(1);
    expect(h["box-b"] ?? []).toHaveLength(0);
  });
});
