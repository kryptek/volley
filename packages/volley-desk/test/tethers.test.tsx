import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDUCED_MOTION_QUERY } from "../src/a11y/motion";
import {
  SAG_MAX,
  type Tether,
  Tethers,
  sagOf,
  tetherControls,
  tetherPath,
} from "../src/look/Tethers";
import { PULSE_MS, SWAY } from "../src/look/tetherPulses";

const tethers: Tether[] = [
  { id: "a1", wave: { x: 0, y: 0, w: 620 }, agent: { x: 656, y: 0 }, accent: "#6ee7f9" },
  { id: "a2", wave: { x: 0, y: 0, w: 620 }, agent: { x: 656, y: 506 }, accent: "#6ee7f9" },
  { id: "b1", wave: { x: 0, y: 700, w: 620 }, agent: { x: 1152, y: 700 }, accent: "#c4b5fd" },
];

const setWidth = (w: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
const realMatchMedia = window.matchMedia;
afterEach(() => {
  setWidth(1024);
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});
const reduceMotion = () => {
  window.matchMedia = (q: string) =>
    ({ ...realMatchMedia(q), matches: q === REDUCED_MOTION_QUERY }) as MediaQueryList;
};
const fakeClock = () =>
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
      "Date",
    ],
  });

describe("Tethers", () => {
  it("draws one cable per visible agent, wave edge → agent title bar, in the wave accent", () => {
    const { container } = render(<Tethers on tethers={tethers} />);
    const cores = [...container.querySelectorAll("svg.tethers path.tether-core")];
    expect(cores).toHaveLength(3);
    expect(cores.map((p) => p.getAttribute("stroke"))).toEqual(["#6ee7f9", "#6ee7f9", "#c4b5fd"]);
    expect(cores.map((p) => p.closest("[data-agent]")?.getAttribute("data-agent"))).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    // Rendered with sag; the unsagged S-curve is the prototype's.
    expect(cores[1]?.getAttribute("d")).toBe(
      tetherPath(tethers[1] as Tether, sagOf(tethers[1] as Tether)),
    );
    expect(tetherPath(tethers[1] as Tether)).toBe("M620,120 C638,120 638,532 656,532");
    expect(tetherPath(tethers[2] as Tether)).toBe("M620,820 C886,820 886,726 1152,726");
  });

  it("is hidden when off", () => {
    const { container } = render(<Tethers on={false} tethers={tethers} />);
    expect(container.querySelector("svg.tethers")).toBeNull();
  });

  it("is one SVG layer with one shared blur filter, however many agents", () => {
    const many: Tether[] = Array.from({ length: 24 }, (_, i) => ({
      id: `a${i}`,
      wave: { x: 0, y: 0, w: 620 },
      agent: { x: 656 + (i % 2) * 496, y: Math.floor(i / 2) * 506 },
      accent: "#6ee7f9",
    }));
    const { container } = render(<Tethers on tethers={many} />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    const filters = container.querySelectorAll("svg.tethers filter");
    expect(filters).toHaveLength(1);
    const ref = `url(#${filters[0]?.id})`;
    // The glow and the drop shadow are filtered once each, as groups, never per path.
    const filtered = [...container.querySelectorAll("svg.tethers [filter]")];
    expect(filtered.map((g) => g.tagName.toLowerCase())).toEqual(["g", "g"]);
    for (const g of filtered) expect(g.getAttribute("filter")).toBe(ref);
    expect(container.querySelectorAll("svg.tethers path[filter]")).toHaveLength(0);
    expect(container.querySelectorAll("path.tether-glow")).toHaveLength(24);
  });

  it("each cable layers glow, core and an upward-offset specular highlight in the accent", () => {
    const { container } = render(<Tethers on tethers={tethers} />);
    for (const t of tethers) {
      const glow = container.querySelector(`path.tether-glow[data-agent="${t.id}"]`);
      const cable = container.querySelector(`g.tether[data-agent="${t.id}"]`);
      const core = cable?.querySelector("path.tether-core");
      const hi = cable?.querySelector("path.tether-hi");
      expect(glow?.getAttribute("stroke")).toBe(t.accent);
      expect(core?.getAttribute("stroke")).toBe(t.accent);
      expect(hi).not.toBeNull();
      // The highlight is a lighter tint of the accent, lifted above the core.
      expect(hi?.getAttribute("stroke")).toMatch(/^#[0-9a-f]{6}$/);
      expect(hi?.getAttribute("stroke")).not.toBe(t.accent);
      expect(hi?.getAttribute("transform")).toMatch(/^translate\(0 -\d+(\.\d+)?\)$/);
      const d = core?.getAttribute("d");
      expect(glow?.getAttribute("d")).toBe(d);
      expect(hi?.getAttribute("d")).toBe(d);
    }
    expect(container.querySelectorAll("path.tether-shadow")).toHaveLength(tethers.length);
  });

  it("sags: the control points lie below the unsagged ones and the curve below the chord", () => {
    for (const t of tethers) {
      const sag = sagOf(t);
      expect(sag).toBeGreaterThan(0);
      expect(sag).toBeLessThanOrEqual(SAG_MAX);
      const flat = tetherControls(t, 0);
      const hung = tetherControls(t, sag);
      expect(hung.c1.y).toBeGreaterThan(flat.c1.y);
      expect(hung.c2.y).toBeGreaterThan(flat.c2.y);
      // The cubic's midpoint (t = ½) lies below the straight chord's midpoint.
      const mid = (hung.p0.y + 3 * hung.c1.y + 3 * hung.c2.y + hung.p3.y) / 8;
      expect(mid).toBeGreaterThan((hung.p0.y + hung.p3.y) / 2);
      expect([hung.p0, hung.p3]).toEqual([flat.p0, flat.p3]);
    }
  });

  it("a progress beat sends one pulse along that agent's cable, retired after its run", () => {
    fakeClock();
    const { container, rerender } = render(<Tethers on tethers={tethers} />);
    const pulses = () => [...container.querySelectorAll("path.tether-pulse")];
    expect(pulses()).toHaveLength(0);
    rerender(<Tethers on tethers={tethers.map((t) => (t.id === "a2" ? { ...t, beat: 1 } : t))} />);
    expect(pulses()).toHaveLength(1);
    expect(pulses()[0]?.getAttribute("data-agent")).toBe("a2");
    expect(pulses()[0]?.getAttribute("d")).toBe(
      container.querySelector('g.tether[data-agent="a2"] path.tether-core')?.getAttribute("d"),
    );
    // The same beat again is not a new message.
    rerender(<Tethers on tethers={tethers.map((t) => (t.id === "a2" ? { ...t, beat: 1 } : t))} />);
    expect(pulses()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(PULSE_MS + 50);
    });
    expect(pulses()).toHaveLength(0);
  });

  it("the first sight of an agent sends no pulse (no replay burst on load)", () => {
    const { container } = render(<Tethers on tethers={tethers.map((t) => ({ ...t, beat: 5 }))} />);
    expect(container.querySelectorAll("path.tether-pulse")).toHaveLength(0);
  });

  it("dragging a window sways its cables, which settle within the configured time", () => {
    fakeClock();
    const { container, rerender } = render(<Tethers on tethers={tethers} />);
    const cable = (id: string) => container.querySelector(`g.tether[data-agent="${id}"]`);
    const moved = tethers.map((t) => (t.id === "b1" ? { ...t, agent: { x: 1190, y: 760 } } : t));
    rerender(<Tethers on tethers={moved} />);
    expect(cable("b1")).toHaveAttribute("data-sway");
    expect(cable("a1")).not.toHaveAttribute("data-sway");
    const still = tetherPath(moved[2] as Tether, sagOf(moved[2] as Tether));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(cable("b1")?.querySelector(".tether-core")?.getAttribute("d")).not.toBe(still);
    act(() => {
      vi.advanceTimersByTime(SWAY.settleMs);
    });
    expect(cable("b1")).not.toHaveAttribute("data-sway");
    expect(cable("b1")?.querySelector(".tether-core")?.getAttribute("d")).toBe(still);
  });

  it.each([
    ["reduced motion", () => reduceMotion()],
    ["390 px", () => setWidth(390)],
  ])("%s: static glowing cables, no pulses, no sway", (_, setup) => {
    setup();
    const { container, rerender } = render(<Tethers on tethers={tethers} />);
    expect(container.querySelectorAll("path.tether-glow")).toHaveLength(3);
    expect(container.querySelector("svg.tethers")).toHaveAttribute("data-still");
    const next = tethers.map((t) => ({
      ...t,
      beat: 2,
      agent: { x: t.agent.x + 40, y: t.agent.y },
    }));
    rerender(<Tethers on tethers={next} />);
    expect(container.querySelector(".tether-pulses")).toBeNull();
    expect(container.querySelectorAll("path.tether-pulse")).toHaveLength(0);
    expect(container.querySelectorAll("[data-sway]")).toHaveLength(0);
  });
});
