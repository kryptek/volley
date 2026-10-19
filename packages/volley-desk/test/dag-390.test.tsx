import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { phoneMaxWidth } from "../src/canvas/useViewport";
import type { WaveStatePayload } from "../src/store/types";
import { DAG_NODE_H, DAG_NODE_W, type DagNode, layoutDag } from "../src/windows/wave/Dag";
import { WaveWindow, dagWidthFor } from "../src/windows/wave/WaveWindow";
import { NOW, waveState, waveView } from "./helpers/desk-msgs";

// Seven tasks, five dependency columns: T1 → T2, T3 → T4 → T5, T6 → T7.
const AFTER: Record<string, string[]> = {
  T1: [],
  T2: ["T1"],
  T3: ["T1"],
  T4: ["T2", "T3"],
  T5: ["T4"],
  T6: ["T4"],
  T7: ["T5", "T6"],
};
const TASKS: DagNode[] = Object.entries(AFTER).map(([id, after], i) => ({
  id,
  issue: i + 1,
  after,
  stage: "queued",
}));
const CHAIN: DagNode[] = Array.from({ length: 7 }, (_, i) => ({
  id: `C${i}`,
  issue: i + 1,
  after: i ? [`C${i - 1}`] : [],
  stage: "queued",
}));

function inside(l: ReturnType<typeof layoutDag>, width: number) {
  expect(l.width).toBeLessThanOrEqual(width);
  for (const n of l.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.y).toBeGreaterThanOrEqual(0);
    expect(n.x + DAG_NODE_W).toBeLessThanOrEqual(l.width);
    expect(n.y + DAG_NODE_H).toBeLessThanOrEqual(l.height);
  }
}

const PHONE = dagWidthFor(phoneMaxWidth(390));

describe("dependency graph at 390 px", () => {
  it("wraps columns into bands so every node of a 7-task graph fits", () => {
    expect(PHONE).toBeLessThan(5 * 172);
    inside(layoutDag(TASKS, PHONE), PHONE);
    inside(layoutDag(CHAIN, PHONE), PHONE);
    // No two nodes overlap.
    const l = layoutDag(CHAIN, PHONE);
    const key = new Set(l.nodes.map((n) => `${n.x},${n.y}`));
    expect(key.size).toBe(l.nodes.length);
    // Every edge is still drawn.
    expect(l.edges).toHaveLength(6);
  });

  it("the wave window passes its phone width to the graph", () => {
    const tasks = Object.entries(AFTER).map(([id], i) => ({
      id,
      issue: i + 1,
      stage: "queued" as const,
      agents: {},
    }));
    const spec: WaveStatePayload["spec"] = {
      version: 1,
      tasks: Object.fromEntries(
        Object.entries(AFTER).map(([id, after], i) => [id, { issue: i + 1, after }]),
      ),
    };
    const { container } = render(
      <WaveWindow
        wave={waveView(waveState({ tasks, spec }))}
        me={null}
        now={NOW}
        frame={{
          pos: { x: 0, y: 0 },
          z: 1,
          scale: 1,
          chrome: "glass",
          onMove: () => {},
          onFocus: () => {},
          maxWidth: phoneMaxWidth(390),
        }}
      />,
    );
    const svg = screen.getByRole("img", { name: "Task dependency graph" });
    const width = Number(svg.getAttribute("width"));
    expect(width).toBeLessThanOrEqual(PHONE);
    for (const g of container.querySelectorAll<SVGGElement>(".dag-node")) {
      const x = Number(/translate\(([\d.]+),/.exec(g.getAttribute("transform") ?? "")?.[1]);
      expect(x + DAG_NODE_W).toBeLessThanOrEqual(width);
    }
  });

  it("desktop is unchanged: no maxWidth, one row of columns", () => {
    expect(layoutDag(TASKS)).toEqual(layoutDag(TASKS, undefined));
    const l = layoutDag(TASKS);
    expect(new Set(l.nodes.map((n) => n.col)).size).toBe(5);
    expect(l.width).toBe(5 * DAG_NODE_W + 4 * 40 + 8);
    // A graph that already fits is not wrapped either.
    expect(layoutDag(TASKS.slice(0, 2), PHONE)).toEqual(layoutDag(TASKS.slice(0, 2)));
  });
});
