import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA,
  type JsonSchema,
  SECTIONS,
  type SchemaRow,
  patchFor,
  schemaRows,
  valueAt,
} from "../src/settings/schemaRows";
import type { Tunables } from "../src/store/types";

// The real T1 schema, read independently of the build-time import under test.
const schema = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../spec/schemas/config.schema.json"), "utf-8"),
) as JsonSchema;
const props = (schema.$defs?.tunableProperties?.properties ?? {}) as Record<string, JsonSchema>;
const leasePool = schema.$defs?.leasePool as JsonSchema;

const values: Tunables = {
  hard_ceiling: 12,
  lease_pools: {
    "backend-it": { capacity: 2, per_machine: 1, ttl_s: 1800, match: ["mvn .*verify"] },
    build: { capacity: 3 },
  },
  hosts: { box: { target: "dev@box", repo: "~/src/app", volley_dir: "~/src/volley" } },
};

/** The heavy pools (those that set `per_machine`): `fleet.fallback.per_machine` has a row each. */
const heavyPools = Object.entries(values.lease_pools ?? {})
  .filter(([, p]) => p.per_machine !== undefined)
  .map(([pool]) => pool);

/** A map whose entries are structured records (e.g. `hosts`), not per-entry capacities. */
const isRecordMap = (v: JsonSchema): boolean => {
  const entry = v.additionalProperties as JsonSchema | undefined;
  if (typeof entry !== "object") return false;
  const ref = entry.$ref?.replace("#/$defs/", "");
  const target = ref !== undefined ? (schema.$defs?.[ref] as JsonSchema) : entry;
  // A map of plain numbers (`fleet.fallback.per_machine`) is not a record map.
  return target.type !== "integer" && target.properties?.capacity === undefined;
};

/** The leaf tunables of the schema, as dotted paths (map entries expand per value). */
function expectedLeaves(s: Record<string, JsonSchema>, prefix = ""): string[] {
  return Object.entries(s).flatMap(([k, v]) => {
    const p = `${prefix}${k}`;
    if (isRecordMap(v)) return [];
    if (v.properties) return expectedLeaves(v.properties as Record<string, JsonSchema>, `${p}.`);
    if (v.additionalProperties) {
      // A top-level map is `lease_pools` (a capacity row per pool); a nested map of integers
      // (`fleet.fallback.per_machine`) has a row per heavy pool.
      if (prefix !== "") return heavyPools.map((pool) => `${p}.${pool}`);
      return Object.keys(values.lease_pools ?? {}).map((pool) => `${p}.${pool}.capacity`);
    }
    return [p];
  });
}

const byPath = (rows: SchemaRow[]) => new Map(rows.map((r) => [r.path, r]));

describe("schemaRows", () => {
  it("bundles the spec's config schema at build time", () => {
    expect(CONFIG_SCHEMA).toEqual(schema);
  });

  const rows = schemaRows(schema, values);
  const at = byPath(rows);

  it("produces exactly one row per tunable in the schema", () => {
    expect(rows.map((r) => r.path).sort()).toEqual(expectedLeaves(props).sort());
  });

  for (const [key, def] of Object.entries(props).filter(([, d]) => !isRecordMap(d))) {
    it(`renders ${key} with the schema's control type and bounds`, () => {
      /** A nested object's leaves, keyed by their path under it (`weights.cpu`). */
      const flat = (o: Record<string, JsonSchema>, pre = ""): Record<string, JsonSchema> =>
        Object.fromEntries(
          Object.entries(o).flatMap(([k, v]) =>
            v.properties
              ? Object.entries(flat(v.properties as Record<string, JsonSchema>, `${pre}${k}.`))
              : v.additionalProperties
                ? heavyPools.map((pool) => [
                    `${pre}${k}.${pool}`,
                    v.additionalProperties as JsonSchema,
                  ])
                : [[`${pre}${k}`, v]],
          ),
        );
      const leaves = Object.entries(
        def.properties
          ? flat(def.properties as Record<string, JsonSchema>)
          : def.additionalProperties
            ? Object.fromEntries(
                Object.keys(values.lease_pools ?? {}).map((pool) => [
                  `${pool}.capacity`,
                  leasePool.properties?.capacity as JsonSchema,
                ]),
              )
            : { "": def },
      );
      expect(leaves.length).toBeGreaterThan(0);
      for (const [sub, leaf] of leaves) {
        const row = at.get(sub === "" ? key : `${key}.${sub}`);
        expect(row, `${key}.${sub}`).toBeDefined();
        if (!row) continue;
        expect(SECTIONS).toContain(row.section);
        expect(row.label.length).toBeGreaterThan(0);
        const t = leaf.type;
        if (t === "integer" || t === "number") {
          expect(row.control).toEqual({
            kind: "slider",
            min: leaf.minimum,
            max: leaf.maximum,
            step: t === "integer" ? 1 : 0.1,
          });
        } else if (t === "boolean") {
          expect(row.control).toEqual({ kind: "toggle" });
        } else if (Array.isArray(leaf.enum)) {
          expect(row.control).toEqual({ kind: "choice", options: leaf.enum });
        } else if ((leaf.oneOf as JsonSchema[] | undefined)?.some((o) => Array.isArray(o.enum))) {
          // an enum or null (fleet.local_agents): the retained config carries the resolved value
          const e = (leaf.oneOf as JsonSchema[]).find((o) => Array.isArray(o.enum));
          expect(row.control).toEqual({ kind: "choice", options: e?.enum });
        } else {
          // strings, and string-or-null (fallback_model)
          const nullable = Array.isArray(leaf.oneOf);
          const str = nullable
            ? (leaf.oneOf as JsonSchema[]).find((o) => o.type === "string")
            : leaf;
          expect(row.control).toEqual({
            kind: "text",
            nullable,
            minLength: str?.minLength,
            maxLength: str?.maxLength,
          });
        }
        if (leaf.description && sub !== "" && !def.additionalProperties) {
          expect(row.hint).toBe(leaf.description);
        }
        if (def.description && sub === "") expect(row.hint).toBe(def.description);
      }
    });
  }

  it("groups tunables into the prototype's sections", () => {
    expect(at.get("hard_ceiling")?.section).toBe("Admission");
    expect(at.get("admission.ci_queue_max")?.section).toBe("Admission");
    expect(at.get("lease_pools.build.capacity")?.section).toBe("Leases");
    expect(at.get("heartbeat_alarm_s")?.section).toBe("Attention");
    expect(at.get("fallback_model")?.section).toBe("Recovery");
  });

  it("labels rows from their keys, with units from the key suffix", () => {
    expect(at.get("hard_ceiling")).toMatchObject({ label: "Hard ceiling", unit: "" });
    expect(at.get("claim_after_s")).toMatchObject({ label: "Claim after", unit: "s" });
    expect(at.get("admission.cmux_ping_max_ms")).toMatchObject({
      label: "cmux ping max",
      unit: "ms",
    });
    expect(at.get("admission.api_overload_window_s")?.label).toBe("API overload window");
    expect(at.get("admission.ci_queue_max")?.label).toBe("CI queue max");
    expect(at.get("mailbox.session_expiry_s")?.label).toBe("Mailbox session expiry");
    expect(at.get("lease_pools.backend-it.capacity")?.label).toBe("backend-it pool capacity");
  });

  it("renders a boolean as a switch, a string enum as a choice, and a nested object per leaf", () => {
    expect(at.get("require_fresh_base")).toMatchObject({
      label: "Require fresh base",
      control: { kind: "toggle" },
    });
    expect(at.get("placement.nudge_on_merge")).toMatchObject({
      label: "Placement nudge on merge",
      control: { kind: "choice", options: ["files", "all", "off"] },
    });
    expect(at.get("placement.weights.cpu")).toMatchObject({
      label: "Placement weights cpu",
      control: { kind: "slider", min: 0, max: 100, step: 1 },
    });
    expect(at.has("placement.weights")).toBe(false);
  });

  it("puts the fleet rows under Admission: local agents a choice, the fallback profile stepped", () => {
    expect(at.get("fleet.local_agents")).toMatchObject({
      section: "Admission",
      label: "Fleet local agents",
      control: { kind: "choice", options: ["always", "fallback", "never"] },
    });
    expect(at.get("fleet.fallback.max_agents")).toMatchObject({
      section: "Admission",
      label: "Fleet fallback max agents",
      control: { kind: "slider", min: 1, max: 100, step: 1 },
    });
  });

  it("gives fleet.fallback.per_machine one stepped row per heavy pool (one that sets per_machine)", () => {
    const fallbackRows = rows.filter((r) => r.path.startsWith("fleet.fallback.per_machine"));
    expect(fallbackRows.map((r) => r.path)).toEqual(["fleet.fallback.per_machine.backend-it"]);
    expect(fallbackRows[0]).toMatchObject({
      section: "Admission",
      label: "backend-it fallback per machine",
      control: { kind: "slider", min: 0, max: 64, step: 1 },
      // a heavy pool not named in the map gets 1 (SPEC §4.6.15)
      default: 1,
    });
    expect(
      schemaRows(schema, null).some((r) => r.path.startsWith("fleet.fallback.per_machine")),
    ).toBe(false);
  });

  it("falls back to the bounds as the hint when the schema has no description", () => {
    expect(at.get("admission.cmux_ping_max_ms")?.hint).toBe("10–60000 ms");
  });

  it("hints each lease pool row with its capacity bounds, not the map's description", () => {
    expect(at.get("lease_pools.build.capacity")?.hint).toBe("0–64");
    expect(at.get("lease_pools.backend-it.capacity")?.hint).toBe("0–64");
  });

  it("gives a map of structured records (hosts) no rows, configured or not", () => {
    expect(Object.keys(props)).toContain("hosts");
    expect(rows.some((r) => r.path.startsWith("hosts"))).toBe(false);
    expect(schemaRows(schema, null).some((r) => r.path.startsWith("hosts"))).toBe(false);
  });

  it("has no lease rows when no pools are configured", () => {
    const none = schemaRows(schema, null);
    expect(none.some((r) => r.section === "Leases")).toBe(false);
    expect(none.some((r) => r.path === "hard_ceiling")).toBe(true);
  });

  it("puts a tunable it has no section for under Other, and rejects shapes it cannot edit", () => {
    const extra: JsonSchema = structuredClone(schema);
    const p = extra.$defs?.tunableProperties?.properties as Record<string, JsonSchema>;
    p.new_knob_s = { type: "integer", minimum: 1, maximum: 5 };
    expect(byPath(schemaRows(extra, null)).get("new_knob_s")?.section).toBe("Other");
    p.unbounded = { type: "integer", minimum: 1 };
    expect(() => schemaRows(extra, null)).toThrow(/unbounded/);
  });
});

describe("valueAt / patchFor", () => {
  it("reads a dotted path, map keys included", () => {
    expect(valueAt(values, "hard_ceiling")).toBe(12);
    expect(valueAt(values, "lease_pools.backend-it.capacity")).toBe(2);
    expect(valueAt(values, "admission.ci_queue_max")).toBeUndefined();
    expect(valueAt(null, "hard_ceiling")).toBeUndefined();
  });

  it("builds a nested partial patch", () => {
    expect(patchFor("hard_ceiling", 4)).toEqual({ hard_ceiling: 4 });
    expect(patchFor("lease_pools.build.capacity", 1)).toEqual({
      lease_pools: { build: { capacity: 1 } },
    });
  });
});
