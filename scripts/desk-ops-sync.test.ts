import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Desk routes a Needs-you answer to its own account-op topic by `DESK_LOGIN_OPS`
 * (volley-desk), and volleyd answers that topic by `DESK_OPS` (volleyd). An op only one list
 * names fails silently: refused on the mailbox, or answered `unknown op` on the ops topic.
 * Neither package depends on the other, so this reads both sources and keeps the lists equal.
 */
const root = join(import.meta.dir, "..");

function opsList(file: string, name: string): string[] {
  const src = readFileSync(join(root, file), "utf-8");
  const m = src.match(
    new RegExp(`export const ${name}\\b[^=]*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]`),
  );
  if (m === null) throw new Error(`${name} not found in ${file}`);
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "").sort();
}

describe("Desk ops", () => {
  test("volley-desk's DESK_LOGIN_OPS equals volleyd's DESK_OPS", () => {
    const desk = opsList("packages/volley-desk/src/steer/deskControl.ts", "DESK_LOGIN_OPS");
    const daemon = opsList("packages/volleyd/src/accounts.ts", "DESK_OPS");
    expect(desk.length).toBeGreaterThan(0);
    expect(desk).toEqual(daemon);
  });
});
