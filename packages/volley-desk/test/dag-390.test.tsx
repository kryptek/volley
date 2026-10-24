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

  it("an edge into a later band never runs through another node", () => {
    for (const graph of [TASKS, CHAIN]) {
      const l = layoutDag(graph, PHONE);
      for (const e of l.edges) {
        for (const n of l.nodes) {
          if (n.id === e.from || n.id === e.to) continue;
          for (const [x, y] of samplePath(e.d)) {
            const through =
              x > n.x + 1 && x < n.x + DAG_NODE_W - 1 && y > n.y + 1 && y < n.y + DAG_NODE_H - 1;
            expect(through, `${e.from}>${e.to} crosses ${n.id} at ${x},${y}`).toBe(false);
          }
        }
        for (const [x] of samplePath(e.d)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(l.width);
        }
      }
    }
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
    const box = screen.getByRole("group", { name: "Task dependency graph" });
    const width = Number.parseFloat(box.style.width);
    expect(width).toBeLessThanOrEqual(PHONE);
    for (const n of container.querySelectorAll<HTMLElement>(".dag-node")) {
      expect(Number.parseFloat(n.style.left) + DAG_NODE_W).toBeLessThanOrEqual(width);
    }
  });

  it("desktop is unchanged: no maxWidth, one row of columns", () => {
    const l = layoutDag(TASKS);
    // The pre-wrap layout's positions: 172 px per column, a one-task column centred.
    const pos = (id: string) => l.nodes.find((n) => n.id === id);
    expect(pos("T1")).toMatchObject({ x: 4, y: 33 });
    expect(pos("T2")).toMatchObject({ x: 176, y: 4 });
    expect(pos("T3")).toMatchObject({ x: 176, y: 62 });
    expect(pos("T7")).toMatchObject({ x: 692, y: 33 });
    expect(l.height).toBe(110);
    expect(new Set(l.nodes.map((n) => n.col)).size).toBe(5);
    expect(l.width).toBe(5 * DAG_NODE_W + 4 * 40 + 8);
    // A graph that already fits is not wrapped either.
    expect(layoutDag(TASKS.slice(0, 2), PHONE)).toEqual(layoutDag(TASKS.slice(0, 2)));
  });
});

/** Points along an SVG path of M / L / H / V / C commands (absolute), for hit tests. */
function samplePath(d: string): [number, number][] {
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  const steps = 24;
  for (const [, cmd, args] of d.matchAll(/([MLHVC])([^MLHVC]*)/g)) {
    const n = (args ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const line = (x2: number, y2: number) => {
      for (let i = 1; i <= steps; i++)
        out.push([x + ((x2 - x) * i) / steps, y + ((y2 - y) * i) / steps]);
      x = x2;
      y = y2;
    };
    if (cmd === "M") {
      x = n[0] ?? 0;
      y = n[1] ?? 0;
      out.push([x, y]);
    } else if (cmd === "L") line(n[0] ?? 0, n[1] ?? 0);
    else if (cmd === "H") line(n[0] ?? 0, y);
    else if (cmd === "V") line(x, n[0] ?? 0);
    else if (cmd === "C") {
      const [ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0] = n;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        out.push([
          u * u * u * x + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * cx,
          u * u * u * y + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * cy,
        ]);
      }
      x = cx;
      y = cy;
    }
  }
  return out;
}
