import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CoordinatorState, WaveStatePayload, WaveView } from "../src/store/types";
import { WaveWindow, type WaveWindowProps } from "../src/windows/wave/WaveWindow";
import { ACCENT_PALETTE, accentFor } from "../src/windows/wave/accent";

function wave(coordinator: CoordinatorState = "working"): WaveView {
  const state: WaveStatePayload = {
    wave: "status-chip",
    version: 3,
    owner: "coordinator-desk1",
    repo: "example-org/example-repo",
    release_branch: "release/2026-10-20-status-chip",
    status: "running",
    tasks: [
      { id: "T0", issue: 101, stage: "done", agents: {} },
      { id: "T1", issue: 102, stage: "merge_ready", agents: {} },
      { id: "T2", issue: 103, stage: "merge_ready", agents: {} },
      { id: "T3", issue: 104, stage: "awaiting_decision", agents: {} },
    ],
    open_decisions: ["status-chip-t3-agent_blocked-1"],
    gates: ["T1", "T2"],
    spec: {
      version: 3,
      release_branch: "release/2026-10-20-status-chip",
      model: "claude-opus-5-5",
      pipeline: ["implement", ["spec_review", "quality_review"], "fixup", "merge_ready"],
      tasks: {
        T0: { issue: 101, title: "Status chip data contract", after: [] },
        T1: { issue: 102, title: "Chip mapper", after: ["T0"] },
        T2: { issue: 103, title: "Status column", after: ["T0"] },
        T3: { issue: 104, title: "Detail page badge", after: ["T1", "T2"] },
      },
    },
    coordinator: {
      agent_id: "coordinator-desk1",
      state: coordinator,
      last_seen: "2026-10-18T12:00:00.000Z",
    },
    updated_at: "2026-10-18T12:00:00.000Z",
  };
  return { id: "status-chip", state, decisions: {}, receivedAt: 0 };
}

const frame: WaveWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

const renderWave = (p: Partial<WaveWindowProps> = {}) =>
  render(<WaveWindow wave={wave()} me={null} frame={frame} {...p} />);

describe("WaveWindow", () => {
  it("renders the wave id, counts and a rail segment per task, 620 wide in the wave accent", () => {
    const { container } = renderWave();
    const win = container.querySelector(".win") as HTMLElement;
    expect(win.querySelector(".t-name")).toHaveTextContent("status-chip");
    expect(win.style.width).toBe("620px");
    expect(win.style.getPropertyValue("--acc")).toBe(accentFor("status-chip"));
    expect(screen.getByText("1 decision · 2 gates")).toBeInTheDocument();
    const segs = container.querySelectorAll(".rail-seg");
    expect(segs).toHaveLength(4);
    expect(segs[0]).toHaveClass("rail-seg--merged");
    expect(segs[3]).toHaveClass("rail-seg--decision");
    expect(container.querySelector(".rail-pct")).toHaveTextContent(/^\d+%$/);
  });

  it("shows the ★ yours chip only when the owner is this browser's coordinator", () => {
    const { unmount } = renderWave({ me: "coordinator-desk1" });
    expect(screen.getByText("★ yours")).toHaveClass("chip--mine");
    unmount();
    renderWave({ me: "coordinator-other" });
    expect(screen.queryByText("★ yours")).not.toBeInTheDocument();
    expect(screen.getByText("coordinator-desk1")).toBeInTheDocument();
  });

  it("shows no ★ yours chip by default", () => {
    renderWave();
    expect(screen.queryByText("★ yours")).not.toBeInTheDocument();
  });

  it("renders the dependency graph, and the wave file with v3 and titles as comments", () => {
    const { container } = renderWave();
    expect(container.querySelectorAll(".dag-node")).toHaveLength(4);
    fireEvent.click(screen.getByRole("tab", { name: "wave file" }));
    expect(screen.getByText("v3")).toBeInTheDocument();
    const yaml = container.querySelector(".yaml") as HTMLElement;
    expect(yaml).toHaveTextContent("T3: { issue: 104, after: [T1, T2] }");
    expect(yaml).toHaveTextContent("# Detail page badge");
    expect(container.querySelector(".dag")).not.toBeInTheDocument();
  });

  it("makes the Claude icon hop while the coordinator awaits input", () => {
    const { container, unmount } = render(
      <WaveWindow wave={wave("awaiting_input")} me={null} frame={frame} />,
    );
    expect(container.querySelector(".clawd")).toHaveClass("clawd--wait");
    unmount();
    const r = renderWave();
    expect(r.container.querySelector(".clawd")).not.toHaveClass("clawd--wait");
  });

  it("prefers the store's coordinator state over the supervisor's snapshot", () => {
    const { container } = renderWave({ coordinatorState: "awaiting_input" });
    expect(container.querySelector(".clawd")).toHaveClass("clawd--wait");
  });

  it("fires the chat and gear callbacks with the wave id", () => {
    const onChat = vi.fn();
    const onSettings = vi.fn();
    renderWave({ onChat, onSettings });
    fireEvent.click(screen.getByRole("button", { name: "Steer wave" }));
    fireEvent.click(screen.getByRole("button", { name: "Wave settings" }));
    expect(onChat).toHaveBeenCalledWith("status-chip");
    expect(onSettings).toHaveBeenCalledWith("status-chip");
  });

  it("renders the banner slot above the graph", () => {
    renderWave({ banner: <div>needs you</div> });
    expect(screen.getByText("needs you")).toBeInTheDocument();
  });

  it("shows how long ago the wave started", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    renderWave({ startedAt: now - 52 * 60_000, now });
    expect(screen.getByText("started 52m ago")).toBeInTheDocument();
  });

  it("waits for the wave state when only a decision has arrived", () => {
    const { container } = render(
      <WaveWindow
        wave={{ id: "late", state: null, decisions: {}, receivedAt: 0 }}
        me={null}
        frame={frame}
      />,
    );
    expect(container.querySelector(".t-name")).toHaveTextContent("late");
    expect(screen.getByText("waiting for wave state")).toBeInTheDocument();
  });
});

describe("accentFor", () => {
  it("is deterministic and drawn from the palette", () => {
    expect(accentFor("status-chip")).toBe(accentFor("status-chip"));
    expect(ACCENT_PALETTE).toContain(accentFor("ci-speed"));
    const spread = new Set(
      ["status-chip", "ci-speed", "leaderboard", "a", "b", "c"].map(accentFor),
    );
    expect(spread.size).toBeGreaterThan(1);
  });
});
