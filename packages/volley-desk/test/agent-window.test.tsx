import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { demoMessages, demoReviewer } from "../src/store/fixtures";
import { UNASSIGNED, initialState, reduceAll } from "../src/store/reducer";
import type { DecisionPayload, DeskMessage, DeskState } from "../src/store/types";
import {
  AgentWindow,
  type AgentWindowProps,
  NEUTRAL_ACCENT,
  markStatus,
} from "../src/windows/agent/AgentWindow";
import { Pipeline } from "../src/windows/agent/Pipeline";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ACCENT = "#c4b5fd";
const FIXUP = "status-chip-t1-fixup-1";

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

function stateWith(...extra: DeskMessage[]): DeskState {
  return reduceAll(initialState(), [...demoMessages(NOW), ...extra]);
}

function status(id: string, type: string, at: number, payload: unknown = {}): DeskMessage {
  return {
    topic: `volley/demo/${id}/status`,
    envelope: {
      schema_version: "0.1",
      agent_id: id,
      wall_time: new Date(at).toISOString(),
      channel: "status",
      type,
      payload,
    },
    receivedAt: at,
  };
}

function renderAgent(
  state: DeskState,
  id: string,
  opts: { now?: number; onChat?: () => void } & Pick<
    AgentWindowProps,
    "icons" | "attentionTier"
  > = {},
) {
  const agent = state.agents[id];
  if (!agent) throw new Error(`no agent ${id}`);
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent={ACCENT}
      frame={frame}
      now={opts.now ?? NOW}
      {...(opts.onChat ? { onChat: opts.onChat } : {})}
      {...(opts.icons ? { icons: opts.icons } : {})}
      {...(opts.attentionTier ? { attentionTier: opts.attentionTier } : {})}
    />,
  );
}

describe("AgentWindow", () => {
  it("title shows the purpose (task · title), the wave chip in the wave accent, and the role", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    expect(bar.querySelector(".t-name")).toHaveTextContent("T1 · Chip mapper + null-case handling");
    const chip = within(bar).getByText("status-chip");
    expect(chip).toHaveClass("chip--wave");
    expect(chip.querySelector("i")).toHaveStyle({ background: ACCENT });
    expect(within(bar).getByText("fixup")).toHaveClass("chip--role");
    expect(within(bar).getByRole("img", { name: "fixing up" })).toBeInTheDocument();
    expect(container.querySelector(".win")).toHaveStyle({ width: "460px" });
  });

  it("shows the task title from the wave spec once, in the headline row, and the latest narration", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    expect(container.querySelector(".win-sub .t-name")).toHaveTextContent(
      "T1 · Chip mapper + null-case handling",
    );
    expect(container.querySelector(".win-title .t-name")).toBeNull();
    expect(container.querySelector(".a-purpose")).toBeNull();
    expect(container.querySelector(".narr")).toHaveTextContent(
      "Addressing quality P1: legacy CLSD alias falls through to the raw enum",
    );
  });

  it("pipeline marks the task's current stage", () => {
    renderAgent(stateWith(), FIXUP);
    const current = screen.getByRole("listitem", { current: "step" });
    expect(current).toHaveTextContent("fixup");
    expect(screen.getByRole("listitem", { name: "implement" })).toHaveClass("done");
    expect(screen.getByRole("listitem", { name: "merge-ready" })).not.toHaveClass("done");
  });

  it("footer shows progress, heartbeat age and model", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const foot = container.querySelector(".win-foot") as HTMLElement;
    expect(foot).toHaveTextContent("62%");
    expect(foot.querySelector(".bar > span")).toHaveStyle({ width: "62%" });
    const hb = foot.querySelector(".hb") as HTMLElement;
    expect(hb).toHaveTextContent("4s");
    expect(hb).not.toHaveClass("hb--stale");
    expect(foot).toHaveTextContent("opus-5-5");
  });

  it("marks the heartbeat stale after 60 s", () => {
    const { container } = renderAgent(stateWith(), FIXUP, { now: NOW + 57_000 });
    const hb = container.querySelector(".hb") as HTMLElement;
    expect(hb).toHaveTextContent("1m");
    expect(hb).toHaveClass("hb--stale");
  });

  it("an agent whose registry entry arrived < 4 s ago is born; an older one is not", () => {
    const later = NOW + 30_000;
    const state = stateWith(...demoReviewer(later));
    const reviewer = renderAgent(state, "status-chip-t1-spec_reviewer-1", { now: later + 1500 });
    expect(reviewer.container.querySelector(".win")).toHaveClass("win--born");
    reviewer.unmount();
    const old = renderAgent(state, FIXUP, { now: later + 1500 });
    expect(old.container.querySelector(".win")).not.toHaveClass("win--born");
  });

  it("an unassigned agent renders with the neutral accent and no task", () => {
    const at = NOW - 2000;
    const state = stateWith({
      topic: "volley/_system/registry/adhoc-1",
      envelope: {
        schema_version: "0.1",
        agent_id: "adhoc-1",
        channel: "_system/registry",
        type: "registered",
        payload: { capabilities: [], started_at: new Date(at).toISOString() },
      },
      receivedAt: at,
    });
    const { container } = renderAgent(state, "adhoc-1");
    expect(state.agents["adhoc-1"]?.wave).toBe(UNASSIGNED);
    expect(container.querySelector(".win")?.getAttribute("style")).toContain(
      `--acc: ${NEUTRAL_ACCENT}`,
    );
    expect(screen.getByText(UNASSIGNED)).toHaveClass("chip--wave");
    expect(container.querySelector(".a-purpose")).toBeNull();
    expect(container.querySelector(".pipe")).toBeNull();
    // The title already names a task-less agent by its id; it is not repeated.
    expect(screen.getAllByText("adhoc-1")).toHaveLength(1);
    expect(container.querySelector(".hb")).toHaveTextContent("—");
    expect(container.querySelector(".win-foot")).toHaveTextContent("model unknown");
  });

  it("switches between the Volley feed and the Terminal tab", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    expect(screen.getByRole("tab", { name: /Volley feed/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(container.querySelector(".feed")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(container.querySelector(".feed")).toBeNull();
    expect(screen.getByText("⏺ Update(src/chip-mapper.ts)")).toHaveClass("tl-cmd");
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("the Terminal shows the stale marker when the wave state flags the task's screen", () => {
    const state = stateWith();
    const wave = state.waves["status-chip"];
    const ws = wave?.state;
    if (!wave || !ws) throw new Error("no wave");
    const tasks = ws.tasks.map((t) => (t.id === "T1" ? { ...t, screen_stale: true } : t));
    const agent = state.agents[FIXUP];
    if (!agent) throw new Error("no agent");
    render(
      <AgentWindow
        agent={agent}
        wave={{ ...wave, state: { ...ws, tasks } }}
        accent={ACCENT}
        frame={frame}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByText("stale")).toBeInTheDocument();
  });

  it("the chat glyph emits a callback with the agent id", () => {
    const onChat = vi.fn();
    renderAgent(stateWith(), FIXUP, { onChat });
    fireEvent.click(
      screen.getByRole("button", { name: "Message T1 · Chip mapper + null-case handling fixup" }),
    );
    expect(onChat).toHaveBeenCalledWith(FIXUP);
  });

  it("renders the attention slot when given", () => {
    const state = stateWith();
    const agent = state.agents[FIXUP];
    if (!agent) throw new Error("no agent");
    render(
      <AgentWindow
        agent={agent}
        wave={state.waves[agent.wave]}
        accent={ACCENT}
        frame={frame}
        now={NOW}
        attention={<span>needs you</span>}
      />,
    );
    const line = screen.getByText("needs you");
    expect(line.parentElement?.querySelector(".narr")).not.toBeNull();
  });
});

describe("AgentWindow icon", () => {
  it("defaults to the Clawd character, with no status ring", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    const img = within(bar).getByRole("img", { name: "fixing up" });
    expect(img).toHaveClass("clawd-sprite");
    expect(container.querySelector(".status-mark")).toBeNull();
  });

  it('icons="classic" keeps the status ring and draws no Clawd', () => {
    const { container } = renderAgent(stateWith(), FIXUP, { icons: "classic" });
    expect(container.querySelector(".status-mark")).not.toBeNull();
    expect(container.querySelector(".clawd-sprite")).toBeNull();
    expect(screen.getByRole("img", { name: "In progress, 62%" })).toBeInTheDocument();
  });

  it("the merge-ready task's done implementer is merge-ready, with the glow", () => {
    renderAgent(stateWith(), "status-chip-t2-implementer-1");
    expect(screen.getByRole("img", { name: "merge-ready" })).toHaveClass("clawd-sprite--glow");
  });

  it("a blocked agent asks for you only when it is you it waits on", () => {
    const state = stateWith();
    const { unmount } = renderAgent(state, "leaderboard-t1-implementer-1", {
      attentionTier: "you",
    });
    expect(screen.getByRole("img", { name: "needs you" })).toBeInTheDocument();
    unmount();
    renderAgent(state, "leaderboard-t1-implementer-1", { attentionTier: "coordinator" });
    expect(screen.getByRole("img", { name: "waiting" })).toBeInTheDocument();
  });
});

describe("AgentWindow status mark", () => {
  it("a done agent that is then reaped keeps its Completed mark", () => {
    const state = stateWith(
      status(FIXUP, "done", NOW + 1000, { msg: "merged" }),
      status(FIXUP, "reaped", NOW + 2000, { reason: "disconnect" }),
    );
    renderAgent(state, FIXUP, { now: NOW + 3000, icons: "classic" });
    expect(screen.getByRole("img", { name: "Completed" })).toBeInTheDocument();
  });

  it("an agent reaped while working shows the crash (failed) mark", () => {
    const state = stateWith(status(FIXUP, "reaped", NOW + 1000, { reason: "disconnect" }));
    renderAgent(state, FIXUP, { now: NOW + 2000, icons: "classic" });
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

  it("a blocked agent does not look like one that has not started", () => {
    const state = stateWith(status(FIXUP, "blocked", NOW + 1000, { reason: "needs a decision" }));
    renderAgent(state, FIXUP, { now: NOW + 2000, icons: "classic" });
    expect(screen.queryByRole("img", { name: "Pending" })).toBeNull();
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

  const at = (type: string) => ({ type, payload: {}, at: NOW });
  const fe = (channel: string, type: string) => ({
    topic: `volley/demo/a/${channel}`,
    envelope: { schema_version: "0.1", agent_id: "a", channel, type, payload: {} },
    receivedAt: NOW,
  });
  it.each([
    ["no status", "pending", null, []],
    ["spawning", "pending", at("spawning"), []],
    ["registered", "pending", at("registered"), []],
    ["working", "running", at("working"), []],
    ["done", "done", at("done"), []],
    ["failed", "failed", at("failed"), []],
    ["blocked", "failed", at("blocked"), []],
    ["reaped after done", "done", at("reaped"), [fe("status", "done"), fe("status", "reaped")]],
    [
      "reaped after done, then a heartbeat",
      "done",
      at("reaped"),
      [fe("status", "done"), fe("progress", "heartbeat"), fe("status", "reaped")],
    ],
    [
      "reaped after failed",
      "failed",
      at("reaped"),
      [fe("status", "failed"), fe("status", "reaped")],
    ],
    [
      "reaped after blocked",
      "failed",
      at("reaped"),
      [fe("status", "blocked"), fe("status", "reaped")],
    ],
    [
      "reaped while working",
      "failed",
      at("reaped"),
      [fe("status", "working"), fe("status", "reaped")],
    ],
    [
      "reaped, replay with only a result",
      "done",
      at("reaped"),
      [fe("result", "pr"), fe("status", "reaped")],
    ],
    ["reaped, nothing else known", "failed", at("reaped"), [fe("status", "reaped")]],
  ] as const)("%s → %s", (_name, mark, st, feed) => {
    expect(markStatus({ status: st, feed: [...feed] })).toBe(mark);
  });
});

describe("Pipeline", () => {
  it("a reviewer's task in review: implement done, review current", () => {
    render(<Pipeline stage="quality_review" agentRole="quality_reviewer" />);
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("review");
    expect(screen.getByRole("listitem", { name: "implement" })).toHaveClass("done");
  });

  it("a held stage falls back to the agent's role step and marks it held", () => {
    render(<Pipeline stage="awaiting_decision" agentRole="implementer" />);
    const cur = screen.getByRole("listitem", { current: "step" });
    expect(cur).toHaveTextContent("implement");
    expect(cur).toHaveClass("held");
  });

  it("a rebase agent held outside a pipeline stage sits on the fixup step (P2-8)", () => {
    render(<Pipeline stage="blocked" agentRole="rebase" />);
    const cur = screen.getByRole("listitem", { current: "step" });
    expect(cur).toHaveTextContent("fixup");
    expect(cur).toHaveClass("held");
  });

  it("done marks every step done and none current", () => {
    render(<Pipeline stage="done" agentRole="implementer" />);
    expect(screen.queryByRole("listitem", { current: "step" })).toBeNull();
    for (const name of ["implement", "review", "fixup", "merge-ready"]) {
      expect(screen.getByRole("listitem", { name })).toHaveClass("done");
    }
  });
});

describe("Pipeline depth classes", () => {
  const items = () =>
    within(screen.getByRole("list", { name: "Pipeline stage" })).getAllByRole("listitem");

  it("the demo's fixup agent: done, done, current, future", () => {
    renderAgent(stateWith(), FIXUP);
    const li = items();
    expect(li.map((el) => el.className)).toEqual([
      "done fx-done",
      "done fx-done",
      "cur fx-cur",
      "fx-future",
    ]);
    expect(li[2]).toHaveAttribute("aria-current", "step");
    expect(li[2]).toHaveAccessibleName("fixup");
  });

  it("a held stage adds held to the current item", () => {
    render(<Pipeline stage="awaiting_decision" agentRole="implementer" />);
    const cur = screen.getByRole("listitem", { current: "step" });
    expect(cur).toHaveClass("cur", "fx-cur", "held");
  });
});

describe("AgentWindow: the account it runs under (T8)", () => {
  const ev = (type: string, seq: number, data: Record<string, unknown>): DeskMessage => ({
    topic: "volley/_waves/status-chip/events",
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/events",
      type,
      wall_time: new Date(NOW - 120_000 + seq * 1000).toISOString(),
      payload: { wave: "status-chip", seq, task: "T1", data },
    },
    receivedAt: NOW,
  });
  const chosen = ev("account_chosen", 9001, {
    task: "T1",
    role: "fixup",
    attempt: 1,
    account: "primary",
    machine: "local",
    source: "balance",
    why: "work: most headroom on peer-a (5h 12%, 7d 40%; primary@peer-a 5h 88%)",
    candidates: [],
  });
  const moved = ev("agent_account_moved", 9002, {
    agent_id: FIXUP,
    role: "fixup",
    from: "primary",
    to: "work",
    by: "autopilot",
    decision_id: "d-acct-1",
    why: "primary at 91% of its 5-hour window",
  });
  const limit: DecisionPayload = {
    decision_id: "status-chip-t1-agent_account_limit-1",
    wave: "status-chip",
    task: "T1",
    kind: "agent_account_limit",
    question: `${FIXUP} runs under primary, at 91% of its 5-hour window.`,
    options: [`move ${FIXUP} to work`, "not now"],
    opened_at: new Date(NOW).toISOString(),
    agent_id: FIXUP,
    role: "fixup",
    window: "five_hour",
    acct: "primary",
    pct: 91,
    resets_at: null,
    suggested: "work",
  };

  function renderAccount(
    opts: { autopilot?: boolean; onResolve?: AgentWindowProps["onResolve"] } = {},
  ) {
    const state = stateWith(chosen, moved);
    const agent = state.agents[FIXUP];
    const wave = state.waves[agent?.wave ?? ""];
    if (!agent || !wave?.state) throw new Error("no agent");
    const autopilot = {
      enabled: opts.autopilot ?? false,
      auto_resolved: 0,
      escalated: 0,
      budgets: {},
    };
    return render(
      <AgentWindow
        agent={agent}
        wave={{ ...wave, state: { ...wave.state, autopilot } }}
        accent={ACCENT}
        frame={frame}
        now={NOW}
        accountEvents={state.accountFeed?.["status-chip"] ?? []}
        accountLimit={limit}
        accounts={[{ id: "work", label: "Work", machine: "local", fivePct: 12, weeklyPct: 40 }]}
        {...(opts.onResolve ? { onResolve: opts.onResolve } : {})}
      />,
    );
  }

  it("the store keeps a wave's account events, by wave, once each", () => {
    const s = reduceAll(stateWith(chosen, moved), [chosen]);
    expect(s.accountFeed?.["status-chip"]?.map((e) => e.envelope.type)).toEqual([
      "account_chosen",
      "agent_account_moved",
    ]);
    // Not the autopilot feed: the wave window's Autopilot list stays autopilot's.
    expect(s.waveFeed?.["status-chip"] ?? []).toEqual([]);
  });

  it("the Volley feed shows the task role's Account rows", () => {
    renderAccount();
    expect(
      screen.getByText(
        "Account · work: most headroom on peer-a (5h 12%, 7d 40%; primary@peer-a 5h 88%)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Account · moved off primary to work by autopilot: primary at 91% of its 5-hour window",
      ),
    ).toBeInTheDocument();
  });

  it("an open agent_account_limit while autopilot is on: what autopilot will do, no buttons", async () => {
    const { container } = renderAccount({ autopilot: true, onResolve: vi.fn() });
    const banner = screen.getByRole("status", { name: "Claude account limit" });
    expect(banner).toHaveTextContent("account at 91% — autopilot will move it to work");
    expect(within(banner).queryByRole("button")).toBeNull();
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("with autopilot off, Move sends the decision's own option and Not now its own", async () => {
    const onResolve = vi.fn(async () => ({ ok: true }));
    const { container } = renderAccount({ onResolve });
    const banner = screen.getByRole("status", { name: "Claude account limit" });
    await act(async () => {
      fireEvent.click(
        within(banner).getByRole("button", { name: "Move to work (5h 12%, 7d 40%)" }),
      );
    });
    expect(onResolve).toHaveBeenCalledWith(limit, `move ${FIXUP} to work`);
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Not now" }));
    });
    expect(onResolve).toHaveBeenLastCalledWith(limit, "not now");
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
