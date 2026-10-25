import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WaveCleanup } from "../src/store/types";
import { WaveWindow } from "../src/windows/wave/WaveWindow";
import { NOW, S, waveState, waveView } from "./helpers/desk-msgs";

/** The wave window says whether the wave was cleaned, and what cleanup kept (#612 D7). */

const H = 3600 * S;
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};
const summary = "cleaned w1: 3 worktrees (1 on box), 2 sessions, 3 branches; kept 2";
const complete = (cleanup?: WaveCleanup) =>
  waveState({
    status: "complete",
    updated_at: new Date(NOW - H).toISOString(),
    tasks: [{ id: "T1", issue: 1, stage: "done", agents: {} }],
    spec: { version: 1, tasks: { T1: { issue: 1, after: [] } } },
    ...(cleanup !== undefined ? { cleanup } : {}),
  });
const win = (state: ReturnType<typeof complete>) => {
  render(
    <WaveWindow wave={waveView(state)} me={null} now={NOW} startedAt={NOW - 6 * H} frame={frame} />,
  );
  return screen.getByRole("region", { name: "w1" });
};

describe("the cleaned chip", () => {
  it("shows the chip with the summary as its title, and each kept item with why", () => {
    const w = win(
      complete({
        at: new Date(NOW - H).toISOString(),
        removed: { worktrees: 3, sessions: 2, branches: 3 },
        kept: [
          {
            kind: "release_branch",
            host: "local",
            what: "release/w1",
            why: "merged into main — git push origin --delete release/w1",
          },
          { kind: "clone", host: "box", what: "/path/to/clone", why: "1 unpushed commit on main" },
        ],
        summary,
      }),
    );
    const chip = within(w).getByText("cleaned");
    expect(chip).toHaveClass("chip--cleaned");
    expect(chip).toHaveAttribute("title", summary);
    const kept = within(w).getByRole("list", { name: "Kept by cleanup" });
    expect(kept).toHaveTextContent(
      "release branch release/w1: merged into main — git push origin --delete release/w1",
    );
    expect(kept).toHaveTextContent("clone /path/to/clone on box: 1 unpushed commit on main");
  });

  it("nothing without a cleanup run, nor for a task's run alone", () => {
    const w = win(complete());
    expect(within(w).queryByText("cleaned")).toBeNull();
    expect(within(w).queryByRole("list", { name: "Kept by cleanup" })).toBeNull();
  });
});
