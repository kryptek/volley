import { basename } from "node:path";
import { derivedMaxAgents } from "volley-cli/peer/machine";
import type { Sharing } from "./claude/sharing";
import { REMOTE_HOST_DEFAULTS } from "./config-defaults";
import { PATH_PROBE_TOOLS } from "./fence";
import { type MachineRecord, machineTopic } from "./machines";
import { type FilterOptions, type MachineView, localRole, machineIneligible } from "./placement";
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
 * push access or Claude signed out. `eligible` / `ineligible_reason` are placement's own machine
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
  /** The supervisor's own clone's origin (its doctor's `repo.origin`), when known. */
  hostOrigin?: string | null;
  /**
   * The supervisor's own machine whose doctor ran without a wave repo (no wave is running): its
   * `repo.*` checks say only that no repo was given, so they do not count.
   */
  noRepo?: boolean;
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
  eligible: boolean;
  ineligible_reason?: string;
  /** The supervisor's own machine only: its `fleet.local_agents` mode and whether the fallback is in force. */
  local_agents?: { mode: LocalAgentsMode; active: boolean; why?: string };
  checked_at: string;
}

const line = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);

/** `github.com/owner/repo` → `owner/repo` (what `gh` calls it). */
const slug = (origin: string | undefined) =>
  origin === undefined ? "the wave repo" : origin.split("/").slice(1).join("/");

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
    if (i.noRepo === true && c.id.startsWith("repo.")) continue;
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
  if (gh === "no_write") out.push(`gh: no write permission on ${slug(r.repo?.origin)}`);
  else if (gh === "unauthenticated") out.push("gh: not signed in");
  else if (gh === "missing") out.push("gh: not installed");
  else if (gh === undefined) out.push("gh: no sign-in state in the doctor report");
  const claude = r.auth?.claude;
  if (claude === "not_signed_in") out.push("claude: not signed in");
  else if (claude === "missing") out.push("claude: not installed");
  else if (claude === "unknown") out.push("claude: sign-in state unknown");
  else if (claude === undefined) out.push("claude: no sign-in state in the doctor report");
  const origin = r.repo?.origin;
  const hostOrigin = i.hostOrigin ?? undefined;
  if (origin !== undefined && hostOrigin !== undefined && origin !== hostOrigin) {
    out.push(`repo origin differs from the host's (${origin}, host: ${hostOrigin})`);
  }
  return out;
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

/** What placement knows about the machine of `v` (its verdict without the eligibility). */
export function machineView(
  i: Pick<ReadinessInput, "name" | "local" | "record" | "held" | "localAgents" | "downSince">,
  v: Pick<ReadinessPayload, "ready" | "reasons" | "drain" | "max_agents" | "placed" | "heavy">,
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
    usage_pct: usage.five_hour_pct,
    ...(usage.account !== null ? { usage_account: usage.account } : {}),
    held: i.held,
  };
}

/** The verdict on one machine (pure). */
export function readiness(i: ReadinessInput): ReadinessPayload {
  const reasons = blockers(i).slice(0, REASONS_MAX).map(line);
  const ready = reasons.length === 0;
  const view = machineView(
    i,
    {
      ready,
      reasons,
      drain: i.host.drain,
      max_agents: i.host.max_agents,
      placed: i.placed,
      heavy: i.heavy,
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
