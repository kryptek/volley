// The Terminal popout sizes the agent's terminal (#403): it reports its text box in cells,
// debounced, on open and on every resize or text size change, and "launch" when it closes; the
// request it becomes is volleyd's `terminal_resize`.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_RESIZE_DEBOUNCE_MS,
  type TerminalSize,
  sendTerminalSize,
  terminalResizeFields,
} from "../src/steer/terminalResize";
import type { AgentView } from "../src/store/types";
import { TerminalPopout, fitCells } from "../src/windows/agent/TerminalPopout";

const AGENT = {
  id: "w1-t1-implementer-1",
  wave: "w1",
  task: "T1",
  role: "implementer",
  screen: {
    lines: ["x".repeat(120)],
    captured_at: "2026-10-22T00:00:00Z",
    workspace: "w",
    hash: "h",
    source: "tmux",
  },
} as unknown as AgentView;

/** The text box's size in px (`.term--popout` client box) and one cell's width. */
let box = { width: 0, height: 0 };
let cellPx = 0;
/** The popout's ResizeObserver callbacks: `resizeTo` fires them as a browser would. */
const observers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  box = { width: 1000, height: 620 };
  cellPx = 8;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("term--popout") ? box.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("term--popout") ? box.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const w = this.classList.contains("popout-probe") ? cellPx * 10 : 0;
    return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0 } as DOMRect;
  });
  // jsdom resolves no CSS: the line height comes from the text size (12 px × 1.55 = 18.6 px).
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function popout(onSize: (s: TerminalSize) => void, fontPx = 12) {
  return render(
    <TerminalPopout
      agent={AGENT}
      wave={undefined}
      z={1}
      onClose={() => {}}
      onRaise={() => {}}
      fontPx={fontPx}
      onFont={() => {}}
      onSize={onSize}
    />,
  );
}

const resizeTo = (width: number, height: number) => {
  box = { width, height };
  for (const fire of observers) fire();
};

describe("TerminalPopout → the agent's terminal size", () => {
  it("fitCells: whole cells less the caret's row, inside 20..500; null before layout", () => {
    expect(fitCells({ width: 1000, height: 620 }, { width: 8, height: 18.6 })).toEqual({
      cols: 125,
      rows: 32,
    });
    expect(fitCells({ width: 80, height: 100 }, { width: 8, height: 20 })).toEqual({
      cols: 20,
      rows: 20,
    });
    expect(fitCells({ width: 99_999, height: 99_999 }, { width: 8, height: 20 })).toEqual({
      cols: 500,
      rows: 500,
    });
    expect(fitCells({ width: 1000, height: 620 }, { width: 0, height: 0 })).toBeNull();
  });

  it("reports its size once on open, after the debounce", () => {
    const sizes: TerminalSize[] = [];
    popout((s) => sizes.push(s));
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS - 1));
    expect(sizes).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(sizes).toEqual([{ cols: 125, rows: 32 }]);
  });

  it("a drag is one report of where it stopped; an unchanged size is not sent again", () => {
    const sizes: TerminalSize[] = [];
    popout((s) => sizes.push(s));
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    act(() => {
      resizeTo(1200, 620);
      vi.advanceTimersByTime(100);
      resizeTo(1440, 800);
      vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS);
    });
    act(() => {
      resizeTo(1440, 800);
      vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS);
    });
    expect(sizes).toEqual([
      { cols: 125, rows: 32 },
      { cols: 180, rows: 42 },
    ]);
  });

  it("a larger text size is fewer cells", () => {
    const sizes: TerminalSize[] = [];
    const view = popout((s) => sizes.push(s));
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    cellPx = 10;
    view.rerender(
      <TerminalPopout
        agent={AGENT}
        wave={undefined}
        z={1}
        onClose={() => {}}
        onRaise={() => {}}
        fontPx={15}
        onFont={() => {}}
        onSize={(s) => sizes.push(s)}
      />,
    );
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    // 1000 / 10 = 100 columns; 620 / (15 × 1.55) = 26.6 → 25 rows past the caret.
    expect(sizes.at(-1)).toEqual({ cols: 100, rows: 25 });
  });

  it("closing hands the terminal back at its launch size; one closed before any report sends nothing", () => {
    const sizes: TerminalSize[] = [];
    const view = popout((s) => sizes.push(s));
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    view.unmount();
    expect(sizes).toEqual([{ cols: 125, rows: 32 }, "launch"]);

    const early: TerminalSize[] = [];
    popout((s) => early.push(s)).unmount();
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    expect(early).toEqual([]);
  });

  it("its width no longer follows the screen once it sizes the terminal: no feedback loop", () => {
    const sizes: TerminalSize[] = [];
    const view = popout((s) => sizes.push(s));
    const dialog = view.getByRole("dialog");
    const opened = dialog.style.width;
    expect(opened).toContain("120ch");
    act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
    // The agent redraws at the reported width (and at a narrower one): the window keeps its size,
    // so the measurement, and the report, hold.
    for (const width of [125, 90]) {
      view.rerender(
        <TerminalPopout
          agent={{ ...AGENT, screen: { ...AGENT.screen, lines: ["x".repeat(width)] } } as AgentView}
          wave={undefined}
          z={1}
          onClose={() => {}}
          onRaise={() => {}}
          fontPx={12}
          onFont={() => {}}
          onSize={(s) => sizes.push(s)}
        />,
      );
      act(() => vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS));
      expect(dialog.style.width).toBe(opened);
    }
    expect(sizes).toEqual([{ cols: 125, rows: 32 }]);
  });

  it("is volleyd's terminal_resize op: cols/rows, or reset", () => {
    expect(terminalResizeFields("a-1", { cols: 180, rows: 48 })).toEqual({
      agent_id: "a-1",
      cols: 180,
      rows: 48,
    });
    expect(terminalResizeFields("a-1", "launch")).toEqual({ agent_id: "a-1", reset: true });
    const control = vi.fn(async () => ({ ok: false, error: "no" }));
    sendTerminalSize(control, "a-1", "launch");
    expect(control).toHaveBeenCalledWith(
      "terminal_resize",
      { agent_id: "a-1", reset: true },
      "Reset a-1's terminal to its launch size",
    );
  });
});
