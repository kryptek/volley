import { describe, expect, it } from "vitest";
import type { Tree } from "../src/footprint";
import { sharedFiles } from "../src/overlap";
import { type PlanTask, coupling, diffPlan, explain, planWave } from "../src/overlap-plan";
import type { FootprintConfidence } from "../src/types";

const TREE: Tree = {
  "src/a.ts": 10_000,
  "src/big.ts": 30_000,
  "src/b.ts": 2_000,
  "src/c.ts": 2_000,
  "src/d.ts": 2_000,
  "src/e.ts": 2_000,
  "src/f.ts": 2_000,
  "src/dock/x.ts": 4_000,
  "src/dock/y.ts": 6_000,
  "README.md": 5_000,
  "changes/README.md": 3_000,
  "spec/examples/valid/x.json": 9_000,
};

function task(
  issue: number,
  files: string[],
  o: { after?: string[]; confidence?: FootprintConfidence; title?: string } = {},
): PlanTask {
  return {
    id: `i${issue}`,
    issue,
    title: o.title ?? `issue ${issue}`,
    files,
    footprint: { confidence: o.confidence ?? "listed" },
    after: o.after ?? [],
  };
}

const byId = (plan: ReturnType<typeof planWave>, id: string) => plan.tasks.find((t) => t.id === id);

describe("weights and coupling", () => {
  it("is the shared source bytes over the smaller task's source bytes", () => {
    // Two 12 kB tasks sharing one 10 kB file.
    expect(coupling(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/c.ts"], TREE)).toBeCloseTo(
      0.833,
      3,
    );
    // A 40 kB and a 12 kB task: the min is the 12 kB one.
    expect(coupling(["src/a.ts", "src/big.ts"], ["src/a.ts", "src/c.ts"], TREE)).toBeCloseTo(
      0.833,
      3,
    );
  });

  it("weighs a shared doc at 0.2 and never counts changes/** or spec/examples/**", () => {
    const base = coupling(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/c.ts"], TREE);
    expect(
      coupling(
        ["src/a.ts", "src/b.ts", "changes/README.md", "spec/examples/valid/x.json"],
        ["src/a.ts", "src/c.ts", "changes/README.md", "spec/examples/valid/x.json"],
        TREE,
      ),
    ).toBe(base);
    expect(
      coupling(["src/a.ts", "src/b.ts", "README.md"], ["src/a.ts", "src/c.ts", "README.md"], TREE),
    ).toBeCloseTo((10_000 + 0.2 * 5_000) / 12_000, 6);
  });

  it("is 0 when either side has no source bytes", () => {
    expect(coupling(["README.md"], ["README.md", "src/a.ts"], TREE)).toBe(0);
  });

  it("matches a glob or a directory against the tree", () => {
    expect(sharedFiles(["src/dock/*"], ["src/dock/y.ts", "src/b.ts"], TREE)).toEqual([
      "src/dock/y.ts",
    ]);
    expect(sharedFiles(["src/dock/"], ["src/dock/**"], TREE)).toEqual([
      "src/dock/x.ts",
      "src/dock/y.ts",
    ]);
    expect(sharedFiles(["src/*.ts"], ["src/new.ts"], TREE)).toEqual(["src/new.ts"]);
  });
});

describe("planWave: collapse", () => {
  it("bundles two strongly coupled 12 kB tasks", () => {
    const plan = planWave({
      tasks: [task(312, ["src/a.ts", "src/c.ts"]), task(310, ["src/a.ts", "src/b.ts"])],
      tree: TREE,
    });
    expect(plan.tasks).toHaveLength(1);
    const b = plan.tasks[0];
    expect(b?.id).toBe("i310");
    expect(b?.issue).toBe(310);
    expect(b?.issues).toEqual([310, 312]);
    expect(b?.title).toBe("bundle: #310 + #312 — issue 310");
    expect(b?.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(b?.plan).toMatchObject({ cluster: "A", by: "collapse" });
    expect(b?.plan.why).toContain("0.83");
    expect(plan.clusters).toEqual([
      expect.objectContaining({
        id: "A",
        tasks: ["i310"],
        strategy: { collapse: [["i310", "i312"]] },
        state: "planned",
      }),
    ]);
  });

  it("bundles a 40 kB and a 12 kB task on the smaller one's coupling", () => {
    const plan = planWave({
      tasks: [task(1, ["src/a.ts", "src/big.ts"]), task(2, ["src/a.ts", "src/c.ts"])],
      tree: TREE,
    });
    expect(plan.tasks.map((t) => t.issues)).toEqual([[1, 2]]);
  });

  it("chains the fifth issue of a bundle that would reach 5", () => {
    const own = ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    const plan = planWave({
      tasks: own.map((f, n) => task(n + 1, ["src/a.ts", f])),
      tree: TREE,
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(["i1", "i5"]);
    expect(byId(plan, "i1")?.issues).toEqual([1, 2, 3, 4]);
    expect(byId(plan, "i5")?.after).toEqual(["i1"]);
    expect(byId(plan, "i5")?.plan.by).toBe("chain");
    expect(byId(plan, "i5")?.plan.why).toMatch(/after i1.*4 issues/);
    expect(plan.clusters[0]?.strategy).toEqual({
      collapse: [["i1", "i2", "i3", "i4"]],
      chain: [["i1", "i5"]],
    });
  });

  it("does not bundle a task whose footprint is only guessed", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/big.ts"], { confidence: "guessed" }),
        task(2, ["src/a.ts", "src/c.ts"]),
      ],
      tree: TREE,
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(["i1", "i2"]);
    // The task with more source bytes goes first.
    expect(byId(plan, "i2")?.after).toEqual(["i1"]);
    expect(byId(plan, "i1")?.plan.by).toBe("chain");
    expect(byId(plan, "i1")?.plan.why).toContain("before i2");
  });

  it("keeps declared after through a collapse and re-points dependents to the bundle", () => {
    const plan = planWave({
      tasks: [
        task(9, ["src/dock/x.ts"]),
        task(10, ["src/a.ts", "src/b.ts"], { after: ["i9"] }),
        task(12, ["src/a.ts", "src/c.ts"]),
        task(20, ["src/f.ts"], { after: ["i12"] }),
      ],
      tree: TREE,
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(["i9", "i10", "i20"]);
    expect(byId(plan, "i10")?.after).toEqual(["i9"]);
    expect(byId(plan, "i20")?.after).toEqual(["i10"]);
  });

  it("drops a member's after on another member of its bundle", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/b.ts"]),
        task(2, ["src/a.ts", "src/c.ts"], { after: ["i1"] }),
      ],
      tree: TREE,
    });
    expect(plan.tasks.map((t) => [t.id, t.after])).toEqual([["i1", []]]);
  });

  it("does not bundle a pair a declared task sits between", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/b.ts"]),
        task(2, ["src/dock/x.ts"], { after: ["i1"] }),
        task(3, ["src/a.ts", "src/c.ts"], { after: ["i2"] }),
      ],
      tree: TREE,
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(["i1", "i2", "i3"]);
    expect(byId(plan, "i3")?.after).toEqual(["i2"]);
  });
});

describe("planWave: chains, independents and caps", () => {
  it("adds no chain against a declared after, and says the after already orders them", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/big.ts"], { confidence: "guessed", after: ["i2"] }),
        task(2, ["src/a.ts", "src/c.ts"], { confidence: "guessed" }),
      ],
      tree: TREE,
    });
    expect(byId(plan, "i1")?.after).toEqual(["i2"]);
    expect(byId(plan, "i2")?.after).toEqual([]);
    expect(byId(plan, "i2")?.plan.why).toContain("a declared after already runs i2 before i1");
    expect(byId(plan, "i2")?.plan.why).not.toContain("parallel");
    expect(plan.clusters[0]?.strategy.chain).toBeUndefined();
  });

  it("makes no cluster of two tasks sharing only README.md", () => {
    const plan = planWave({
      tasks: [task(1, ["src/b.ts", "README.md"]), task(2, ["src/c.ts", "README.md"])],
      tree: TREE,
    });
    expect(plan.clusters).toEqual([]);
    expect(plan.tasks.map((t) => t.plan)).toEqual([
      { by: "independent", why: "shares no source file" },
      { by: "independent", why: "shares no source file" },
    ]);
  });

  it("counts nothing for a shared changes/README.md", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/b.ts", "changes/README.md"]),
        task(2, ["src/c.ts", "changes/README.md"]),
      ],
      tree: TREE,
    });
    expect(plan.clusters).toEqual([]);
  });

  it("puts a task with no footprint on its own, with the why", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/b.ts"]),
        task(2, ["src/a.ts", "src/c.ts"], { confidence: "none" }),
      ],
      tree: TREE,
    });
    expect(plan.clusters).toEqual([]);
    expect(byId(plan, "i2")?.plan).toEqual({ by: "independent", why: "no footprint" });
  });

  it("caps a loose 9-task cluster at 4 in flight", () => {
    const tree: Tree = { "src/shared.ts": 1_000 };
    const tasks = Array.from({ length: 9 }, (_, n) => {
      tree[`src/own${n}.ts`] = 10_000;
      return task(n + 1, ["src/shared.ts", `src/own${n}.ts`]);
    });
    const plan = planWave({ tasks, tree });
    expect(plan.tasks).toHaveLength(9);
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]?.strategy).toEqual({ cap: 4 });
    expect(plan.clusters[0]?.hot).toEqual([
      { file: "src/shared.ts", bytes: 1_000, shared_by: tasks.map((t) => t.id) },
    ]);
    expect(plan.tasks.every((t) => t.plan.by === "cap" && t.plan.cluster === "A")).toBe(true);
  });

  it("runs a small loose cluster in parallel", () => {
    const tree: Tree = { "src/shared.ts": 1_000, "src/x.ts": 10_000, "src/y.ts": 10_000 };
    const plan = planWave({
      tasks: [task(1, ["src/shared.ts", "src/x.ts"]), task(2, ["src/shared.ts", "src/y.ts"])],
      tree,
    });
    expect(plan.clusters[0]?.strategy).toEqual({});
    expect(plan.tasks.map((t) => t.plan.by)).toEqual(["independent", "independent"]);
    expect(plan.tasks[0]?.plan.cluster).toBe("A");
  });

  it("names clusters by size, then by lowest issue", () => {
    const tree: Tree = { "s/p.ts": 100, "s/q.ts": 100, "s/r.ts": 100 };
    const loose = (issue: number, f: string) => task(issue, [f, `s/own${issue}.ts`]);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) tree[`s/own${n}.ts`] = 10_000;
    const plan = planWave({
      tasks: [
        loose(5, "s/q.ts"),
        loose(6, "s/q.ts"),
        loose(1, "s/p.ts"),
        loose(2, "s/p.ts"),
      ].concat([loose(3, "s/r.ts"), loose(4, "s/r.ts"), loose(7, "s/r.ts")]),
      tree,
    });
    expect(plan.clusters.map((c) => [c.id, c.tasks])).toEqual([
      ["A", ["i3", "i4", "i7"]],
      ["B", ["i1", "i2"]],
      ["C", ["i5", "i6"]],
    ]);
  });
});

describe("explain", () => {
  it("writes one line per cluster, the independents, then the expected branch updates", () => {
    const tree: Tree = {
      "src/hot.ts": 440_000,
      "src/x.ts": 480_000,
      "src/b.ts": 2_000,
      "src/c.ts": 2_000,
    };
    const tasks = Array.from({ length: 6 }, (_, n) => {
      tree[`src/own${n}.ts`] = 4_000_000;
      return task(n + 1, ["src/hot.ts", `src/own${n}.ts`]);
    });
    tasks.push(task(7, ["src/hot.ts", "src/x.ts", "src/b.ts"]));
    tasks.push(task(8, ["src/hot.ts", "src/x.ts", "src/c.ts"]));
    tasks.push(task(9, ["src/z.ts"]), task(10, ["README.md"]));
    const plan = planWave({ tasks, tree });
    expect(explain(plan)).toEqual([
      "cluster A: 8 tasks share src/hot.ts (11k lines, 8 tasks), src/x.ts (12k lines, 2 tasks) → 1 bundle (i7+i8), cap 4 in flight",
      "independent: i9, i10",
      "expected branch updates: ≤ 2 (was ≤ 9 one at a time)",
    ]);
  });

  it("names the chains", () => {
    const plan = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/big.ts"], { confidence: "guessed" }),
        task(2, ["src/a.ts", "src/c.ts"]),
      ],
      tree: TREE,
    });
    expect(explain(plan)).toEqual([
      "cluster A: 2 tasks share src/a.ts (250 lines, 2 tasks) → 1 chain (i1 → i2)",
      "expected branch updates: ≤ 2 (was ≤ 1 one at a time)",
    ]);
  });
});

describe("diffPlan", () => {
  const tasks = [
    task(1, ["src/a.ts", "src/big.ts"], { confidence: "guessed" }),
    task(2, ["src/a.ts", "src/c.ts"]),
    task(3, ["src/a.ts", "src/d.ts"]),
    task(4, ["src/b.ts"]),
  ];
  const plan = planWave({ tasks, tree: TREE });

  it("is empty when the wave file is what the planner wrote", () => {
    expect(diffPlan(plan.tasks, plan)).toEqual([]);
  });

  it("notes a bundle the file splits, a chain it drops and a plan it rewrites", () => {
    const file = [
      { id: "i1", issue: 1, after: [] },
      { id: "i2", issue: 2, after: [] },
      { id: "i3", issue: 3, after: [] },
      { id: "i4", issue: 4, after: [], plan: { by: "cap" as const } },
    ];
    expect(diffPlan(file, plan)).toEqual([
      "i2 and i3 run as separate tasks; the planner would bundle them as i2 — kept as written",
      "i1 and i2 share src/a.ts and run in parallel; the planner would chain them — kept as written",
      "i4 is planned by cap; the planner would plan it independent — kept as written",
    ]);
  });

  it("names the paths a glob shares in a dropped chain", () => {
    const globbed = planWave({
      tasks: [
        task(1, ["src/a.ts", "src/big.ts"], { confidence: "guessed" }),
        task(2, ["src/*.ts", "src/c.ts"]),
      ],
      tree: TREE,
    });
    expect(globbed.clusters[0]?.strategy.chain).toEqual([["i2", "i1"]]);
    expect(
      diffPlan(
        [
          { id: "i1", issue: 1, after: [] },
          { id: "i2", issue: 2, after: [] },
        ],
        globbed,
      ),
    ).toEqual([
      "i2 and i1 share src/a.ts, src/big.ts and run in parallel; the planner would chain them — kept as written",
    ]);
  });

  it("notes a bundle the planner would not make", () => {
    const file = [
      { id: "i1", issue: 1, issues: [1, 4], after: [] },
      { id: "i2", issue: 2, issues: [2, 3], after: ["i1"] },
    ];
    expect(diffPlan(file, plan)).toEqual([
      "i1 bundles #1 + #4; the planner would not — kept as written",
    ]);
  });
});
