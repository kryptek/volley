import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveCoordinator } from "../src/attention";
import type { Rect } from "../src/canvas/useViewport";
import type { CoordinatorState, WaveView } from "../src/store/types";
import {
  CoordinatorsWindow,
  type CoordinatorsWindowProps,
  waveChip,
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

  it("says `1 needs you` for one", () => {
    setup({ needsYou: 1 });
    expect(screen.getByText("1 needs you")).toHaveClass("chip--hot");
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
    fireEvent.click(screen.getByRole("button", { name: "Ended · 2" }));
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

describe("CoordinatorsWindow repo chips", () => {
  const gh = (slug: string) => ({ slug, url: `https://github.com/${slug}` });
  const on = (w: WaveView, slug: string, status?: "complete"): WaveView => ({
    ...w,
    state: w.state && { ...w.state, github: gh(slug), ...(status ? { status } : {}) },
  });
  const sup = {
    id: "volleyd",
    namespace: "default",
    registry: null,
    status: "working",
    lastHeartbeat: Date.parse("2026-10-18T12:00:00.000Z"),
    wavesOwned: 3,
  };
  const supRow = () => screen.getByRole("listitem", { name: "Supervisor volleyd" });

  it("a wave row with github has the chip; one without has none", () => {
    setup({ waves: [on(WAVES[0] as WaveView, "example-org/example-repo"), WAVES[1] as WaveView] });
    const chip = within(row("status-chip")).getByRole("link", {
      name: "example-org/example-repo on GitHub",
    });
    expect(chip).toHaveAttribute("href", "https://github.com/example-org/example-repo");
    expect(within(row("ci-speed")).queryByRole("link")).toBeNull();
  });

  it("the Supervisor row: one chip per distinct repository of the active waves", () => {
    setup({
      supervisors: [sup],
      now: Date.parse("2026-10-18T12:00:00.000Z"),
      waves: [
        on(WAVES[0] as WaveView, "example-org/a"),
        on(WAVES[1] as WaveView, "example-org/b"),
        on(WAVES[2] as WaveView, "example-org/a"),
        on(wave("old", "coord-9"), "example-org/c", "complete"),
      ],
    });
    const links = within(supRow()).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "example-org/a on GitHub",
      "example-org/b on GitHub",
    ]);
  });

  it("the Supervisor row: more than two repositories read `N repositories`, listed in its title", () => {
    setup({
      supervisors: [sup],
      now: Date.parse("2026-10-18T12:00:00.000Z"),
      waves: [
        on(WAVES[0] as WaveView, "example-org/a"),
        on(WAVES[1] as WaveView, "example-org/b"),
        on(WAVES[2] as WaveView, "example-org/c"),
      ],
    });
    expect(within(supRow()).queryByRole("link")).toBeNull();
    const many = within(supRow()).getByText("3 repositories");
    expect(many).toHaveAttribute("title", "example-org/a\nexample-org/b\nexample-org/c");
    expect(many).toHaveAttribute(
      "aria-label",
      "3 repositories: example-org/a, example-org/b, example-org/c",
    );
  });

  it("the Supervisor row has no chips when no wave has github", () => {
    setup({ supervisors: [sup], now: Date.parse("2026-10-18T12:00:00.000Z") });
    expect(within(supRow()).queryByRole("link")).toBeNull();
    expect(within(supRow()).queryByText(/repositories/)).toBeNull();
  });
});

describe("CoordinatorsWindow status chips and the Ended group", () => {
  const ended = (id: string, status: "complete" | "stopped"): WaveView => {
    const w = wave(id, "coord-9");
    return { ...w, state: w.state && { ...w.state, status } };
  };
  const mixed = () =>
    setup({
      waves: [ended("old-a", "complete"), WAVES[0] as WaveView, ended("old-b", "stopped")],
      coordinators: {
        ...coordinators,
        "old-a": { id: "coord-9", state: "gone" },
        "old-b": { id: "coord-9", state: "gone" },
      },
      shownEnded: new Set(["old-b"]),
      onShowEnded: vi.fn(),
      onDismiss: vi.fn(),
    });

  it("gives every row a status chip apart from its identity bar", () => {
    setup({ supervisors: [] });
    const chip = (id: string) => row(id).querySelector(".st-chip");
    expect(chip("status-chip")).toHaveTextContent("needs you");
    expect(chip("status-chip")).toHaveClass("st-chip--needs");
    expect(chip("ci-speed")).toHaveTextContent("working");
    expect(chip("leaderboard")).toHaveTextContent("needs you");
    // The supervisor's health is a chip too, and its bar carries no wave colour.
    const sup = screen.getByRole("listitem", { name: "Supervisor volleyd" });
    expect(sup.querySelector(".st-chip")).toHaveTextContent("down");
    expect(sup.querySelector(".coord-dot")).toHaveClass("coord-dot--neutral");
  });

  it("lists active waves first and folds ended ones into a collapsed 'Ended · N' group", () => {
    mixed();
    const names = screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"));
    expect(names).toEqual(["status-chip", "Ended waves"]);
    const head = screen.getByRole("button", { name: "Ended · 2" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(row("old-a")).getByText("completed")).toHaveClass("st-chip--completed");
    expect(within(row("old-b")).getByText("stopped")).toHaveClass("st-chip--stopped");
    // Folded off the canvas reads as hidden; one already shown does not.
    expect(row("old-a")).toHaveTextContent("· hidden");
    expect(row("old-b")).not.toHaveTextContent("· hidden");
  });

  it("an ended wave offers Show and Dismiss, not claim or go-to", () => {
    const p = mixed();
    fireEvent.click(screen.getByRole("button", { name: "Ended · 2" }));
    expect(within(row("old-a")).queryByRole("button", { name: /Go to/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show old-a on the canvas" }));
    expect(p.onShowEnded).toHaveBeenCalledWith("old-a");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss old-b from the Desk" }));
    expect(p.onDismiss).toHaveBeenCalledWith("old-b");
  });

  it("an archived wave (its one transient publish) is ended, with an archived chip", () => {
    const w = wave("old-c", "coord-9");
    setup({
      waves: [WAVES[0] as WaveView, { ...w, state: w.state && { ...w.state, status: "archived" } }],
    });
    expect(screen.queryByRole("listitem", { name: "old-c" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ended · 1" }));
    expect(within(row("old-c")).getByText("archived")).toHaveClass("st-chip--archived");
  });

  it("counts archived waves from the index: `N archived (volleyd archive)`", () => {
    setup({ archived: 3 });
    expect(screen.getByText(/3 archived/)).toHaveTextContent("3 archived (volleyd archive)");
    expect(screen.getByText("volleyd archive").tagName).toBe("CODE");
  });

  it("says nothing about archived waves when none are", () => {
    setup({ archived: 0 });
    expect(screen.queryByText(/archived \(/)).toBeNull();
  });

  it("says how many waves are dismissed and brings them back", () => {
    const onRestore = vi.fn();
    setup({ dismissed: { count: 2, onRestore } });
    fireEvent.click(screen.getByRole("button", { name: "Ended · 0" }));
    expect(screen.getByText(/2 dismissed waves/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(onRestore).toHaveBeenCalled();
  });
});

describe("a coordinator reconnecting", () => {
  const NOW = Date.parse("2026-10-18T12:00:00.000Z");
  const w = wave("relaunch", "lead");
  const reconnecting: EffectiveCoordinator = {
    id: "lead",
    state: "reconnecting",
    since: NOW - 4 * 60_000,
  };

  it("reads `Coordinator reconnecting · 4m` with a neutral chip and no claim it", () => {
    setup({ waves: [w], coordinators: { relaunch: reconnecting }, needsYou: 0, now: NOW });
    const r = row("relaunch");
    expect(within(r).getByText("Coordinator reconnecting · 4m")).toBeInTheDocument();
    expect(within(r).getByText("reconnecting")).toHaveClass("st-chip--reconnecting");
    expect(within(r).queryByText(/claim it/)).toBeNull();
    expect(within(r).queryByText("needs you")).toBeNull();
    expect(r).toHaveClass("st-reconnecting");
  });
});

describe("an owner away (autopilot runs the wave)", () => {
  const NOW = Date.parse("2026-10-18T12:00:00.000Z");
  const base = wave("overnight", "lead");
  const w = (enabled: boolean): WaveView => ({
    ...base,
    state: base.state && {
      ...base.state,
      coordinator: {
        agent_id: "lead",
        presence: "offline",
        state: "away",
        last_seen: new Date(NOW - 2 * 3_600_000).toISOString(),
      },
      autopilot: { enabled, auto_resolved: 0, escalated: 0, budgets: {} },
    },
  });
  const away: EffectiveCoordinator = { id: "lead", state: "away", lastSeen: NOW - 2 * 3_600_000 };

  it("reads `Owner away · autopilot · last seen 2h ago` with a neutral chip and no claim it", () => {
    setup({ waves: [w(true)], coordinators: { overnight: away }, needsYou: 0, now: NOW });
    const r = row("overnight");
    expect(within(r).getByText("Owner away · autopilot · last seen 2h ago")).toBeInTheDocument();
    expect(within(r).getByText("away")).toHaveClass("st-chip--away");
    expect(within(r).queryByText(/claim it/)).toBeNull();
    expect(within(r).queryByText("needs you")).toBeNull();
    expect(r).toHaveClass("st-away");
  });

  it("without autopilot reads `Owner away · last seen 2h ago`", () => {
    setup({ waves: [w(false)], coordinators: { overnight: away }, needsYou: 0, now: NOW });
    expect(within(row("overnight")).getByText("Owner away · last seen 2h ago")).toBeInTheDocument();
  });

  it("waveChip is `away`, never `needs`", () => {
    expect(waveChip(w(true), away)).toBe("away");
  });
});

describe("messaging a reconnecting coordinator", () => {
  it("is refused until a session binds again: its old agent is gone", async () => {
    const { waveChatTarget } = await import("../src/steer/useSteering");
    expect(waveChatTarget("lead", { id: "lead", state: "reconnecting" }, "desk")).toEqual({
      agentId: null,
      reason: "This wave's coordinator is reconnecting. Message it once it is back.",
    });
  });
});
