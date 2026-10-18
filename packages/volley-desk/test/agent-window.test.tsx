import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import { demoMessages, demoReviewer } from "../src/store/fixtures";
import { UNASSIGNED, initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, DeskState } from "../src/store/types";
import { AgentWindow, NEUTRAL_ACCENT } from "../src/windows/agent/AgentWindow";
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

function renderAgent(
  state: DeskState,
  id: string,
  opts: { now?: number; onChat?: () => void } = {},
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
    />,
  );
}

describe("AgentWindow", () => {
  it("title shows task, issue, the wave chip in the wave accent, and the role", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    expect(bar.querySelector(".t-name")).toHaveTextContent("T1 #102");
    const chip = within(bar).getByText("status-chip");
    expect(chip).toHaveClass("chip--wave");
    expect(chip.querySelector("i")).toHaveStyle({ background: ACCENT });
    expect(within(bar).getByText("fixup")).toHaveClass("chip--role");
    expect(within(bar).getByRole("img", { name: "In progress, 62%" })).toBeInTheDocument();
    expect(container.querySelector(".win")).toHaveStyle({ width: "460px" });
  });

  it("shows the task title from the wave spec and the latest narration", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    expect(container.querySelector(".a-title")).toHaveTextContent(
      "Chip mapper + null-case handling",
    );
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
    expect(container.querySelector(".a-title")).toBeNull();
    expect(container.querySelector(".pipe")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Message T1 fixup" }));
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

  it("done marks every step done and none current", () => {
    render(<Pipeline stage="done" agentRole="implementer" />);
    expect(screen.queryByRole("listitem", { current: "step" })).toBeNull();
    for (const name of ["implement", "review", "fixup", "merge-ready"]) {
      expect(screen.getByRole("listitem", { name })).toHaveClass("done");
    }
  });
});

describe("App agent windows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an agent volleyd spawns mid-session pops in with the born class", () => {
    vi.useFakeTimers();
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const born = () => [...container.querySelectorAll(".world .win--born .t-name")];
    expect(born()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(22_500);
    });
    expect(born().map((n) => n.textContent)).toEqual(["T1 #102"]);
    expect(container.querySelector(".world .win--born .chip--role")).toHaveTextContent(
      "spec review",
    );
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(born()).toHaveLength(0);
  });
});
