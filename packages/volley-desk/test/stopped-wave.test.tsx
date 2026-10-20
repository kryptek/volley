import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { DISMISSED_WAVES_KEY } from "../src/App";
import { agentAttention, waveAttention } from "../src/attention";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import { endedWaves, initialState, reduceAll, workingCount } from "../src/store/reducer";
import { WaveWindow } from "../src/windows/wave/WaveWindow";
import {
  NOW,
  S,
  fakeClient,
  progress,
  registry,
  status,
  waveMsg,
  waveState,
  waveView,
} from "./helpers/desk-msgs";

const H = 3600 * S;
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const stopped = (status: "stopped" | "complete" = "stopped") =>
  waveState({
    status,
    // The state was last published when the wave stopped, 2.8 h ago.
    updated_at: new Date(NOW - 2.8 * H).toISOString(),
    tasks: [
      { id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } },
      { id: "T2", issue: 2, stage: "done", agents: {} },
    ],
    spec: {
      version: 1,
      tasks: { T1: { issue: 1, after: [] }, T2: { issue: 2, after: [] } },
    },
  });

describe("stopped / complete wave — attention", () => {
  it("gives the wave and its agents no attention, even a blocked agent or a gone coordinator", () => {
    const state = reduceAll(initialState(), [
      waveMsg(stopped()),
      registry("impl-1", NOW - H),
      status("impl-1", "blocked", NOW - H, { reason: "tests fail" }),
    ]);
    const w = state.waves.w1;
    if (!w) throw new Error("no wave");
    const ctx = { now: NOW, agents: state.agents, coordinators: state.coordinators };
    expect(waveAttention(w, ctx)).toEqual({ tier: "none" });
    const a = state.agents["impl-1"];
    if (!a) throw new Error("no agent");
    expect(agentAttention(a, w, ctx)).toEqual({ tier: "none" });
    expect(endedWaves(state)).toEqual(new Set(["w1"]));
  });
});

describe("stopped / complete wave — the top bar's working count", () => {
  it("does not count an agent of an ended wave, whatever its last status said", () => {
    const s = reduceAll(initialState(), [
      waveMsg(stopped()),
      registry("impl-1", NOW - H),
      status("impl-1", "working", NOW - 3 * H),
    ]);
    expect(s.agents["impl-1"]?.wave).toBe("w1");
    expect(workingCount(s)).toBe(0);
  });
});

describe("stopped / complete wave — WaveWindow", () => {
  it("renders dimmed with a Stopped chip and a frozen `stopped … ago` footer", () => {
    const { container } = render(
      <WaveWindow
        wave={waveView(stopped())}
        me={null}
        now={NOW}
        startedAt={NOW - 6 * H}
        frame={frame}
      />,
    );
    const win = screen.getByRole("region", { name: "w1" });
    expect(within(win).getByText("Stopped")).toHaveClass("chip--ended");
    expect(container.querySelector(".wave-ended")).not.toBeNull();
    expect(win).toHaveTextContent("stopped 2.8h ago");
    expect(win).not.toHaveTextContent(/running \d/);
    // Task stages are shown as they were, struck through.
    expect(container.querySelector(".dag.dag--ended")).not.toBeNull();
  });

  it("a complete wave reads Complete and `complete … ago`", () => {
    render(
      <WaveWindow
        wave={waveView(stopped("complete"))}
        me={null}
        now={NOW}
        startedAt={NOW - 6 * H}
        frame={frame}
      />,
    );
    const win = screen.getByRole("region", { name: "w1" });
    expect(within(win).getByText("Complete")).toBeInTheDocument();
    expect(win).toHaveTextContent("complete 2.8h ago");
  });

  it("a running wave keeps its running clock and no ended chip", () => {
    const { container } = render(
      <WaveWindow
        wave={waveView(waveState())}
        me={null}
        now={NOW}
        startedAt={NOW - H}
        frame={frame}
      />,
    );
    expect(screen.getByRole("region", { name: "w1" })).toHaveTextContent("running 1.0h");
    expect(container.querySelector(".wave-ended")).toBeNull();
  });
});

describe("stopped wave — App fold under Show finished", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  function mount() {
    const f = fakeClient();
    const view = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      f.up();
      f.emit(waveMsg(stopped()));
      f.emit(waveMsg(waveState({ wave: "w2", tasks: [] })));
      f.emit(registry("impl-1", NOW - H));
      f.emit(status("impl-1", "working", NOW - H));
      f.emit(progress("impl-1", "narration", NOW - 2 * S, { msg: "still here" }));
      vi.advanceTimersByTime(100);
    });
    return { ...view, f };
  }

  it("hides the stopped wave and its agents by default", () => {
    mount();
    expect(screen.queryByRole("region", { name: "w1" })).toBeNull();
    expect(screen.queryByRole("region", { name: "w1 · T1 · implementer" })).toBeNull();
    expect(screen.getByRole("region", { name: "w2" })).toBeInTheDocument();
    // The coordinators window still lists it, as Stopped, in its Ended group, and offers the toggle.
    const coords = screen.getByRole("region", { name: "Wave coordinators" });
    fireEvent.click(within(coords).getByRole("button", { name: "Ended · 1" }));
    expect(within(coords).getByText("Stopped")).toBeInTheDocument();
    expect(coords).toHaveTextContent(/1 ended wave/);
  });

  it("leaves no gap where the folded wave would sit: the running wave listed after it is first", () => {
    mount();
    const w2 = screen.getByRole("region", { name: "w2" });
    expect(w2.style.top).toBe("0px");
  });

  it("shows it (without tethers) when Show finished is on", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ showFinished: true, tethers: true }));
    const { container } = mount();
    expect(screen.getByRole("region", { name: "w1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "w1 · T1 · implementer" })).toBeInTheDocument();
    expect(container.querySelectorAll("svg.tethers path.tether-core")).toHaveLength(0);
  });

  const coords = () => screen.getByRole("region", { name: "Wave coordinators" });
  const openEnded = () =>
    fireEvent.click(within(coords()).getByRole("button", { name: /^Ended · / }));

  it("Show puts that one ended wave back on the canvas, with its agents", () => {
    mount();
    openEnded();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Show w1 on the canvas" }));
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("region", { name: "w1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "w1 · T1 · implementer" })).toBeInTheDocument();
    expect(within(coords()).getByRole("listitem", { name: "w1" })).not.toHaveTextContent(
      "· hidden",
    );
    expect(coords()).not.toHaveTextContent(/ended wave hidden/);
  });

  it("Dismiss drops it from this Desk (kept in this browser) until brought back", () => {
    mount();
    openEnded();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss w1 from the Desk" }));
    expect(within(coords()).queryByRole("listitem", { name: "w1" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(DISMISSED_WAVES_KEY) ?? "[]")).toEqual(["w1"]);
    expect(within(coords()).getByRole("button", { name: "Ended · 0" })).toBeInTheDocument();
    // Not even "Show finished" brings a dismissed wave back onto the canvas.
    fireEvent.click(screen.getByRole("checkbox", { name: /Show finished agents/ }));
    expect(screen.queryByRole("region", { name: "w1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(within(coords()).getByRole("listitem", { name: "w1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "w1" })).toBeInTheDocument();
  });

  it("a dismissal lasts while the wave stays ended: a reused id that runs and ends again is back", () => {
    const { f } = mount();
    openEnded();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss w1 from the Desk" }));
    act(() => {
      vi.advanceTimersByTime(5000); // the replay settles; w1 is still ended, so still dismissed
    });
    expect(JSON.parse(localStorage.getItem(DISMISSED_WAVES_KEY) ?? "[]")).toEqual(["w1"]);
    act(() => {
      f.emit({ ...waveMsg(waveState()), retained: false }); // w1 is reused and runs
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("region", { name: "w1" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(DISMISSED_WAVES_KEY) ?? "[]")).toEqual([]);
    act(() => {
      f.emit({ ...waveMsg(stopped()), retained: false }); // …and ends again
      vi.advanceTimersByTime(100);
    });
    expect(within(coords()).getByRole("button", { name: "Ended · 1" })).toBeInTheDocument();
  });

  it("keeps a dismissal whose wave has not been replayed yet (a slow link)", () => {
    localStorage.setItem(DISMISSED_WAVES_KEY, JSON.stringify(["w9"]));
    mount();
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(JSON.parse(localStorage.getItem(DISMISSED_WAVES_KEY) ?? "[]")).toEqual(["w9"]);
  });
});
