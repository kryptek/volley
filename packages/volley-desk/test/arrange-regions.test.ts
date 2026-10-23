// Arrange & fit by region (#397): the waves, the side windows next to them and the list
// windows (Needs you) capped at the fit area's height; ties go to the fuller layout.
import { describe, expect, it } from "vitest";
import {
  type Box,
  CGAP,
  type Cluster,
  arrange,
  candidates,
  capListHeight,
  fitArea,
  pickBest,
} from "../src/layout/arrange";

const box = (id: string, w: number, h: number): Box => ({ id, w, h });
type R = { x: number; y: number; w: number; h: number };

// The Desk's real sizes: wave 620 x 440, agent 460 x 470, coordinators 430 wide, Needs you
// 460 wide and 130 + 150 per item tall, Machines 460 wide.
const wave = (id: string, n: number): Cluster => ({
  main: box(id, 620, 440),
  kids: Array.from({ length: n }, (_, i) => box(`${id}-${i}`, 460, 470)),
});
const machines: Cluster = { main: box("machines", 460, 80 + 76 * 2), kids: [], side: true };
const sessions: Cluster = {
  main: box("_sessions", 620, 200),
  kids: [box("s1", 460, 470), box("s2", 460, 470)],
  side: true,
};
const coords: Cluster = { main: box("coordinators", 430, 150 + 66 * 4), kids: [], side: true };
const inbox: Cluster = { main: box("inbox", 460, 130 + 150 * 16), kids: [], list: true };
const big = wave("w1", 7);
const all = [big, machines, sessions, coords, inbox];
const wide = { width: 2560, height: 1400 };
const area = fitArea(wide);

const sizes = (cls: readonly Cluster[], cap = Number.POSITIVE_INFINITY) =>
  Object.fromEntries(
    cls.flatMap((c) =>
      [c.main, ...c.kids].map((b) => [b.id, { w: b.w, h: c.list ? Math.min(b.h, cap) : b.h }]),
    ),
  );
const rectsOf = (
  place: Record<string, { x: number; y: number }>,
  dims: Record<string, { w: number; h: number }>,
) =>
  Object.fromEntries(
    Object.entries(place).map(([id, p]) => [
      id,
      { ...p, w: dims[id]?.w ?? 0, h: dims[id]?.h ?? 0 },
    ]),
  ) as Record<string, R>;
const union = (rs: readonly R[]): R => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rs.map((r) => r.x + r.w)) - x,
    h: Math.max(...rs.map((r) => r.y + r.h)) - y,
  };
};
const inside = (r: R, outer: R) =>
  r.x >= outer.x - 0.5 &&
  r.y >= outer.y - 0.5 &&
  r.x + r.w <= outer.x + outer.w + 0.5 &&
  r.y + r.h <= outer.y + outer.h + 0.5;
/** The gap between two rects that do not overlap: along x or y, whichever separates them. */
const gapBetween = (a: R, b: R) =>
  Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

describe("Arrange & fit lays out regions (#397)", () => {
  const r = arrange(all, wide);
  if (!r) throw new Error("no arrangement");
  const dims = sizes(all, area.h);
  const rects = rectsOf(r.place, dims);
  const waveIds = [big.main.id, ...big.kids.map((k) => k.id)];
  const sideIds = [machines, sessions, coords].flatMap((c) => [
    c.main.id,
    ...c.kids.map((k) => k.id),
  ]);

  it("a 7-agent wave next to a Needs-you window taller than the area gets more than one agent column", () => {
    const cols = new Set(big.kids.map((k) => r.place[k.id]?.x));
    expect(cols.size).toBeGreaterThanOrEqual(2);
  });

  it("the block uses at least 60% of the fit area's width", () => {
    const u = union(Object.values(rects));
    expect(u.w * r.view.s).toBeGreaterThanOrEqual(0.6 * area.w);
  });

  it("the Needs-you window is capped at the fit area's height", () => {
    expect(capListHeight(inbox.main.h, area)).toBe(area.h);
    expect(capListHeight(300, area)).toBe(300);
    const c = candidates(all, wide);
    for (const x of c) {
      const ny = rectsOf(x.place, dims).inbox;
      expect(ny?.h).toBeLessThanOrEqual(area.h);
    }
  });

  it("each region's windows lie inside its bounding box, and the regions do not overlap", () => {
    const { waves, side, list } = r.regions;
    if (!waves || !side || !list) throw new Error("missing region");
    for (const id of waveIds) expect(inside(rects[id] as R, waves)).toBe(true);
    for (const id of sideIds) expect(inside(rects[id] as R, side)).toBe(true);
    expect(inside(rects.inbox as R, list)).toBe(true);
    expect(gapBetween(waves, side)).toBeGreaterThan(0);
    expect(gapBetween(side, list)).toBeGreaterThan(0);
    expect(gapBetween(waves, list)).toBeGreaterThan(0);
  });

  it("the side region sits next to the waves, a cluster gap away", () => {
    const { waves, side } = r.regions;
    if (!waves || !side) throw new Error("missing region");
    expect(gapBetween(waves, side)).toBeLessThanOrEqual(CGAP);
  });

  it("no side window is the leftmost or rightmost box alone in its column", () => {
    const boxes = Object.entries(rects);
    const left = Math.min(...boxes.map(([, b]) => b.x));
    const right = Math.max(...boxes.map(([, b]) => b.x + b.w));
    const side = new Set(sideIds);
    /** Some window outside the side region shares `b`'s column (overlaps it across). */
    const shared = (b: R) =>
      boxes.some(([id, o]) => !side.has(id) && o.x < b.x + b.w && b.x < o.x + o.w);
    for (const id of sideIds) {
      const b = rects[id] as R;
      if (b.x === left || b.x + b.w === right) expect(shared(b), id).toBe(true);
    }
  });

  it("region bounding boxes (snapshot)", () => {
    // 4 agent columns; the side windows in a row under the waves; Needs you capped, last
    expect(r.regions).toEqual({
      waves: { x: 0, y: 0, w: 2604, h: 976 },
      side: { x: 0, y: 976 + CGAP, w: 2694, h: 470 },
      list: { x: 2694 + CGAP, y: 0, w: 460, h: area.h },
    });
    expect(r.view.s).toBeCloseTo(0.772923, 6);
  });
});

describe("scoring: scale first, then the fraction of the area used", () => {
  const cand = (s: number, used: number) => ({ s, used });

  it("of two candidates with equal scale, the fuller one wins", () => {
    expect(pickBest([cand(0.8, 0.3), cand(0.8, 0.7), cand(0.8, 0.5)])).toBe(1);
  });

  it("a larger scale still beats a fuller one", () => {
    expect(pickBest([cand(0.8, 0.9), cand(0.9, 0.2)])).toBe(1);
  });

  it("equal scale and equal use keep the earlier candidate", () => {
    expect(pickBest([cand(0.8, 0.5), cand(0.8, 0.5)])).toBe(0);
  });

  it("returns -1 for no candidates", () => {
    expect(pickBest([])).toBe(-1);
  });

  it("equal-scale layouts pick the wider, fuller one, not the single column", () => {
    // Two short agents: 1 column or 2 are both capped at 1.1 on a big screen.
    const huge = { width: 10_000, height: 10_000 };
    const cl: Cluster = {
      main: box("w", 620, 400),
      kids: [box("k1", 460, 100), box("k2", 460, 100)],
    };
    const r = arrange([cl], huge);
    expect(r?.place.k1?.x).not.toBe(r?.place.k2?.x);
  });
});

describe("a column count per cluster", () => {
  it("a 7-agent wave and a 1-agent wave get different columns", () => {
    const r = arrange([wave("big", 7), wave("small", 1)], wide);
    if (!r) throw new Error("no arrangement");
    const bigCols = new Set(wave("big", 7).kids.map((k) => r.place[k.id]?.x)).size;
    expect(bigCols).toBeGreaterThan(1);
    const c = candidates([wave("big", 7), wave("small", 1)], wide);
    expect(c.some((x) => x.cols.big !== x.cols.small)).toBe(true);
  });

  it("a big wave spreads out while a small one stays compact", () => {
    const sm = wave("small", 2);
    const r = arrange([wave("big", 9), sm], { width: 1920, height: 1080 });
    if (!r) throw new Error("no arrangement");
    const bigCols = new Set(wave("big", 9).kids.map((k) => r.place[k.id]?.x)).size;
    const smallCols = new Set(sm.kids.map((k) => r.place[k.id]?.x)).size;
    expect(bigCols).toBeGreaterThan(smallCols);
  });
});

describe("Arrange & fit after a close reclaims the gap", () => {
  it("the region's boxes pack as if the closed window never existed", () => {
    const before = [wave("w1", 3), machines, coords, sessions, inbox];
    const after = [wave("w1", 3), coords, sessions, inbox];
    const a = arrange(after, wide);
    const fresh = arrange(after, wide);
    expect(a).toEqual(fresh);
    const b = arrange(before, wide);
    if (!a || !b) throw new Error("no arrangement");
    expect(a.place.machines).toBeUndefined();
    // nothing sits where Machines did: the side region shrank
    const side = a.regions.side;
    const sideBefore = b.regions.side;
    if (!side || !sideBefore) throw new Error("missing region");
    expect(side.w * side.h).toBeLessThan(sideBefore.w * sideBefore.h);
    const dims = sizes(after, area.h);
    const rects = Object.values(rectsOf(a.place, dims)).filter((q) => inside(q, side));
    // the side windows fill their region's bounding box edge to edge
    expect(union(rects)).toEqual(side);
  });
});
