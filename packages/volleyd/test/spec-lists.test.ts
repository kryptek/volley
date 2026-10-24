import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DECISION_KINDS } from "../src/decisions";
import { WAVE_EVENT_TYPES } from "../src/types";

/**
 * SPEC.md lists the decision kinds and wave events one per line, and `bun run check:spec-refs`
 * checks those lists against the schemas. These tie the daemon's own lists to the same schemas.
 */
const SCHEMAS = path.resolve(__dirname, "../../../spec/schemas");
const json = (f: string) => JSON.parse(readFileSync(path.join(SCHEMAS, f), "utf8"));

describe("the daemon's enums match the schemas", () => {
  it("WAVE_EVENT_TYPES is wave-event.schema.json's type enum", () => {
    const schema = json("wave-event.schema.json").allOf[1].properties.type.enum;
    expect([...WAVE_EVENT_TYPES].sort()).toEqual([...schema].sort());
  });

  it("DECISION_KINDS is decision.schema.json's payload.kind enum", () => {
    const schema = json("decision.schema.json").allOf[1].properties.payload.properties.kind.enum;
    expect([...DECISION_KINDS].sort()).toEqual([...schema].sort());
  });
});

describe("machine roles (SPEC §4.6.24)", () => {
  it("WAVE_EVENT_TYPES carries the record's and the moves' events", () => {
    for (const t of [
      "roles_changed",
      "role_move_started",
      "role_move_step",
      "role_move_completed",
      "role_move_failed",
      "role_rolled_back",
    ])
      expect(WAVE_EVENT_TYPES).toContain(t);
  });
});
