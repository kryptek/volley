import { describe, expect, it } from "vitest";
import { FIT_MIN_SCALE } from "../src/canvas/useViewport";
import {
  ARRANGE_MAX_SCALE,
  ARRANGE_MIN_SCALE,
  type Box,
  CGAP,
  type Cluster,
  GAP,
  arrange,
  candidates,
  layoutCluster,
} from "../src/layout/arrange";

const box = (id: string, w: number, h: number): Box => ({ id, w, h });

// 2 waves (4 + 2 agents) + the coordinators window. Agents are in task order.
const coords: Cluster = { main: box("coordinators", 430, 360), kids: [] };
const waveA: Cluster = {
  main: box("wave-a", 620, 600),
  kids: [box("a1", 460, 500), box("a2", 460, 300), box("a3", 460, 400), box("a4", 460, 300)],
};
const waveB: Cluster = {
  main: box("wave-b", 620, 500),
  kids: [box("b1", 460, 450), box("b2", 460, 450)],
};
const clusters = [coords, waveA, waveB];
const screen = { width: 1600, height: 1000 };
// The fit area: the screen less the side gutters (24 px each) and the top bar + dock bands.
const vw = screen.width - 48;
const vh = screen.height - 64 - 110;

const sizeOf = Object.fromEntries(
  clusters.flatMap((c) => [c.main, ...c.kids]).map((b) => [b.id, b]),
);

/** Bounding box of a placement, from the boxes' own sizes. */
function bounds(place: Record<string, { x: number; y: number }>) {
  const rs = Object.entries(place).map(([id, p]) => ({ ...p, ...sizeOf[id] }) as Box & typeof p);
  return {
    minX: Math.min(...rs.map((r) => r.x)),
    minY: Math.min(...rs.map((r) => r.y)),
    W: Math.max(...rs.map((r) => r.x + r.w)),
    H: Math.max(...rs.map((r) => r.y + r.h)),
  };
}

describe("layoutCluster", () => {
  it("packs agents shortest-column-first in task order, to the right of the wave window", () => {
    const l = layoutCluster(waveA, 2);
    const col0 = 620 + GAP;
    const col1 = col0 + 460 + GAP;
    expect(l.at).toEqual({
      "wave-a": { x: 0, y: 0 },
      a1: { x: col0, y: 0 },
      a2: { x: col1, y: 0 },
      // column 1 (300 + gap) is shorter than column 0 (500 + gap): a3 goes under a2
      a3: { x: col1, y: 300 + GAP },
      a4: { x: col0, y: 500 + GAP },
    });
    expect(l.w).toBe(620 + GAP + 2 * 460 + GAP);
    expect(l.h).toBe(Math.max(600, 500 + GAP + 300, 300 + GAP + 400));
  });

  it("caps the columns at the number of agents", () => {
    const l = layoutCluster(waveB, 3);
    expect(l.w).toBe(620 + GAP + 2 * 460 + GAP);
    expect(l.at.b2).toEqual({ x: 620 + GAP + 460 + GAP, y: 0 });
  });

  it("a cluster with no agents is just the wave window", () => {
    const l = layoutCluster({ main: box("lonely", 620, 480), kids: [] }, 3);
    expect(l).toEqual({ at: { lonely: { x: 0, y: 0 } }, w: 620, h: 480 });
  });
});

describe("arrange", () => {
  it("tries agent-column counts 1..max(3, most agents in a cluster) and every row count", () => {
    const all = candidates(clusters, screen);
    // wave-a has 4 agents
    expect(all.map((c) => [c.cols, c.rows])).toEqual(
      [1, 2, 3, 4].flatMap((c) => [1, 2, 3].map((r) => [c, r])),
    );
  });

  it("spreads one big cluster across the viewport's aspect instead of a tall strip (owner finding b)", () => {
    const kids = Array.from({ length: 14 }, (_, i) => box(`k${i}`, 460, 470));
    const one: Cluster = { main: box("w", 620, 440), kids };
    const wide = { width: 1920, height: 1080 };
    const r = arrange([one], wide);
    if (!r) throw new Error("no arrangement");
    const columns = new Set(kids.map((k) => r.place[k.id]?.x)).size;
    expect(columns).toBeGreaterThan(3);
    // Beats the best a 3-column cap could do.
    const capped = Math.min(
      (wide.width - 48) / layoutCluster(one, 3).w,
      (wide.height - 174) / layoutCluster(one, 3).h,
    );
    expect(r.view.s).toBeGreaterThan(capped);
  });

  it("zooms out far enough to show everything, however many windows (owner finding b)", () => {
    const many: Cluster[] = Array.from({ length: 30 }, (_, w) => ({
      main: box(`w${w}`, 620, 440),
      kids: Array.from({ length: 4 }, (_, i) => box(`w${w}k${i}`, 460, 470)),
    }));
    const r = arrange(many, screen);
    if (!r) throw new Error("no arrangement");
    const all = many.flatMap((c) => [c.main, ...c.kids]);
    const right = Math.max(...all.map((b) => (r.place[b.id]?.x ?? 0) + b.w));
    const bottom = Math.max(...all.map((b) => (r.place[b.id]?.y ?? 0) + b.h));
    expect(r.view.s).toBeLessThan(0.2);
    expect(right * r.view.s).toBeLessThanOrEqual(vw + 0.5);
    expect(bottom * r.view.s).toBeLessThanOrEqual(vh + 0.5);
  });

  it("every candidate's size and scale match its placement (brute force)", () => {
    for (const c of candidates(clusters, screen)) {
      const b = bounds(c.place);
      expect([b.minX, b.minY]).toEqual([0, 0]);
      expect(c.W).toBe(b.W);
      expect(c.H).toBe(b.H);
      expect(c.s).toBeCloseTo(Math.min(ARRANGE_MAX_SCALE, vw / b.W, vh / b.H));
      // every window is placed
      expect(Object.keys(c.place).sort()).toEqual(Object.keys(sizeOf).sort());
    }
  });

  it("picks the placement with the largest fitting scale among candidates", () => {
    const all = candidates(clusters, screen);
    const best = Math.max(...all.map((c) => c.s));
    const r = arrange(clusters, screen);
    if (!r) throw new Error("no arrangement");
    expect(r.view.s).toBeCloseTo(best);
    // here the winner is 3 agent columns in 2 rows, clear of the runner-up by more than EPS
    const win = all.find((c) => c.s === best);
    expect([win?.cols, win?.rows]).toEqual([3, 2]);
    const runnerUp = Math.max(...all.filter((c) => c !== win).map((c) => c.s));
    expect(runnerUp).toBeLessThan(best - 0.005);
    expect(r.place).toEqual(win?.place);
    // and centres it in the fit area below the top bar
    const W = bounds(r.place).W;
    const H = bounds(r.place).H;
    expect(r.view.x).toBeCloseTo(24 + (vw - W * r.view.s) / 2);
    expect(r.view.y).toBeCloseTo(64 + (vh - H * r.view.s) / 2);
  });

  it("lays rows of clusters left to right, CGAP apart, in cluster order", () => {
    const one = candidates(clusters, screen).find((c) => c.cols === 2 && c.rows === 1);
    if (!one) throw new Error("missing candidate");
    expect(one.place.coordinators).toEqual({ x: 0, y: 0 });
    expect(one.place["wave-a"]).toEqual({ x: 430 + CGAP, y: 0 });
    const aw = layoutCluster(waveA, 2).w;
    expect(one.place["wave-b"]).toEqual({ x: 430 + CGAP + aw + CGAP, y: 0 });
    const two = candidates(clusters, screen).find((c) => c.cols === 2 && c.rows === 2);
    if (!two) throw new Error("missing candidate");
    // two rows of ceil(3 / 2) = 2 clusters: wave-b starts the second row
    const rowH = Math.max(360, layoutCluster(waveA, 2).h);
    expect(two.place["wave-b"]).toEqual({ x: 0, y: rowH + CGAP });
  });

  it("keeps the earlier candidate unless a later one beats it by more than 0.005", () => {
    // one cluster, two agents of equal height: 1 column (taller) vs 2 columns (wider)
    // are both capped at 1.1 on a big screen, so the 1-column layout stays.
    const big = { width: 10_000, height: 10_000 };
    const cl = { main: box("w", 620, 400), kids: [box("k1", 460, 100), box("k2", 460, 100)] };
    expect(candidates([cl], big).map((c) => c.s)).toEqual([1.1, 1.1, 1.1]);
    expect(arrange([cl], big)?.place).toEqual(layoutCluster(cl, 1).at);
  });

  it("caps the scale at 1.1 and floors it at the fit minimum", () => {
    const small = arrange([{ main: box("w", 100, 100), kids: [] }], screen);
    expect(small?.view.s).toBe(ARRANGE_MAX_SCALE);
    const huge = arrange([{ main: box("w", 1_000_000, 1_000_000), kids: [] }], screen);
    expect(huge?.view.s).toBe(ARRANGE_MIN_SCALE);
    expect(ARRANGE_MIN_SCALE).toBe(FIT_MIN_SCALE);
  });

  it("returns null with nothing to arrange", () => {
    expect(arrange([], screen)).toBeNull();
  });
});
