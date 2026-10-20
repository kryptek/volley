import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ciPending, waveAttention } from "../src/attention";
import { initialState, reduceAll } from "../src/store/reducer";
import { WaveWindow } from "../src/windows/wave/WaveWindow";
import { NOW, S, registry, status, waveMsg, waveState, waveView } from "./helpers/desk-msgs";

const WHY = "CI pending on abc1234 (2/5 checks)";

const state = () =>
  waveState({
    owner: "coord-1",
    tasks: [
      {
        id: "T1",
        issue: 1,
        stage: "implement",
        agents: { implementer: "impl-1" },
        why_waiting: WHY,
        pr: {
          number: 12,
          url: "https://example.invalid/pr/12",
          head_sha: "abc1234",
          ci: "running",
        },
      },
      { id: "T2", issue: 2, stage: "queued", agents: {} },
    ],
    spec: { version: 1, tasks: { T1: { issue: 1, after: [] }, T2: { issue: 2, after: ["T1"] } } },
  });

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

describe("CI pending", () => {
  it("is read from the task's why_waiting", () => {
    const [t1, t2] = state().tasks;
    expect(t1 && ciPending(t1)).toBe(true);
    expect(t2 && ciPending(t2)).toBe(false);
  });

  it("the wave window shows the 'waiting for CI' chip and the task row with why_waiting and its pipeline", () => {
    render(<WaveWindow wave={waveView(state())} me={null} now={NOW} frame={frame} />);
    const win = screen.getByRole("region", { name: "w1" });
    expect(win.querySelector(".win-title .chip--ci")).toHaveTextContent("waiting for CI");
    const row = within(win).getByRole("listitem", { name: "T1 CI pending" });
    expect(row).toHaveTextContent(WHY);
    expect(row).toHaveTextContent("implement ✓ · CI ⟳ · review");
    // The graph node no longer reads as a plain `implementing`.
    const node = win.querySelector('.dag-node[data-id="T1"]');
    expect(node).toHaveTextContent("waiting for CI");
  });

  it("no live agent and no stall tier: the retired implementer is not a no-signal item", () => {
    const s = reduceAll(initialState(), [
      waveMsg(state()),
      registry("coord-1", NOW - 600 * S),
      status("coord-1", "working", NOW - 5 * S),
      registry("impl-1", NOW - 900 * S),
      status("impl-1", "done", NOW - 300 * S),
    ]);
    const w = s.waves.w1;
    if (!w) throw new Error("no wave");
    const tier = waveAttention(w, {
      now: NOW,
      agents: s.agents,
      coordinators: s.coordinators,
    }).tier;
    expect(["info", "none"]).toContain(tier);
  });

  it("no chip when nothing waits for CI", () => {
    render(<WaveWindow wave={waveView(waveState())} me={null} now={NOW} frame={frame} />);
    expect(screen.queryAllByText("waiting for CI")).toHaveLength(0);
  });
});
