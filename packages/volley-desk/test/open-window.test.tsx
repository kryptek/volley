// Opening a window keeps the zoom and pans to it; closing one moves nothing (#404).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { fitToArea, panToTopView } from "../src/canvas/useViewport";
import { ARRANGE_ANIM_MS, FIRST_ARRANGE_MS } from "../src/layout/useAutoArrange";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import { INBOX_CHROME_H } from "../src/windows/inbox/NeedsYouWindow";
import { WAVE_W } from "../src/windows/wave/WaveWindow";

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const SCREEN = { width: 1600, height: 1000 };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none" }));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: SCREEN.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: SCREEN.height });
});
afterEach(() => {
  vi.useRealTimers();
});

const viewOf = (c: HTMLElement) => {
  const t = (c.querySelector(".world") as HTMLElement).style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t);
  if (!m) throw new Error(`no transform: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
};
const windows = (c: HTMLElement) =>
  new Map(
    [...c.querySelectorAll<HTMLElement>(".world .win")].map((w) => [
      w,
      `${w.style.left},${w.style.top}`,
    ]),
  );

describe("opening a window from the dock (#404)", () => {
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));
  const area = fitToArea(SCREEN);

  for (const [name, tile, closedFirst] of [
    ["Machines", "Machines", false],
    ["Needs you", "Needs you", true],
    ["Wave coordinators", "Wave coordinators", true],
  ] as const) {
    it(`${name}: keeps the scale, pans its top edge near the top, moves no other window`, () => {
      const { container } = renderApp();
      advance(FIRST_ARRANGE_MS + ARRANGE_ANIM_MS);
      const button = () => dock().getByRole("button", { name: tile });
      if (closedFirst) {
        fireEvent.click(button());
        advance(1000);
        expect(screen.queryByRole("region", { name })).toBeNull();
      }
      const before = viewOf(container);
      const others = windows(container);
      fireEvent.click(button());
      advance(1000);
      const win = screen.getByRole("region", { name });
      const v = viewOf(container);
      expect(v.s).toBe(before.s);
      const left = v.x + Number.parseFloat(win.style.left) * v.s;
      const top = v.y + Number.parseFloat(win.style.top) * v.s;
      expect(left).toBeGreaterThanOrEqual(area.x);
      expect(left).toBeLessThan(area.x + area.w);
      expect(top).toBeGreaterThanOrEqual(area.y);
      expect(top).toBeLessThanOrEqual(area.y + 48);
      for (const [el, at] of others) expect(`${el.style.left},${el.style.top}`).toBe(at);
      expect(container.querySelector(".world")).not.toHaveClass("world--anim");

      // closing it changes no window and no scale
      const open = viewOf(container);
      const rest = windows(container);
      rest.delete(win);
      fireEvent.click(button());
      advance(1000);
      expect(screen.queryByRole("region", { name })).toBeNull();
      expect(viewOf(container)).toEqual(open);
      for (const [el, at] of rest) expect(`${el.style.left},${el.style.top}`).toBe(at);
    });
  }

  it("a window opened after the arrange lands clear of every other window", () => {
    const { container } = renderApp();
    advance(FIRST_ARRANGE_MS + ARRANGE_ANIM_MS);
    fireEvent.click(dock().getByRole("button", { name: "Machines" }));
    advance(1000);
    // jsdom lays nothing out, so a window's height is App's default for its kind (WAVE_H,
    // AGENT_H, machinesH; the list windows' chrome alone, a lower bound).
    const heightOf = (el: HTMLElement) => {
      const label = el.getAttribute("aria-label") ?? "";
      if (label === "Machines")
        return 80 + 76 * Math.max(1, el.querySelectorAll(".mrow-item").length);
      if (label === "Needs you") return INBOX_CHROME_H;
      if (label === "Wave coordinators") return 150;
      return Number.parseFloat(el.style.width) === WAVE_W ? 440 : 470;
    };
    const rect = (el: HTMLElement) => ({
      x: Number.parseFloat(el.style.left),
      y: Number.parseFloat(el.style.top),
      w: Number.parseFloat(el.style.width),
      h: heightOf(el),
    });
    const m = rect(screen.getByRole("region", { name: "Machines" }));
    const others = [...container.querySelectorAll<HTMLElement>(".world .win")].filter(
      (el) => el.getAttribute("aria-label") !== "Machines",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const el of others) {
      const o = rect(el);
      const overlaps = m.x < o.x + o.w && o.x < m.x + m.w && m.y < o.y + o.h && o.y < m.y + m.h;
      expect(overlaps, el.getAttribute("aria-label") ?? "").toBe(false);
    }
  });
});

describe("panToTopView (#404)", () => {
  const a = { x: 0, y: 70, w: 1600, h: 830 };

  it("keeps the scale and puts the rect's top edge 24 px below the area's top", () => {
    const v = panToTopView({ x: 10, y: 20, s: 0.8 }, { x: 100, y: 500, w: 400, h: 2000 }, a);
    expect(v.s).toBe(0.8);
    expect(v.y + 500 * 0.8).toBe(70 + 24);
    // already in view across: x stays
    expect(v.x).toBe(10);
  });

  it("off-screen to the right: x moves by exactly the least that shows the window", () => {
    const v0 = { x: 0, y: 0, s: 0.8 };
    const r = { x: 3000, y: 0, w: 460, h: 400 };
    const v = panToTopView(v0, r, a);
    const right = v.x + (r.x + r.w) * v.s;
    expect(right).toBeCloseTo(a.x + a.w - 24);
    // any less and its right edge would be off screen
    expect(v0.x - v.x).toBeCloseTo(3000 * 0.8 + 460 * 0.8 - (1600 - 24));
  });

  it("off-screen to the left: its left edge comes in at the margin", () => {
    const v = panToTopView({ x: 0, y: 0, s: 0.5 }, { x: -1000, y: 0, w: 460, h: 400 }, a);
    expect(v.x + -1000 * 0.5).toBe(24);
  });

  it("wider than the screen: its left edge stays in view", () => {
    const v = panToTopView({ x: 0, y: 0, s: 1 }, { x: 2000, y: 0, w: 5000, h: 400 }, a);
    expect(v.x + 2000).toBe(24);
  });
});
