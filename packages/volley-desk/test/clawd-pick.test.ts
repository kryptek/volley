import { describe, expect, it } from "vitest";
import { fnv1a, pickVariant } from "../src/clawd/pick";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";

describe("pickVariant", () => {
  it("FNV-1a 32-bit", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });

  it("the same input gives the same output, in [0, n)", () => {
    for (const id of ["a", "status-chip-t1-fixup-1", "x".repeat(200)]) {
      for (const n of [1, 2, 3, 7]) {
        const i = pickVariant(id, "implement", n);
        expect(pickVariant(id, "implement", n)).toBe(i);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
        expect(Number.isInteger(i)).toBe(true);
      }
    }
  });

  // Pinned: these lock the pick across devices and releases. Changing the hash
  // (or the key's shape) changes every agent's sprite; do it on purpose only.
  it.each([
    ["status-chip-t1-fixup-1", "fixup", 0],
    ["status-chip-t2-implementer-1", "merge_ready", 1],
    ["ci-speed-t3b-implementer-1", "implement", 1],
    ["leaderboard-t1-implementer-1", "implement", 0],
    ["demo-spec-reviewer", "review", 0],
  ])("%s · %s → %i", (id, state, want) => {
    expect(pickVariant(id, state, 3)).toBe(want);
  });

  it("the demo's agents do not all get the same implement variant", () => {
    const s = reduceAll(initialState(), demoMessages(Date.parse("2026-10-18T12:00:00Z")));
    const picks = new Set(Object.keys(s.agents).map((id) => pickVariant(id, "implement", 3)));
    expect(picks.size).toBeGreaterThanOrEqual(2);
  });
});
