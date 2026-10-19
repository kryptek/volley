import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import {
  agentsByWave,
  initialState,
  reduceAll,
  stageChip,
  workingCount,
} from "../src/store/reducer";
import type { DeskMessage } from "../src/store/types";
import {
  NOW,
  S,
  fakeClient,
  progress,
  registry,
  status,
  waveMsg,
  waveState,
} from "./helpers/desk-msgs";

const state = () =>
  waveState({
    owner: "coord-1",
    tasks: [
      {
        id: "T1",
        issue: 1,
        stage: "spec_review",
        agents: {
          implementer: "impl-1",
          fixup: "fix-1",
          spec_reviewer: "spec-1",
          quality_reviewer: "qual-1",
        },
      },
    ],
  });

const live = (id: string, type = "working"): DeskMessage[] => [
  registry(id, NOW - 60 * S),
  status(id, type, NOW - 60 * S),
  progress(id, "narration", NOW - 2 * S, { msg: `${id} at work` }),
];

const msgs = (): DeskMessage[] => [
  waveMsg(state()),
  ...live("impl-1", "done"),
  ...live("fix-1", "done"),
  ...live("spec-1"),
  ...live("qual-1"),
];

describe("parallel reviewers — store", () => {
  it("both reviewers are agents of the task, counted as working, ordered implementer/fixup/spec/quality", () => {
    const s = reduceAll(initialState(), msgs());
    expect(workingCount(s)).toBe(2);
    expect((agentsByWave(s).w1 ?? []).map((a) => a.id)).toEqual([
      "impl-1",
      "fix-1",
      "spec-1",
      "qual-1",
    ]);
  });

  it("an agent the MCP left at `registered` that is narrating still counts as working", () => {
    const s = reduceAll(initialState(), [...msgs(), status("qual-1", "registered", NOW - 30 * S)]);
    expect(workingCount(s)).toBe(2);
  });

  it("the stage chip reads 'review (spec + quality)' while both reviewers run", () => {
    const s = reduceAll(initialState(), msgs());
    expect(stageChip(s, "w1", "T1")).toBe("review (spec + quality)");
    const one = reduceAll(initialState(), [...msgs(), status("qual-1", "done", NOW - S)]);
    expect(stageChip(one, "w1", "T1")).toBe("spec review");
  });
});

describe("parallel reviewers — App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two windows, top bar '2 agents working', the stage chip on both", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeClient();
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      f.up();
      for (const m of msgs()) f.emit(m);
      vi.advanceTimersByTime(100);
    });
    const spec = screen.getByRole("region", { name: "w1 · T1 · spec review" });
    const qual = screen.getByRole("region", { name: "w1 · T1 · quality review" });
    expect(container.querySelector(".topbar-mid")).toHaveTextContent("2 agents working");
    for (const win of [spec, qual]) {
      expect(within(win).getByText("review (spec + quality)")).toHaveClass("chip--stage");
    }
  });
});
