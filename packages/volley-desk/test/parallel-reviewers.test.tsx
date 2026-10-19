import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import {
  agentsByWave,
  initialState,
  reduceAll,
  stageChip,
  workingCount,
} from "../src/store/reducer";
import type { DeskMessage } from "../src/store/types";
import {
  NOW,
  S,
  fakeClient,
  progress,
  registry,
  status,
  waveMsg,
  waveState,
} from "./helpers/desk-msgs";

const state = () =>
  waveState({
    owner: "coord-1",
    tasks: [
      {
        id: "T1",
        issue: 1,
        stage: "spec_review",
        agents: {
          implementer: "impl-1",
          fixup: "fix-1",
          spec_reviewer: "spec-1",
          quality_reviewer: "qual-1",
        },
      },
    ],
  });

const live = (id: string, type = "working"): DeskMessage[] => [
  registry(id, NOW - 60 * S),
  status(id, type, NOW - 60 * S),
  progress(id, "narration", NOW - 2 * S, { msg: `${id} at work` }),
];

const msgs = (): DeskMessage[] => [
  waveMsg(state()),
  ...live("impl-1", "done"),
  ...live("fix-1", "done"),
  ...live("spec-1"),
  ...live("qual-1"),
];

describe("parallel reviewers — store", () => {
  it("both reviewers are agents of the task, counted as working, ordered implementer/fixup/spec/quality", () => {
    const s = reduceAll(initialState(), msgs());
    expect(workingCount(s)).toBe(2);
    expect((agentsByWave(s).w1 ?? []).map((a) => a.id)).toEqual([
      "impl-1",
      "fix-1",
      "spec-1",
      "qual-1",
    ]);
  });

  it("an agent the MCP left at `registered` that is narrating still counts as working", () => {
    const s = reduceAll(initialState(), [...msgs(), status("qual-1", "registered", NOW - 30 * S)]);
    expect(workingCount(s)).toBe(2);
  });

  it("the stage chip reads 'review (spec + quality)' while both reviewers run", () => {
    const s = reduceAll(initialState(), msgs());
    expect(stageChip(s, "w1", "T1")).toBe("review (spec + quality)");
    const one = reduceAll(initialState(), [...msgs(), status("qual-1", "done", NOW - S)]);
    expect(stageChip(one, "w1", "T1")).toBe("spec review");
  });
});

describe("parallel reviewers — App", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  // The App's default heights: the wave window, and the coordinators window with one wave
  // row plus the supervisor row (150 + 66 per row); agent windows are 470.
  const HEIGHT: Record<string, number> = { w1: 440, "Wave coordinators": 150 + 66 * 2 };

  /** Every window's canvas box (style left/top/width; jsdom has no layout, so the default height). */
  function boxes() {
    return screen
      .getAllByRole("region")
      .filter((r) => r.style.left !== "")
      .map((r) => ({
        name: r.getAttribute("aria-label") ?? "",
        x: Number.parseFloat(r.style.left),
        y: Number.parseFloat(r.style.top),
        w: Number.parseFloat(r.style.width),
        h: HEIGHT[r.getAttribute("aria-label") ?? ""] ?? 470,
      }));
  }

  // The smoke's shape: the Desk was arranged while only the implementer ran (auto-arrange
  // off, or before its relayout), then both reviewers arrived. A new window's default slot
  // ignored the windows already placed, so one reviewer sat under the coordinators window.
  it("reviewers that arrive after an arrange get a slot of their own: no window covers another", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ autoArrange: false }));
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeClient();
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    const implOnly = waveState({
      owner: "coord-1",
      tasks: [{ id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } }],
    });
    act(() => {
      f.up();
      f.emit(registry("coord-1", NOW - 600 * S));
      f.emit(status("coord-1", "working", NOW - 600 * S));
      f.emit(waveMsg(implOnly));
      for (const m of live("impl-1")) f.emit(m);
      vi.advanceTimersByTime(4000);
    });
    const canvas = container.querySelector<HTMLElement>("[aria-label^='Desk canvas']");
    if (!canvas) throw new Error("no canvas");
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "f" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      f.emit(waveMsg(state()));
      for (const id of ["spec-1", "qual-1"]) for (const m of live(id, "registered")) f.emit(m);
      vi.advanceTimersByTime(1000);
    });
    const all = boxes();
    expect(all.map((b) => b.name)).toEqual(
      expect.arrayContaining(["w1 · T1 · spec review", "w1 · T1 · quality review"]),
    );
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it("two windows, top bar '2 agents working', the stage chip on both", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeClient();
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      f.up();
      for (const m of msgs()) f.emit(m);
      vi.advanceTimersByTime(100);
    });
    const spec = screen.getByRole("region", { name: "w1 · T1 · spec review" });
    const qual = screen.getByRole("region", { name: "w1 · T1 · quality review" });
    expect(container.querySelector(".topbar-mid")).toHaveTextContent("2 agents working");
    for (const win of [spec, qual]) {
      expect(within(win).getByText("review (spec + quality)")).toHaveClass("chip--stage");
    }
  });
});
