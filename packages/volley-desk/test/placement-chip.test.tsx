import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, reduceAll } from "../src/store/reducer";
import type { WaveTask } from "../src/store/types";
import { AgentWindow } from "../src/windows/agent/AgentWindow";
import { WaveWindow, type WaveWindowProps } from "../src/windows/wave/WaveWindow";
import {
  NOW,
  placement,
  registry,
  status,
  waveMsg,
  waveState,
  waveView,
} from "./helpers/desk-msgs";

const frame: WaveWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

const placed: WaveTask = {
  id: "T1",
  issue: 1,
  stage: "implement",
  agents: { implementer: "impl-1" },
  host: "box-a",
  placement: placement(),
  base_sha: "4f9c2e1d8b7a6c5e4d3c2b1a0f9e8d7c6b5a4f3e",
};
const pinned: WaveTask = {
  id: "T2",
  issue: 2,
  stage: "queued",
  agents: {},
  host: "box-b",
  placement: placement({
    host: "box-b",
    by: "wave_file",
    score: null,
    candidates: [{ host: "box-b", score: null, line: "box-b: named by the wave file" }],
  }),
};
const moved: WaveTask = {
  id: "T3",
  issue: 3,
  stage: "queued",
  agents: {},
  host: "box-a",
  placement: placement({ by: "decision", decided_at: "2026-10-18T09:15:00.000Z" }),
};
const unplaced: WaveTask = { id: "T4", issue: 4, stage: "queued", agents: {} };

const state = waveState({ tasks: [placed, pinned, moved, unplaced] });

const renderWave = () =>
  render(<WaveWindow wave={waveView(state)} me={null} frame={frame} now={NOW} />);

describe("task host chip and why here", () => {
  it("each placed task shows its host; an unplaced one shows none", () => {
    renderWave();
    expect(screen.getByRole("button", { name: "T1 on box-a: why here" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "T2 on box-b: why here" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^T4 on/ })).toBeNull();
  });

  it("the popover gives the rule and volleyd's candidate lines verbatim, best first", () => {
    renderWave();
    const chip = screen.getByRole("button", { name: "T1 on box-a: why here" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const pop = within(screen.getByRole("dialog", { name: "Why T1 runs on box-a" }));
    expect(pop.getByText("placed automatically at admission")).toBeInTheDocument();
    const lines = pop.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual([
      "box-a: 0.82 (cpu 0.9, slots 0.5, mem 0.71, usage 0.58)",
      "hub: 0.61 (cpu 0.4, slots 0.75, mem 0.6, usage 0.58)",
      "ineligible: box-b is down (no heartbeat for 90 s)",
    ]);
    expect(pop.getByText("cut from 4f9c2e1")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a pinned task says the wave file pinned it; a re-placed one says when the owner did", () => {
    renderWave();
    fireEvent.click(screen.getByRole("button", { name: "T2 on box-b: why here" }));
    expect(screen.getByText("pinned by the wave file")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "T3 on box-a: why here" }));
    expect(screen.getByText("re-placed by owner on 2026-10-18")).toBeInTheDocument();
  });

  it("the agent window footer reads on <host>", () => {
    const s = reduceAll(initialState(), [
      waveMsg(state),
      registry("impl-1", NOW),
      status("impl-1", "working", NOW),
    ]);
    const agent = s.agents["impl-1"];
    if (!agent) throw new Error("no impl-1");
    const { container } = render(
      <AgentWindow agent={agent} wave={s.waves.w1} accent="#c4b5fd" frame={frame} now={NOW} />,
    );
    expect(container.querySelector(".agent-foot")).toHaveTextContent("on box-a");
  });
});
