/**
 * Settings rows, built generically from the T1 config schema
 * (`spec/schemas/config.schema.json`, bundled at build time) — there is no
 * hand-maintained list of tunables. Each leaf of `$defs/tunableProperties`
 * becomes one row: a bounded number is a stepped slider, a boolean a switch, a
 * string enum a choice, a string (or string-or-null) a text field, a nested
 * object one row per leaf, and the `lease_pools` map gets one capacity row per
 * configured pool. A string enum that may also be null (`fleet.local_agents`,
 * which the retained config carries resolved) is a choice of its strings, and a
 * nested map of integers (`fleet.fallback.per_machine`) gets one stepped row per
 * heavy pool (one that sets `per_machine`). Labels and units come from the key, hints from the
 * schema `description` (else the bounds). Only the grouping into the modal's
 * sections is listed here; a tunable it does not know lands under "Other".
 */
import configSchema from "../../../../spec/schemas/config.schema.json";
import type { Tunables } from "../store/types";

/** The subset of JSON Schema the config schema uses. */
export interface JsonSchema {
  type?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  [key: string]: unknown;
}

export const CONFIG_SCHEMA = configSchema as JsonSchema;

export const SECTIONS = ["Admission", "Leases", "Attention", "Recovery", "Other"] as const;
export type Section = (typeof SECTIONS)[number];

/** Top-level tunable → section, after the prototype's grouping. */
const SECTION_OF: Record<string, Section> = {
  hard_ceiling: "Admission",
  spawn_budget_multiplier: "Admission",
  admission: "Admission",
  lease_pools: "Leases",
  claim_after_s: "Attention",
  heartbeat_alarm_s: "Attention",
  mailbox: "Attention",
  fleet: "Admission",
  fallback_model: "Recovery",
  spawn_timeout_s: "Recovery",
  wake_grace_s: "Recovery",
  worktree_root: "Recovery",
};

export type RowControl =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "toggle" }
  | { kind: "choice"; options: string[] }
  | { kind: "text"; nullable: boolean; minLength?: number; maxLength?: number };

export interface SchemaRow {
  /** Dotted config path, as `volleyd config set` takes it (`admission.ci_queue_max`). */
  path: string;
  section: Section;
  label: string;
  unit: string;
  hint: string;
  control: RowControl;
  /** The value in force when the config omits the path (a fallback per-machine cap: 1). */
  default?: unknown;
}

/** SPEC §4.6.15: a heavy pool not named in `fleet.fallback.per_machine` gets this cap. */
const FALLBACK_PER_MACHINE_DEFAULT = 1;

const UNITS: [suffix: string, unit: string][] = [
  ["_ms", "ms"],
  ["_s", "s"],
  ["_multiplier", "×"],
];

/** Words a label spells as written here, never capitalised. */
const AS_WRITTEN: Record<string, string> = { api: "API", ci: "CI", cmux: "cmux" };

/** `claim_after_s` → words `claim after`, unit `s`. */
function wordsAndUnit(key: string): { words: string; unit: string } {
  const [suffix, unit] = UNITS.find(([s]) => key.endsWith(s)) ?? ["", ""];
  return { words: key.slice(0, key.length - suffix.length).replaceAll("_", " "), unit };
}

/** Sentence case, with `AS_WRITTEN` words spelled their own way. */
function sentence(words: string): string {
  return words
    .split(" ")
    .map((w, i) => AS_WRITTEN[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function resolve(root: JsonSchema, s: JsonSchema): JsonSchema {
  const ref = s.$ref;
  if (ref === undefined) return s;
  const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
  const target = name !== undefined ? root.$defs?.[name] : undefined;
  if (!target) throw new Error(`config schema: unresolvable $ref ${ref}`);
  return resolve(root, target);
}

function controlFor(path: string, s: JsonSchema): RowControl {
  if (s.type === "integer" || s.type === "number") {
    if (s.minimum === undefined || s.maximum === undefined) {
      throw new Error(`config schema: ${path} needs minimum and maximum to render as a slider`);
    }
    return { kind: "slider", min: s.minimum, max: s.maximum, step: s.type === "integer" ? 1 : 0.1 };
  }
  if (s.type === "boolean") return { kind: "toggle" };
  const isChoice = (v: JsonSchema) =>
    v.enum !== undefined && v.enum.length > 0 && v.enum.every((e) => typeof e === "string");
  if (isChoice(s)) return { kind: "choice", options: s.enum as string[] };
  const variants = s.oneOf ?? [s];
  // An enum or null: the retained config carries the resolved value, so offer the strings.
  const choice = variants.find(isChoice);
  if (choice && variants.every((v) => v === choice || v.type === "null")) {
    return { kind: "choice", options: choice.enum as string[] };
  }
  const str = variants.find((v) => v.type === "string");
  if (str && variants.every((v) => v.type === "string" || v.type === "null")) {
    return {
      kind: "text",
      nullable: variants.some((v) => v.type === "null"),
      ...(str.minLength !== undefined ? { minLength: str.minLength } : {}),
      ...(str.maxLength !== undefined ? { maxLength: str.maxLength } : {}),
    };
  }
  throw new Error(`config schema: no settings control for ${path}`);
}

function boundsHint(control: RowControl, unit: string): string {
  if (control.kind === "slider") return `${control.min}–${control.max}${unit ? ` ${unit}` : ""}`;
  if (control.kind === "text") return control.nullable ? "Leave empty for none." : "";
  return "";
}

function row(
  path: string,
  section: Section,
  label: string,
  unit: string,
  s: JsonSchema,
  hint?: string,
): SchemaRow {
  const control = controlFor(path, s);
  return {
    path,
    section,
    label,
    unit,
    hint: hint ?? s.description ?? boundsHint(control, unit),
    control,
  };
}

/**
 * One row per tunable leaf, in schema order. `values` (the retained config or a
 * wave's effective config) supplies the lease pool names; no values, no pools.
 */
export function schemaRows(schema: JsonSchema, values: Tunables | null | undefined): SchemaRow[] {
  const props = schema.$defs?.tunableProperties?.properties ?? {};
  const heavyPools = Object.entries(values?.lease_pools ?? {})
    .filter(([, p]) => p.per_machine !== undefined)
    .map(([pool]) => pool)
    .sort();
  return Object.entries(props).flatMap(([key, raw]) => {
    const def = resolve(schema, raw);
    const section = SECTION_OF[key] ?? "Other";
    if (def.properties) {
      const prefix = section.toLowerCase() === key ? "" : `${wordsAndUnit(key).words} `;
      // A nested object (`placement.weights`) gives one row per leaf, its key in the label.
      const leaves = (path: string, words: string, d: JsonSchema): SchemaRow[] =>
        Object.entries(d.properties ?? {}).flatMap(([sub, leafRaw]) => {
          const leaf = resolve(schema, leafRaw);
          const w = wordsAndUnit(sub);
          if (leaf.properties) return leaves(`${path}.${sub}`, `${words}${w.words} `, leaf);
          if (typeof leaf.additionalProperties === "object") {
            // A nested map of per-pool caps (`fleet.fallback.per_machine`): a row per heavy pool.
            const entry = resolve(schema, leaf.additionalProperties);
            const last = words.trim().split(" ").at(-1) ?? "";
            return heavyPools.map((pool) => ({
              ...row(
                `${path}.${sub}.${pool}`,
                section,
                `${pool} ${last} ${w.words}`,
                w.unit,
                entry,
                leaf.description,
              ),
              default: FALLBACK_PER_MACHINE_DEFAULT,
            }));
          }
          return [row(`${path}.${sub}`, section, sentence(words + w.words), w.unit, leaf)];
        });
      return leaves(key, prefix, def);
    }
    if (typeof def.additionalProperties === "object") {
      const entry = resolve(schema, def.additionalProperties);
      const capacity = entry.properties?.capacity;
      // A map of structured records (remote `hosts`) has no per-entry slider: set in config.yaml.
      if (!capacity) return [];
      const pools = Object.keys((values?.[key] as Record<string, unknown> | undefined) ?? {});
      return pools
        .sort()
        .map((pool) =>
          row(
            `${key}.${pool}.capacity`,
            section,
            `${pool} pool capacity`,
            "",
            resolve(schema, capacity),
          ),
        );
    }
    const { words, unit } = wordsAndUnit(key);
    return [row(key, section, sentence(words), unit, def)];
  });
}

/** The value at a dotted path, or undefined. */
export function valueAt(values: Tunables | null | undefined, path: string): unknown {
  let v: unknown = values;
  for (const seg of path.split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, seg)) return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

/** `lease_pools.build.capacity`, 1 → `{ lease_pools: { build: { capacity: 1 } } }`. */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  return path.split(".").reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), value) as Record<
    string,
    unknown
  >;
}
