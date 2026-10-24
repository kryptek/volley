import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DAG_ID_CHAR_PX,
  DAG_NODE_W,
  Dag,
  type DagNode,
  fitId,
  layoutDag,
} from "../src/windows/wave/Dag";
import { ACCENT_PALETTE } from "../src/windows/wave/accent";

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
    expect(container.querySelector(".dag-id")?.hasAttribute("fill")).toBe(false);
    expect(container.querySelector("svg.dag")?.getAttribute("style")).toContain("--acc: #fbbf24");
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

describe("Dag task ids that do not fit", () => {
  const LONG = "fix-test-clock-test-ts-sleep-resolves-on-abo";
  const tasks: DagNode[] = [
    { id: "T1", issue: 123, after: [], stage: "implement" },
    { id: LONG, issue: 0, after: ["T1"], stage: "implement", fixerFor: ["T1"] },
  ];

  it("fitId keeps an id that fits and elides a long one as head…tail", () => {
    expect(fitId("T1")).toBe("T1");
    expect(fitId("fix-short-slug")).toBe("fix-short-slug");
    expect(fitId(LONG)).toBe("fix-te…n-abo");
    expect(fitId(LONG).length * DAG_ID_CHAR_PX).toBeLessThanOrEqual(DAG_NODE_W - 20);
  });

  it("draws a long fixer id inside its node, no #0, and the full id in the tooltip", () => {
    const { container } = render(<Dag tasks={tasks} accent="#6ee7f9" />);
    const node = container.querySelector(`.dag-node[data-id="${LONG}"]`) as SVGGElement;
    const id = node.querySelector(".dag-id") as SVGTextElement;
    expect(id.textContent).toBe("fix-te…n-abo");
    expect((id.textContent ?? "").length * DAG_ID_CHAR_PX).toBeLessThanOrEqual(DAG_NODE_W - 20);
    expect(node).not.toHaveTextContent("#0");
    expect(node.querySelector(".dag-fixer")?.textContent).toBe("🔧");
    expect(node.querySelector("title")?.textContent).toContain(LONG);
  });

  it("a normal task keeps its full id and its #issue, on the second line", () => {
    const { container } = render(<Dag tasks={tasks} accent="#6ee7f9" />);
    const node = container.querySelector('.dag-node[data-id="T1"]') as SVGGElement;
    expect(node.querySelector(".dag-id")?.textContent).toBe("T1");
    const issue = node.querySelector(".dag-issue") as SVGTextElement;
    expect(issue).toHaveTextContent("#123");
    expect(issue.getAttribute("y")).toBe(node.querySelector(".dag-stage")?.getAttribute("y"));
  });

  it("a non-fixer task without an issue draws no #0 either", () => {
    const { container } = render(
      <Dag tasks={[{ id: "T9", issue: 0, after: [], stage: "queued" }]} accent="#6ee7f9" />,
    );
    expect(container.querySelector(".dag-node")).not.toHaveTextContent("#0");
  });
});

describe("Dag of a planned wave (#388)", () => {
  const PLANNED: DagNode[] = [
    {
      id: "A1",
      issue: 310,
      after: [],
      stage: "implement",
      cluster: { id: "A", hue: 2, badge: "A · 4/4" },
      bundle: [{ issue: 312, href: "https://github.com/example-org/example-repo/issues/312" }],
      issueHref: "https://github.com/example-org/example-repo/issues/310",
    },
    {
      id: "A2",
      issue: 311,
      after: ["A1"],
      stage: "queued",
      cluster: { id: "A", hue: 2, badge: "A · 4/4" },
    },
    {
      id: "B1",
      issue: 330,
      after: [],
      stage: "queued",
      cluster: { id: "B", hue: 5, badge: "B · hold" },
    },
    {
      id: "B2",
      issue: 331,
      after: ["B1", "A1"],
      stage: "queued",
      cluster: { id: "B", hue: 5, badge: "B · hold" },
      chained: ["B1"],
    },
    { id: "C", issue: 340, after: [], stage: "queued" },
  ];

  it("draws an edge the planner chained dashed, every other edge solid", () => {
    const l = layoutDag(PLANNED);
    expect(l.edges.map((e) => [`${e.from}>${e.to}`, !!e.chained])).toEqual([
      ["A1>A2", false],
      ["B1>B2", true],
      ["A1>B2", false],
    ]);
    const { container } = render(<Dag tasks={PLANNED} accent="#6ee7f9" />);
    const dashed = [...container.querySelectorAll(".dag-edge--chain")];
    expect(dashed).toHaveLength(1);
    expect(container.querySelectorAll(".dag-edge")).toHaveLength(3);
  });

  it("tints each cluster's nodes with one palette hue and badges them with the cluster id", () => {
    const { container } = render(<Dag tasks={PLANNED} accent="#6ee7f9" />);
    const node = (id: string) => container.querySelector(`.dag-node[data-id="${id}"]`) as Element;
    const hull = (id: string) => node(id).querySelector(".dag-hull");
    expect(hull("A1")).toHaveClass("hull-2");
    expect(hull("A2")?.getAttribute("fill")).toBe(ACCENT_PALETTE[2]);
    expect(hull("B1")).toHaveClass("hull-5");
    expect(hull("B1")?.getAttribute("fill")).toBe(ACCENT_PALETTE[5]);
    expect(hull("C")).toBeNull();
    expect(node("A1")).toHaveAttribute("data-cluster", "A");
    expect(node("A1").querySelector(".dag-cluster")?.textContent).toBe("A · 4/4");
    expect(node("B2").querySelector(".dag-cluster")?.textContent).toBe("B · hold");
    expect(node("C").querySelector(".dag-cluster")).toBeNull();
  });

  it("labels a bundle `#310 +1`, links both issues and lists them in the title", () => {
    const { container } = render(<Dag tasks={PLANNED} accent="#6ee7f9" />);
    const n = container.querySelector('.dag-node[data-id="A1"]') as Element;
    expect(n.querySelector(".dag-issue")).toHaveTextContent("#310 +1");
    expect(n.querySelector("title")?.textContent).toContain("#310, #312");
    expect(screen.getByRole("link", { name: "Issue #310 on GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Issue #312 on GitHub" })).toBeInTheDocument();
  });
});
