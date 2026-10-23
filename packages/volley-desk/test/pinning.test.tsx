import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Frame, type FrameProps } from "../src/canvas/Frame";
import { PINS_STORAGE_KEY, loadPins } from "../src/layout/pins";
import { ARRANGE_ANIM_MS } from "../src/layout/useAutoArrange";
import { DeskStoreProvider } from "../src/store/context";

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const setScreen = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
};

const base: Omit<FrameProps, "children"> = {
  id: "w",
  title: "wave-1",
  accent: "#6ee7f9",
  pos: { x: 0, y: 0 },
  width: 460,
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

describe("Frame: the pin toggle", () => {
  it("is a labelled button in the title bar that names the state", () => {
    const onCycle = vi.fn();
    const onMove = vi.fn();
    render(
      <Frame {...base} onMove={onMove} pin={{ mode: "none", onCycle }}>
        body
      </Frame>,
    );
    const btn = screen.getByRole("button", { name: "Not pinned · pin in place" });
    expect(btn).toHaveAttribute("title", "Not pinned · pin in place");
    expect(btn.closest(".win-bar")).not.toBeNull();
    // a click on it cycles and never drags the window
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(btn, { clientX: 60, clientY: 60 });
    fireEvent.click(btn);
    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("shows each state", () => {
    const { rerender } = render(
      <Frame {...base} pin={{ mode: "place", onCycle: () => {} }}>
        body
      </Frame>,
    );
    expect(
      screen.getByRole("button", { name: "Pinned in place · anchor to the screen" }),
    ).toHaveAttribute("aria-pressed", "true");
    rerender(
      <Frame {...base} pin={{ mode: "screen", onCycle: () => {} }}>
        body
      </Frame>,
    );
    expect(screen.getByRole("button", { name: "Anchored to the screen · unpin" })).toBeVisible();
    expect(screen.getByRole("region", { name: "wave-1" })).toHaveClass("win--anchored");
  });

  it("without a pin there is no toggle", () => {
    render(<Frame {...base}>body</Frame>);
    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();
  });

  it("renders into the layer it is given (the screen-anchored layer)", () => {
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    render(
      <Frame {...base} layer={layer}>
        body
      </Frame>,
    );
    expect(layer.querySelector("section.win")).not.toBeNull();
    layer.remove();
  });

  it("moving into the layer and back keeps the window mounted, its state and the focus", () => {
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    let mounts = 0;
    function Child() {
      const [n, setN] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button type="button" onClick={() => setN((x) => x + 1)}>
          clicked {n}
        </button>
      );
    }
    function Host() {
      const [mode, setMode] = useState<"none" | "place" | "screen">("place");
      return (
        <Frame
          {...base}
          pin={{ mode, onCycle: () => setMode((m) => (m === "place" ? "screen" : "place")) }}
          {...(mode === "screen" ? { layer } : {})}
        >
          <Child />
        </Frame>
      );
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "clicked 0" }));
    const pin = screen.getByRole("button", { name: "Pinned in place · anchor to the screen" });
    pin.focus();
    fireEvent.click(pin);
    expect(layer.querySelector("section.win")).not.toBeNull();
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeVisible();
    expect(document.activeElement).toHaveAccessibleName("Anchored to the screen · unpin");
    fireEvent.click(document.activeElement as HTMLElement);
    expect(container.querySelector("section.win")).not.toBeNull();
    expect(layer.querySelector("section.win")).toBeNull();
    expect(document.activeElement).toHaveAccessibleName("Pinned in place · anchor to the screen");
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeVisible();
    expect(mounts).toBe(1);
    layer.remove();
  });

  it("collapsed: only the title bar shows, and a tap on it expands", () => {
    const onCollapse = vi.fn();
    render(
      <Frame {...base} collapsed onCollapse={onCollapse}>
        body
      </Frame>,
    );
    const win = screen.getByRole("region", { name: "wave-1" });
    expect(win).toHaveClass("win--collapsed");
    expect(win.querySelector(".win-body")).toHaveAttribute("hidden");
    const bar = win.querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 11, clientY: 10, pointerId: 1 });
    expect(onCollapse).toHaveBeenCalledWith(false);
    // and a keyboard user has a labelled expand button
    fireEvent.click(screen.getByRole("button", { name: "Expand wave-1" }));
    expect(onCollapse).toHaveBeenCalledTimes(2);
  });

  it("a drag on a collapsed bar moves it and does not expand", () => {
    const onCollapse = vi.fn();
    const onMove = vi.fn();
    render(
      <Frame {...base} collapsed onCollapse={onCollapse} onMove={onMove}>
        body
      </Frame>,
    );
    const bar = screen.getByRole("region", { name: "wave-1" }).querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(bar, { clientX: 80, clientY: 40 });
    fireEvent.pointerUp(bar, { clientX: 80, clientY: 40 });
    expect(onMove).toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });
});

describe("App: pinning windows (demo mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setScreen(1600, 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const coords = () => screen.getByRole("region", { name: "Wave coordinators" });
  const at = (el: HTMLElement) => ({ left: el.style.left, top: el.style.top });
  const pinBtn = (el: HTMLElement) =>
    within(el).getByRole("button", {
      name: /^(Not pinned|Pinned in place|Anchored to the screen) · /,
    });
  const view = (c: HTMLElement) => {
    const t = (c.querySelector(".world") as HTMLElement).style.transform;
    const [, x = "0", y = "0", sc = "1"] =
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(t) ?? [];
    return { x: Number(x), y: Number(y), s: Number(sc) };
  };
  const arrangeNow = () => {
    fireEvent.click(screen.getByRole("button", { name: "Arrange & fit" }));
    advance(ARRANGE_ANIM_MS);
  };
  const dragBar = (el: HTMLElement, dx: number, dy: number) => {
    const bar = el.querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { clientX: 100 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(bar, { clientX: 100 + dx, clientY: 100 + dy });
  };

  it("pinned in place: arrange leaves it where it is, and it still pans with the canvas", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    dragBar(coords(), -900, 300);
    const placed = at(coords());
    fireEvent.click(pinBtn(coords()));
    expect(pinBtn(coords())).toHaveAccessibleName("Pinned in place · anchor to the screen");
    arrangeNow();
    expect(at(coords())).toEqual(placed);
    // still inside the transformed world: pans and zooms with it
    expect(container.querySelector(".world")?.contains(coords())).toBe(true);
    // hiding a wave re-arranges the rest; the pinned window stays put
    fireEvent.click(screen.getByRole("button", { name: "Hide leaderboard" }));
    advance(120 + ARRANGE_ANIM_MS);
    expect(at(coords())).toEqual(placed);
  });

  it("anchored to the screen: out of the world, fixed through pan, arrange and reload", () => {
    const { container, unmount } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    expect(pinBtn(coords())).toHaveAccessibleName("Anchored to the screen · unpin");
    const hud = container.querySelector(".hud") as HTMLElement;
    expect(hud.contains(coords())).toBe(true);
    expect(container.querySelector(".world")?.contains(coords())).toBe(false);
    // drag it to the top left of the screen
    dragBar(coords(), -5000, -5000);
    const anchored = at(coords());
    expect(anchored).toEqual({ left: "8px", top: "64px" });
    expect(loadPins().desktop["panel:coordinators"]).toEqual({
      mode: "screen",
      corner: "tl",
      dx: 8,
      dy: 64,
    });
    // pan the canvas with the wheel, then arrange & fit: it does not move
    const stage = container.querySelector(".stage") as HTMLElement;
    fireEvent.wheel(stage, { deltaX: 300, deltaY: 200 });
    arrangeNow();
    expect(at(coords())).toEqual(anchored);
    // a resize keeps the corner
    setScreen(1200, 800);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(200 + ARRANGE_ANIM_MS);
    expect(at(coords())).toEqual(anchored);
    // reload: the pin is kept for this device
    unmount();
    const again = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    expect(again.container.querySelector(".hud")?.contains(coords())).toBe(true);
    expect(at(coords())).toEqual(anchored);
  });

  it("a window anchored to the bottom right holds that corner when the viewport shrinks", () => {
    renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    dragBar(coords(), 5000, 5000);
    const pin = loadPins().desktop["panel:coordinators"];
    expect(pin).toMatchObject({ mode: "screen", corner: "br" });
    const before = Number.parseFloat(coords().style.left);
    setScreen(1200, 800);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(200 + ARRANGE_ANIM_MS);
    expect(Number.parseFloat(coords().style.left)).toBeCloseTo(before - 400, 0);
  });

  it("a third click unpins it: back on the canvas and arranged again", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    for (let i = 0; i < 3; i++) fireEvent.click(pinBtn(coords()));
    expect(pinBtn(coords())).toHaveAccessibleName("Not pinned · pin in place");
    expect(container.querySelector(".world")?.contains(coords())).toBe(true);
    expect(loadPins().desktop["panel:coordinators"]).toBeUndefined();
  });

  it("phone and desktop layouts are independent, across the phone-width threshold", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    expect(loadPins().desktop["panel:coordinators"]).toMatchObject({ mode: "screen" });
    expect(loadPins().phone["panel:coordinators"]).toBeUndefined();
    // at phone width the desktop pin does not apply
    setScreen(390, 844);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(200 + ARRANGE_ANIM_MS);
    expect(pinBtn(coords())).toHaveAccessibleName("Not pinned · pin in place");
    expect(container.querySelector(".world")?.contains(coords())).toBe(true);
    // a phone pin does not apply on the desktop
    fireEvent.click(pinBtn(coords()));
    expect(loadPins().phone["panel:coordinators"]).toMatchObject({ mode: "place" });
    setScreen(1600, 1000);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(200 + ARRANGE_ANIM_MS);
    expect(pinBtn(coords())).toHaveAccessibleName("Anchored to the screen · unpin");
    expect(container.querySelector(".hud")?.contains(coords())).toBe(true);
  });

  it("Settings › General › Reset layout clears every pin, then arranges", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    const wave = screen.getByRole("region", { name: "ci-speed" });
    fireEvent.click(pinBtn(wave));
    dragBar(wave, 4000, 3000);
    const pinnedAt = at(screen.getByRole("region", { name: "ci-speed" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    advance(ARRANGE_ANIM_MS);
    expect(localStorage.getItem(PINS_STORAGE_KEY)).toBe(JSON.stringify({ desktop: {}, phone: {} }));
    expect(container.querySelector(".world")?.contains(coords())).toBe(true);
    expect(pinBtn(coords())).toHaveAccessibleName("Not pinned · pin in place");
    // the arrange put the formerly pinned wave back among the others
    expect(at(screen.getByRole("region", { name: "ci-speed" }))).not.toEqual(pinnedAt);
  });

  it("arrange & fit leaves room for a window anchored to the screen", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    dragBar(coords(), -5000, -5000);
    expect(at(coords())).toEqual({ left: "8px", top: "64px" });
    arrangeNow();
    const v = view(container);
    const wins = [...container.querySelectorAll<HTMLElement>(".world section.win")];
    expect(wins.length).toBeGreaterThan(0);
    // the coordinators window is 430 wide at (8, 64): every canvas window starts right of it
    for (const w of wins) {
      expect(v.x + Number.parseFloat(w.style.left) * v.s).toBeGreaterThanOrEqual(8 + 430);
    }
  });

  it("a fit (go-to from the coordinators list) leaves room for it too", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(pinBtn(coords()));
    fireEvent.click(pinBtn(coords()));
    dragBar(coords(), -5000, -5000);
    advance(120 + ARRANGE_ANIM_MS);
    fireEvent.click(within(coords()).getByRole("button", { name: "Go to ci-speed" }));
    const v = view(container);
    const wave = screen.getByRole("region", { name: "ci-speed" });
    expect(v.x + Number.parseFloat(wave.style.left) * v.s).toBeGreaterThanOrEqual(8 + 430);
  });

  /** A canvas window's screen rect (430 wide) lies inside the 1600 x 1000 viewport. */
  const inViewport = (c: HTMLElement, el: HTMLElement) => {
    const v = view(c);
    const x = v.x + Number.parseFloat(el.style.left) * v.s;
    const y = v.y + Number.parseFloat(el.style.top) * v.s;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + 430 * v.s).toBeLessThanOrEqual(1600);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1000);
  };

  it("the first fit frames pinned windows too", () => {
    // Auto-arrange off: only the first fit sets the view.
    localStorage.setItem("volley-desk-look", JSON.stringify({ autoArrange: false }));
    const baseline = renderApp();
    const s0 = view(baseline.container).s;
    // pin the coordinators window in place far away (not so far that even the fit minimum
    // zoom could not frame it), then reload
    fireEvent.click(pinBtn(coords()));
    dragBar(coords(), -3600, -3600);
    baseline.unmount();
    const again = renderApp();
    // the fit includes it: it zooms out, and the window is on screen
    expect(view(again.container).s).toBeLessThan(s0);
    inViewport(again.container, coords());
  });

  it("arrange & fit keeps a window pinned in place on screen", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    dragBar(coords(), -900, 300);
    const placed = at(coords());
    fireEvent.click(pinBtn(coords()));
    arrangeNow();
    expect(at(coords())).toEqual(placed);
    inViewport(container, coords());
  });

  describe("at phone width", () => {
    beforeEach(() => setScreen(390, 844));

    it("an anchored window collapses to its title bar and expands on tap", () => {
      renderApp();
      advance(400 + ARRANGE_ANIM_MS);
      fireEvent.click(pinBtn(coords()));
      fireEvent.click(pinBtn(coords()));
      expect(coords()).toHaveClass("win--collapsed");
      expect(loadPins().phone["panel:coordinators"]).toMatchObject({ mode: "screen" });
      fireEvent.click(within(coords()).getByRole("button", { name: "Expand Wave coordinators" }));
      expect(coords()).not.toHaveClass("win--collapsed");
      fireEvent.click(within(coords()).getByRole("button", { name: "Collapse Wave coordinators" }));
      expect(coords()).toHaveClass("win--collapsed");
    });
  });
});
