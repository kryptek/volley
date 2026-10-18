import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACKABLE_TYPES } from "../src/lib/drain";

describe("ACKABLE_TYPES", () => {
  it("is exactly mailbox.schema.json's acked_type enum (no drift)", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../../../spec/schemas/mailbox.schema.json", import.meta.url), "utf-8"),
    );
    const found: string[][] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "acked_type") found.push((x as { enum: string[] }).enum);
        walk(x);
      }
    };
    walk(schema);
    expect(found).toHaveLength(1);
    expect([...ACKABLE_TYPES].sort()).toEqual([...(found[0] ?? [])].sort());
  });
});
