import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Tree, footprintOf } from "../src/footprint";
import { sharedFiles } from "../src/overlap";
import { type PlanTask, explain, isBundleFile, planWave } from "../src/overlap-plan";

/**
 * The dogfood batch replayed through the planner: the 26 issues of the replay fixture, their
 * Files lists resolved against the tree by the footprint resolver, must plan to at most 16 tasks.
 */
const read = (f: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/replay/${f}`, import.meta.url), "utf8"));

const issues = read("dogfood-26.json") as {
  id: string;
  issue: number;
  title: string;
  files: string[];
}[];
const tree = read("tree.json") as Tree;

function replayTasks(): PlanTask[] {
  return issues.map((i) => {
    const fp = footprintOf(`## Files\n\n${i.files.map((f) => `- \`${f}\``).join("\n")}\n`, tree);
    return {
      id: i.id,
      issue: i.issue,
      title: i.title,
      files: fp.files,
      footprint: { confidence: fp.confidence },
      after: [],
    };
  });
}

describe("the dogfood replay", () => {
  it("plans the 26 issues to at most 16 tasks, ten or more of them bundled", () => {
    const plan = planWave({ tasks: replayTasks(), tree });
    expect(plan.tasks.length).toBeLessThanOrEqual(16);
    const bundled = plan.tasks.filter((t) => t.issues.length > 1).flatMap((t) => t.issues);
    expect(bundled.length).toBeGreaterThanOrEqual(10);
    // Every issue is planned exactly once.
    expect(plan.tasks.flatMap((t) => t.issues).sort()).toEqual(issues.map((i) => i.issue).sort());
  });

  it("bundles no more than 4 issues or 16 source files (tests aside)", () => {
    const plan = planWave({ tasks: replayTasks(), tree });
    for (const t of plan.tasks) {
      expect(t.issues.length).toBeLessThanOrEqual(4);
      const sources = sharedFiles(t.files, t.files, tree).filter(isBundleFile);
      if (t.issues.length > 1) expect(sources.length).toBeLessThanOrEqual(16);
    }
  });

  it("caps cluster A at 4 in flight and explains it by src/daemon.ts first", () => {
    const plan = planWave({ tasks: replayTasks(), tree });
    const a = plan.clusters.find((c) => c.id === "A");
    expect(a?.strategy.cap).toBe(4);
    expect(a?.hot[0]?.file).toBe("packages/volleyd/src/daemon.ts");
    const lines = explain(plan);
    expect(lines[0]).toMatch(/^cluster A: \d+ tasks share packages\/volleyd\/src\/daemon\.ts \(/);
    expect(lines.at(-1)).toMatch(/^expected branch updates: ≤ \d+ \(was ≤ 25 one at a time\)$/);
  });

  it("is deterministic", () => {
    const a = planWave({ tasks: replayTasks(), tree });
    const b = planWave({ tasks: replayTasks(), tree });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(explain(b)).toEqual(explain(a));
  });
});
