import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * What a Desk build was made from and what it is: the stamp `volley setup` and `volley deploy`
 * write next to a build (`deskStamp` of its checkout), and the bundle's own `version.json`
 * (written by the Desk's Vite build). `volley desk serve` compares both to warn on a stale build.
 */

/** Where a Desk build records what it was built from (`deskStamp` of its checkout). */
export const DESK_STAMP = ".volley-build";

/** The Desk's sources a build depends on, besides bun.lock at the repo root. */
const DESK_INPUTS = [
  "src",
  "public",
  "index.html",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
];

/**
 * A hash of the Desk's sources and the lockfile: a build whose recorded stamp differs is stale
 * (an update since, or a build made outside setup).
 */
export function deskStamp(repo: string): string {
  const desk = join(repo, "packages", "volley-desk");
  const files: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(join(p, e));
    } else files.push(p);
  };
  for (const i of DESK_INPUTS) walk(join(desk, i));
  files.push(join(repo, "bun.lock"));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${relative(repo, f)}\0`);
    h.update(existsSync(f) ? readFileSync(f) : "");
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** The stamp recorded in the build at `dist`, or null when there is none. */
export function readDeskStamp(dist: string): string | null {
  const p = join(dist, DESK_STAMP);
  if (!existsSync(p)) return null;
  const s = readFileSync(p, "utf-8").trim();
  return s === "" ? null : s;
}

/** Record that the build at `dist` was made from a checkout whose `deskStamp` is `stamp`. */
export function writeDeskStamp(dist: string, stamp: string): void {
  writeFileSync(join(dist, DESK_STAMP), `${stamp}\n`);
}

/** The version in the build's `version.json`, or null (missing, unreadable, no version). */
export function readBundleVersion(dist: string): string | null {
  try {
    const v = (
      JSON.parse(readFileSync(join(dist, "version.json"), "utf-8")) as { version?: unknown }
    ).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
