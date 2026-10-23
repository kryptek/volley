#!/usr/bin/env bun
/**
 * Regenerates the replay fixture (run by hand, never by CI; the output is committed):
 *
 * - `test/fixtures/replay/dogfood-26.json`: the 26 issues of the dogfood wave, each as
 *   `{ id, issue, title, files }`, `files` being its body's Files list as `parseFilesSection`
 *   reads it today (bare names included). No bodies, no path outside the repository, and a
 *   home directory a title quotes is masked as `/path/to/home`.
 * - `test/fixtures/replay/tree.json`: `{ <path>: bytes }` for every file of `<ref>` under
 *   `packages/`, `spec/`, `scripts/` and `docs/`, plus the root files (`git ls-tree -r -l`).
 *
 *   bun scripts/replay-fixture.ts [--ref origin/main]
 *
 * Needs `gh` signed in to the repository and `<ref>` fetched.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseFilesSection } from "../src/overlap";

/** The dogfood wave: one task per issue, none with `after:`. */
const ISSUES = Array.from({ length: 26 }, (_, n) => 310 + n);

const { values } = parseArgs({ options: { ref: { type: "string", default: "origin/main" } } });
const pkg = join(import.meta.dir, "..");
const out = join(pkg, "test/fixtures/replay");
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: pkg, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const inRepo = (f: string) => !/^[/~]/.test(f) && !f.split("/").includes("..");
/** A title quoting a home directory (`/home/me`) names the placeholder the repository uses. */
const masked = (title: string) =>
  title.replace(/(?<!\w)\/(?:Users|home)\/[A-Za-z][A-Za-z0-9_-]*/g, "/path/to/home");

const issues = ISSUES.map((issue) => {
  const { title, body } = JSON.parse(
    run("gh", ["issue", "view", String(issue), "--json", "title,body"]),
  ) as { title: string; body: string };
  return {
    id: `i${issue}`,
    issue,
    title: masked(title),
    files: parseFilesSection(body).filter(inRepo),
  };
});

const tree: Record<string, number> = {};
for (const line of run("git", ["ls-tree", "-r", "-l", "--full-tree", values.ref]).split("\n")) {
  // <mode> SP <type> SP <object> SP+ <size> TAB <path>
  const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line);
  if (m === null) continue;
  const path = m[2] as string;
  if (/^(packages|spec|scripts|docs)\//.test(path) || !path.includes("/")) {
    tree[path] = Number(m[1]);
  }
}

const files = [join(out, "dogfood-26.json"), join(out, "tree.json")];
writeFileSync(files[0] as string, `${JSON.stringify(issues, null, 2)}\n`);
writeFileSync(files[1] as string, `${JSON.stringify(tree, null, 2)}\n`);
run("bunx", ["biome", "format", "--write", ...files]);
console.log(`${issues.length} issues, ${Object.keys(tree).length} tree paths (${values.ref})`);
