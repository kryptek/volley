import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveCoordinator } from "../src/attention";
import type { Rect } from "../src/canvas/useViewport";
import type { CoordinatorState, WaveView } from "../src/store/types";
import {
  CoordinatorsWindow,
  type CoordinatorsWindowProps,
} from "../src/windows/coordinators/CoordinatorsWindow";

function wave(id: string, owner: string): WaveView {
  return {
    id,
    state: {
      wave: id,
      version: 1,
      owner,
      repo: "example-org/example-repo",
      release_branch: `release/${id}`,
      status: "running",
      tasks: [
        { id: "T1", issue: 1, stage: "done", agents: {} },
        { id: "T2", issue: 2, stage: "implement", agents: {} },
      ],
      open_decisions: [],
      gates: [],
      updated_at: "2026-10-18T12:00:00.000Z",
    },
    decisions: {},
    receivedAt: 0,
  };
}

const WAVES = [
  wave("status-chip", "coord-1"),
  wave("ci-speed", "coord-2"),
  wave("leaderboard", "coord-3"),
];
const STATES: CoordinatorState[] = ["awaiting_input", "working", "gone"];
const coordinators: Record<string, EffectiveCoordinator> = Object.fromEntries(
  WAVES.map((w, i) => [w.id, { id: w.state?.owner ?? null, state: STATES[i] ?? "working" }]),
);

const frame: CoordinatorsWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

function setup(over: Partial<CoordinatorsWindowProps> = {}) {
  const props: CoordinatorsWindowProps = {
    waves: WAVES,
    coordinators,
    needsYou: 2,
    me: "coord-2",
    hidden: new Set(),
    frame,
    onToggle: vi.fn(),
    onGoTo: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<CoordinatorsWindow {...props} />);
  return props;
}

const row = (id: string) => screen.getByRole("listitem", { name: id });

describe("CoordinatorsWindow show finished", () => {
  it("toggles finished agents and says how many are hidden", () => {
    const onToggleFinished = vi.fn();
    setup({ finished: { hidden: 3, shown: false, graceMin: 10, onToggle: onToggleFinished } });
    const box = screen.getByRole("checkbox", { name: /Show finished agents/ });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/3 finished more than 10 min ago are hidden/)).toBeInTheDocument();
    fireEvent.click(box);
    expect(onToggleFinished).toHaveBeenCalledTimes(1);
  });

  it("shown, the box is checked", () => {
    setup({ finished: { hidden: 0, shown: true, graceMin: 10, onToggle: () => {} } });
    expect(screen.getByRole("checkbox", { name: /Show finished agents/ })).toBeChecked();
  });
});

describe("CoordinatorsWindow", () => {
  it("renders one row per wave with the prototype's three state labels", () => {
    setup();
    expect(within(row("status-chip")).getByText("Waiting for your answer")).toBeInTheDocument();
    expect(within(row("ci-speed")).getByText("Working")).toBeInTheDocument();
    expect(within(row("leaderboard")).getByText("No coordinator · claim it")).toBeInTheDocument();
    expect(row("status-chip")).toHaveClass("coord", "st-awaiting_input");
    expect(row("leaderboard")).toHaveClass("st-gone");
    expect(within(row("ci-speed")).getByText("★ yours")).toBeInTheDocument();
    expect(within(row("status-chip")).getByText(/coord-1/)).toBeInTheDocument();
    expect(screen.getByText("2 need you")).toHaveClass("chip--hot");
  });

  it("shows each wave's progress", () => {
    setup();
    const bar = row("ci-speed").querySelector(".coord-bar > span") as HTMLElement;
    // T1 done (1) + T2 implementing: more than half way, never 0 or 100.
    expect(bar.style.width).toMatch(/^\d+%$/);
    expect(Number.parseInt(bar.style.width, 10)).toBeGreaterThan(50);
    expect(Number.parseInt(bar.style.width, 10)).toBeLessThan(100);
  });

  it("toggles a wave's visibility", () => {
    const p = setup({ hidden: new Set(["ci-speed"]) });
    fireEvent.click(screen.getByRole("button", { name: "Hide status-chip" }));
    fireEvent.click(screen.getByRole("button", { name: "Show ci-speed" }));
    expect(p.onToggle).toHaveBeenNthCalledWith(1, "status-chip");
    expect(p.onToggle).toHaveBeenNthCalledWith(2, "ci-speed");
  });

  it("go-to fits the viewport to the wave and its agents", () => {
    const fitTo = vi.fn<(rects: readonly Rect[]) => void>();
    const cluster: Rect[] = [
      { x: 0, y: 0, w: 620, h: 440 },
      { x: 656, y: 0, w: 460, h: 470 },
    ];
    const clusterOf = vi.fn((id: string) => (id === "leaderboard" ? cluster : []));
    const p = setup({ fitTo, clusterOf });
    fireEvent.click(screen.getByRole("button", { name: "Go to leaderboard" }));
    expect(clusterOf).toHaveBeenCalledWith("leaderboard");
    expect(fitTo).toHaveBeenCalledWith(cluster);
    expect(p.onGoTo).toHaveBeenCalledWith("leaderboard");
  });

  it("shows an ended wave as Complete / Stopped, not as one to claim", () => {
    const done = (w: WaveView, status: "complete" | "stopped"): WaveView => ({
      ...w,
      state: w.state && { ...w.state, status },
    });
    setup({
      waves: [
        done(wave("old-a", "coord-1"), "complete"),
        done(wave("old-b", "coord-2"), "stopped"),
      ],
      coordinators: {
        "old-a": { id: "coord-1", state: "gone" },
        "old-b": { id: "coord-2", state: "gone" },
      },
    });
    expect(within(row("old-a")).getByText("Complete")).toBeInTheDocument();
    expect(within(row("old-b")).getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("No coordinator · claim it")).toBeNull();
    expect(row("old-a")).toHaveClass("st-ended");
    expect(row("old-a")).not.toHaveClass("st-gone");
  });

  it("closes", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close coordinators" }));
    expect(p.onClose).toHaveBeenCalled();
  });
});

describe("CoordinatorsWindow supervisor row", () => {
  it("is absent without supervisors (the demo), so the first row is the first wave", () => {
    setup();
    expect(screen.queryByRole("listitem", { name: /^Supervisor/ })).toBeNull();
    expect(screen.getAllByRole("listitem")[0]).toHaveAccessibleName("status-chip");
  });
});
