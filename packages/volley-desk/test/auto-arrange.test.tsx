import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import {
  ARRANGE_ANIM_MS,
  LOOK_STORAGE_KEY,
  useAutoArrange,
  useAutoArrangeSetting,
} from "../src/layout/useAutoArrange";
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
  type Props = { enabled: boolean; layoutKey: string; hold?: boolean };
  const setup = (enabled: boolean, layoutKey: string) => {
    const arrange = vi.fn();
    const hook = renderHook((p: Props) => useAutoArrange({ ...p, arrange }), {
      initialProps: { enabled, layoutKey } as Props,
    });
    return { arrange, ...hook };
  };

  it("runs the first layout after 400 ms", () => {
    const { arrange } = setup(true, "c|w1|a1");
    advance(399);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("only the very first schedule waits 400 ms: a key change after mount waits 120 ms", () => {
    // as in the prototype, the first-layout flag clears when the first timer is set
    const { arrange, rerender } = setup(true, "");
    advance(100);
    rerender({ enabled: true, layoutKey: "c|w1" });
    advance(119);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("hold freezes the key: a resync and replay back to the same windows does not arrange", () => {
    const { arrange, rerender } = setup(true, "c|w1|a1");
    advance(400);
    arrange.mockClear();
    rerender({ enabled: true, layoutKey: "|__unassigned__|a1", hold: true });
    advance(500);
    rerender({ enabled: true, layoutKey: "c|w1|a1", hold: true });
    advance(500);
    rerender({ enabled: true, layoutKey: "c|w1|a1", hold: false });
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
  });

  it("released with different windows, it arranges once after 120 ms", () => {
    const { arrange, rerender } = setup(true, "c|w1|a1");
    advance(400);
    arrange.mockClear();
    rerender({ enabled: true, layoutKey: "", hold: true });
    advance(500);
    rerender({ enabled: true, layoutKey: "c|w1", hold: false });
    advance(119);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("a new agent window triggers one arrange after 120 ms", () => {
    const { arrange, rerender } = setup(true, "c|w1|a1");
    advance(400);
    arrange.mockClear();
    rerender({ enabled: true, layoutKey: "c|w1|a1|a2" });
    advance(119);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("changes in quick succession collapse into one arrange", () => {
    const { arrange, rerender } = setup(true, "c|w1");
    advance(400);
    arrange.mockClear();
    rerender({ enabled: true, layoutKey: "c|w1|a1" });
    advance(60);
    rerender({ enabled: true, layoutKey: "c|w1|a1|a2" });
    advance(119);
    expect(arrange).not.toHaveBeenCalled();
    advance(1);
    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it("a re-render with the same layout key (a drag, a tick) does not trigger", () => {
    const { arrange, rerender } = setup(true, "c|w1|a1");
    advance(400);
    arrange.mockClear();
    rerender({ enabled: true, layoutKey: "c|w1|a1" });
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
  });

  it("a browser resize triggers after 200 ms, debounced", () => {
    const { arrange } = setup(true, "c|w1");
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

  it("OFF: no arrange on first layout, key changes or resize", () => {
    const { arrange, rerender } = setup(false, "c|w1");
    advance(1000);
    rerender({ enabled: false, layoutKey: "c|w1|a1" });
    act(() => window.dispatchEvent(new Event("resize")));
    advance(1000);
    expect(arrange).not.toHaveBeenCalled();
  });

  it("turning it back ON arranges", () => {
    const { arrange, rerender } = setup(false, "c|w1");
    advance(1000);
    rerender({ enabled: true, layoutKey: "c|w1" });
    advance(400);
    expect(arrange).toHaveBeenCalledTimes(1);
  });
});

describe("useAutoArrangeSetting", () => {
  it("defaults to ON", () => {
    const { result } = renderHook(() => useAutoArrangeSetting());
    expect(result.current[0]).toBe(true);
  });

  it("persists into the Desk look entry, keeping its other fields", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "Aurora" }));
    const { result } = renderHook(() => useAutoArrangeSetting());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}")).toEqual({
      bg: "Aurora",
      autoArrange: false,
    });
    const again = renderHook(() => useAutoArrangeSetting());
    expect(again.result.current[0]).toBe(false);
  });

  it("a corrupt entry falls back to ON", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useAutoArrangeSetting());
    expect(result.current[0]).toBe(true);
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
    // arrange puts the coordinators cluster first, at the origin
    expect(at("Wave coordinators")).toEqual({ left: "0px", top: "0px" });
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

  it("hiding a wave re-arranges after 120 ms", () => {
    const { container } = renderApp();
    advance(400 + ARRANGE_ANIM_MS);
    fireEvent.click(screen.getByRole("button", { name: "Hide leaderboard" }));
    expect(screen.queryByRole("region", { name: "leaderboard" })).toBeNull();
    advance(119);
    expect(world(container)).not.toHaveClass("world--anim");
    advance(1);
    expect(world(container)).toHaveClass("world--anim");
  });

  it("a new agent window (the demo's spec reviewer) triggers one arrange after 120 ms", () => {
    const { container } = renderApp();
    const windows = () => container.querySelectorAll(".win").length;
    advance(400 + ARRANGE_ANIM_MS);
    const before = windows();
    // the demo spawns its spec reviewer 22 s after load
    advance(22_000 - 400 - ARRANGE_ANIM_MS);
    expect(windows()).toBe(before + 1);
    expect(world(container)).not.toHaveClass("world--anim");
    advance(119);
    expect(world(container)).not.toHaveClass("world--anim");
    advance(1);
    expect(world(container)).toHaveClass("world--anim");
    advance(ARRANGE_ANIM_MS);
    expect(world(container)).not.toHaveClass("world--anim");
    advance(1000);
    expect(world(container)).not.toHaveClass("world--anim");
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
