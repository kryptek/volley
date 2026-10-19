import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatWave } from "../src/commands/status";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/** While a parallel stage group runs, the task reads as the group, with both roles' agents. */

const H1 = sha(0x1001);
let h: Harness;
afterEach(() => h?.cleanup());
const review = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

describe("stage group in status", () => {
  it("during [spec_review, quality_review] the stage reads `review (spec + quality)` with both roles", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    const spec = h.run("spec_reviewer")?.agent_id as string;
    const quality = h.run("quality_reviewer")?.agent_id as string;
    const t = h.task();
    expect(t?.stage).toBe("spec_review"); // the closed stage enum is unchanged
    expect(t?.stage_label).toBe("review (spec + quality)");
    expect(t?.stage_group).toEqual([
      { role: "spec_reviewer", agent_id: spec, state: "running" },
      { role: "quality_reviewer", agent_id: quality, state: "running" },
    ]);
    const out = formatWave(h.record().state as never);
    expect(out).toContain("review (spec + quality)");
    expect(out).toContain(`spec_reviewer ${spec} (running)`);
    expect(out).toContain(`quality_reviewer ${quality} (running)`);

    await h.finish("spec_reviewer", { result: review("spec-p1") });
    expect(h.task()?.stage_group?.map((g) => g.state)).toEqual(["done", "running"]);

    await h.finish("quality_reviewer", { result: review("quality-p1-elsewhere") });
    // The fixup is one role: no group.
    expect(h.task()?.stage).toBe("fixup");
    expect(h.task()?.stage_label).toBeUndefined();
    expect(h.task()?.stage_group).toBeUndefined();
  });
});
