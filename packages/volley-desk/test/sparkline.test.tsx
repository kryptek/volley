import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HISTORY_MS } from "../src/store/machineHistory";
import { Sparkline, sparkLevel, sparkPoints } from "../src/windows/machines/Sparkline";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const MIN = 60_000;

describe("sparkPoints", () => {
  it("maps the window ending at now to x 0..100, newest at the right", () => {
    const pts = sparkPoints(
      [
        { at: NOW - 10 * MIN, value: 0 },
        { at: NOW - 5 * MIN, value: 50 },
        { at: NOW, value: 100 },
      ],
      NOW,
      HISTORY_MS,
    );
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    // 0 % at the bottom, 100 % at the top
    expect((pts[0] as { y: number }).y).toBeGreaterThan((pts[1] as { y: number }).y);
    expect((pts[1] as { y: number }).y).toBeGreaterThan((pts[2] as { y: number }).y);
  });

  it("clamps a reading above 100 % (load per core) to the top", () => {
    const [a, b] = sparkPoints(
      [
        { at: NOW - MIN, value: 100 },
        { at: NOW, value: 340 },
      ],
      NOW,
      HISTORY_MS,
    );
    expect(b?.y).toBe(a?.y);
  });

  it("drops samples older than the window and nulls (no reading)", () => {
    const pts = sparkPoints(
      [
        { at: NOW - 11 * MIN, value: 10 },
        { at: NOW - MIN, value: null },
        { at: NOW, value: 10 },
      ],
      NOW,
      HISTORY_MS,
    );
    expect(pts).toHaveLength(1);
  });
});

describe("sparkLevel", () => {
  it("warns at 70 and is bad at 90, by the reading", () => {
    expect(sparkLevel(69)).toBe("ok");
    expect(sparkLevel(70)).toBe("warn");
    expect(sparkLevel(89.9)).toBe("warn");
    expect(sparkLevel(90)).toBe("bad");
    expect(sparkLevel(null)).toBe("ok");
  });
});

describe("Sparkline", () => {
  const two = [
    { at: NOW - MIN, value: 20 },
    { at: NOW, value: 30 },
  ];
  const svg = (el: HTMLElement) => el.querySelector("svg") as SVGSVGElement;

  it("draws a polyline from two samples, hidden from assistive tech", () => {
    const { container } = render(<Sparkline kind="load" samples={two} now={NOW} />);
    expect(svg(container)).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(svg(container).getAttribute("class")).toContain("spark--load");
  });

  it("draws one dot from a single sample", () => {
    const { container } = render(
      <Sparkline kind="mem" samples={[{ at: NOW, value: 10 }]} now={NOW} />,
    );
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector("circle")).not.toBeNull();
  });

  it("turns warn at exactly 70 and bad at 90, by the latest reading", () => {
    const cls = (v: number) => {
      const { container, unmount } = render(
        <Sparkline kind="load" samples={[...two, { at: NOW + 1, value: v }]} now={NOW + 1} />,
      );
      const c = svg(container).getAttribute("class") ?? "";
      unmount();
      return c;
    };
    expect(cls(69)).not.toMatch(/spark--(warn|bad)/);
    expect(cls(70)).toContain("spark--warn");
    expect(cls(90)).toContain("spark--bad");
  });

  it("down: a flat grey baseline, never the stale points", () => {
    const { container } = render(<Sparkline kind="load" samples={two} now={NOW} down />);
    expect(svg(container).getAttribute("class")).toContain("spark--down");
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("line.spark-base")).not.toBeNull();
  });
});
