/** The overlap plan in the wave window (#388): clusters, bundles, holds, trains and churn. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PLAN_EVENTS,
  autopilotLine,
  clusterBadge,
  strategyLine,
  trainLine,
} from "../src/store/autopilot";
import { PLANNED_WAVE, demoPlanned } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { Envelope, WaveStatePayload, WaveView } from "../src/store/types";
import { hotLine } from "../src/windows/wave/Clusters";
import { WaveWindow, type WaveWindowProps, dagNodes } from "../src/windows/wave/WaveWindow";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");

const stored = () => reduceAll(initialState(), demoPlanned(NOW));
const planned = (): WaveView => {
  const w = stored().waves[PLANNED_WAVE];
  if (!w) throw new Error("no planned wave");
  return w;
};

/** The planned wave with the plan, spawns and trains dropped: an older supervisor's state. */
function unplanned(): WaveView {
  const w = planned();
  const { overlap_plan: _p, spawns: _s, trains: _t, ...rest } = w.state as WaveStatePayload;
  const state: WaveStatePayload = {
    ...rest,
    tasks: rest.tasks.filter((t) => !t.train).map(({ cluster: _c, churn: _ch, ...t }) => t),
  };
  return { ...w, state };
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
  render(<WaveWindow wave={w} me={null} frame={frame} now={NOW} {...p} />);

describe("the clusters panel", () => {
  it("lists one row per cluster: id, members, hot files, strategy, state and why", () => {
    renderWave(planned());
    const panel = screen.getByRole("region", { name: "Clusters" });
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [a, b] = rows as [HTMLElement, HTMLElement];
    expect(a).toHaveTextContent("A");
    expect(a).toHaveTextContent("5 tasks");
    expect(a).toHaveTextContent("src/daemon.ts · 11k · 5 tasks");
    expect(a).toHaveTextContent("1 bundle · cap 4");
    expect(a).toHaveTextContent("planned");
    expect(a).toHaveTextContent(/capped at 4 in flight/);
    expect(b).toHaveTextContent("1 chain");
    expect(b).toHaveTextContent("hold");
  });

  it("collapses and expands from its heading", () => {
    renderWave(planned());
    const toggle = screen.getByRole("button", { name: /Clusters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = screen.getByRole("region", { name: "Clusters" });
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("formats a hot file as its last two path segments, size and sharers", () => {
    expect(
      hotLine({ file: "packages/volleyd/src/daemon.ts", bytes: 11_234, shared_by: ["a", "b"] }),
    ).toBe("src/daemon.ts · 11k · 2 tasks");
    expect(hotLine({ file: "README.md", bytes: 640, shared_by: ["a"] })).toBe(
      "README.md · 640 B · 1 task",
    );
  });

  it("names a strategy by its parts, or independent", () => {
    expect(strategyLine({ collapse: [["a"], ["b", "c"]], chain: [["a", "b"]], cap: 4 })).toBe(
      "2 bundles · 1 chain · cap 4",
    );
    expect(strategyLine({})).toBe("independent");
  });
});

describe("the dependency graph of a planned wave", () => {
  it("labels a bundle `#310 +1`, with the full list in its title and each issue linked", () => {
    const { container } = renderWave(planned());
    const node = container.querySelector('.dag-node[data-id="i310"]') as SVGGElement;
    expect(node.querySelector(".dag-issue")).toHaveTextContent("#310 +1");
    expect(node.querySelector("title")).toHaveTextContent("#310, #312");
    const links = [...node.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "https://github.com/example-org/example-repo/issues/310",
      "https://github.com/example-org/example-repo/issues/312",
    ]);
  });

  it("badges a capped cluster `A · 4/4` and a held one `B · hold`", () => {
    const { container } = renderWave(planned());
    const badge = (id: string) =>
      container.querySelector(`.dag-node[data-id="${id}"] .dag-cluster`)?.textContent;
    expect(badge("i310")).toBe("A · 4/4");
    expect(badge("i330")).toBe("B · hold");
    expect(badge("i301")).toBeUndefined();
  });

  it("leaves the synthetic train task out of the graph and the rail", () => {
    const nodes = dagNodes(planned().state as WaveStatePayload);
    expect(nodes.map((n) => n.id)).not.toContain("train-1");
    const { container } = renderWave(planned());
    expect(container.querySelector('.rail-seg[title^="train-1"]')).toBeNull();
  });

  it("badges one cluster per call: in flight over the cap, hold, else just the id", () => {
    const c = { id: "A", tasks: ["x"], hot: [], why: "" };
    expect(clusterBadge({ ...c, strategy: { cap: 4 }, state: "planned" }, 2)).toBe("A · 2/4");
    expect(clusterBadge({ ...c, strategy: { cap: 4 }, state: "hold" }, 2)).toBe("A · hold");
    expect(clusterBadge({ ...c, strategy: {}, state: "planned" }, 2)).toBe("A");
  });
});

describe("the merge queue line with trains", () => {
  it("reads `train-1 (i301, i302, i303) integrating · queued i305, i306`, linking the train's PR", () => {
    renderWave(planned());
    const line = screen.getByLabelText("Merge queue");
    expect(line).toHaveTextContent("train-1 (i301, i302, i303) integrating · queued i305, i306");
    const pr = within(line).getByRole("link", { name: "PR #340 on GitHub" });
    expect(pr).toHaveAttribute("href", "https://github.com/example-org/example-repo/issues/340");
  });

  it("formats a train without its ended ones", () => {
    expect(trainLine({ id: "train-2", tasks: ["a", "b"], state: "ci", since: "" })).toBe(
      "train-2 (a, b) ci",
    );
  });
});

describe("the churn chip", () => {
  it("shows `churn 7` with the breakdown in its title", () => {
    const { container } = renderWave(planned());
    const chip = container.querySelector(".chip--churn") as HTMLElement;
    expect(chip).toHaveTextContent("churn 7");
    expect(chip.title).toMatch(/7 churn · 14 productive/);
    expect(chip.title).toMatch(/i318: 3/);
    // The autopilot chip is unchanged.
    expect(container.querySelector(".chip--autopilot .ap-full")).toHaveTextContent(
      "autopilot on · 2 auto · 0 escalated",
    );
  });
});

describe("a wave without a plan", () => {
  it("renders no clusters panel, badges, bundle label, train or churn chip", () => {
    const { container } = renderWave(unplanned());
    expect(screen.queryByRole("region", { name: "Clusters" })).toBeNull();
    expect(container.querySelector(".dag-cluster")).toBeNull();
    expect(container.querySelector(".dag-hull")).toBeNull();
    expect(container.querySelector(".chip--churn")).toBeNull();
    expect(screen.getByLabelText("Merge queue")).not.toHaveTextContent("train");
  });
});

describe("the plan's events in the wave feed", () => {
  const ev = (type: string, data: Record<string, unknown>): Envelope => ({
    schema_version: "0.1",
    agent_id: "volleyd",
    channel: "_waves/events",
    type,
    payload: { wave: "w", seq: 1, at: "", data },
  });

  it("labels each of the five events", () => {
    expect(PLAN_EVENTS.size).toBe(5);
    expect(autopilotLine(ev("wave_planned", { clusters: [{}, {}] }))).toBe("planned · 2 clusters");
    expect(
      autopilotLine(
        ev("cluster_strategy_changed", { cluster: "A", from: "cap", to: "hold", why: "churn" }),
      ),
    ).toBe("cluster A → hold: churn");
    expect(autopilotLine(ev("train_started", { train: "train-1", tasks: ["a", "b"] }))).toBe(
      "train train-1 started (a, b)",
    );
    expect(autopilotLine(ev("train_merged", { train: "train-1", pr: 9, tasks: ["a"] }))).toBe(
      "train train-1 merged in #9",
    );
    expect(autopilotLine(ev("train_failed", { train: "train-1", why: "red CI" }))).toBe(
      "train train-1 failed: red CI",
    );
  });

  it("keeps them in the wave's feed", () => {
    expect(stored().waveFeed?.[PLANNED_WAVE]?.map((e) => e.envelope.type)).toEqual([
      "wave_planned",
      "cluster_strategy_changed",
      "train_started",
    ]);
  });
});
