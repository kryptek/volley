import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dag, type DagNode, layoutDag } from "../src/windows/wave/Dag";

// The epic's example wave file: T0 → T1, T2 → T3.
const EXAMPLE: DagNode[] = [
  { id: "T0", issue: 101, title: "Status chip data contract", after: [], stage: "merged" },
  { id: "T1", issue: 102, title: "Chip mapper", after: ["T0"], stage: "fixup" },
  { id: "T2", issue: 103, title: "Status column", after: ["T0"], stage: "merge_ready" },
  { id: "T3", issue: 104, title: "Detail page badge", after: ["T1", "T2"], stage: "queued" },
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
      { id: "A", issue: 1, after: ["B", "ghost"], stage: "queued" },
      { id: "B", issue: 2, after: ["A"], stage: "queued" },
    ]);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges.every((e) => e.from !== "ghost")).toBe(true);
  });
});

describe("Dag", () => {
  it("renders the example graph in 3 columns with 4 edges and stage classes", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#6ee7f9" />);
    const nodes = [...container.querySelectorAll<SVGGElement>(".dag-node")];
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map((n) => n.dataset.col))).toEqual(new Set(["0", "1", "2"]));
    expect(container.querySelectorAll(".dag-edge")).toHaveLength(4);
    expect(nodes.map((n) => n.getAttribute("class"))).toEqual([
      "dag-node st-merged",
      "dag-node st-fixup",
      "dag-node st-merge_ready",
      "dag-node st-queued",
    ]);
    expect(nodes[1]).toHaveTextContent("T1");
    expect(nodes[1]).toHaveTextContent("fixup");
    expect(nodes[1]).toHaveTextContent("#102");
  });

  it("colours task ids in the wave accent and centres the single-task columns", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#fbbf24" />);
    expect(container.querySelector(".dag-id")?.getAttribute("fill")).toBe("#fbbf24");
    const [t0, t1, t2, t3] = layoutDag(EXAMPLE).nodes.map((n) => n.y);
    expect(t0).toBe(((t1 ?? 0) + (t2 ?? 0)) / 2);
    expect(t3).toBe(t0);
  });
});

describe("Dag issue links", () => {
  const HREF = "https://github.com/example-org/example-repo/issues/101";
  const linked: DagNode[] = [
    { id: "T0", issue: 101, after: [], stage: "merged", issueHref: HREF },
    { id: "T1", issue: 102, after: ["T0"], stage: "queued" },
  ];

  it("a node with issueHref links its corner label; one without keeps the bare text", () => {
    const { container } = render(<Dag tasks={linked} accent="#6ee7f9" />);
    const a = screen.getByRole("link", { name: "Issue #101 on GitHub" });
    expect(a).toHaveClass("dag-issue-link");
    expect(a).toHaveAttribute("href", HREF);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.querySelector("text.dag-issue")).toHaveTextContent("#101");
    expect(Number(a.getAttribute("tabindex") ?? "0")).toBeGreaterThanOrEqual(0);
    const t1 = container.querySelector('.dag-node[data-id="T1"]') as Element;
    expect(t1.querySelector("a")).toBeNull();
    expect(t1.querySelector("text.dag-issue")).toHaveTextContent("#102");
  });

  it("a click on the link never reaches a click handler around the node", () => {
    const onClick = vi.fn();
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: a test probe for click propagation
      <div onClick={onClick}>
        <Dag tasks={linked} accent="#6ee7f9" />
      </div>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Issue #101 on GitHub" }));
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("#102"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
