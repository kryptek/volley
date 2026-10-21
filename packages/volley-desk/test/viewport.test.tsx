import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../src/canvas/World";
import {
  FIT_MIN_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  type Rect,
  type View,
  useViewport,
  worldTransform,
} from "../src/canvas/useViewport";

let api: ReturnType<typeof useViewport>;

function Harness({ initial }: { initial: View }) {
  api = useViewport({ initial });
  return (
    <div data-testid="stage" ref={api.stageRef} {...api.stageHandlers}>
      <World view={api.view} ref={api.worldRef}>
        <section className="win" data-testid="win">
          <div className="feed" data-testid="feed" />
        </section>
      </World>
    </div>
  );
}

const view = () => api.view;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
});

describe("useViewport — wheel", () => {
  it("pans on a plain wheel", () => {
    render(<Harness initial={{ x: 40, y: 76, s: 0.82 }} />);
    fireEvent.wheel(screen.getByTestId("stage"), { deltaX: 10, deltaY: 25 });
    expect(view()).toEqual({ x: 30, y: 51, s: 0.82 });
  });

  it("⌘-wheel zooms around the cursor", () => {
    render(<Harness initial={{ x: 100, y: 50, s: 1 }} />);
    fireEvent.wheel(screen.getByTestId("stage"), {
      deltaY: -20,
      metaKey: true,
      clientX: 300,
      clientY: 250,
    });
    const s = Math.exp(0.2);
    expect(view().s).toBeCloseTo(s);
    // the world point under the cursor stays under the cursor
    expect((300 - view().x) / view().s).toBeCloseTo((300 - 100) / 1);
    expect((250 - view().y) / view().s).toBeCloseTo((250 - 50) / 1);
  });

  it("ctrl-wheel (trackpad pinch) zooms out and clamps", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 0.5 }} />);
    fireEvent.wheel(screen.getByTestId("stage"), {
      deltaY: 900,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
    });
    expect(view().s).toBe(MIN_SCALE);
    fireEvent.wheel(screen.getByTestId("stage"), {
      deltaY: -900,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
    });
    expect(view().s).toBe(MAX_SCALE);
    expect([MIN_SCALE, MAX_SCALE]).toEqual([0.3, 1.6]);
  });

  it("leaves wheel events inside scrollable window content alone", () => {
    render(<Harness initial={{ x: 40, y: 76, s: 0.82 }} />);
    fireEvent.wheel(screen.getByTestId("feed"), { deltaY: 25 });
    expect(view()).toEqual({ x: 40, y: 76, s: 0.82 });
  });
});

describe("useViewport — pointer pan", () => {
  it("drags empty canvas to pan", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 50, clientY: 35, pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(view()).toEqual({ x: 40, y: 25, s: 1 });
  });

  it("does not pan when the drag starts on a window", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    fireEvent.pointerDown(screen.getByTestId("win"), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(screen.getByTestId("stage"), { clientX: 40, clientY: 30 });
    expect(view()).toEqual({ x: 0, y: 0, s: 1 });
  });
});

describe("useViewport — gesture pan", () => {
  /** Animation frames run only when `frame()` is called. */
  let frames: FrameRequestCallback[] = [];
  const frame = () =>
    act(() => {
      const due = frames;
      frames = [];
      for (const f of due) f(performance.now());
    });
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((f) => {
      frames.push(f);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const world = () => document.querySelector(".world") as HTMLElement;
  const t = (pointerId: number, clientX: number, clientY: number) => ({
    pointerId,
    pointerType: "touch",
    clientX,
    clientY,
  });

  it("moves the world element per frame and commits the view on release", () => {
    const initial = { x: 10, y: 20, s: 0.5 };
    render(<Harness initial={initial} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, t(1, 100, 100));
    fireEvent.pointerMove(stage, t(1, 130, 110));
    fireEvent.pointerMove(stage, t(1, 150, 125));
    frame();
    expect(world().style.transform).toBe("translate(60px, 45px) scale(0.5)");
    expect(view()).toEqual(initial);
    fireEvent.pointerUp(stage, t(1, 150, 125));
    expect(view()).toEqual({ x: 60, y: 45, s: 0.5 });
    expect(world().style.transform).toBe(worldTransform(view()));
  });

  it("a two-finger pinch commits its scale and midpoint on release", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 0.5 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, t(1, 100, 100));
    fireEvent.pointerDown(stage, t(2, 200, 100));
    fireEvent.pointerMove(stage, t(2, 300, 100));
    frame();
    expect(view()).toEqual({ x: 0, y: 0, s: 0.5 });
    expect(world().style.transform).toMatch(/scale\(1\)$/);
    fireEvent.pointerUp(stage, t(2, 300, 100));
    fireEvent.pointerUp(stage, t(1, 100, 100));
    expect(view().s).toBeCloseTo(1);
    expect((200 - view().x) / view().s).toBeCloseTo(150 / 0.5);
    expect((100 - view().y) / view().s).toBeCloseTo(100 / 0.5);
  });

  it("a cancelled pointer commits too", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, t(1, 0, 0));
    fireEvent.pointerMove(stage, t(1, 25, -5));
    expect(view()).toEqual({ x: 0, y: 0, s: 1 });
    fireEvent.pointerCancel(stage, t(1, 25, -5));
    expect(view()).toEqual({ x: 25, y: -5, s: 1 });
  });

  it("a render mid-gesture keeps the moved transform", () => {
    const { rerender } = render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, t(1, 0, 0));
    fireEvent.pointerMove(stage, t(1, 30, 40));
    frame();
    rerender(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    expect(world().style.transform).toBe("translate(30px, 40px) scale(1)");
    fireEvent.pointerUp(stage, t(1, 30, 40));
    expect(view()).toEqual({ x: 30, y: 40, s: 1 });
  });
});

describe("useViewport — zoomAt / fitTo", () => {
  it("zoomAt defaults to the viewport centre", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    act(() => api.zoomAt(1.2));
    expect(view().s).toBeCloseTo(1.2);
    expect((600 - view().x) / view().s).toBeCloseTo(600);
    expect((450 - view().y) / view().s).toBeCloseTo(450);
  });

  it("fitTo frames the given rects below the top bar", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    const rects: Rect[] = [
      { x: 100, y: 100, w: 620, h: 560 },
      { x: 800, y: 100, w: 460, h: 520 },
    ];
    act(() => api.fitTo(rects));
    // bounding box 1160 × 560; usable area 1200 × (900 − 170) with 80px padding
    const s = Math.min(1200 / (1160 + 80), 730 / (560 + 80));
    expect(view().s).toBeCloseTo(s);
    expect(view().x + 100 * s).toBeCloseTo((1200 - 1160 * s) / 2);
    expect(view().y + 100 * s).toBeCloseTo(70 + (730 - 560 * s) / 2);
  });

  it("fitTo zooms out below the wheel minimum so everything fits (owner finding b)", () => {
    render(<Harness initial={{ x: 0, y: 0, s: 1 }} />);
    act(() => api.fitTo([{ x: 0, y: 0, w: 12_000, h: 6_000 }]));
    const s = Math.min(1200 / (12_000 + 80), 730 / (6_000 + 80));
    expect(s).toBeLessThan(MIN_SCALE);
    expect(view().s).toBeCloseTo(s);
    expect(view().s).toBeGreaterThanOrEqual(FIT_MIN_SCALE);
    // From there the wheel zooms back in smoothly instead of snapping up to the minimum,
    // and zooming out stays put rather than going lower than the fit.
    act(() => api.zoomAt(1.1));
    expect(view().s).toBeCloseTo(s * 1.1);
    act(() => api.zoomAt(0.5));
    expect(view().s).toBeCloseTo(s * 1.1);
  });

  it("fitTo caps the scale at 1.1 and ignores an empty list", () => {
    render(<Harness initial={{ x: 5, y: 6, s: 0.7 }} />);
    act(() => api.fitTo([]));
    expect(view()).toEqual({ x: 5, y: 6, s: 0.7 });
    act(() => api.fitTo([{ x: 0, y: 0, w: 100, h: 100 }]));
    expect(view().s).toBe(1.1);
  });
});

describe("World", () => {
  it("applies the view as a translate + scale transform", () => {
    const { container } = render(
      <World view={{ x: 12, y: -4, s: 0.5 }} animating>
        <span />
      </World>,
    );
    const world = container.querySelector(".world") as HTMLElement;
    expect(world.style.transform).toBe("translate(12px, -4px) scale(0.5)");
    expect(world).toHaveClass("world--anim");
  });
});
