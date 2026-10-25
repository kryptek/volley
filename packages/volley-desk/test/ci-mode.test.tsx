// A repository with no CI (`ci_mode: none`, #602): the wave window says `no CI` beside the repo
// chip, and a task verified without CI reads `no CI · the reviewers and the gate are the check`
// in its CI panel, never a pending bar.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WaveStatePayload, WaveTask, WaveView } from "../src/store/types";
import { CiPanel } from "../src/windows/wave/CiPanel";
import { WaveWindow, type WaveWindowProps } from "../src/windows/wave/WaveWindow";

function wave(over: Partial<WaveStatePayload> = {}): WaveView {
  const state: WaveStatePayload = {
    wave: "no-ci",
    version: 1,
    owner: null,
    repo: "example-org/example-repo",
    release_branch: "release/no-ci",
    status: "running",
    tasks: [{ id: "T1", issue: 1, stage: "implement", agents: {} }],
    open_decisions: [],
    gates: [],
    updated_at: "2026-10-25T12:00:00.000Z",
    ...over,
  };
  return { id: "no-ci", state, decisions: {}, receivedAt: 0 };
}

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const renderWave = (w: WaveView) =>
  render(<WaveWindow wave={w} me={null} frame={frame as WaveWindowProps["frame"]} />);

const verified: WaveTask = {
  id: "T1",
  issue: 1,
  stage: "spec_review",
  agents: {},
  pr: { number: 12, url: "https://example.invalid/pr/12", ci: "none" },
};

describe("ci_mode: none on the Desk (#602)", () => {
  it("the wave window shows the no CI chip, titled with the sentence", () => {
    const { container } = renderWave(wave({ ci_mode: "none" }));
    const chip = container.querySelector(".chip--noci");
    expect(chip).toHaveTextContent("no CI");
    expect(chip?.getAttribute("title")).toContain("the reviewers and the gate are the check");
    expect(container.querySelector(".win-title")?.contains(chip as Node)).toBe(true);
  });

  it("workflows (or an older supervisor) shows no chip", () => {
    expect(
      renderWave(wave({ ci_mode: "workflows" })).container.querySelector(".chip--noci"),
    ).toBeNull();
    expect(renderWave(wave()).container.querySelector(".chip--noci")).toBeNull();
  });

  it("CiPanel: a task with pr.ci none in such a wave reads the sentence, no bar, no checks link", () => {
    render(<CiPanel task={verified} wave="no-ci" ciMode="none" accent="#6ee7f9" frame={frame} />);
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(win.querySelector(".ci-none")?.textContent).toBe(
      "no CI · the reviewers and the gate are the check",
    );
    expect(within(win).queryByRole("progressbar")).toBeNull();
    expect(within(win).queryByRole("link")).toBeNull();
    expect(win.querySelector(".chip--ci")).toHaveTextContent("no CI");
  });

  it("CiPanel in a wave with workflows keeps its hold sentence", () => {
    const task = { ...verified, why_waiting: "CI pending on 0000602 (no run yet)" };
    render(<CiPanel task={task} wave="w" ciMode="workflows" accent="#6ee7f9" frame={frame} />);
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(win.querySelector(".ci-none")).toBeNull();
    expect(win.querySelector(".ci-why")).toHaveTextContent("CI pending on 0000602");
  });
});
