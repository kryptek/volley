import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Stage } from "../src/store/types";
import {
  DESK_STAGES,
  type DeskStage,
  STAGE_LABEL,
  STAGE_WEIGHT,
  deskStage,
  wavePct,
} from "../src/windows/wave/stages";

const schemaPath = path.resolve(__dirname, "../../../spec/schemas/wave-state.schema.json");
const schemaStages: Stage[] = JSON.parse(readFileSync(schemaPath, "utf8")).$defs.stage.enum;

describe("deskStage", () => {
  it.each(schemaStages)("maps the wave-state enum value %s onto the desk stage set", (s) => {
    expect(DESK_STAGES).toContain(deskStage(s));
  });

  it("collapses the parallel reviews and maps terminal and human-wait stages", () => {
    expect(deskStage("spec_review")).toBe("review");
    expect(deskStage("quality_review")).toBe("review");
    expect(deskStage("done")).toBe("merged");
    expect(deskStage("awaiting_decision")).toBe("decision");
    expect(deskStage("blocked")).toBe("decision");
    expect(deskStage("merge_ready")).toBe("merge_ready");
  });

  it("falls back to queued for a stage the desk does not know yet", () => {
    expect(deskStage("rebasing" as Stage)).toBe("queued");
  });
});

describe("STAGE_LABEL / STAGE_WEIGHT", () => {
  it("cover every desk stage, queued weighs 0 and merged weighs 1", () => {
    for (const s of DESK_STAGES) {
      expect(STAGE_LABEL[s]).toBeTruthy();
      expect(STAGE_WEIGHT[s]).toBeGreaterThanOrEqual(0);
      expect(STAGE_WEIGHT[s]).toBeLessThanOrEqual(1);
    }
    expect(STAGE_WEIGHT.queued).toBe(0);
    expect(STAGE_WEIGHT.merged).toBe(1);
  });
});

describe("wavePct", () => {
  it("is the mean stage weight as a whole percentage", () => {
    const stages: DeskStage[] = ["merged", "queued"];
    expect(wavePct(stages)).toBe(50);
    expect(wavePct(["merged", "merged"])).toBe(100);
  });

  it("is 0 for a wave with no tasks", () => {
    expect(wavePct([])).toBe(0);
  });
});
