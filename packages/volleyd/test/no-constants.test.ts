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

/** Every tunable key, including nested ones (admission.*, mailbox.*). */
function tunableKeys(obj: Record<string, unknown>): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && k !== "lease_pools"
      ? [k, ...tunableKeys(v as Record<string, unknown>)]
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
  });

  it("src/ is clean", () => {
    const offenders = sourceFiles(SRC).flatMap((f) =>
      violations(readFileSync(f, "utf-8")).map((v) => `${f.slice(SRC.length)}:${v}`),
    );
    expect(offenders).toEqual([]);
  });
});
