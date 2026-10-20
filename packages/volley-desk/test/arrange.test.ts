import { describe, expect, it } from "vitest";
import { FIT_MIN_SCALE } from "../src/canvas/useViewport";
import {
  ARRANGE_MAX_SCALE,
  ARRANGE_MIN_SCALE,
  type Box,
  CGAP,
  type Cluster,
  GAP,
  type Screen,
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

  it("with no pinned windows the layout and the view are unchanged (snapshot)", () => {
    const r = arrange(clusters, screen);
    if (!r) throw new Error("no arrangement");
    expect(r.view.x).toBeCloseTo(24, 6);
    expect(r.view.s).toBeCloseTo(0.58921792, 6);
    expect(r.view.y).toBeCloseTo(114.041762, 6);
    const win = candidates(clusters, screen).find((c) => c.cols === 3 && c.rows === 2);
    expect(r.place).toEqual(win?.place);
    expect(arrange(clusters, screen, { pinned: {} })).toEqual(r);
  });

  it("returns null with nothing to arrange", () => {
    expect(arrange([], screen)).toBeNull();
  });

  describe("unassigned agents and the coordinators window sit next to the waves", () => {
    // Two waves, the unassigned group (3 agents) and the coordinators window: the last two are
    // side clusters, laid out on the first row right after its waves.
    const unassigned: Cluster = {
      main: box("unassigned", 620, 200),
      kids: [box("u1", 460, 470), box("u2", 460, 470), box("u3", 460, 470)],
      side: true,
    };
    const coordsSide: Cluster = { ...coords, side: true };
    const set = [unassigned, waveA, coordsSide, waveB];
    const dims = Object.fromEntries(set.flatMap((c) => [c.main, ...c.kids]).map((b) => [b.id, b]));
    /** A cluster's right edge in a placement. */
    const end = (place: Record<string, { x: number; y: number }>, ids: string[]) =>
      Math.max(...ids.map((k) => (place[k]?.x ?? 0) + (dims[k]?.w ?? 0)));
    const waveIds = (c: Cluster) => [c.main.id, ...c.kids.map((k) => k.id)];

    const screens = [screen, { width: 1920, height: 1080 }, { width: 390, height: 844 }];
    for (const sc of screens) {
      const portrait = sc.width < sc.height;
      it(`every candidate keeps them together, one CGAP from the first wave row (${sc.width}px)`, () => {
        let under = 0;
        for (const c of candidates(set, sc)) {
          const p = c.place;
          const u = p.unassigned;
          const co = p.coordinators;
          const a = p["wave-a"];
          if (!u || !co || !a) throw new Error("not placed");
          const row = [waveA, waveB].filter((w) => p[w.main.id]?.y === a.y);
          if (u.y === a.y) {
            // closing the first row, after its last wave cluster
            const last = row.at(-1);
            if (!last) throw new Error("no wave on the row");
            expect(u.x - end(p, waveIds(last))).toBe(CGAP);
          } else {
            // portrait only: starting the second row, under the first wave
            under++;
            expect(portrait).toBe(true);
            const rowH = Math.max(...row.map((w) => layoutCluster(w, c.cols).h));
            expect(u).toEqual({ x: 0, y: a.y + rowH + CGAP });
          }
          // coordinators: right after the unassigned group, or stacked under it
          const uH = layoutCluster(unassigned, 2).h;
          if (co.y === u.y) expect(co.x - end(p, waveIds(unassigned))).toBe(CGAP);
          else expect(co).toEqual({ x: u.x, y: u.y + uH + CGAP });
          // every window is placed, once
          expect(Object.keys(p).sort()).toEqual(Object.keys(dims).sort());
        }
        expect(under > 0).toBe(portrait);
      });

      it(`keeps the tethers to unassigned agents short in every candidate (${sc.width}px)`, () => {
        // Chord from the group window's right edge to each agent's top-left corner. One
        // column of three agents (the old layout) reaches hypot(36, 1012) ≈ 1013.
        const bound = 460 + 470 + 2 * GAP;
        for (const c of candidates(set, sc)) {
          const m = c.place.unassigned;
          if (!m) throw new Error("unassigned not placed");
          for (const k of unassigned.kids) {
            const a = c.place[k.id];
            if (!a) throw new Error(`${k.id} not placed`);
            expect(Math.hypot(a.x - (m.x + 620), a.y - m.y)).toBeLessThan(bound);
          }
        }
      });
    }

    it("packs unassigned agents in ⌈√n⌉ columns whatever the waves use", () => {
      const nine: Cluster = {
        main: box("unassigned", 620, 200),
        kids: Array.from({ length: 9 }, (_, i) => box(`n${i}`, 460, 470)),
        side: true,
      };
      for (const c of candidates([waveA, nine, coordsSide], screen)) {
        const xs = new Set(nine.kids.map((k) => c.place[k.id]?.x));
        expect(xs.size).toBe(3);
      }
    });

    it("keeps a readable zoom at phone width (390 x 844) and on a laptop (1440 x 900)", () => {
      // The Desk's real sizes: wave 620 x 440, agent 460 x 470, coordinators 430 wide.
      const wave = (id: string, n: number): Cluster => ({
        main: box(id, 620, 440),
        kids: Array.from({ length: n }, (_, i) => box(`${id}-${i}`, 460, 470)),
      });
      const un = (n: number): Cluster => ({ ...wave("unassigned", n), side: true });
      const co: Cluster = { main: box("coordinators", 430, 348), kids: [], side: true };
      const phone = { width: 390, height: 844 };
      const laptop = { width: 1440, height: 900 };
      const s = (cl: Cluster[], sc: Screen) => arrange(cl, sc)?.view.s ?? 0;
      expect(s([wave("w1", 3), co], phone)).toBeGreaterThan(0.3);
      expect(s([wave("w1", 3), un(2), co], phone)).toBeGreaterThan(0.2);
      expect(s([wave("w1", 3), un(2), co], laptop)).toBeGreaterThan(0.48);
      const four = ["w1", "w2", "w3", "w4"].map((id) => wave(id, 4));
      expect(s([...four, un(6), co], phone)).toBeGreaterThan(0.12);
    });

    it("with no waves, the side clusters make one row", () => {
      const c = candidates([unassigned, coordsSide], screen);
      expect(c.map((x) => x.rows)).toEqual(c.map(() => 1));
      expect(c[0]?.place.unassigned).toEqual({ x: 0, y: 0 });
    });
  });
});

describe("pinned windows (C12)", () => {
  const rectsOf = (place: Record<string, { x: number; y: number }>) =>
    Object.entries(place).map(([id, p]) => ({
      ...p,
      w: sizeOf[id]?.w ?? 0,
      h: sizeOf[id]?.h ?? 0,
    }));
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("skips a window pinned in place: it gets no new position", () => {
    const pinned = { coordinators: { x: 0, y: 0, w: 430, h: 360 } };
    const r = arrange(clusters, screen, { pinned });
    expect(r?.place.coordinators).toBeUndefined();
    expect(Object.keys(r?.place ?? {}).sort()).toEqual(
      ["wave-a", "a1", "a2", "a3", "a4", "wave-b", "b1", "b2"].sort(),
    );
  });

  type R = { x: number; y: number; w: number; h: number };
  const inflate = (r: R): R => ({
    x: r.x - CGAP,
    y: r.y - CGAP,
    w: r.w + 2 * CGAP,
    h: r.h + 2 * CGAP,
  });
  const twoPins = {
    coordinators: { x: 0, y: 0, w: 430, h: 360 },
    b2: { x: 3000, y: 2500, w: 460, h: 450 },
  };
  const portrait = { width: 390, height: 844 };

  for (const [name, sc] of [
    ["landscape, block moves right", screen],
    ["portrait, block moves down", portrait],
  ] as const) {
    for (const [what, pinned] of [
      ["one pinned window", { coordinators: twoPins.coordinators }],
      ["two pinned windows", twoPins],
    ] as const) {
      it(`lays the other windows clear of the pinned ones, gap included (${name}, ${what})`, () => {
        const r = arrange(clusters, sc, { pinned });
        if (!r) throw new Error("no arrangement");
        for (const id of Object.keys(pinned)) expect(r.place[id]).toBeUndefined();
        for (const rect of rectsOf(r.place)) {
          for (const p of Object.values(pinned)) expect(overlaps(rect, inflate(p))).toBe(false);
        }
      });
    }
  }

  /** A world rect, mapped through the view, lies inside the fit area. */
  const onScreen = (r: { view: { x: number; y: number; s: number } }, rect: R) => {
    const { x, y, s } = r.view;
    expect(x + rect.x * s).toBeGreaterThanOrEqual(24 - 0.5);
    expect(x + (rect.x + rect.w) * s).toBeLessThanOrEqual(24 + 1552 + 0.5);
    expect(y + rect.y * s).toBeGreaterThanOrEqual(64 - 0.5);
    expect(y + (rect.y + rect.h) * s).toBeLessThanOrEqual(64 + 826 + 0.5);
  };

  it("the view frames the pinned windows with the arranged ones", () => {
    const cases: [Cluster[], Record<string, R>][] = [
      [[waveA, waveB], { coordinators: { x: 0, y: 0, w: 430, h: 360 } }],
      [[waveA, waveB], { coordinators: { x: -1500, y: 400, w: 430, h: 360 } }],
      [clusters, twoPins],
    ];
    for (const [cls, pinned] of cases) {
      const r = arrange(cls, screen, { pinned });
      if (!r) throw new Error("no arrangement");
      for (const rect of rectsOf(r.place)) onScreen(r, rect);
      for (const p of Object.values(pinned)) onScreen(r, p);
    }
  });

  it("a pinned wave window keeps its place; its agents are still arranged", () => {
    const pinned = { "wave-a": { x: -2000, y: -2000, w: 620, h: 600 } };
    const r = arrange(clusters, screen, { pinned });
    expect(r?.place["wave-a"]).toBeUndefined();
    for (const id of ["a1", "a2", "a3", "a4"]) expect(r?.place[id]).toBeDefined();
  });

  it("a pinned agent keeps its place and the rest of its cluster packs without it", () => {
    const pinned = { a1: { x: 5000, y: 5000, w: 460, h: 500 } };
    const r = arrange(clusters, screen, { pinned });
    expect(r?.place.a1).toBeUndefined();
    expect(r?.place["wave-a"]).toBeDefined();
  });

  it("fits the given area: windows anchored to the screen are left room", () => {
    const area = { x: 24 + 460, y: 64, w: 1552 - 460, h: 826 };
    const r = arrange(clusters, screen, { area });
    const s = r?.view.s ?? 0;
    const b = bounds(r?.place ?? {});
    // the arranged block lands inside the area, on screen
    expect(r?.view.x ?? 0).toBeGreaterThanOrEqual(area.x - 0.5);
    expect((r?.view.x ?? 0) + b.W * s).toBeLessThanOrEqual(area.x + area.w + 0.5);
    // a narrower area fits at a smaller (or equal) scale than the whole screen
    expect(s).toBeLessThanOrEqual(arrange(clusters, screen)?.view.s ?? 0);
  });

  it("with every window pinned there is nothing to arrange", () => {
    const pinned = Object.fromEntries(
      Object.values(sizeOf).map((b) => [b.id, { x: 0, y: 0, w: b.w, h: b.h }]),
    );
    expect(arrange(clusters, screen, { pinned })).toBeNull();
  });
});
