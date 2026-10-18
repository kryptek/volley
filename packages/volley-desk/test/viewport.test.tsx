import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "../src/canvas/World";
import {
  FIT_MIN_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  type Rect,
  type View,
  useViewport,
} from "../src/canvas/useViewport";

let api: ReturnType<typeof useViewport>;

function Harness({ initial }: { initial: View }) {
  api = useViewport({ initial });
  return (
    <div data-testid="stage" ref={api.stageRef} {...api.stageHandlers}>
      <World view={api.view}>
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
