import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ARRANGE_ANIM_MS, useAutoArrange } from "../src/layout/useAutoArrange";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoArrange", () => {
  type Props = { enabled: boolean; ready: boolean };
  const setup = (enabled: boolean, ready = true) => {
    const arrange = vi.fn();
    const hook = renderHook((p: Props) => useAutoArrange({ ...p, arrange }), {
      initialProps: { enabled, ready } as Props,
    });
    return { arrange, ...hook };
  };

  it("runs the first layout after 400 ms", () => {
    const { arrange } = setup(true);
    advance(399);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("waits for the first windows: the first layout runs 400 ms after ready", () => {
    const { arrange, rerender } = setup(true, false);
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
    rerender({ enabled: true, ready: true });
    advance(399);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("windows opening or closing after the first arrange never arrange again (#404)", () => {
    const { arrange, rerender } = setup(true);
    advance(400);
    arrange.mockClear();
    // a reconnect's resync empties the canvas and the replay fills it again
    rerender({ enabled: true, ready: false });
    advance(500);
    rerender({ enabled: true, ready: true });
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
  });

  it("a browser resize triggers after 200 ms, debounced", () => {
    const { arrange } = setup(true);
    advance(400);
    arrange.mockClear();
    act(() => window.dispatchEvent(new Event("resize")));
    advance(150);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(199);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("OFF: no arrange on first layout or resize", () => {
    const { arrange } = setup(false);
    advance(1000);
    act(() => window.dispatchEvent(new Event("resize")));
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
  });

  it("turning it back ON arranges", () => {
    const { arrange, rerender } = setup(true);
    advance(400);
    rerender({ enabled: false, ready: true });
    advance(1000);
    rerender({ enabled: true, ready: true });
    advance(400);
    expect(arrange).toHaveBeenCalledTimes(2);
  });
});

describe("App auto-arrange (demo mode)", () => {
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const world = (c: HTMLElement) => c.querySelector(".world") as HTMLElement;
  const at = (name: string) => {
    const el = screen.getByRole("region", { name });
    return { left: el.style.left, top: el.style.top };
  };

  it("arranges after the first layout, animated for 650 ms", () => {
    const { container } = renderApp();
    // before arrange, the placeholder layout has the coordinators window somewhere other than the origin
    expect(at("Wave coordinators")).not.toEqual({ left: "0px", top: "0px" });
    advance(399);
    expect(world(container)).not.toHaveClass("world--anim");
    advance(1);
    expect(world(container)).toHaveClass("world--anim");
    // arrange puts the first wave at the origin and closes its row with the coordinators window
    expect(at("status-chip")).toEqual({ left: "0px", top: "0px" });
    expect(at("Wave coordinators").top).toBe("0px");
    expect(at("Wave coordinators").left).not.toBe("0px");
    advance(ARRANGE_ANIM_MS);
    expect(world(container)).not.toHaveClass("world--anim");
  });

  it("a manual drag moves the window and does not re-arrange", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    const win = screen.getByRole("region", { name: "ci-speed" });
    const before = at("ci-speed");
    const bar = win.querySelector(".win-bar") as Element;
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { clientX: 300, clientY: 260 });
    fireEvent.pointerUp(bar);
    const dragged = at("ci-speed");
    expect(dragged).not.toEqual(before);
    advance(1000);
    expect(world(container)).not.toHaveClass("world--anim");
    expect(at("ci-speed")).toEqual(dragged);
  });

  it("hiding a wave moves no other window and keeps the view (#404)", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    const before = at("ci-speed");
    const view = world(container).style.transform;
    fireEvent.click(screen.getByRole("button", { name: "Hide leaderboard" }));
    expect(screen.queryByRole("region", { name: "leaderboard" })).toBeNull();
    advance(1000);
    expect(world(container)).not.toHaveClass("world--anim");
    expect(at("ci-speed")).toEqual(before);
    expect(world(container).style.transform).toBe(view);
  });

  it("a new agent window (the demo's spec reviewer) is placed without an arrange (#404)", () => {
    const { container } = renderApp();
    const windows = () => container.querySelectorAll(".win").length;
    advance(400 + ARRANGE_ANIM_MS);
    const before = windows();
    const others = [...container.querySelectorAll<HTMLElement>(".win")].map(
      (w) => [w, w.style.left, w.style.top] as const,
    );
    const view = world(container).style.transform;
    // the demo spawns its spec reviewer 22 s after load
    advance(22_000 - 400 - ARRANGE_ANIM_MS);
    expect(windows()).toBe(before + 1);
    advance(1000);
    expect(world(container)).not.toHaveClass("world--anim");
    expect(world(container).style.transform).toBe(view);
    for (const [el, left, top] of others) {
      expect(el.isConnected).toBe(true);
      expect([el.style.left, el.style.top]).toEqual([left, top]);
    }
  });

  it("OFF: windows stay where they are", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ autoArrange: false }));
    const { container } = renderApp();
    const before = at("ci-speed");
    advance(1000);
    expect(world(container)).not.toHaveClass("world--anim");
    expect(at("ci-speed")).toEqual(before);
  });
});
