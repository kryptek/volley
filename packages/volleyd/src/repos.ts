import { posix } from "node:path";
import { CONFIG_DEFAULTS } from "./config-defaults";
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
 * The managed root on a paired machine (#596): a home-relative `repo_root` (`~`, `~/…`) is each
 * machine's own; an absolute one (the installed daemon's `<VOLLEYD_HOME>/repos`) is the
 * supervisor's disk, so a paired machine keeps the default `~/.volley/repos`, where its doctor
 * clones.
 */
export function remoteRepoRoot(root: string): string {
  return root === "~" || root.startsWith("~/") ? root : CONFIG_DEFAULTS.fleet.repo_root;
}

/**
 * The path of `slug`'s clone a machine record reports existing (#596), compared
 * case-insensitively; undefined without a record or such a clone. Any existing clone counts,
 * managed or not (a legacy or adopted one the box reports is still where the repository is).
 */
export function reportedClone(
  record: { repos?: readonly MachineRepoFacts[] | undefined } | undefined,
  slug: string,
): string | undefined {
  return record?.repos?.find((r) => r.exists && sameSlug(r.slug, slug))?.path;
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

/**
 * What is known about the machine itself: its home, its reported clone of the repository, and its
 * legacy clone's normalised origin.
 */
export interface MachineFacts {
  home?: string | undefined;
  /**
   * The clone its record reports for the repository (`reportedClone`): its managed clone, where
   * the repository is assigned to it (#596).
   */
  clone?: string | undefined;
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
 * else the managed clone when `repos[slug].machines` includes it (the one its record reports, else
 * the managed path), else its legacy `hosts.<m>.repo`
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
    const managed = facts.clone ?? managedClonePath(cfg.fleet.repo_root, canonical, facts.home);
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
 * The machines that hold a clone of `slug` by config (#448): every machine `repos.<slug>.machines`
 * names (`all`: every `hosts.<name>` and the supervisor's machine `local`) and every host that
 * adopts one; sorted, each once.
 */
export function holdersOf(cfg: RepoConfig, local: string, slug: string): string[] {
  const key = slugKey(cfg.repos, slug);
  const machines = key !== undefined ? cfg.repos[key]?.machines : undefined;
  const out = new Set<string>(
    machines === "all" ? [...Object.keys(cfg.hosts), local] : (machines ?? []),
  );
  for (const [name, host] of Object.entries(cfg.hosts)) {
    if (slugKey(host?.repos, slug) !== undefined) out.add(name);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * How the supervisor runs `gh` for a wave's repository (#448): an `owner/name` (a wave the
 * supervisor holds no clone of) with `--repo`, a checkout's path in that directory.
 */
export function ghRepoContext(repo: string): { args: string[]; cwd?: string } {
  return isSlug(repo) ? { args: ["--repo", repo] } : { args: [], cwd: repo };
}

/**
 * Of `slugs`, those config names (in `repos`, or adopted on a host) without assigning them to
 * `machine` (nor adopting a clone there): repositories other machines work on. A slug config
 * does not name is not one.
 */
export function unassignedSlugs(
  cfg: RepoConfig,
  machine: string,
  slugs: readonly string[],
): string[] {
  const mine = assignedSlugs(cfg, machine);
  const named = (s: string) =>
    slugKey(cfg.repos, s) !== undefined ||
    Object.values(cfg.hosts).some((h) => slugKey(h?.repos, s) !== undefined);
  return slugs.filter((s) => named(s) && !mine.some((m) => sameSlug(m, s)));
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

/** `repos.<slug>.machines`: every machine, or these by name. */
export type RepoMachines = "all" | string[];

/** `current` with `add` assigned too (`all` absorbs any list). */
export function withMachines(current: RepoMachines | undefined, add: RepoMachines): RepoMachines {
  if (current === "all" || add === "all") return "all";
  return [...new Set([...(current ?? []), ...add])];
}

/**
 * `current` without `remove` (`all`: every machine), `every` naming the machines `all` stands for;
 * null when none is left (the repository leaves config).
 */
export function withoutMachines(
  current: RepoMachines | undefined,
  remove: RepoMachines,
  every: readonly string[],
): RepoMachines | null {
  if (remove === "all" || current === undefined) return null;
  const left = (current === "all" ? every : current).filter((m) => !remove.includes(m));
  return left.length > 0 ? left : null;
}

/** A Claude account profile as the registry lists it (claude/profiles.ts `ClaudeAccount`). */
export interface ProfileFacts {
  id: string;
  /** `local` for the supervisor's own machine, else the paired machine's name. */
  machine: string;
  /** A paired machine's profile dir there (recorded at sign-in). */
  dir?: string | undefined;
  signed_in_at?: string | undefined;
}

/** One machine's part of a `repo_add` (`addPlan`). */
export interface AddStep {
  machine: string;
  /** The supervisor's own machine. */
  local: boolean;
  /** The box doctor's `--repo-add`: `<owner/name>` (managed) or `<owner/name>=<abs>` (adopted). */
  repo_add: string;
  /** The clone's path when config or the machine's record tells it. */
  path?: string;
  /** No clone reported there yet: the doctor runs with `--fix --clone`. */
  clone: boolean;
  /**
   * The Claude profiles whose folder trust the clone gets (D4): null is the machine's default
   * profile, else a signed-in profile's config dir.
   */
  profiles: (string | null)[];
}

/**
 * Each machine's steps of a `repo_add` of `slug` (D4, D6): adopt `paths[m]` or the managed clone,
 * clone it where the machine's record reports none, and trust it in the default profile and in
 * every signed-in profile there. A paired machine's path is its record's, else its managed path
 * under `remoteRepoRoot` once its home is known, never the supervisor's (#596). Pure: config as it
 * will be once the add is applied.
 */
export function addPlan(
  cfg: RepoConfig,
  local: string,
  accounts: readonly ProfileFacts[],
  records: (machine: string) => { repos?: readonly MachineRepoFacts[] | undefined } | undefined,
  slug: string,
  machines: readonly string[],
  o: { localHome?: string; localDir: (id: string) => string },
): AddStep[] {
  return machines.map((machine) => {
    const isLocal = machine === local;
    const record = records(machine);
    const reported = record?.repos?.find((r) => sameSlug(r.slug, slug));
    const root = isLocal ? cfg.fleet.repo_root : remoteRepoRoot(cfg.fleet.repo_root);
    const home = isLocal ? o.localHome : homeFromClones(root, record?.repos);
    const source = cloneSource(
      { ...cfg, fleet: { ...cfg.fleet, repo_root: root } },
      machine,
      slug,
      {
        home,
        ...(isLocal ? {} : { clone: reportedClone(record, slug) }),
      },
    );
    const path =
      reported?.path ??
      (source !== undefined && posix.isAbsolute(source.path) ? source.path : undefined);
    const profiles = accounts
      .filter((a) => a.signed_in_at !== undefined && (a.machine === "local") === isLocal)
      .filter((a) => isLocal || a.machine === machine)
      .flatMap((a) => (isLocal ? [o.localDir(a.id)] : a.dir !== undefined ? [a.dir] : []));
    return {
      machine,
      local: isLocal,
      repo_add:
        source?.kind === "adopted" ? `${source.slug}=${source.path}` : (source?.slug ?? slug),
      ...(path !== undefined ? { path } : {}),
      clone: reported?.exists !== true,
      profiles: [null, ...profiles],
    };
  });
}

/** What `addPlan` reads of a machine record's `repos[]` entry (machines.ts `MachineRepo`). */
export interface MachineRepoFacts {
  slug: string;
  path: string;
  exists: boolean;
  managed: boolean;
}

/** Where a repository stands on one machine, as readiness says it (`RepoVerdict`). */
export interface RepoStateFacts {
  state: "ready" | "cloning" | "blocked" | "absent";
  path?: string | undefined;
  reasons: readonly string[];
}

/**
 * One machine's line for a repository (`repo_status`, `volley repo status`, the Desk):
 * `box: ready (/srv/a)`, `box: cloning`, `box: blocked (why; why)`, `box: absent (why)`.
 */
export function repoStateLine(machine: string, v: RepoStateFacts | undefined): string {
  if (v === undefined) return `${machine}: not assigned`;
  const why = v.reasons.length > 0 ? v.reasons.join("; ") : v.path;
  return `${machine}: ${v.state}${why !== undefined ? ` (${why})` : ""}`;
}

/**
 * The `repo_add` runs not finished on a machine, by machine and slug, with the last run's why:
 * each `repo_clone_run` that failed and no later one that succeeded, nor a `repo_removed` there
 * since. Replayed from the `_system` journal, so a restart retries them too.
 */
export function pendingRepoRuns(
  events: readonly { type: string; data: unknown }[],
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const drop = (m: string, slug: string) => {
    const k = [...(out.get(m)?.keys() ?? [])].find((s) => sameSlug(s, slug));
    if (k !== undefined) out.get(m)?.delete(k);
    if (out.get(m)?.size === 0) out.delete(m);
  };
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    if (
      e.type === "repo_clone_run" &&
      typeof d.machine === "string" &&
      typeof d.slug === "string"
    ) {
      drop(d.machine, d.slug);
      if (d.ok !== true) {
        const why = typeof d.error === "string" ? d.error : "the last run failed";
        out.set(d.machine, (out.get(d.machine) ?? new Map()).set(d.slug, why));
      }
    } else if (e.type === "repo_removed" && typeof d.slug === "string") {
      const machines = d.machines === "all" ? [...out.keys()] : (d.machines as string[]);
      for (const m of Array.isArray(machines) ? machines : []) drop(m, d.slug);
    }
  }
  return out;
}
