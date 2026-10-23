import { posix } from "node:path";
import type { FleetConfig, GitHubRepo, RemoteHostConfig, Tunables } from "./types";

/**
 * Repositories as a compute pool: every machine's clone of a repository, by its canonical GitHub
 * `owner/name` (config `repos`, `fleet.repo_root`, `hosts.<name>.repos`). Pure: no I/O.
 */

/**
 * A GitHub `owner/name`: an owner GitHub allows (alphanumerics and inner hyphens, at most 39) and
 * a repository name of `[A-Za-z0-9_.-]`, never `.`, `..` or ending `.git`. The config schema's
 * `repos` / `hosts.<name>.repos` key patterns are this string (a test checks they agree).
 */
export const SLUG_PATTERN =
  "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/(?!\\.\\.?$)(?![A-Za-z0-9_.-]*\\.git$)[A-Za-z0-9_.-]{1,100}$";

const SLUG = new RegExp(SLUG_PATTERN);

/** True for an `owner/name` slug (no URL, host, `.git` or whitespace). */
export const isSlug = (s: string): boolean => SLUG.test(s);

/** GitHub's names are case-insensitive: two slugs name one repository when they match so. */
export const sameSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The key of `map` that names `slug` (compared case-insensitively), or undefined. */
export function slugKey(
  map: Record<string, unknown> | undefined,
  slug: string,
): string | undefined {
  return Object.keys(map ?? {}).find((k) => sameSlug(k, slug));
}

/**
 * A normalised origin's slug: `github.com/<owner>/<name>` → `<owner>/<name>`; undefined for any
 * other origin (a non-GitHub repository is compared by its normalised origin instead).
 */
export function originToSlug(origin: string | null | undefined): string | undefined {
  const m = /^github\.com\/([^/]+\/[^/]+)$/.exec(origin ?? "");
  return m?.[1] !== undefined && isSlug(m[1]) ? m[1] : undefined;
}

/** `~` or `~/…` against `home`; unchanged when no home is known (or `p` is not home-relative). */
function underHome(p: string, home: string | undefined): string {
  if (home === undefined) return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? posix.join(home, p.slice(2)) : p;
}

/** A managed clone: `<repo_root>/<owner>/<name>`, `repo_root` expanded on the machine (`home`). */
export function managedClonePath(root: string, slug: string, home?: string): string {
  return posix.join(underHome(root, home), slug);
}

/**
 * A machine's home from the managed clones its record reports (#436): a managed clone sits at
 * `<repo_root>/<owner>/<name>` with `repo_root` expanded on the machine, so a home-relative
 * `repo_root` (`~/…`) leaves the home as the rest of its path. Undefined when no clone tells.
 */
export function homeFromClones(
  root: string,
  clones: readonly { slug: string; path: string; managed: boolean }[] | undefined,
): string | undefined {
  if (root !== "~" && !root.startsWith("~/")) return undefined;
  for (const c of clones ?? []) {
    if (!c.managed) continue;
    const tail = posix.join("/", root.slice(1), c.slug);
    const path = trimPath(c.path);
    if (path.endsWith(tail) && path.length > tail.length) return path.slice(0, -tail.length);
  }
  return undefined;
}

/** A repository's worktree root on a machine: `<home>/.volley/worktrees/<owner>/<name>`. */
export function managedWorktreeRoot(home: string | undefined, slug: string): string {
  return posix.join(home ?? "~", ".volley", "worktrees", slug);
}

/** What resolving a machine's clone reads from the config. */
export interface RepoConfig {
  repos: Tunables["repos"];
  fleet: Pick<FleetConfig, "repo_root">;
  hosts: Record<string, Pick<RemoteHostConfig, "repo" | "repos">>;
}

/** What is known about the machine itself: its home, and its legacy clone's normalised origin. */
export interface MachineFacts {
  home?: string | undefined;
  /** The machine record's `repo.origin` (its `hosts.<name>.repo` clone's origin). */
  origin?: string | null | undefined;
}

const trimPath = (p: string): string => p.replace(/(.)\/+$/, "$1");

/**
 * The origin a machine record reports for `legacy` (its `hosts.<m>.repo`): the record's
 * `repo.origin` only when the record's clone is that path; another clone's origin says nothing
 * about it.
 */
export function legacyOrigin(
  seen: { path: string; origin?: string | undefined } | undefined,
  legacy: string | undefined,
): string | undefined {
  if (seen === undefined || legacy === undefined) return undefined;
  return trimPath(seen.path) === trimPath(legacy) ? seen.origin : undefined;
}

/** True when `repos.<slug>.machines` assigns the repository to `machine`. */
function assigned(cfg: Pick<RepoConfig, "repos">, machine: string, slug: string): boolean {
  const key = slugKey(cfg.repos, slug);
  const machines = key !== undefined ? cfg.repos[key]?.machines : undefined;
  return machines === "all" || (Array.isArray(machines) && machines.includes(machine));
}

/** Where a machine's clone of a repository comes from (`cloneSource`). */
export type CloneKind = "adopted" | "managed" | "legacy";

/**
 * `machine`'s clone of `slug`, where it comes from, and the slug as the config spells it: its adopted clone (`hosts.<m>.repos[slug]`),
 * else the managed path when `repos[slug].machines` includes it, else its legacy `hosts.<m>.repo`
 * when the machine record's origin is that repository (or it reports none yet); undefined when it
 * has none.
 */
export function cloneSource(
  cfg: RepoConfig,
  machine: string,
  slug: string,
  facts: MachineFacts = {},
): { path: string; kind: CloneKind; slug: string } | undefined {
  const host = Object.hasOwn(cfg.hosts, machine) ? cfg.hosts[machine] : undefined;
  // The slug as the config spells it (paths on disk are case-sensitive; GitHub is not).
  const canonical = slugKey(cfg.repos, slug) ?? slug;
  const adopted = slugKey(host?.repos, slug);
  const path = adopted !== undefined ? host?.repos?.[adopted] : undefined;
  if (path !== undefined) return { path, kind: "adopted", slug: canonical };
  if (assigned(cfg, machine, slug)) {
    const managed = managedClonePath(cfg.fleet.repo_root, canonical, facts.home);
    return { path: managed, kind: "managed", slug: canonical };
  }
  // No origin (not reported yet, as records arrive asynchronously, or a clone without one) does
  // not rule the legacy clone out: it serves any slug, as the one clone per host did before repos.
  const origin = facts.origin;
  const legacy = origin == null ? slug : originToSlug(origin);
  if (host?.repo !== undefined && legacy !== undefined && sameSlug(legacy, slug)) {
    return { path: host.repo, kind: "legacy", slug: canonical };
  }
  return undefined;
}

/** `machine`'s clone of `slug` (`cloneSource`'s path), or undefined. */
export function cloneFor(
  cfg: RepoConfig,
  machine: string,
  slug: string,
  facts: MachineFacts = {},
): string | undefined {
  return cloneSource(cfg, machine, slug, facts)?.path;
}

/** The slugs `machine` holds a clone of by config (assigned, or adopted), sorted. */
export function assignedSlugs(cfg: RepoConfig, machine: string): string[] {
  const out = Object.keys(cfg.repos).filter((s) => assigned(cfg, machine, s));
  const host = Object.hasOwn(cfg.hosts, machine) ? cfg.hosts[machine] : undefined;
  for (const s of Object.keys(host?.repos ?? {})) {
    if (!out.some((o) => sameSlug(o, s))) out.push(s);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A wave's repository slug: its state's `github.slug` (`gh repo view` at submit), else the
 * supervisor clone's normalised `origin` mapped to a slug; undefined for a non-GitHub repository.
 */
export function waveSlug(
  rec: { state?: { github?: GitHubRepo | undefined } | null | undefined },
  origin?: string | null,
): string | undefined {
  return rec.state?.github?.slug ?? originToSlug(origin);
}
