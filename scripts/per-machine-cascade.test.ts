import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * config.schema.json spells `per_machine <= capacity` as one if/then per capacity value, because
 * JSON Schema cannot compare two values. A one-character slip in one of the rules, or a raised
 * bound without a new rule, would silently weaken the check: this keeps the cascade exact.
 */
interface Rule {
  if: { required: string[]; properties: { capacity: { maximum: number } } };
  then: { properties: { per_machine: { maximum: number } } };
}

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "spec", "schemas", "config.schema.json"), "utf-8"),
);
const pool = schema.$defs.leasePool;
const rules: Rule[] = schema.$defs.perMachineWithinCapacity.allOf;

describe("perMachineWithinCapacity", () => {
  test("lease pools apply it", () => {
    expect(pool.allOf).toContainEqual({ $ref: "#/$defs/perMachineWithinCapacity" });
  });

  test("one rule per capacity below the bound, rule k: capacity <= k => per_machine <= k", () => {
    const capMax: number = pool.properties.capacity.maximum;
    expect(rules).toHaveLength(capMax);
    rules.forEach((rule, k) => {
      expect(Object.keys(rule).sort()).toEqual(["if", "then"]);
      expect(rule.if).toEqual({ required: ["capacity"], properties: { capacity: { maximum: k } } });
      expect(rule.then).toEqual({ properties: { per_machine: { maximum: k } } });
    });
  });

  test("per_machine's own bound covers capacity at its bound (no rule needed there)", () => {
    expect(pool.properties.per_machine.maximum).toBe(pool.properties.capacity.maximum);
  });
});
