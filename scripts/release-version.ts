#!/usr/bin/env bun
/**
 * Release-time version bump: `bun run release:version --set <X.Y.Z>` or `--check`.
 *
 * Every workspace package and the root share one version. `--set` writes it into the root
 * `package.json` and every workspace's (the root's `workspaces` globs), the matching workspace
 * entries of `bun.lock`, and `version: X.Y` in `packages/volley-issues/SKILL.md` (its frontmatter
 * and the sentence that quotes it). Each file is edited textually: only the version changes, its
 * formatting stays. Running it again is a no-op.
 *
 * `--check` writes nothing: it compares every one of those against the root `package.json`'s
 * version and names each file that disagrees. The release playbook (`.volley/release.yaml`)
 * runs `--set`; the volley-cli version test runs `--check`.
 *
 * Exit code: 0 on success (or all agree); 1 when `--check` finds a disagreement or a file cannot
 * be read; 2 on usage. `--root <dir>` names the workspace (default: this repository).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "usage: bun run release:version (--set <X.Y.Z> | --check) [--root <dir>]\n" +
  "  --set    write X.Y.Z into every package.json, bun.lock's workspaces and SKILL.md's X.Y\n" +
  "  --check  exit 1 when any of them disagrees with the root package.json";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The skill whose `version:` carries the release's major.minor. */
export const SKILL_PATH = "packages/volley-issues/SKILL.md";

/** The workspace directories (relative), from the root's `workspaces` (`dir/*` or a plain dir). */
export function workspaceDirs(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const w of pkg.workspaces ?? []) {
    if (w.endsWith("/*")) {
      const parent = w.slice(0, -2);
      for (const name of readdirSync(join(root, parent)).sort())
        if (existsSync(join(root, parent, name, "package.json"))) dirs.push(`${parent}/${name}`);
    } else if (existsSync(join(root, w, "package.json"))) dirs.push(w);
  }
  return dirs;
}

/** The top-level `"version": "…"` of a package.json's text (its first, at two-space indent). */
const PKG_VERSION = /^( {2}"version": ")([^"]*)(")/m;

/** A bun.lock workspace entry's version: `"<dir>": {\n "name": "…",\n "version": "…"`. */
const lockEntry = (dir: string) =>
  new RegExp(
    `("${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": \\{\\s*"name": "[^"]*",\\s*"version": ")([^"]*)(")`,
  );

/** The skill's frontmatter line and the sentence quoting it. */
const SKILL_FRONT = /^(version: )(\d+\.\d+)$/m;
const SKILL_QUOTE = /(declares `version: )(\d+\.\d+)(`)/g;

const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

interface Found {
  file: string;
  /** What the file holds now (null: no version found). */
  got: string | null;
  want: string;
  /** How a disagreement reads (`version 0.12 (want 0.13)`); default `<got> (want <want>)`. */
  label?: string;
  /** The file's text with `want` written in. */
  next: string;
}

/** Every versioned spot in the workspace, against `version`. */
export function survey(root: string, version: string): Found[] {
  const found: Found[] = [];
  for (const dir of [".", ...workspaceDirs(root)]) {
    const file = dir === "." ? "package.json" : `${dir}/package.json`;
    const text = readFileSync(join(root, file), "utf8");
    found.push({
      file,
      got: PKG_VERSION.exec(text)?.[2] ?? null,
      want: version,
      next: text.replace(PKG_VERSION, `$1${version}$3`),
    });
  }
  const lockPath = join(root, "bun.lock");
  if (existsSync(lockPath)) {
    let lock = readFileSync(lockPath, "utf8");
    for (const dir of workspaceDirs(root)) {
      const re = lockEntry(dir);
      const got = re.exec(lock)?.[2];
      if (got === undefined) continue;
      lock = lock.replace(re, `$1${version}$3`);
      found.push({ file: `bun.lock ${dir}`, got, want: version, next: lock });
    }
  }
  const skillPath = join(root, SKILL_PATH);
  if (existsSync(skillPath)) {
    const text = readFileSync(skillPath, "utf8");
    const want = majorMinor(version);
    const quoted = [...text.matchAll(SKILL_QUOTE)].map((m) => m[2]);
    const front = SKILL_FRONT.exec(text)?.[2] ?? null;
    const got = [front, ...quoted].find((v) => v !== want) ?? front;
    found.push({
      file: SKILL_PATH,
      got,
      want,
      label: `version ${got ?? "missing"} (want ${want})`,
      next: text.replace(SKILL_FRONT, `$1${want}`).replace(SKILL_QUOTE, `$1${want}$3`),
    });
  }
  return found;
}

export interface MainDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function main(argv: string[], deps: MainDeps = {}): number {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  let values: { set?: string; check?: boolean; root?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        set: { type: "string" },
        check: { type: "boolean" },
        root: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if ((values.set === undefined) === (values.check !== true)) {
    err(USAGE);
    return 2;
  }
  if (values.set !== undefined && !SEMVER.test(values.set)) {
    err(`release-version: not X.Y.Z: ${JSON.stringify(values.set)}\n${USAGE}`);
    return 2;
  }
  const root = values.root ?? join(import.meta.dir, "..");

  try {
    if (values.check) {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version?: string;
      };
      const version = pkg.version ?? "";
      const off = survey(root, version).filter((f) => f.got !== f.want);
      for (const f of off)
        err(`${f.file}: ${f.label ?? `${f.got ?? "no version"} (want ${f.want})`}`);
      if (off.length > 0) return 1;
      out(`release-version: every package at ${version}`);
      return 0;
    }
    const version = values.set as string;
    const found = survey(root, version);
    // The lockfile's entries share one text: the last one carries every replacement.
    const writes = new Map<string, string>();
    for (const f of found) writes.set(f.file.startsWith("bun.lock ") ? "bun.lock" : f.file, f.next);
    let changed = 0;
    for (const [file, text] of writes) {
      const path = join(root, file);
      if (readFileSync(path, "utf8") === text) continue;
      writeFileSync(path, text);
      changed++;
    }
    out(`release-version: ${version} (${changed} file${changed === 1 ? "" : "s"} changed)`);
    return 0;
  } catch (e) {
    err(`release-version: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
