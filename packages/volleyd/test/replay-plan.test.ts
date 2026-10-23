import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FootprintConfidence } from "../src/footprint";
import {
  type PlanTask,
  type Tree,
  explain,
  isBundleFile,
  planWave,
  sharedFiles,
} from "../src/overlap-plan";

/**
 * The dogfood batch replayed through the planner: the 26 issues of the replay fixture, their
 * Files lists resolved against the tree by the footprint resolver when it is present (else taken
 * as given, every one `listed`), must plan to at most 16 tasks.
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

type FootprintOf = (
  body: string,
  tree: Tree,
) => { files: string[]; confidence: FootprintConfidence; unresolved?: string[] };

async function resolver(): Promise<FootprintOf | null> {
  const mod = (await import("../src/footprint")) as Record<string, unknown>;
  return typeof mod.footprintOf === "function" ? (mod.footprintOf as FootprintOf) : null;
}

async function replayTasks(): Promise<PlanTask[]> {
  const footprintOf = await resolver();
  return issues.map((i) => {
    if (footprintOf === null) {
      return {
        id: i.id,
        issue: i.issue,
        title: i.title,
        files: i.files,
        footprint: { confidence: "listed" },
        after: [],
      };
    }
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
  it("plans the 26 issues to at most 16 tasks, ten or more of them bundled", async () => {
    const plan = planWave({ tasks: await replayTasks(), tree });
    expect(plan.tasks.length).toBeLessThanOrEqual(16);
    const bundled = plan.tasks.filter((t) => t.issues.length > 1).flatMap((t) => t.issues);
    expect(bundled.length).toBeGreaterThanOrEqual(10);
    // Every issue is planned exactly once.
    expect(plan.tasks.flatMap((t) => t.issues).sort()).toEqual(issues.map((i) => i.issue).sort());
  });

  it("bundles no more than 4 issues or 16 source files (tests aside)", async () => {
    const plan = planWave({ tasks: await replayTasks(), tree });
    for (const t of plan.tasks) {
      expect(t.issues.length).toBeLessThanOrEqual(4);
      const sources = sharedFiles(t.files, t.files, tree).filter(isBundleFile);
      if (t.issues.length > 1) expect(sources.length).toBeLessThanOrEqual(16);
    }
  });

  it("caps cluster A at 4 in flight and explains it by src/daemon.ts first", async () => {
    const plan = planWave({ tasks: await replayTasks(), tree });
    const a = plan.clusters.find((c) => c.id === "A");
    expect(a?.strategy.cap).toBe(4);
    expect(a?.hot[0]?.file).toBe("packages/volleyd/src/daemon.ts");
    const lines = explain(plan);
    expect(lines[0]).toMatch(/^cluster A: \d+ tasks share packages\/volleyd\/src\/daemon\.ts \(/);
    expect(lines.at(-1)).toMatch(/^expected branch updates: ≤ \d+ \(was ≤ 25 one at a time\)$/);
  });

  it("is deterministic", async () => {
    const a = planWave({ tasks: await replayTasks(), tree });
    const b = planWave({ tasks: await replayTasks(), tree });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(explain(b)).toEqual(explain(a));
  });
});
