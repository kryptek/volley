/**
 * The repositories the supervisor's machines work on, as Settings › Repositories, the machine
 * cards and Repair read them (SPEC §4.6.21), pure. Config names them (`repos.<owner/name>.machines`:
 * `all` or a list, and `hosts.<m>.repos` / `fleet.repos` for an adopted clone); each machine's record reports its
 * clones (`repos[]`, with the toolchain they lack); volleyd's readiness verdict says where each
 * stands there (`repos.<owner/name>`). Slugs compare case-insensitively, as GitHub's do.
 */
import type {
  ConfigPayload,
  MachinePayload,
  MachineRepo,
  ReadinessPayload,
  RepoState,
} from "../store/types";

/** One repository on one machine: its verdict (none yet: `state` absent) and its clone. */
export interface RepoOnMachine {
  slug: string;
  state?: RepoState | undefined;
  path?: string | undefined;
  /** `false`: an adopted clone (cloned at its own path); `true`: the managed one. */
  managed?: boolean | undefined;
  /** Whether the record found the clone; unknown without a record entry. */
  exists?: boolean | undefined;
  reasons: string[];
  /** The tools the repository needs that the machine lacks, and those it has too old. */
  missing: string[];
  outdated: string[];
}

export const sameSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `map`'s entry for `slug`, matched case-insensitively. */
export function bySlug<V>(map: Record<string, V> | undefined, slug: string): V | undefined {
  if (!map) return undefined;
  if (Object.hasOwn(map, slug)) return map[slug];
  const key = Object.keys(map).find((k) => sameSlug(k, slug));
  return key === undefined ? undefined : map[key];
}

/** Every machine `all` names: the supervisor's own (`fleet.local_name`), then each configured host. */
export function allMachines(config: ConfigPayload | null): string[] {
  const local = config?.fleet?.local_name ?? null;
  const hosts = Object.keys(config?.hosts ?? {}).filter((h) => h !== local);
  return local ? [local, ...hosts] : hosts;
}

/**
 * Each machine's adopted clones: the supervisor's own (`fleet.repos`, under `fleet.local_name`,
 * #616), then each host's `hosts.<m>.repos`.
 */
function adoptedMaps(config: ConfigPayload | null): [string, Record<string, string>][] {
  const local = config?.fleet?.local_name ?? null;
  const own: [string, Record<string, string>][] =
    local && config?.fleet?.repos !== undefined ? [[local, config.fleet.repos]] : [];
  return [
    ...own,
    ...Object.entries(config?.hosts ?? {}).flatMap(([m, h]): [string, Record<string, string>][] =>
      h.repos !== undefined && m !== local ? [[m, h.repos]] : [],
    ),
  ];
}

/** Every repository config names, its own `repos` first, then those only adopted on a machine. */
export function configuredRepos(config: ConfigPayload | null): string[] {
  const out = Object.keys(config?.repos ?? {});
  for (const [, map] of adoptedMaps(config)) {
    for (const s of Object.keys(map)) {
      if (!out.some((o) => sameSlug(o, s))) out.push(s);
    }
  }
  return out;
}

/** The machines `slug` is assigned to: `machines` (`all`: every one), then any adopting it. */
export function assignedMachines(config: ConfigPayload | null, slug: string): string[] {
  const every = allMachines(config);
  const named = bySlug(config?.repos, slug)?.machines;
  const out = named === "all" ? [...every] : [...(named ?? [])];
  for (const [m, map] of adoptedMaps(config)) {
    if (bySlug(map, slug) !== undefined && !out.includes(m)) out.push(m);
  }
  return out;
}

/** The record's clone of `slug`, when it reports one. */
const cloneOf = (record: MachinePayload | undefined, slug: string): MachineRepo | undefined =>
  record?.repos?.find((r) => sameSlug(r.slug, slug));

/** `slug` on one machine, from its record and volleyd's verdict on it. */
export function repoOn(
  slug: string,
  record: MachinePayload | undefined,
  verdict: ReadinessPayload | undefined,
): RepoOnMachine {
  const v = bySlug(verdict?.repos, slug);
  const clone = cloneOf(record, slug);
  return {
    slug,
    state: v?.state,
    path: v?.path ?? clone?.path,
    managed: clone?.managed,
    exists: clone?.exists,
    reasons: v?.reasons ?? [],
    missing: clone?.toolchain.missing ?? [],
    outdated: clone?.toolchain.outdated ?? [],
  };
}

/**
 * Every repository on machine `name`: the ones its verdict judges, its record reports and config
 * assigns it, each once (by slug, the verdict's spelling first).
 */
export function reposOnMachine(
  name: string,
  config: ConfigPayload | null,
  record: MachinePayload | undefined,
  verdict: ReadinessPayload | undefined,
): RepoOnMachine[] {
  const slugs: string[] = [];
  const add = (s: string) => {
    if (!slugs.some((x) => sameSlug(x, s))) slugs.push(s);
  };
  for (const s of Object.keys(verdict?.repos ?? {})) add(s);
  for (const r of record?.repos ?? []) add(r.slug);
  for (const s of configuredRepos(config)) {
    if (assignedMachines(config, s).includes(name)) add(s);
  }
  return slugs.map((s) => repoOn(s, record, verdict));
}

/** Whether Repair can clone it there: no clone (volleyd says absent, or the record found none). */
export const cloneable = (r: RepoOnMachine): boolean => r.state === "absent" || r.exists === false;

/** Where a chip's reason is cut: at its first `: ` past this many characters… */
const SHORT_FROM = 24;
/** …or at this many, whichever comes first. */
const SHORT_MAX = 72;

/**
 * The first reason, short enough for a chip on a phone: cut at its first `: ` past 24 characters
 * (`volley peer doctor on <target> printed no report: bash: …` reads up to `report`) or at 72
 * characters, whichever comes first, with `…`. The whole text is the chip's `Why`.
 */
export function shortReason(reasons: readonly string[]): string {
  const first = reasons[0] ?? "";
  const colon = first.indexOf(": ", SHORT_FROM);
  const cut = Math.min(colon < 0 ? Number.POSITIVE_INFINITY : colon, SHORT_MAX);
  return cut < first.length ? `${first.slice(0, cut).trimEnd()}…` : first;
}

/**
 * Where it stands, in a chip's words: `ready`, `cloning…`, `blocked: <the first reason, short>`,
 * `no clone yet`, or `none` while volleyd has said nothing about it there.
 */
export function stateText(
  r: { state?: RepoState | undefined; reasons: readonly string[] },
  none: string,
): string {
  switch (r.state) {
    case "ready":
      return "ready";
    case "cloning":
      return "cloning…";
    case "blocked":
      return r.reasons[0] ? `blocked: ${shortReason(r.reasons)}` : "blocked";
    case "absent":
      return "no clone yet";
    default:
      return none;
  }
}

/**
 * The repository's toolchain across `machines`: `toolchain ok`, `needs java on hub, box-a ·
 * needs newer node on box-b`, or null while no record reports its clone.
 */
export function toolchainSummary(
  slug: string,
  machines: readonly string[],
  records: Record<string, MachinePayload>,
): string | null {
  const missing = new Map<string, string[]>();
  const outdated = new Map<string, string[]>();
  let seen = false;
  const note = (map: Map<string, string[]>, tool: string, m: string) =>
    map.set(tool, [...(map.get(tool) ?? []), m]);
  for (const m of machines) {
    const clone = cloneOf(records[m], slug);
    if (!clone) continue;
    seen = true;
    for (const t of clone.toolchain.missing) note(missing, t, m);
    for (const t of clone.toolchain.outdated) note(outdated, t, m);
  }
  if (!seen) return null;
  const parts = [
    ...[...missing].map(([t, ms]) => `needs ${t} on ${ms.join(", ")}`),
    ...[...outdated].map(([t, ms]) => `needs newer ${t} on ${ms.join(", ")}`),
  ];
  return parts.length > 0 ? parts.join(" · ") : "toolchain ok";
}

/** `volley repo add`'s command for the same request (the CLI twin a form shows). */
export function addCommand(
  slug: string,
  machines: "all" | readonly string[],
  paths: Readonly<Record<string, string>> = {},
): string {
  const parts = [`volley repo add ${slug || "owner/name"}`];
  if (machines !== "all") for (const m of machines) parts.push(`--machine ${m}`);
  for (const [m, p] of Object.entries(paths)) parts.push(`--path ${m}=${p}`);
  return parts.join(" ");
}
