import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import { type FilesEntry, filesEntries, globRe, hasFileExtension, isPattern } from "./overlap";
import type { Footprint, FootprintConfidence } from "./types";

/**
 * A task's footprint: the files it is expected to touch and how they were found (wave-file
 * `files` and `footprint`). `footprintOf` resolves an issue body's Files list against the
 * repository tree, so a footprint is never silently empty or full of non-paths. Pure, except
 * `readTree`, which reads the tree through the fence.
 */
export type { Footprint, FootprintConfidence } from "./types";

/** The repository tree: every file path to its size in bytes. */
export type Tree = Record<string, number>;

/** What `footprintOf` found: `files` go to the wave file, `confidence` and `unresolved` too. */
export interface ResolvedFootprint {
  /** Tree paths, new files, and each resolved glob or `dir/` beside the paths it matched. */
  files: string[];
  confidence: FootprintConfidence;
  /** Entries that matched no tree path, or more than one. */
  unresolved: string[];
  /** Σ tree bytes of the resolved files (new files and globs count 0). */
  bytes: number;
}

/**
 * Resolve an issue body's Files list against the tree:
 * - a tree path resolves; a glob or `dir/` resolves to the tree paths it matches (kept too);
 * - a bare file name or a relative fragment (`types.ts`, `helpers/x.ts`, `src/dock/*`) resolves
 *   to the unique tree path ending with it inside the last resolved package (`packages/<p>/`),
 *   else the unique one repo-wide, else goes to `unresolved`;
 * - an entry marked `(new)`, or under `changes/`, is accepted as a new file;
 * - a token with no `/` and no known file extension (`github.slug`, `lease_pools.*.match`) that
 *   names no tree file is an identifier and is dropped.
 * `listed`: every entry resolved or new; `resolved`: some did not; `guessed`: no Files section
 * (or none of it resolved), so the backticked tree paths in the body; `none`: nothing.
 */
export function footprintOf(body: string, tree: Tree): ResolvedFootprint {
  const paths = Object.keys(tree);
  const files = new Set<string>();
  const unresolved: string[] = [];
  let pkg: string | null = null;
  for (const e of filesEntries(body) ?? []) {
    const got = resolveEntry(e, tree, paths, pkg);
    // No `/` and no known extension: an identifier, unless it names a tree file (`x.conf`).
    const identifier = !e.raw.includes("/") && !hasFileExtension(e.raw);
    if (identifier && !got?.some((f) => Object.hasOwn(tree, f))) continue;
    if (got === null) {
      if (!unresolved.includes(e.raw)) unresolved.push(e.raw);
      continue;
    }
    for (const f of got) files.add(f);
    pkg = packageOf(got[0] ?? "") ?? pkg;
  }
  if (files.size === 0) {
    const guess = guessed(body, tree);
    const confidence = guess.length > 0 ? "guessed" : "none";
    return { files: guess, confidence, unresolved, bytes: bytesOf(guess, tree) };
  }
  const out = [...files];
  const confidence = unresolved.length === 0 ? "listed" : "resolved";
  return { files: out, confidence, unresolved, bytes: bytesOf(out, tree) };
}

/** An entry's files (a glob first, then its matches), or null when it does not resolve. */
function resolveEntry(
  e: FilesEntry,
  tree: Tree,
  paths: string[],
  pkg: string | null,
): string[] | null {
  if (Object.hasOwn(tree, e.path)) return [e.path];
  if (e.new || e.path.startsWith("changes/")) return [e.path];
  if (isPattern(e.path)) {
    const re = globRe(e.path);
    const hits = paths.filter((t) => re.test(t));
    if (hits.length > 0) return [e.path, ...hits];
  }
  return resolveFragment(e.raw, paths, pkg);
}

/**
 * The unique place a fragment ends a tree path: inside `pkg` first, else repo-wide. A glob
 * fragment resolves when its matches share one prefix (`src/dock/*` → `packages/d/src/dock/*`).
 */
function resolveFragment(frag: string, paths: string[], pkg: string | null): string[] | null {
  const re = new RegExp(`(?:^|/)${globRe(frag).source.slice(1, -1)}$`);
  const hits: { path: string; prefix: string }[] = [];
  for (const t of paths) {
    const m = re.exec(t);
    if (m === null) continue;
    hits.push({ path: t, prefix: t.slice(0, m.index + (m[0].startsWith("/") ? 1 : 0)) });
  }
  const scoped = pkg === null ? [] : hits.filter((h) => h.path.startsWith(pkg));
  for (const set of [scoped, hits]) {
    const prefixes = new Set(set.map((h) => h.prefix));
    if (isPattern(frag)) {
      const [prefix] = prefixes;
      if (prefixes.size === 1 && prefix !== undefined)
        return [`${prefix}${frag}`, ...set.map((h) => h.path)];
    } else if (set.length === 1 && set[0] !== undefined) return [set[0].path];
    if (set.length > 0) return null; // ambiguous here, so ambiguous repo-wide too
  }
  return null;
}

const packageOf = (p: string): string | null => /^packages\/[^/]+\//.exec(p)?.[0] ?? null;

/** Every backticked token in the body that is a tree path, de-duplicated, in order. */
function guessed(body: string, tree: Tree): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    for (const tok of (m[1] ?? "").split(/[\s,]+/)) {
      const p = tok.replace(/^\.\//, "");
      if (p !== "" && Object.hasOwn(tree, p)) out.add(p);
    }
  }
  return [...out];
}

const bytesOf = (files: string[], tree: Tree): number =>
  files.reduce((n, f) => n + (Object.hasOwn(tree, f) ? (tree[f] ?? 0) : 0), 0);

/**
 * `git ls-tree -r -l --full-tree <ref>` output → a Tree: each blob's path and size (submodule
 * commits have no size and are skipped; C-quoted paths are unquoted).
 */
export function treeFromLsTree(stdout: string): Tree {
  const tree: Tree = {};
  for (const line of stdout.split("\n")) {
    const m = /^\d+ (\w+) [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line);
    if (m === null || m[1] !== "blob" || m[2] === "-") continue;
    tree[unquote(m[3] ?? "")] = Number(m[2]);
  }
  return tree;
}

/** A path git printed C-quoted (`"a\tb"`, `"\303\251.md"`) as the bytes it names. */
function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const bytes: number[] = [];
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  const s = Array.from(p.slice(1, -1)); // code points, so a raw surrogate pair stays whole
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? "";
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = s[i + 1] ?? "";
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4).join(""));
    if (oct !== null) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(ESC[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Read the tree at `ref` in `repo` (read-only, through the fence); null on any failure. */
export async function readTree(exec: ExecFn, repo: string, ref: string): Promise<Tree | null> {
  const r = await exec(["git", "ls-tree", "-r", "-l", "--full-tree", ref], {
    cwd: repo,
    timeoutMs: DAEMON_DEFAULTS.tree_read_ms,
  });
  return r.code === 0 && !r.timedOut && r.truncated !== true ? treeFromLsTree(r.stdout) : null;
}

/**
 * The tree a wave's tasks start from: `origin/<branch>` in `repo`, else the local `<branch>`;
 * null when neither reads (not a checkout, no such branch).
 */
export async function readReleaseTree(
  exec: ExecFn,
  repo: string,
  branch: string,
): Promise<Tree | null> {
  return (await readTree(exec, repo, `origin/${branch}`)) ?? readTree(exec, repo, branch);
}

/** One task's footprint, as `footprintSummary` counts it: once per issue it closes. */
export interface FootprintOf {
  id: string;
  issues: number[];
  footprint: Footprint;
}

const CONFIDENCES: FootprintConfidence[] = ["listed", "resolved", "guessed", "none"];

/**
 * `footprints: 24 listed, 2 guessed (#333, #313); 11 entries unresolved (…)`: how many issues'
 * footprints have each confidence (the weak ones named), and the entries that matched no path,
 * listed (`inline`: `T3: a.ts, b; T5: c`) or left to a flag (`hint`: the text in parentheses).
 */
export function footprintSummary(tasks: FootprintOf[], unresolved: { hint: string } | "inline") {
  const counts = new Map<FootprintConfidence, number[]>();
  for (const t of tasks) {
    const c = t.footprint.confidence;
    counts.set(c, [...(counts.get(c) ?? []), ...t.issues]);
  }
  const parts = CONFIDENCES.flatMap((c) => {
    const issues = counts.get(c) ?? [];
    if (issues.length === 0) return [];
    const named =
      c === "guessed" || c === "none" ? ` (${issues.map((i) => `#${i}`).join(", ")})` : "";
    return [`${issues.length} ${c}${named}`];
  });
  const missed = tasks.filter((t) => (t.footprint.unresolved ?? []).length > 0);
  const n = missed.reduce((k, t) => k + (t.footprint.unresolved?.length ?? 0), 0);
  let tail = "";
  if (n > 0) {
    const which =
      unresolved === "inline"
        ? missed.map((t) => `${t.id}: ${(t.footprint.unresolved ?? []).join(", ")}`).join("; ")
        : unresolved.hint;
    tail = `; ${n} ${n === 1 ? "entry" : "entries"} unresolved (${which})`;
  }
  return `footprints: ${parts.join(", ")}${tail}`;
}
