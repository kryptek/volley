import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS as TYPED_DEFAULTS } from "../src/config-defaults";

const CONFIG_DEFAULTS = TYPED_DEFAULTS as unknown as Record<string, unknown>;

/**
 * Grep-guard: runtime tunables are read through the config store, never hard-coded. Outside
 * src/config-defaults.ts no line may name a tunable (snake_case, camelCase or UPPER_SNAKE) next
 * to a numeric literal, and no distinctive default value may appear as a bare literal.
 */

const SRC = new URL("../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts") && d.name !== "config-defaults.ts"
        ? [join(dir, d.name)]
        : [],
  );
}

/**
 * Keys whose children are not tunable names: `lease_pools` is keyed by pool, and the children of
 * `placement.weights` are generic words (`cpu`, `slots`, `mem`, `usage`) that name kinds of
 * headroom, not settings a line could hard-code under their own name. The children of
 * `fleet.fallback.per_machine` and `per_machine_overrides` are pool and machine names.
 */
const OPAQUE = new Set(["lease_pools", "weights", "per_machine", "per_machine_overrides"]);

/**
 * Tunable names that are plain English words a line uses for other things (`placement.default`:
 * "default 30000" in a help text; `coordinator.dir`, any directory); their values are strings,
 * so no number could hard-code them. `coordinator.capacity` is numeric, but the word is every
 * lease pool's own `capacity` (opaque above) and a slice's; its default is read in one place
 * (coordinator/runner.ts, from the config).
 */
const GENERIC = new Set(["default", "dir", "capacity"]);

/** Every tunable key, including nested ones (admission.*, mailbox.*). */
function tunableKeys(obj: Record<string, unknown>): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && !OPAQUE.has(k)
      ? [k, ...tunableKeys(v as Record<string, unknown>)]
      : GENERIC.has(k)
        ? []
        : [k],
  );
}

function spellings(key: string): string[] {
  const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return [...new Set([key, camel, key.toUpperCase()])];
}

function numericDefaults(obj: Record<string, unknown>): number[] {
  return Object.values(obj).flatMap((v) =>
    typeof v === "number"
      ? [v]
      : typeof v === "object" && v !== null
        ? numericDefaults(v as Record<string, unknown>)
        : [],
  );
}

// A numeric literal other than 0/1 (no tunable defaults to either), not part of an identifier.
const NUMBER = /(?<![\w.$])(?:[2-9]|[1-9]\d+)(?:_\d+)*(?:\.\d+)?(?![\w])/;

/** The offending lines of `text`, as `line: content`. */
function violations(text: string): string[] {
  const names = tunableKeys(CONFIG_DEFAULTS).flatMap(spellings);
  const distinctive = numericDefaults(CONFIG_DEFAULTS).filter((n) => n >= 100);
  const bare = new RegExp(`(?<![\\w.$])(?:${distinctive.join("|")})(?![\\w.])`);
  return text.split("\n").flatMap((line, i) => {
    if (/^\s*(\/\*|\*)/.test(line)) return []; // block / doc comment lines
    const code = line.replace(/\/\/.*$/, "").replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '""');
    const namesTunable = names.some((n) => new RegExp(`\\b${n}\\b`).test(line));
    return (namesTunable && NUMBER.test(code)) || bare.test(code)
      ? [`${i + 1}: ${line.trim()}`]
      : [];
  });
}

describe("no tunable constants outside config-defaults.ts", () => {
  it("the detector catches the patterns it guards against", () => {
    expect(violations("const HARD_CEILING = 12;")).toHaveLength(1);
    expect(violations("const ceiling = config.get('hard_ceiling') ?? 12;")).toHaveLength(1);
    expect(violations("claimAfterS: 1800,")).toHaveLength(1);
    expect(violations("setTimeout(check, 604800 * 1000);")).toHaveLength(1);
    expect(violations("const room = Math.max(0, ctx.hardCeiling - live);")).toEqual([]);
    expect(violations("hardCeiling: eff.hard_ceiling,")).toEqual([]);
    expect(violations(" * e.g. hard_ceiling: 12 in a doc comment")).toEqual([]);
    // The parent of the exempt weight names is still guarded.
    expect(violations("weights: { cpu: 40, slots: 30 }")).toHaveLength(1);
  });

  it("the default placement weights are spelled only in config-defaults.ts", () => {
    const w = TYPED_DEFAULTS.placement.weights;
    const literal = new RegExp(
      `\\b(?:cpu:\\s*${w.cpu}|slots:\\s*${w.slots}|mem:\\s*${w.mem}|usage:\\s*${w.usage})(?![\\w.])`,
    );
    const offenders = sourceFiles(SRC).flatMap((f) =>
      readFileSync(f, "utf-8")
        .split("\n")
        .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l) && literal.test(l))
        .map((l) => `${f.slice(SRC.length)}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
    expect(literal.test("weights: { cpu: 40 }")).toBe(true);
  });

  it("src/ is clean", () => {
    const offenders = sourceFiles(SRC).flatMap((f) =>
      violations(readFileSync(f, "utf-8")).map((v) => `${f.slice(SRC.length)}:${v}`),
    );
    expect(offenders).toEqual([]);
  });
});
