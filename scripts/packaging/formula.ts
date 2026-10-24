/**
 * The Homebrew formula's template (packaging/homebrew/volley.rb), rendered for a release:
 *
 *   bun scripts/packaging/formula.ts render --version 0.11.0 --sha256 <hex> [--out <file>]
 *
 * The release workflow runs it with the tarball's sha256 and pushes the result to the tap.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FORMULA = join(import.meta.dir, "..", "..", "packaging", "homebrew", "volley.rb");

/** The name `brew install` takes (tap kryptek/volley is github.com/kryptek/homebrew-volley). */
export const TAP_FORMULA = "kryptek/volley/volley";

/** The template filled in for `version` (x.y.z, a leading `v` allowed) and the tarball's sha256. */
export function renderFormula(version: string, sha256: string): string {
  const v = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`not a release version (x.y.z): ${version}`);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error(`not a sha256 (64 hex digits): ${sha256}`);
  return readFileSync(FORMULA, "utf-8")
    .replaceAll("@VERSION@", v)
    .replaceAll("@SHA256@", sha256.toLowerCase());
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      console.error(`formula.ts: expected --<option> <value>, got ${key ?? "nothing"}`);
      return 2;
    }
    opts[key.slice(2)] = value;
  }
  if (cmd !== "render" || opts.version === undefined || opts.sha256 === undefined) {
    console.error("Usage: formula.ts render --version <x.y.z> --sha256 <hex> [--out <file>]");
    return 2;
  }
  let rb: string;
  try {
    rb = renderFormula(opts.version, opts.sha256);
  } catch (e) {
    console.error(`formula.ts: ${(e as Error).message}`);
    return 2;
  }
  if (opts.out === undefined) process.stdout.write(rb);
  else writeFileSync(opts.out, rb);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
