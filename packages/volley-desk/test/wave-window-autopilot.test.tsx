import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixerFor, mergeQueueLine } from "../src/store/autopilot";
import type { FeedEntry, WaveStatePayload, WaveView } from "../src/store/types";
import { WaveWindow, type WaveWindowProps, dagNodes } from "../src/windows/wave/WaveWindow";

const AT = "2026-10-20T12:00:00.000Z";

/** `undefined` drops a field (a supervisor that does not publish it). */
type Over = { [K in keyof WaveStatePayload]?: WaveStatePayload[K] | undefined };

function wave(over: Over = {}): WaveView {
  const state: WaveStatePayload = {
    wave: "autopilot",
    version: 1,
    owner: "lead",
    repo: "example-org/example-repo",
    release_branch: "release/autopilot",
    status: "running",
    tasks: [
      { id: "T3", issue: 3, stage: "merge_ready", agents: {} },
      { id: "T5", issue: 5, stage: "merge_ready", agents: {} },
      { id: "T7", issue: 7, stage: "merge_ready", agents: {} },
      { id: "T9", issue: 9, stage: "merge_ready", agents: {} },
      {
        id: "T3-fix1",
        issue: 3,
        stage: "implement",
        agents: {},
        synthetic: { for: ["T3", "T7"] },
      },
    ],
    open_decisions: [],
    gates: [],
    spec: {
      version: 1,
      tasks: {
        T3: { issue: 3, after: [] },
        T5: { issue: 5, after: [] },
        T7: { issue: 7, after: [] },
        T9: { issue: 9, after: [] },
      },
    },
    autopilot: { enabled: true, auto_resolved: 4, escalated: 1, budgets: {} },
    merge_queue: [
      { task: "T3", state: "merging", since: AT },
      { task: "T5", state: "updating", since: AT },
      { task: "T7", state: "queued", since: AT },
      { task: "T9", state: "queued", since: AT },
    ],
    updated_at: AT,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete state[k];
    else state[k] = v;
  }
  return { id: state.wave, state, decisions: {}, receivedAt: 0 };
}

const frame: WaveWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

const renderWave = (w: WaveView, p: Partial<WaveWindowProps> = {}) =>
  render(<WaveWindow wave={w} me={null} frame={frame} now={Date.parse(AT)} {...p} />);

describe("the wave window's autopilot chip", () => {
  it("reads `autopilot on · N auto · M escalated` from state.autopilot", () => {
    renderWave(wave());
    expect(screen.getByText("autopilot on · 4 auto · 1 escalated")).toHaveClass("chip");
  });

  it("reads `autopilot off` when the wave runs without it", () => {
    renderWave(
      wave({ autopilot: { enabled: false, auto_resolved: 0, escalated: 0, budgets: {} } }),
    );
    expect(screen.getByText("autopilot off")).toHaveClass("chip");
  });

  it("is absent for a supervisor that predates autopilot", () => {
    const { container } = renderWave(wave({ autopilot: undefined }));
    expect(container.querySelector(".chip--autopilot")).toBeNull();
  });
});

describe("the merge queue line", () => {
  it("groups the queue by state, in merge order", () => {
    expect(mergeQueueLine(wave().state?.merge_queue ?? [])).toBe(
      "merging T3 · updating T5 · queued T7, T9",
    );
    expect(
      mergeQueueLine([
        { task: "T1", state: "queued", since: AT },
        { task: "T2", state: "refused", since: AT },
      ]),
    ).toBe("queued T1 · refused T2");
  });

  it("shows under the graph while the queue has tasks", () => {
    const { unmount } = renderWave(wave());
    const line = screen.getByLabelText("Merge queue");
    expect(line).toHaveTextContent("merging T3 · updating T5 · queued T7, T9");
    unmount();
    renderWave(wave({ merge_queue: undefined }));
    expect(screen.queryByLabelText("Merge queue")).toBeNull();
  });
});

describe("the release train rows", () => {
  const release: WaveStatePayload["release"] = {
    stage: "publish",
    stages: [
      { name: "tag", state: "verified" },
      { name: "publish", state: "awaiting_go" },
      { name: "announce", state: "pending" },
    ],
  };

  it("lists every stage with its state while the wave is releasing", () => {
    renderWave(wave({ status: "releasing", release, merge_queue: undefined }));
    const rows = within(screen.getByRole("list", { name: "Release train" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      "tag · verified",
      "publish · awaiting go",
      "announce · pending",
    ]);
    expect(rows[1]).toHaveAttribute("aria-current", "step");
  });

  it("is not shown while the wave is not releasing", () => {
    renderWave(wave({ release }));
    expect(screen.queryByRole("list", { name: "Release train" })).toBeNull();
  });
});

describe("synthetic fixer tasks", () => {
  it("name the tasks they fix", () => {
    const t = wave().state?.tasks.at(-1);
    expect(t && fixerFor(t)).toEqual(["T3", "T7"]);
    expect(fixerFor({ id: "T1", issue: 1, stage: "queued", agents: {} })).toBeNull();
    // A synthetic task that says only `remediation.for`.
    expect(
      fixerFor({
        id: "F1",
        issue: 1,
        stage: "queued",
        agents: {},
        synthetic: true,
        remediation: { for: ["T2"] },
      }),
    ).toEqual(["T2"]);
  });

  it("get a wrench glyph and `fixer for …` in the graph node's tooltip and the task list", () => {
    const w = wave();
    expect(dagNodes(w.state as WaveStatePayload).at(-1)).toMatchObject({
      id: "T3-fix1",
      fixerFor: ["T3", "T7"],
    });
    const { container } = renderWave(w);
    const node = container.querySelector('.dag-node[data-id="T3-fix1"]') as SVGGElement;
    expect(node.querySelector("title")?.textContent).toBe("T3-fix1 · fixer for T3, T7");
    expect(node.querySelector(".dag-fixer")?.textContent).toBe("🔧");
    const list = screen.getByRole("list", { name: "Fixer tasks" });
    expect(within(list).getByText("fixer for T3, T7")).toBeInTheDocument();
    expect(list).toHaveTextContent("🔧 T3-fix1");
  });
});

describe("the wave window's autopilot feed", () => {
  it("shows the wave's autopilot events through the feed", () => {
    const entry: FeedEntry = {
      topic: "volley/_waves/autopilot/events",
      receivedAt: Date.parse(AT),
      envelope: {
        schema_version: "0.1",
        agent_id: "volleyd",
        channel: "_waves/events",
        type: "decision_escalated",
        wall_time: AT,
        payload: { wave: "autopilot", seq: 1, at: AT, data: { why: "no_policy" } },
      },
    };
    renderWave(wave(), { autopilotFeed: [entry] });
    expect(screen.getByText("Autopilot could not resolve (no_policy)")).toBeInTheDocument();
  });
});
