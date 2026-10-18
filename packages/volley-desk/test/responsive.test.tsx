import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { World } from "../src/canvas/World";
import { type View, clampWindowWidth, useNarrow, useViewport } from "../src/canvas/useViewport";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

const setWidth = (w: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none" }));
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
});
afterEach(() => setWidth(1024));

const renderApp = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );
const winWidths = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>(".world section.win")].map((w) =>
    Number.parseFloat(w.style.width),
  );

describe("phone width (< 700 px)", () => {
  it("starts at scale 0.5 with the prototype's phone offsets", () => {
    setWidth(390);
    const { result } = renderHook(() => useViewport());
    expect(result.current.view).toEqual({ x: 8, y: 70, s: 0.5 });
    setWidth(1200);
    const { result: wide } = renderHook(() => useViewport());
    expect(wide.current.view).toEqual({ x: 40, y: 76, s: 0.82 });
  });

  it("hides the top bar counts but keeps the needs-you pill", () => {
    setWidth(390);
    const { container } = renderApp();
    expect(container.querySelector(".topbar .topbar-mid")).toBeNull();
    expect(container.querySelector(".topbar .ny-pill")).not.toBeNull();
  });

  it("clamps every window to min(460, 100vw - 24)", () => {
    setWidth(390);
    const { container } = renderApp();
    const widths = winWidths(container);
    expect(widths.length).toBeGreaterThan(2);
    for (const w of widths) expect(w).toBe(366);
    expect(clampWindowWidth(620, 390)).toBe(366);
    expect(clampWindowWidth(620, 600)).toBe(460);
    expect(clampWindowWidth(430, 600)).toBe(430);
    // Wide screens keep the prototype widths.
    expect(clampWindowWidth(620, 1200)).toBe(620);
  });

  it("wide screens keep the counts and full widths; a resize to phone width collapses them", () => {
    setWidth(1200);
    const { container } = renderApp();
    expect(container.querySelector(".topbar .topbar-mid")).not.toBeNull();
    expect(winWidths(container)).toContain(620);
    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector(".topbar .topbar-mid")).toBeNull();
    expect(Math.max(...winWidths(container))).toBe(366);
  });

  it("useNarrow follows the window width", () => {
    setWidth(390);
    const { result } = renderHook(() => useNarrow());
    expect(result.current).toBe(true);
    act(() => {
      setWidth(900);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });
});

let api: ReturnType<typeof useViewport>;
function Stage({ initial }: { initial: View }) {
  api = useViewport({ initial });
  return (
    <div data-testid="stage" ref={api.stageRef} {...api.stageHandlers}>
      <World view={api.view}>
        <section className="win" data-testid="win" />
      </World>
    </div>
  );
}

describe("touch: pan and two-finger pinch", () => {
  it("one finger pans", () => {
    setWidth(390);
    render(<Stage initial={{ x: 0, y: 0, s: 0.5 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "touch", clientX: 70, clientY: 40 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch" });
    expect(api.view).toEqual({ x: 20, y: -10, s: 0.5 });
  });

  it("two fingers pinch-zoom around their midpoint and pan with it", () => {
    render(<Stage initial={{ x: 0, y: 0, s: 0.5 }} />);
    const stage = screen.getByTestId("stage");
    const t = (pointerId: number, clientX: number, clientY: number) => ({
      pointerId,
      pointerType: "touch",
      clientX,
      clientY,
    });
    fireEvent.pointerDown(stage, t(1, 100, 100));
    fireEvent.pointerDown(stage, t(2, 200, 100));
    // Spread to twice the distance; the midpoint moves from (150,100) to (200,100).
    fireEvent.pointerMove(stage, t(2, 300, 100));
    expect(api.view.s).toBeCloseTo(1);
    // The world point under the old midpoint is now under the new one.
    expect((200 - api.view.x) / api.view.s).toBeCloseTo(150 / 0.5);
    expect((100 - api.view.y) / api.view.s).toBeCloseTo(100 / 0.5);
    // Pinch-in clamps at MIN_SCALE.
    fireEvent.pointerMove(stage, t(2, 101, 100));
    expect(api.view.s).toBe(0.3);
    // Lift one finger: the other pans on from where it is, without a jump.
    fireEvent.pointerUp(stage, t(2, 101, 100));
    const before = { ...api.view };
    fireEvent.pointerMove(stage, t(1, 110, 105));
    expect(api.view).toEqual({ ...before, x: before.x + 10, y: before.y + 5 });
    fireEvent.pointerUp(stage, t(1, 110, 105));
  });

  it("a second finger landing on a window does not start a pinch", () => {
    render(<Stage initial={{ x: 0, y: 0, s: 0.5 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.pointerDown(screen.getByTestId("win"), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 100,
      clientY: 0,
    });
    fireEvent.pointerMove(stage, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 0 });
    expect(api.view.s).toBe(0.5);
  });
});
