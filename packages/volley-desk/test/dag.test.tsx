import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dag, type DagNode, layoutDag } from "../src/windows/wave/Dag";

// The epic's example wave file: T0 → T1, T2 → T3.
const EXAMPLE: DagNode[] = [
  { id: "T0", title: "Status chip data contract", after: [], stage: "merged" },
  { id: "T1", title: "Chip mapper", after: ["T0"], stage: "fixup" },
  { id: "T2", title: "Status column", after: ["T0"], stage: "merge_ready" },
  { id: "T3", title: "Detail page badge", after: ["T1", "T2"], stage: "queued" },
];

describe("layoutDag", () => {
  it("puts each task one column right of its deepest dependency", () => {
    const l = layoutDag(EXAMPLE);
    expect(l.cols).toBe(3);
    expect(l.nodes.map((n) => [n.id, n.col, n.row])).toEqual([
      ["T0", 0, 0],
      ["T1", 1, 0],
      ["T2", 1, 1],
      ["T3", 2, 0],
    ]);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["T0>T1", "T0>T2", "T1>T3", "T2>T3"]);
  });

  it("drops edges to tasks outside the wave and survives a cycle", () => {
    const l = layoutDag([
      { id: "A", after: ["B", "ghost"], stage: "queued" },
      { id: "B", after: ["A"], stage: "queued" },
    ]);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges.every((e) => e.from !== "ghost")).toBe(true);
  });
});

describe("Dag", () => {
  it("renders the example graph in 3 columns with 4 edges and stage classes", () => {
    const { container } = render(<Dag nodes={EXAMPLE} />);
    const nodes = [...container.querySelectorAll<HTMLElement>(".dag-node")];
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map((n) => n.dataset.col))).toEqual(new Set(["0", "1", "2"]));
    expect(container.querySelectorAll(".dag-edge")).toHaveLength(4);
    expect(nodes[0]).toHaveClass("dag-node--merged");
    expect(nodes[1]).toHaveClass("dag-node--fixup");
    expect(nodes[2]).toHaveClass("dag-node--merge_ready");
    expect(nodes[3]).toHaveClass("dag-node--queued");
    expect(nodes[1]).toHaveTextContent("T1");
    expect(nodes[1]).toHaveTextContent("fixup");
  });

  it("marks edges out of a merged task as done", () => {
    const { container } = render(<Dag nodes={EXAMPLE} />);
    expect(container.querySelectorAll(".dag-edge--done")).toHaveLength(2);
  });
});
