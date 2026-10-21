import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const IMPORT = /(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

// The value-import closure of a module: type-only imports are erased and do not load anything.
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [resolve(SRC, entry)];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const [, typeOnly, spec] = m as unknown as [string, string | undefined, string];
      if (typeOnly) continue;
      if (!spec.startsWith(".")) {
        seen.add(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      const hit = [`${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p));
      if (hit) todo.push(hit);
    }
  }
  return seen;
}

describe("pure modules stay off the MQTT I/O layer", () => {
  for (const entry of ["reducer.ts", "archive.ts"]) {
    it(`${entry} does not transitively load mqtt or the broker`, () => {
      const deps = [...closure(entry)];
      expect(
        deps.filter((d) => d === "mqtt" || d === "volley-mcp/broker" || d.endsWith("/control.ts")),
      ).toEqual([]);
    });
  }
});
