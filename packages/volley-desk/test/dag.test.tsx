import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DAG_FIXER_PX,
  DAG_ID_CHAR_PX,
  DAG_ISSUE_CHAR_PX,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_STAGE_CHAR_PX,
  Dag,
  type DagNode,
  fitId,
  fitStatus,
  layoutDag,
  stageState,
} from "../src/windows/wave/Dag";
import { ACCENT_PALETTE } from "../src/windows/wave/accent";
import { DESK_STAGES, type DeskStage, STAGE_LABEL } from "../src/windows/wave/stages";

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
    const nodes = [...container.querySelectorAll<HTMLElement>(".dag-node")];
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map((n) => n.dataset.col))).toEqual(new Set(["0", "1", "2"]));
    expect(container.querySelectorAll("svg.dag-edges path.dag-edge")).toHaveLength(4);
    expect(nodes.map((n) => n.getAttribute("class"))).toEqual([
      "dag-node st-merged fx-done",
      "dag-node st-fixup fx-cur",
      "dag-node st-merge_ready fx-cur",
      "dag-node st-queued fx-future",
    ]);
    expect(nodes[1]).toHaveTextContent("T1");
    expect(nodes[1]).toHaveTextContent("fixup");
    expect(nodes[1]).toHaveTextContent("#102");
  });

  it("colours task ids in the wave accent and centres the single-task columns", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#fbbf24" />);
    expect(container.querySelector(".dag-id")?.hasAttribute("style")).toBe(false);
    expect(container.querySelector("div.dag")?.getAttribute("style")).toContain("--acc: #fbbf24");
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
    expect(a).toHaveTextContent("#101");
    expect(Number(a.getAttribute("tabindex") ?? "0")).toBeGreaterThanOrEqual(0);
    const t1 = container.querySelector('.dag-node[data-id="T1"]') as Element;
    expect(t1.querySelector("a")).toBeNull();
    expect(t1.querySelector("span.dag-issue")).toHaveTextContent("#102");
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
    const node = container.querySelector(`.dag-node[data-id="${LONG}"]`) as HTMLElement;
    const id = node.querySelector(".dag-id") as HTMLElement;
    expect(id.textContent).toBe("fix-te…n-abo");
    expect((id.textContent ?? "").length * DAG_ID_CHAR_PX).toBeLessThanOrEqual(DAG_NODE_W - 20);
    expect(node).not.toHaveTextContent("#0");
    expect(node.querySelector(".dag-fixer")?.textContent).toBe("🔧");
    expect(node.querySelector(".dag-fixer")).toHaveAttribute("aria-hidden", "true");
    expect(node.getAttribute("title")).toContain(LONG);
  });

  it("a normal task keeps its full id and its #issue, on the second line", () => {
    const { container } = render(<Dag tasks={tasks} accent="#6ee7f9" />);
    const node = container.querySelector('.dag-node[data-id="T1"]') as HTMLElement;
    expect(node.querySelector(".dag-id")?.textContent).toBe("T1");
    const issue = node.querySelector(".dag-issue") as HTMLElement;
    expect(issue).toHaveTextContent("#123");
    // The issue follows the stage: the node's grid puts both on its second line.
    expect(issue.previousElementSibling).toHaveClass("dag-stage");
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
    // The hull is the node's sibling, behind it: the depth states clip what a node holds.
    const hull = (id: string) =>
      container.querySelector<HTMLElement>(`.dag > .dag-hull[data-for="${id}"]`);
    expect(hull("A1")).toHaveClass("hull-2");
    expect(hull("A2")?.style.getPropertyValue("--hue")).toBe(ACCENT_PALETTE[2]);
    expect(hull("B1")).toHaveClass("hull-5");
    expect(hull("B1")?.style.getPropertyValue("--hue")).toBe(ACCENT_PALETTE[5]);
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
    expect(n.getAttribute("title")).toContain("#310, #312");
    expect(screen.getByRole("link", { name: "Issue #310 on GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Issue #312 on GitHub" })).toBeInTheDocument();
  });
});

describe("stageState", () => {
  const LIVE: Record<DeskStage, ReturnType<typeof stageState>> = {
    merged: "done",
    implement: "cur",
    review: "cur",
    fixup: "cur",
    merge_ready: "cur",
    queued: "future",
    decision: null,
  };
  for (const stage of DESK_STAGES) {
    it(`${stage}: ${LIVE[stage] ?? "no state"}`, () => {
      expect(stageState(stage, false, false)).toBe(LIVE[stage]);
    });
    it(`${stage}, cancelled: no state`, () => {
      expect(stageState(stage, true, false)).toBeNull();
    });
    it(`${stage}, the wave ended: no state`, () => {
      expect(stageState(stage, false, true)).toBeNull();
      expect(stageState(stage, true, true)).toBeNull();
    });
  }
});

describe("Dag nodes are HTML with the depth states (#367)", () => {
  it("places each node at its layout x / y over one SVG edge layer", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#6ee7f9" />);
    const l = layoutDag(EXAMPLE);
    const box = screen.getByRole("group", { name: "Task dependency graph" });
    expect(box.tagName).toBe("DIV");
    expect(box.style.width).toBe(`${l.width}px`);
    expect(box.style.height).toBe(`${l.height}px`);
    const edges = box.querySelector("svg.dag-edges") as SVGSVGElement;
    expect(edges).toHaveAttribute("aria-hidden", "true");
    expect([...edges.querySelectorAll("path.dag-edge")].map((p) => p.getAttribute("d"))).toEqual(
      l.edges.map((e) => e.d),
    );
    for (const n of l.nodes) {
      const el = container.querySelector<HTMLElement>(`div.dag-node[data-id="${n.id}"]`);
      expect(el?.style.left).toBe(`${n.x}px`);
      expect(el?.style.top).toBe(`${n.y}px`);
      expect(el?.style.width).toBe(`${DAG_NODE_W}px`);
      expect(el?.style.height).toBe(`${DAG_NODE_H}px`);
    }
  });

  it("the id is real text, and no running node claims aria-current", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#6ee7f9" />);
    const t1 = container.querySelector('.dag-node[data-id="T1"]') as HTMLElement;
    expect(t1.querySelector("b.dag-id")).toHaveTextContent("T1");
    expect(t1).toHaveTextContent("T1fixup#102");
    expect(t1).toHaveClass("fx-cur");
    expect(container.querySelector("[aria-current]")).toBeNull();
  });

  it("a cancelled or decision node keeps its own look, no depth state", () => {
    const { container } = render(
      <Dag
        tasks={[
          { id: "D", issue: 1, after: [], stage: "decision" },
          { id: "X", issue: 2, after: [], stage: "implement", cancelled: true },
        ]}
        accent="#6ee7f9"
      />,
    );
    const cls = (id: string) =>
      container.querySelector(`.dag-node[data-id="${id}"]`)?.getAttribute("class");
    expect(cls("D")).toBe("dag-node st-decision");
    expect(cls("X")).toBe("dag-node st-cancelled");
  });

  it("an ended wave's nodes are flat: no fx-* class anywhere", () => {
    const { container } = render(<Dag tasks={EXAMPLE} accent="#6ee7f9" ended />);
    expect(container.querySelector(".dag")).toHaveClass("dag--ended");
    expect(container.querySelector('[class*="fx-"]')).toBeNull();
  });
});

describe("Dag statuses that do not fit (#489)", () => {
  const corner = (issue: number) => `#${issue}`.length * DAG_ISSUE_CHAR_PX;
  const GAP = 4;

  it("fitStatus keeps a short status and cuts a long one clear of the corner label", () => {
    expect(fitStatus("implementing", corner(386))).toBe("implementing");
    const cut = fitStatus("waiting for CI · 12/17", corner(386));
    expect(cut.endsWith("…")).toBe(true);
    // The ellipsis counts as two characters' width.
    expect((cut.length + 1) * DAG_STAGE_CHAR_PX + GAP).toBeLessThanOrEqual(
      DAG_NODE_W - 20 - corner(386),
    );
    // No corner label: the full 112 px.
    const max = Math.floor((DAG_NODE_W - 20) / DAG_STAGE_CHAR_PX);
    expect(fitStatus("x".repeat(max), 0)).toBe("x".repeat(max));
    expect(fitStatus("x".repeat(max + 1), 0).endsWith("…")).toBe(true);
  });

  it("cuts a long status on the node, keeps CI · 12/17 whole, and puts the full line in the title", () => {
    const { container } = render(
      <Dag
        tasks={[
          { id: "T1", issue: 386, title: "Desk polish", after: [], stage: "implement" },
          { id: "T2", issue: 12345, after: [], stage: "implement" },
        ]}
        accent="#6ee7f9"
        labels={{ T1: "waiting for CI · 12/17", T2: "CI · 12/17" }}
        status={{ T1: "waiting for CI · 12/17 jobs", T2: "waiting for CI · 12/17 jobs" }}
      />,
    );
    const node = (id: string) => container.querySelector(`.dag-node[data-id="${id}"]`) as Element;
    const stage = (id: string) => node(id).querySelector(".dag-stage")?.textContent ?? "";
    expect(stage("T1").endsWith("…")).toBe(true);
    expect((stage("T1").length + 1) * DAG_STAGE_CHAR_PX + GAP).toBeLessThanOrEqual(
      DAG_NODE_W - 20 - corner(386),
    );
    expect(stage("T2")).toBe("CI · 12/17");
    expect(node("T1").getAttribute("title")).toBe("T1 · Desk polish · waiting for CI · 12/17 jobs");
    expect(node("T2").getAttribute("title")).toBe("T2 · waiting for CI · 12/17 jobs");
  });

  it("every node string the graph can show fits beside a 4-digit issue untouched", () => {
    for (const s of [
      ...Object.values(STAGE_LABEL),
      "CI · 21/22",
      "CI pending",
      "merge turn",
      "decision",
      "merging",
      "updating",
      "merged",
      "cancelled",
      "implementing",
      "reviewing",
      "fixing",
      "rebasing",
    ]) {
      expect(fitStatus(s, corner(9999))).toBe(s);
    }
  });

  it("a fixer's status is budgeted against its wrench", () => {
    expect(fitStatus("waiting for CI · 12/17", DAG_FIXER_PX).endsWith("…")).toBe(true);
    const { container } = render(
      <Dag
        tasks={[{ id: "F", issue: 0, after: [], stage: "implement", fixerFor: ["T1"] }]}
        accent="#6ee7f9"
        labels={{ F: "waiting for CI · 12/17" }}
      />,
    );
    expect(container.querySelector(".dag-stage")?.textContent?.endsWith("…")).toBe(true);
    expect(container.querySelector(".dag-node")?.getAttribute("title")).toBe(
      "F · fixer for T1 · waiting for CI · 12/17",
    );
  });
});
