#!/usr/bin/env bun
/**
 * Release-time changelog assembly: `bun run changelog --version <v> --date <YYYY-MM-DD>
 * [--check] [--commit]`.
 *
 * A PR records its changelog entry as a fragment, `changes/<issue>.<type>[.<slug>].md` (or
 * `changes/pr<N>.<type>[.<slug>].md` for a change with no issue), never by editing CHANGELOG.md:
 * two PRs then never conflict on it. At release time this script assembles every fragment into
 * one `## <version> — <date>` section at the top of CHANGELOG.md, grouped by type in the order of
 * `TYPES` and by issue inside a type, and deletes the fragments (`changes/README.md` stays).
 *
 * Running it again is a no-op (no fragments left). It refuses to run when the version's section
 * already exists and fragments remain: a half-done release. `--check` writes nothing and prints
 * the section; `--commit` commits the result as `release: changelog for <version>`.
 *
 * Exit code: 0 on success; 1 on a malformed fragment or a half-done release; 2 on usage.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The fragment types, in the order their sections appear. */
export const TYPES = ["added", "changed", "fixed", "removed", "docs"] as const;
export type FragmentType = (typeof TYPES)[number];

const HEADINGS: Record<FragmentType, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
  docs: "Docs",
};

export interface Fragment {
  path: string;
  /** The GitHub issue number, or null for a `pr<N>` fragment. */
  issue: number | null;
  /** The PR number of a `pr<N>` fragment, else null. */
  pr: number | null;
  type: FragmentType;
  slug: string | null;
  /** Each bullet with its continuation lines, ending in its `(#N)` reference. */
  bullets: string[];
}

const NAME = /^(?:(\d+)|pr(\d+))\.([a-z]+)(?:\.([a-z0-9-]+))?\.md$/;

/** Parses one fragment; throws an Error naming `path` when its name or body is malformed. */
export function parseFragment(path: string, text: string): Fragment {
  const base = path.split("/").pop() ?? path;
  const m = NAME.exec(base);
  const type = m?.[3] as FragmentType | undefined;
  if (!m || type === undefined || !TYPES.includes(type))
    throw new Error(
      `${path}: a fragment is named <issue>.<type>[.<slug>].md or pr<N>.<type>[.<slug>].md, ` +
        `<type> one of ${TYPES.join(" | ")}, <slug> [a-z0-9-]+`,
    );
  const issue = m[1] === undefined ? null : Number(m[1]);
  const pr = m[2] === undefined ? null : Number(m[2]);
  const slug = m[4] ?? null;

  let lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end === -1) throw new Error(`${path}: the front matter has no closing ---`);
    for (const line of lines.slice(1, end)) {
      const [, key, value] = /^(\w+):\s*(.*?)\s*$/.exec(line) ?? [];
      if (key === "issue" && Number(value?.replace(/^#/, "")) !== (issue ?? pr))
        throw new Error(`${path}: front matter says issue ${value}, the name says ${issue ?? pr}`);
      if (key === "type" && value !== type)
        throw new Error(`${path}: front matter says type ${value}, the name says ${type}`);
    }
    lines = lines.slice(end + 1);
  }

  const bullets: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) bullets.push([line]);
    else if (line.trim() === "") bullets.at(-1)?.push(line);
    else if (line.startsWith("  ") && bullets.length > 0) bullets.at(-1)?.push(line);
    else
      throw new Error(
        `${path}: every line is a "- " bullet or a continuation indented two spaces: ${line}`,
      );
  }
  if (bullets.length === 0) throw new Error(`${path}: a fragment has at least one "- " bullet`);

  const ref = `(#${issue ?? pr})`;
  return {
    path,
    issue,
    pr,
    type,
    slug,
    bullets: bullets.map((b) => {
      while (b.length > 1 && b.at(-1)?.trim() === "") b.pop();
      const body = b.join("\n");
      return body.includes(ref) ? body : `${body} ${ref}`;
    }),
  };
}

/** Numbered issues ascending, then `pr` fragments by number, then by slug (none first). */
function order(a: Fragment, b: Fragment): number {
  const key = (f: Fragment) => (f.issue !== null ? [0, f.issue] : [1, f.pr ?? 0]);
  const [ka, kb] = [key(a), key(b)];
  return (
    (ka[0] ?? 0) - (kb[0] ?? 0) ||
    (ka[1] ?? 0) - (kb[1] ?? 0) ||
    (a.slug ?? "").localeCompare(b.slug ?? "")
  );
}

/** The `## <version> — <date>` section for `fragments`; "" when there are none. */
export function assemble(
  fragments: Fragment[],
  { version, date }: { version: string; date: string },
): string {
  if (fragments.length === 0) return "";
  const parts = [`## ${version} — ${date}`, ""];
  for (const type of TYPES) {
    const of = fragments.filter((f) => f.type === type).sort(order);
    if (of.length === 0) continue;
    parts.push(`### ${HEADINGS[type]}`, "", ...of.flatMap((f) => f.bullets), "");
  }
  return parts.join("\n");
}

/**
 * `changelog` with `section` above its newest `## ` section (below the intro). An empty section
 * leaves it as it is; a section whose version is already there throws `ALREADY_RELEASED`.
 */
export function insertSection(changelog: string, section: string): string {
  if (section === "") return changelog;
  const version = /^## (\S+)/.exec(section)?.[1];
  if (version === undefined) throw new Error("a section starts with a ## <version> heading");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^## ${escaped}(\\s|$)`, "m").test(changelog))
    throw new Error(
      `ALREADY_RELEASED: CHANGELOG.md already has a ## ${version} section and fragments remain in changes/`,
    );
  const at = changelog.search(/^## /m);
  if (at === -1) return `${changelog.replace(/\n*$/, "\n\n")}${section}`;
  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

const USAGE = "usage: bun run changelog --version <v> --date <YYYY-MM-DD> [--check] [--commit]";

export interface MainDeps {
  /** The repository root holding CHANGELOG.md and changes/. */
  root?: string;
  /** The git binary `--commit` runs. */
  git?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function main(argv: string[], deps: MainDeps = {}): number {
  const root = deps.root ?? join(import.meta.dir, "..");
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  let values: { version?: string; date?: string; check?: boolean; commit?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        version: { type: "string" },
        date: { type: "string" },
        check: { type: "boolean" },
        commit: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { version, date } = values;
  if (!version || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err(USAGE);
    return 2;
  }

  const dir = join(root, "changes");
  let names: string[];
  let fragments: Fragment[];
  let changelog: string;
  let next: string;
  try {
    names = readdirSync(dir)
      .filter((n) => n !== "README.md")
      .sort();
    fragments = names.map((n) => parseFragment(`changes/${n}`, readFileSync(join(dir, n), "utf8")));
    const section = assemble(fragments, { version, date });
    changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    next = insertSection(changelog, section);
    if (values.check) {
      out(section === "" ? "changelog: no fragments in changes/" : section);
      return 0;
    }
  } catch (e) {
    err((e as Error).message);
    return 1;
  }

  if (fragments.length === 0) {
    out("changelog: no fragments in changes/; nothing to assemble");
    return 0;
  }
  writeFileSync(join(root, "CHANGELOG.md"), next);
  for (const n of names) rmSync(join(dir, n));
  out(`changelog: assembled ${fragments.length} fragments into ## ${version} — ${date}`);

  if (values.commit) {
    const git = deps.git ?? "git";
    for (const args of [
      ["add", "CHANGELOG.md", "changes"],
      ["commit", "-m", `release: changelog for ${version}`],
    ]) {
      const r = Bun.spawnSync([git, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) {
        err(`changelog: git ${args[0]} failed (exit ${r.exitCode})`);
        return 1;
      }
    }
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
