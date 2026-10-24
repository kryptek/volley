import { describe, expect, it } from "vitest";
import { type Frame, frameOf } from "../src/clawd/canvas";
import { BODY_FAILED, C, H, W } from "../src/clawd/palette";
import { CLAWD_LABEL, CLAWD_STATES, VARIANTS } from "../src/clawd/variants";

const TS = Array.from({ length: 96 }, (_, t) => t);
/** Still by design: exempt from "frame t and t+1 differ". */
const STILL = new Set(["failed", "done"]);
const BODIES = new Set<string>([C.body, BODY_FAILED, C.bodyHi]);

const cases = CLAWD_STATES.flatMap((state) =>
  VARIANTS[state].map((v) => [state, v.name, v] as const),
);

describe.each(cases)("%s · %s", (state, _name, v) => {
  it("every frame is non-empty, in the 16×14 grid and #rrggbb", () => {
    for (const t of TS) {
      const f = v.frame(t);
      expect(f.length).toBeGreaterThan(0);
      for (const p of f) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(W);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(H);
        expect(p.c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("is deterministic", () => {
    for (const t of TS) expect(v.frame(t)).toEqual(v.frame(t));
  });

  it(STILL.has(state) ? "is still" : "animates", () => {
    const moves = TS.some((t) => JSON.stringify(v.frame(t)) !== JSON.stringify(v.frame(t + 1)));
    expect(moves).toBe(!STILL.has(state));
  });

  it("contains the body colour", () => {
    for (const t of TS) expect(v.frame(t).some((p) => BODIES.has(p.c))).toBe(true);
  });
});

describe("Clawd variants", () => {
  it("three variants per step, one per rest state, a label for each", () => {
    for (const s of ["implement", "review", "fixup", "merge_ready"] as const) {
      expect(VARIANTS[s]).toHaveLength(3);
    }
    for (const s of ["dozing", "needs_you", "failed", "done"] as const) {
      expect(VARIANTS[s]).toHaveLength(1);
    }
    expect(CLAWD_LABEL).toEqual({
      implement: "implementing",
      review: "reviewing",
      fixup: "fixing up",
      merge_ready: "merge-ready",
      done: "done",
      failed: "failed",
      needs_you: "needs you",
      dozing: "waiting",
    });
  });
});

describe("clawd()", () => {
  const at = (f: Frame, x: number, y: number) => f.find((p) => p.x === x && p.y === y)?.c;

  it("paints the 12×9 body at ox=2, oy=4", () => {
    const f = frameOf((_t, s) => s.clawd({ eyes: "closed" }), 0);
    // 6 body rows: 8 + 8 + 12 + 12 + 8 + 8 = 56 cells, plus 4 legs × 2 = 64 pixels.
    expect(f).toHaveLength(64);
    expect(at(f, 4, 4)).toBe(C.body);
    expect(at(f, 2, 6)).toBe(C.body);
    expect(at(f, 13, 7)).toBe(C.body);
    expect(at(f, 2, 4)).toBeUndefined();
    for (const lx of [4, 6, 9, 11]) {
      expect(at(f, lx, 10)).toBe(C.body);
      expect(at(f, lx, 11)).toBe(C.body);
    }
    expect(at(f, 5, 6)).toBe(C.eye);
  });

  it('eyes: "x" paints the ten X pixels', () => {
    const f = frameOf((_t, s) => s.clawd({ eyes: "x" }), 0);
    expect(f.filter((p) => p.c === C.eye)).toHaveLength(10);
  });
});
