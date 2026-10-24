import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../src/store/claude";
import type {
  CoordinatorState,
  DecisionPayload,
  WaveStatePayload,
  WaveView,
} from "../src/store/types";
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
  const open = {
    decision_id: "status-chip-t3-agent_blocked-1",
    wave: "status-chip",
    task: "T3",
    kind: "agent_blocked" as const,
    question: "Ties: shared or dense ranking?",
    pointers: {},
    opened_at: "2026-10-18T12:00:00Z",
  };
  return { id: "status-chip", state, decisions: { [open.decision_id]: open }, receivedAt: 0 };
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
    expect(segs[0]).toHaveClass("st-merged");
    expect(segs[3]).toHaveClass("st-decision");
    // (1 + 0.9 + 0.9 + 0.7) / 4
    expect(container.querySelector(".rail-pct")).toHaveTextContent("88%");
    expect(screen.getByRole("progressbar", { name: "status-chip progress" })).toHaveAttribute(
      "aria-valuenow",
      "88",
    );
    expect(screen.getByText("1 of 4 merged")).toBeInTheDocument();
  });

  it("shows the ★ yours chip only when the owner is this browser's coordinator", () => {
    const { unmount } = renderWave({ me: "coordinator-desk1" });
    expect(screen.getByText("★ yours")).toHaveClass("chip", "chip--mine");
    unmount();
    renderWave({ me: "coordinator-other" });
    expect(screen.queryByText("★ yours")).not.toBeInTheDocument();
    expect(screen.getByText("coordinator-desk1")).not.toHaveClass("chip--mine");
  });

  it("shows no ★ yours chip by default", () => {
    renderWave();
    expect(screen.queryByText("★ yours")).not.toBeInTheDocument();
  });

  it("renders the dependency graph, and the wave file with v3 and titles as comments", () => {
    const { container } = renderWave();
    expect(container.querySelectorAll(".dag-node")).toHaveLength(4);
    expect(screen.getByText("v3")).toBeInTheDocument();
    const yaml = screen.getByLabelText("Wave file");
    expect(yaml).toHaveTextContent("T3: { issue: 104, after: [T1, T2] }");
    expect(yaml).toHaveTextContent("T0: { issue: 101 }");
    expect(yaml).toHaveTextContent("# Detail page badge");
    // Two spaces before the inline comment, as in the prototype (toHaveTextContent normalises whitespace).
    expect(yaml.textContent).toContain("}  # Detail page badge");
    expect(yaml).toHaveTextContent(
      "pipeline: [implement, [spec_review, quality_review], fixup, merge_ready]",
    );
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
    const { container, unmount } = renderWave({ coordinatorState: "awaiting_input" });
    expect(container.querySelector(".clawd")).toHaveClass("clawd--wait");
    unmount();
    // The store has seen the coordinator resume while the retained snapshot still says it waits.
    const r = renderWave({ wave: wave("awaiting_input"), coordinatorState: "working" });
    expect(r.container.querySelector(".clawd")).not.toHaveClass("clawd--wait");
  });

  it("is a region named after the wave", () => {
    renderWave();
    expect(screen.getByRole("region", { name: "status-chip" })).toBeInTheDocument();
  });

  it("leaves cancelled tasks out of the progress and marks them in the graph", () => {
    const w = wave();
    const s = w.state as WaveStatePayload;
    s.status = "complete";
    s.tasks = [
      { id: "T0", issue: 101, stage: "done", agents: {} },
      { id: "T1", issue: 102, stage: "done", agents: {} },
      { id: "T2", issue: 103, stage: "cancelled", agents: {} },
      { id: "T3", issue: 104, stage: "done", agents: {} },
      // Removed by a plan change: no longer in the spec.
      { id: "T4", issue: 105, stage: "cancelled", agents: {} },
    ];
    const { container } = renderWave({ wave: w });
    expect(container.querySelector(".rail-pct")).toHaveTextContent("100%");
    expect(screen.getByText("3 of 3 merged")).toBeInTheDocument();
    expect(container.querySelectorAll(".rail-seg")).toHaveLength(3);
    const nodes = [...container.querySelectorAll(".dag-node")];
    expect(nodes.map((n) => n.querySelector(".dag-id")?.textContent)).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
    ]);
    expect(nodes[2]).toHaveClass("st-cancelled");
    expect(nodes[2]).not.toHaveClass("st-queued");
    expect(nodes[2]).toHaveTextContent("cancelled");
  });

  it("orders tasks by the wave state's task list, not object key order", () => {
    const w = wave();
    const s = w.state as WaveStatePayload;
    s.tasks = [
      { id: "T9", issue: 1, stage: "done", agents: {} },
      { id: "10", issue: 2, stage: "queued", agents: {} },
      { id: "2", issue: 3, stage: "queued", agents: {} },
    ];
    s.spec = {
      version: 1,
      release_branch: s.release_branch,
      // Integer-like keys enumerate first in JS, whatever the file order was.
      tasks: {
        T9: { issue: 1, after: [] },
        "10": { issue: 2, after: ["T9"] },
        "2": { issue: 3, after: ["T9"] },
      },
    };
    const { container } = renderWave({ wave: w });
    const ids = [...container.querySelectorAll(".rail-seg")].map(
      (n) => n.getAttribute("title")?.split(" ")[0],
    );
    expect(ids).toEqual(["T9", "10", "2"]);
    const yaml = screen.getByLabelText("Wave file").textContent ?? "";
    expect(yaml.indexOf("T9:")).toBeLessThan(yaml.indexOf("10:"));
    expect(yaml.indexOf("10:")).toBeLessThan(yaml.indexOf("2:"));
  });

  it("fires the chat and gear callbacks with the wave id", () => {
    const onChat = vi.fn();
    const onSettings = vi.fn();
    renderWave({ onChat, onSettings });
    fireEvent.click(screen.getByRole("button", { name: "Message the coordinator of status-chip" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings for status-chip" }));
    expect(onChat).toHaveBeenCalledWith("status-chip");
    expect(onSettings).toHaveBeenCalledWith("status-chip");
  });

  it("renders the banner slot above the graph", () => {
    renderWave({ banner: <div>needs you</div> });
    const banner = screen.getByText("needs you");
    const graph = screen.getByRole("group", { name: "Task dependency graph" });
    expect(banner.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("highlights the chat glyph while the steering panel is open", () => {
    renderWave({ steerOpen: true });
    expect(
      screen.getByRole("button", { name: "Message the coordinator of status-chip" }),
    ).toHaveClass("icon-btn--hot");
  });

  it("shows how long ago the wave started", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    renderWave({ startedAt: now - 52 * 60_000, now });
    expect(screen.getByText("running 52m")).toBeInTheDocument();
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

describe("WaveWindow: GitHub", () => {
  it("shows the repo chip after the owner chip when the state has github, links the graph's issues", () => {
    const w = wave();
    const github = {
      slug: "example-org/example-repo",
      url: "https://github.com/example-org/example-repo",
    };
    const { container } = renderWave({
      wave: { ...w, state: { ...(w.state as WaveStatePayload), github } },
    });
    const chip = screen.getByRole("link", { name: "example-org/example-repo on GitHub" });
    const title = container.querySelector(".win-title");
    expect(title?.contains(chip)).toBe(true);
    const owner = within(title as HTMLElement).getByText("coordinator-desk1");
    expect(owner.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Issue #101 on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/example-org/example-repo/issues/101",
    );
  });

  it("no github: no chip, the graph's issues unlinked", () => {
    const { container } = renderWave();
    expect(container.querySelector(".chip--repo")).toBeNull();
    expect(screen.queryByRole("link", { name: /on GitHub/ })).toBeNull();
    expect(container.querySelector(".dag-issue")).toHaveTextContent("#101");
  });
});

describe("WaveWindow: the wave's Claude account (#499)", () => {
  const acct = (id: string, label: string, machine = "local"): AccountInfo => ({
    id,
    label,
    machine,
    plan: null,
    email: null,
    org: null,
    fiveHour: null,
    weekly: null,
    sampledAt: null,
    modelWeekly: {},
    probe: null,
    signedIn: true,
    agents: [],
    waves: [],
  });
  const accounts = [
    acct("team", "Team account"),
    acct("personal", "Personal"),
    acct("team@box-a", "Team account (box-a)", "box-a"),
    acct("gpu@box-b", "GPU box", "box-b"),
    { ...acct("fresh", "Fresh"), signedIn: false },
  ];
  const limit: DecisionPayload = {
    decision_id: "status-chip-account_limit-1",
    wave: "status-chip",
    task: null,
    kind: "account_limit",
    question: "Needs you: Claude account team is at 91% of its 5-hour window.",
    options: ["move wave status-chip to personal", "not now"],
    opened_at: "2026-10-18T12:00:00Z",
    acct: "team",
    pct: 91,
    resets_at: null,
    suggested: "personal",
  };
  const on = (account: WaveView["account"], decisions: WaveView["decisions"] = {}): WaveView => {
    const w = wave();
    const state = w.state as WaveStatePayload;
    // T1 runs on box-a: that machine's accounts are the wave's too.
    const tasks = state.tasks.map((t) => (t.id === "T1" ? { ...t, host: "box-a" } : t));
    return {
      ...w,
      state: { ...state, tasks },
      decisions: { ...w.decisions, ...decisions },
      ...(account ? { account } : {}),
    };
  };
  const pick = () =>
    screen.getByRole("combobox", { name: "Claude account for new agents of status-chip" });

  it("a balanced wave reads Account: Balanced; a pinned one names its account by its label", () => {
    const { rerender } = renderWave({ wave: on({ pinned: null, source: "balanced" }), accounts });
    expect(screen.getByText("Account: Balanced")).toHaveClass("chip");
    rerender(
      <WaveWindow
        wave={on({ pinned: "team", source: "wave" })}
        me={null}
        frame={frame}
        accounts={accounts}
      />,
    );
    expect(screen.getByText("Account: Team account")).toBeInTheDocument();
    expect(screen.queryByText(/Account: team$/)).toBeNull();
  });

  it("the dropdown lists Balanced (default) and the wave's machines' signed-in accounts by name", () => {
    renderWave({
      wave: on({ pinned: "team", source: "wave" }),
      accounts,
      onSetAccount: vi.fn(async () => ({ ok: true })),
    });
    expect(pick()).toHaveValue("team");
    expect(
      within(pick())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Balanced (default)", "Team account", "Personal"]);
  });

  it("picking sends wave_account_set and shows the confirm line until the account moves on", async () => {
    const set = vi.fn(async () => ({ ok: true }));
    const view = (account: WaveView["account"]) => (
      <WaveWindow
        wave={on(account)}
        me={null}
        frame={frame}
        accounts={accounts}
        onSetAccount={set}
      />
    );
    const { rerender } = renderWave({
      wave: on({ pinned: null, source: "balanced" }),
      accounts,
      onSetAccount: set,
    });
    await act(async () => {
      fireEvent.change(pick(), { target: { value: "personal" } });
    });
    expect(set).toHaveBeenCalledWith("personal");
    const line = "New agents start on Personal; running ones finish where they are.";
    rerender(view({ pinned: "personal", source: "wave" }));
    expect(screen.getByText(line)).toBeInTheDocument();
    // Another client moves the wave: the line would name a stale account, so it goes.
    rerender(view({ pinned: "team", source: "wave", moved_from: "personal" }));
    expect(screen.queryByText(line)).toBeNull();
    await act(async () => {
      fireEvent.change(pick(), { target: { value: "" } });
    });
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it("a refused pick says why and leaves the dropdown on the wave's account", async () => {
    const set = vi.fn(async () => ({ ok: false, error: "unknown Claude account 'personal'" }));
    renderWave({ wave: on({ pinned: "team", source: "wave" }), accounts, onSetAccount: set });
    await act(async () => {
      fireEvent.change(pick(), { target: { value: "personal" } });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("unknown Claude account 'personal'");
    expect(pick()).toHaveValue("team");
  });

  it("a read-only Desk shows the chip only", () => {
    renderWave({ wave: on({ pinned: "team", source: "wave" }), accounts });
    expect(screen.getByText("Account: Team account")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Claude account/ })).toBeNull();
  });

  it("an open account_limit preselects its suggestion; Switch answers it with that pick", async () => {
    const set = vi.fn(async () => ({ ok: true }));
    renderWave({
      wave: on({ pinned: "team", source: "wave" }, { [limit.decision_id]: limit }),
      accounts,
      onSetAccount: set,
    });
    expect(screen.getByText("Account: Team account")).toBeInTheDocument();
    expect(pick()).toHaveValue("personal");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    });
    expect(set).toHaveBeenCalledWith("personal");
    expect(screen.queryByRole("button", { name: "Switch" })).toBeNull();
  });

  it("an older volleyd's state (no account) still renders, without the chip", () => {
    renderWave({ wave: on(undefined), accounts, onSetAccount: vi.fn() });
    expect(screen.getByText("Dependency graph")).toBeInTheDocument();
    expect(screen.queryByText(/^Account:/)).toBeNull();
  });
});
