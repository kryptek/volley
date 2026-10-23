import { basename } from "node:path";
import { derivedMaxAgents } from "volley-cli/peer/machine";
import type { Sharing } from "./claude/sharing";
import { REMOTE_HOST_DEFAULTS } from "./config-defaults";
import { PATH_PROBE_TOOLS } from "./fence";
import { type MachineRecord, type MachineRepo, machineTopic } from "./machines";
import { type FilterOptions, type MachineView, localRole, machineIneligible } from "./placement";
import { originToSlug, sameSlug } from "./repos";
import type { LocalAgentsMode } from "./types";

/**
 * Readiness (SPEC §4.6.15), as pure logic: the supervisor's verdict on one machine, its own
 * included, from a snapshot of what it knows. The machine record is the machine's statement about
 * itself; the verdict needs the supervisor's config and version, so it has its own retained topic,
 * `volley/_system/machines/<name>/readiness`, which only the supervisor publishes.
 *
 * `ready` is false on a failing `block` check, a volley version other than the supervisor's, a
 * `claude` or `bun` the PATH probe did not find (the supervisor's own probe decides: the doctor's
 * `claude_on_path` / `bun_on_path` only estimate the non-interactive ssh PATH), GitHub without
 * push access or Claude signed out. A repository is judged on its own (`repos`, #436): a clone
 * that is missing, fails a per-repository check or lacks a tool its repository needs blocks that
 * repository only, never the machine; placement skips the machine for that repository's waves.
 * `eligible` / `ineligible_reason` are placement's own machine
 * filter (`machineIneligible`): ready, not draining, under `max_agents`, the machine's own
 * admission open, load per core, memory, disk and usage within the supervisor's thresholds. So a
 * verdict never says `eligible` about a machine placement skips, and its reason is the same line.
 */

export const READINESS_CHANNEL = "_system/machines/readiness";
export const readinessTopic = (name: string) => `${machineTopic(name)}/readiness`;

/**
 * The tools the PATH probe looks for (`command -v claude bun`): what an agent session runs. The
 * fence's list, so the probe never asks for a name the fence refuses.
 */
export const PATH_TOOLS = PATH_PROBE_TOOLS;
export type PathTool = (typeof PATH_TOOLS)[number];
export type PathProbe = Record<PathTool, boolean>;

/** One reason or ineligible_reason line, at most (readiness.schema.json). */
const LINE_MAX = 200;
const REASONS_MAX = 32;

/**
 * A peer's `max_agents` (SPEC §4.6.15): its `hosts.<name>.max_agents` when set, else derived from
 * its record's cores and total memory (as `join` derives it), else 4 when its size is unknown.
 */
export function peerMaxAgents(
  configured: number | undefined,
  record: Pick<MachineRecord, "cores" | "memory"> | undefined,
): number {
  return (
    configured ??
    derivedMaxAgents(record?.cores, record?.memory?.total_mb) ??
    REMOTE_HOST_DEFAULTS.max_agents
  );
}

export interface ReadinessInput {
  name: string;
  /** The machine's last record (MachineHealth's, or the supervisor's own); undefined: none yet. */
  record: MachineRecord | undefined;
  /** The supervisor's own machine: its PATH is its own agents' environment, not an ssh session. */
  local: boolean;
  /** `hosts.<name>.max_agents` / `.drain` (the supervisor's own machine: hard_ceiling, false). */
  host: { max_agents: number; drain: boolean };
  /** The supervisor's own volley version: a machine's must match it. */
  hostVersion: string;
  /**
   * The repositories to judge: `wanted`, every running wave's slug, beside every one the record
   * reports (`records`, its `repos[]`; an older peer's `legacy` single clone, by its origin).
   */
  repos: {
    wanted: string[];
    records: MachineRecord["repos"] | undefined;
    legacy?: MachineRecord["repo"];
  };
  /** The last PATH probe; null: not probed yet. */
  probe: PathProbe | null;
  /** Why the last PATH probe could not run (ssh failed, the host is not reachable). */
  probeError?: string;
  /** Live supervised agents on the machine, plus placements reserved for it. */
  placed: number;
  /** The supervisor's own machine: its own agents alone (`MachineView.local_agents`). */
  localAgents?: number;
  /** A peer the supervisor marked down: since when (epoch ms, `MachineView.down_since`). */
  downSince?: number;
  /**
   * The supervisor's own machine: placement's view of every peer, which its `local_agents` mode
   * (`filter.local_agents`) weighs (SPEC §4.6.15).
   */
  peers?: MachineView[];
  heavy: Record<string, { held: number; per_machine: number }>;
  usage: { account: string | null; five_hour_pct: number | null };
  /** The lowest bun the supervisor accepts (the wave repo's `packageManager` / `engines.bun`). */
  bun?: string;
  /** The supervisor's `sharing.yaml` modes (`readSharing`). */
  sharing?: Sharing;
  /** Placement's thresholds (the supervisor's effective config, without a wave's overrides). */
  filter: FilterOptions;
  /** What the machine's own admission holds back (`MachineView.held`). */
  held: string[];
  checkedAt: Date;
}

/** Where one repository stands on a machine (`ReadinessPayload.repos`). */
export type RepoState = "ready" | "cloning" | "blocked" | "absent";

/** One `readiness.schema.json` `repos` entry. */
export interface RepoVerdict {
  state: RepoState;
  /** The clone's path on the machine, when it has one. */
  path?: string;
  /** Why it is not ready; empty when ready. */
  reasons: string[];
  /** When its doctor last fetched it. */
  fetched_at?: string;
}

/** One `readiness.schema.json` payload. */
export interface ReadinessPayload {
  name: string;
  ready: boolean;
  reasons: string[];
  drain: boolean;
  max_agents: number;
  placed: number;
  path_ok: { claude: boolean | null; bun: boolean | null };
  requirements: { volley: string; bun?: string; sharing?: Sharing };
  heavy: Record<string, { held: number; per_machine: number }>;
  usage: { account: string | null; five_hour_pct: number | null };
  /** Each repository by its `owner/name`: where it stands on the machine. */
  repos: Record<string, RepoVerdict>;
  eligible: boolean;
  ineligible_reason?: string;
  /** The supervisor's own machine only: its `fleet.local_agents` mode and whether the fallback is in force. */
  local_agents?: { mode: LocalAgentsMode; active: boolean; why?: string };
  checked_at: string;
}

const line = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);

/** Most repositories a verdict carries (readiness.schema.json's `repos.maxProperties`). */
const REPOS_MAX = 64;

/** Why the PATH an agent gets lacks `tool` (null: not probed yet), in the machine's terms. */
function pathReasons(probe: PathProbe | null, local: boolean, error?: string): string[] {
  if (probe === null && error !== undefined) return [`PATH probe over ssh failed: ${error}`];
  if (probe === null) {
    return [
      local
        ? "claude and bun not probed yet in the environment the supervisor gives its own agents"
        : "claude and bun not probed yet on the non-interactive ssh PATH",
    ];
  }
  return PATH_TOOLS.filter((t) => !probe[t]).map((t) =>
    local
      ? `${t} not on the PATH the supervisor gives its own agents`
      : `${t} not on the non-interactive ssh PATH (the supervisor's ssh probe decides; the doctor's ${t}_on_path only estimates it)`,
  );
}

/** What keeps a machine with a doctor report from running an agent, beside the PATH. */
function doctorReasons(r: MachineRecord, i: ReadinessInput): string[] {
  const out: string[] = [];
  // volley.version is the doctor's view of our requirement; the comparison below decides.
  for (const c of r.checks ?? []) {
    // A repository's own checks (an older peer's untagged `repo.*` too) judge that repository.
    if (c.repo !== undefined || c.id.startsWith("repo.")) continue;
    if (!c.ok && c.severity === "block" && c.id !== "volley.version") {
      out.push(`${c.id}: ${c.detail}`);
    }
  }
  const volley = r.versions?.volley ?? null;
  if (volley !== i.hostVersion) {
    out.push(`volley ${volley ?? "missing"} on ${i.name}, host runs ${i.hostVersion}`);
  }
  return out;
}

function authReasons(r: MachineRecord, i: ReadinessInput): string[] {
  const out: string[] = [];
  const gh = r.auth?.gh;
  if (gh === "no_write") {
    const named =
      i.repos.records?.[0]?.slug ?? originToSlug(i.repos.legacy?.origin) ?? "the wave repo";
    out.push(`gh: no write permission on ${named}`);
  } else if (gh === "unauthenticated") out.push("gh: not signed in");
  else if (gh === "missing") out.push("gh: not installed");
  else if (gh === undefined) out.push("gh: no sign-in state in the doctor report");
  const claude = r.auth?.claude;
  if (claude === "not_signed_in") out.push("claude: not signed in");
  else if (claude === "missing") out.push("claude: not installed");
  else if (claude === "unknown") out.push("claude: sign-in state unknown");
  else if (claude === undefined) out.push("claude: no sign-in state in the doctor report");
  return out;
}

/** Why a clone that exists is not ready for its repository: its failing block checks, its tools. */
function repoReasons(
  slug: string,
  checks: MachineRecord["checks"],
  toolchain: MachineRepo["toolchain"] | undefined,
): string[] {
  const out = (checks ?? [])
    // A toolchain's `tool.<name>` checks are said once, from the toolchain below.
    .filter((c) => !c.ok && c.severity === "block")
    .filter((c) => toolchain === undefined || !c.id.startsWith("tool."))
    .map((c) => `${c.id}: ${c.detail}`);
  for (const t of toolchain?.missing ?? []) out.push(`${t} not installed (needed by ${slug})`);
  for (const t of toolchain?.outdated ?? [])
    out.push(`${t} older than required (needed by ${slug})`);
  return out;
}

/** One repository's clone on the machine, as the record reports it. */
function repoVerdict(
  slug: string,
  clone: {
    path: string;
    exists: boolean;
    fetched_at?: string | null | undefined;
    toolchain?: MachineRepo["toolchain"];
  },
  checks: MachineRecord["checks"],
): RepoVerdict {
  const at = { path: clone.path };
  const fetched = typeof clone.fetched_at === "string" ? { fetched_at: clone.fetched_at } : {};
  if (!clone.exists) {
    return { state: "absent", ...at, reasons: [`no clone of ${slug} at ${clone.path}`] };
  }
  const reasons = repoReasons(slug, checks, clone.toolchain);
  return { state: reasons.length > 0 ? "blocked" : "ready", ...at, reasons, ...fetched };
}

/**
 * Each repository on the machine (D6: by canonical slug): every one its record reports, and every
 * wanted one (absent when it has none). An older peer's single `repo` is its origin's slug; one
 * without an origin yet serves every wanted slug, as placement resolves its clone.
 */
function repoVerdicts(
  i: Pick<ReadinessInput, "name" | "record" | "repos">,
): Record<string, RepoVerdict> {
  const checks = i.record?.checks;
  const out: Record<string, RepoVerdict> = {};
  const has = (s: string) => Object.keys(out).some((k) => sameSlug(k, s));
  for (const r of i.repos.records ?? []) {
    if (has(r.slug)) continue;
    out[r.slug] = repoVerdict(
      r.slug,
      r,
      checks?.filter((c) => c.repo !== undefined && sameSlug(c.repo, r.slug)),
    );
  }
  const legacy = i.repos.legacy;
  const legacySlug = originToSlug(legacy?.origin);
  // Its checks carry no `repo`: its `repo.*` ones are about that one clone.
  const legacyChecks = checks?.filter((c) => c.repo === undefined && c.id.startsWith("repo."));
  if (legacy !== undefined && legacySlug !== undefined && !has(legacySlug)) {
    out[legacySlug] = repoVerdict(legacySlug, legacy, legacyChecks);
  }
  for (const s of i.repos.wanted) {
    if (has(s)) continue;
    out[s] =
      legacy !== undefined && legacy.origin === undefined
        ? repoVerdict(s, legacy, legacyChecks)
        : { state: "absent", reasons: [`no clone of ${s} on ${i.name}`] };
  }
  // Over the cap, the running waves' repositories are kept first.
  const wanted = (k: string) => i.repos.wanted.some((w) => sameSlug(w, k));
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => Number(wanted(b)) - Number(wanted(a)))
      .slice(0, REPOS_MAX)
      .map(([k, v]) => [k, { ...v, reasons: v.reasons.slice(0, REASONS_MAX).map(line) }]),
  );
}

/** The blockers, in the order a person fixes them. */
function blockers(i: ReadinessInput): string[] {
  const r = i.record;
  if (r === undefined) {
    return [`no machine record from ${i.name} yet: is its \`volley peer run\` service running?`];
  }
  const out: string[] = [];
  if (r.tunnel === "down") {
    out.push(
      `tunnel down to ${i.name}: ${r.reason === "heartbeat_timeout" ? "no heartbeat" : "disconnected"}`,
    );
  }
  const doctored = r.doctor_at !== undefined && r.checks !== undefined;
  if (!doctored) out.push("no doctor report: run volley peer doctor");
  else out.push(...doctorReasons(r, i));
  out.push(...pathReasons(i.probe, i.local, i.probeError));
  if (doctored) out.push(...authReasons(r, i));
  return out;
}

/**
 * Where `slug` stands on machine `name` from its record alone (a placement preview whose wave no
 * running wave shares, so no verdict judges it yet).
 */
export function repoVerdictFromRecord(
  name: string,
  record: MachineRecord | undefined,
  slug: string,
): RepoVerdict | undefined {
  const all = repoVerdicts({
    name,
    record,
    repos: {
      wanted: [slug],
      records: record?.repos,
      ...(record?.repo !== undefined ? { legacy: record.repo } : {}),
    },
  });
  return Object.entries(all).find(([k]) => sameSlug(k, slug))?.[1];
}

/** What placement knows about the machine of `v` (its verdict without the eligibility). */
export function machineView(
  i: Pick<ReadinessInput, "name" | "local" | "record" | "held" | "localAgents" | "downSince">,
  v: Pick<ReadinessPayload, "ready" | "reasons" | "drain" | "max_agents" | "placed" | "heavy"> &
    Partial<Pick<ReadinessPayload, "repos">>,
  usage: { account: string | null; five_hour_pct: number | null },
): MachineView {
  return {
    name: i.name,
    local: i.local,
    ...(i.record !== undefined ? { record: i.record } : {}),
    ready: v.ready,
    reasons: v.reasons,
    drain: v.drain,
    max_agents: v.max_agents,
    agents: v.placed,
    ...(i.localAgents !== undefined ? { local_agents: i.localAgents } : {}),
    ...(i.downSince !== undefined ? { down_since: i.downSince } : {}),
    heavy: v.heavy,
    ...(v.repos !== undefined ? { repos: v.repos } : {}),
    usage_pct: usage.five_hour_pct,
    ...(usage.account !== null ? { usage_account: usage.account } : {}),
    held: i.held,
  };
}

/** The verdict on one machine (pure). */
export function readiness(i: ReadinessInput): ReadinessPayload {
  const reasons = blockers(i).slice(0, REASONS_MAX).map(line);
  const ready = reasons.length === 0;
  const repos = repoVerdicts(i);
  const view = machineView(
    i,
    {
      ready,
      reasons,
      drain: i.host.drain,
      max_agents: i.host.max_agents,
      placed: i.placed,
      heavy: i.heavy,
      repos,
    },
    i.usage,
  );
  const snap = { machines: [view, ...(i.local ? (i.peers ?? []) : [])], reservations: {} };
  const why = machineIneligible(view, snap, i.filter);
  const ineligible = why[0] !== undefined ? line(why[0]) : undefined;
  const role = i.local && i.filter.local_agents !== undefined ? localRole(snap, i.filter) : null;
  return {
    name: i.name,
    ready,
    reasons,
    drain: i.host.drain,
    max_agents: i.host.max_agents,
    placed: i.placed,
    path_ok: { claude: i.probe?.claude ?? null, bun: i.probe?.bun ?? null },
    requirements: {
      volley: i.hostVersion,
      ...(i.bun !== undefined ? { bun: i.bun } : {}),
      ...(i.sharing !== undefined ? { sharing: { ...i.sharing } } : {}),
    },
    heavy: i.heavy,
    usage: i.usage,
    repos,
    eligible: ineligible === undefined,
    ...(ineligible !== undefined ? { ineligible_reason: ineligible } : {}),
    ...(role !== null
      ? {
          local_agents: {
            mode: role.mode,
            active: role.active,
            ...(role.why !== undefined ? { why: line(role.why) } : {}),
          },
        }
      : {}),
    checked_at: i.checkedAt.toISOString(),
  };
}

/**
 * The PATH probe's answer: `command -v claude bun` prints one line per name it resolves (a path,
 * a function's bare name, or `alias <name>=…`) and nothing for a missing one.
 */
export function parsePathProbe(stdout: string): PathProbe {
  const found = new Set(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => (l.startsWith("alias ") ? (l.slice(6).split("=")[0] ?? "") : basename(l))),
  );
  return { claude: found.has("claude"), bun: found.has("bun") };
}

/**
 * A verdict without `checked_at`, nor the live seconds of a peer that may be back (`down 40 s`):
 * what decides whether a re-publish carries news.
 */
export function readinessKey(p: ReadinessPayload): string {
  const { checked_at: _at, ...rest } = p;
  return JSON.stringify(rest).replace(/may be back \(down \d+ s,/g, "may be back (down _ s,");
}
