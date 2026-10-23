import type { ProbeLogin } from "./claude/usage";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { validator } from "./schemas";

/**
 * Paired machines' health (SPEC §4.6.14). A machine paired with `volley peer join` publishes its
 * record, retained, on `volley/_system/machines/<name>` every heartbeat through its own tunnel, so
 * a record that arrives means the tunnel works; its LWT republishes the record with
 * `tunnel: "down"`. `MachineHealth` folds those records in on the supervisor's clock (never the
 * machine's, which may be skewed) and marks a machine whose heartbeat stopped for
 * `machine_down_after_ms` down: spawns on its host park until it is back. Running agents are
 * never touched.
 */

export const MACHINE_CHANNEL = "_system/machines";
export const MACHINES_FILTER = "volley/_system/machines/+";
export const machineTopic = (name: string) => `volley/_system/machines/${name}`;

/** One doctor check as a record carries it (no fix text). */
export interface MachineCheck {
  id: string;
  ok: boolean;
  severity: "block" | "warn";
  detail: string;
  /** The repository (`owner/name`) a per-repository check is about (#435). */
  repo?: string;
}

/** One repository a machine works on, as its doctor last found it (#435). */
export interface MachineRepo {
  slug: string;
  path: string;
  exists: boolean;
  origin?: string;
  /** The managed clone (fast-forwarded by the doctor); false: an adopted one (fetched only). */
  managed: boolean;
  fetched_at: string | null;
  release_branch?: string;
  /** The tools it needs that the machine lacks or has too old: either blocks it only. */
  toolchain: { ok: boolean; missing: string[]; outdated: string[] };
}

/** Most checks a record carries (machine.schema.json's `checks.maxItems`). */
const MAX_CHECKS = 128;
/** Most repositories a record carries (machine.schema.json's `repos.maxItems`). */
const MAX_REPOS = 64;

/** One `machine.schema.json` payload (SPEC §4.6.14, plus the Fleet fields of §4.6.15). */
export interface MachineRecord {
  name: string;
  /** `supervisor`: the supervisor's own machine, published by volleyd. Absent: `peer`. */
  kind?: "peer" | "supervisor";
  os: string;
  arch?: string;
  cores: number;
  /** `local`: the supervisor's own machine, which needs no tunnel. */
  tunnel: "up" | "down" | "local";
  reason?: "disconnect" | "heartbeat_timeout";
  load: [number, number, number];
  agents: number;
  remote_port?: number;
  memory?: { total_mb: number; available_pct: number };
  disk?: { path: string; free_gb: number; free_pct: number };
  uptime_s?: number;
  versions?: {
    peer: string | null;
    volley: string | null;
    bun: string | null;
    git: string | null;
  } & Partial<Record<"node" | "gh" | "tmux" | "claude", string | null>>;
  auth?: {
    gh: "ok" | "unauthenticated" | "missing" | "no_write";
    claude: "signed_in" | "not_signed_in" | "missing" | "unknown";
    trust: "ok" | "missing" | "unknown";
    claude_plan?: string | null;
    /** The default profile's identity (claude/identity.ts), only while it is signed in. */
    claude_email?: string;
    claude_org?: string;
  };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at?: string | null;
  };
  /** Each repository the machine works on (peer.json's `repos`). */
  repos?: MachineRepo[];
  checks?: MachineCheck[];
  /** Each login's usage probe reading (SPEC §4.6.12): numbers and states only. */
  claude_logins?: ProbeLogin[];
  doctor_at?: string;
  last_seen: string;
}

export type MachineStatus = "up" | "down";

/** A record's status: the supervisor's own machine (`tunnel: local`) is always up. */
export const statusOf = (r: MachineRecord): MachineStatus => (r.tunnel === "down" ? "down" : "up");

/**
 * The record carried by a retained message on `topic`, or null: not a schema-valid machine
 * envelope, a record for another name than the topic's, or a publisher that is neither the
 * machine itself nor the supervisor (the broker ACL already allows only those two).
 */
export function parseMachine(topic: string, raw: string): MachineRecord | null {
  return parseMachineFrom(topic, raw)?.record ?? null;
}

/** As `parseMachine`, with who published the record (the machine itself, or `volleyd`). */
export function parseMachineFrom(
  topic: string,
  raw: string,
): { record: MachineRecord; by: string } | null {
  if (raw === "") return null;
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validator("machine.schema.json")(env)) return null;
  const e = env as { agent_id: string; payload: MachineRecord };
  const name = topic.split("/")[3];
  if (e.payload.name !== name) return null;
  if (e.agent_id !== name && e.agent_id !== "volleyd") return null;
  return { record: e.payload, by: e.agent_id };
}

/** Why a machine is down, as a task's why_waiting reads it (`limitMs`: the heartbeat timeout). */
export function downReason(
  r: MachineRecord,
  limitMs: number = DAEMON_DEFAULTS.machine_down_after_ms,
): string {
  return r.reason === "heartbeat_timeout"
    ? `no heartbeat for ${Math.round(limitMs / 1000)} s`
    : "disconnected";
}

export interface MachineHealthDeps {
  now: () => number;
  /** A machine went up or down (after `observe` or `sweep`). */
  onChange: (name: string, status: MachineStatus, record: MachineRecord) => void;
  /** Default `machine_down_after_ms`. */
  downAfterMs?: number;
}

interface Entry {
  record: MachineRecord;
  status: MachineStatus;
  /** When the supervisor last received an `up` record (its own clock). */
  heardAt: number;
  /** When it went down (its own clock); undefined while it is up. */
  downAt?: number;
}

/**
 * `incoming`, with `prior`'s doctor fields when `prior` holds a newer doctor run. A run's
 * `doctor_at` is when it started, so a heartbeat carrying a run that began before a Repair never
 * replaces the Repair's fold, however late that run ended.
 */
function keepNewerDoctor(incoming: MachineRecord, prior: MachineRecord | undefined): MachineRecord {
  if (prior?.doctor_at === undefined || incoming.doctor_at === undefined) return incoming;
  // As instants: the schema allows any date-time form (offsets, fraction lengths).
  if (!(Date.parse(incoming.doctor_at) < Date.parse(prior.doctor_at))) return incoming;
  const { versions, auth, repo, repos, checks, doctor_at } = prior;
  return {
    ...incoming,
    ...(versions !== undefined ? { versions } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(repos !== undefined ? { repos } : {}),
    ...(checks !== undefined ? { checks } : {}),
    doctor_at,
  };
}

export class MachineHealth {
  private readonly machines = new Map<string, Entry>();
  constructor(private readonly deps: MachineHealthDeps) {}

  /**
   * Fold in a record from the broker. A down record after an up one keeps the last heartbeat's
   * values: the machine's LWT was built when it connected, so its `last_seen`, `load` and
   * `agents` may be hours old. An up record whose doctor run is older than the one held (a
   * supervisor-run doctor folded in before the box's service re-ran its own) keeps the newer
   * run's fields, and says so (`true`), for the supervisor to re-assert them. `heard: false`
   * folds a record the supervisor made itself (a Repair's fold, or its echo): it is no heartbeat,
   * so the machine's down timer keeps running, and it never brings a down machine back up.
   */
  observe(incoming: MachineRecord, opts: { heard?: boolean } = {}): boolean {
    const prior = this.machines.get(incoming.name);
    const status = statusOf(incoming);
    if (opts.heard === false && status === "up" && prior?.status === "down") return false;
    const record: MachineRecord =
      status === "down" && prior !== undefined
        ? {
            ...prior.record,
            tunnel: "down",
            reason: incoming.reason ?? "disconnect",
            last_seen:
              incoming.last_seen > prior.record.last_seen
                ? incoming.last_seen
                : prior.record.last_seen,
          }
        : keepNewerDoctor(incoming, prior?.record);
    const heard = status === "up" && opts.heard !== false;
    const heardAt = heard || prior === undefined ? this.deps.now() : prior.heardAt;
    const downAt =
      status === "up" ? undefined : prior?.status === "down" ? prior.downAt : this.deps.now();
    this.machines.set(record.name, {
      record,
      status,
      heardAt,
      ...(downAt !== undefined ? { downAt } : {}),
    });
    if (prior?.status !== status) this.deps.onChange(record.name, status, record);
    return status === "up" && record.doctor_at !== incoming.doctor_at;
  }

  /**
   * Mark every up machine whose last record is older than the limit down
   * (`reason: heartbeat_timeout`). Returns those records, for the supervisor to republish.
   */
  sweep(): MachineRecord[] {
    const limit = this.limitMs();
    const now = this.deps.now();
    const down: MachineRecord[] = [];
    for (const [name, e] of this.machines) {
      // The supervisor's own machine publishes no heartbeat to miss: it is always up.
      if (e.status !== "up" || e.record.tunnel === "local" || now - e.heardAt < limit) continue;
      const record: MachineRecord = { ...e.record, tunnel: "down", reason: "heartbeat_timeout" };
      this.machines.set(name, { ...e, record, status: "down", downAt: now });
      down.push(record);
      this.deps.onChange(name, "down", record);
    }
    return down;
  }

  /** Why `r`'s machine is down, with this monitor's heartbeat timeout. */
  whyDown(r: MachineRecord): string {
    return downReason(r, this.limitMs());
  }

  private limitMs(): number {
    return this.deps.downAfterMs ?? DAEMON_DEFAULTS.machine_down_after_ms;
  }

  /** The machine's status; undefined for a host that never published a record. */
  status(name: string): MachineStatus | undefined {
    return this.machines.get(name)?.status;
  }

  /**
   * When the supervisor marked the machine down (its own clock, epoch ms); undefined while it is
   * up or unknown. A `machine_down` decision opens `placement.down_decision_after_s` after it.
   */
  downSince(name: string): number | undefined {
    return this.machines.get(name)?.downAt;
  }

  record(name: string): MachineRecord | undefined {
    return this.machines.get(name)?.record;
  }

  all(): MachineRecord[] {
    return [...this.machines.values()].map((e) => e.record);
  }

  /** A removed peer: forgotten without a status change. */
  forget(name: string): void {
    this.machines.delete(name);
  }
}

/** `volley peer doctor --json` (volley-cli): the record's doctor fields, plus each check's fix. */
export interface DoctorReport {
  checks: (MachineCheck & { fix?: string })[];
  versions?: MachineRecord["versions"];
  auth?: MachineRecord["auth"];
  repo?: MachineRecord["repo"];
  repos?: MachineRepo[];
  memory?: MachineRecord["memory"];
  disk?: MachineRecord["disk"];
  claude_logins?: ProbeLogin[];
  /** Under `--fix`: the fixes it applied (the report's journal; never in the record). */
  fixes?: { id: string; repo?: string; command: string; ok: boolean }[];
  doctor_at: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The doctor's JSON report from its stdout, or null when it printed none. */
export function parseDoctorReport(stdout: string): DoctorReport | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObject(v) || !Array.isArray(v.checks) || typeof v.doctor_at !== "string") return null;
  return v as unknown as DoctorReport;
}

/**
 * At most `MAX_CHECKS`, in the report's order. Over the cap, the machine-level checks are kept
 * first, then failing per-repository ones: many repositories never push out a failing `gh.*` or
 * `claude.*` check, which readiness reads.
 */
function keptChecks<C extends { ok: boolean; repo?: string }>(checks: C[]): C[] {
  if (checks.length <= MAX_CHECKS) return checks;
  const rank = (c: C) => (c.repo === undefined ? 0 : c.ok ? 2 : 1);
  const kept = new Set(
    checks
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
      .slice(0, MAX_CHECKS)
      .map(({ i }) => i),
  );
  return checks.filter((_, i) => kept.has(i));
}

/**
 * A doctor run folded into a machine's record: the run's fields replace the record's. A report
 * without `repo` or `repos` (its last repository removed, or a second one added) clears the
 * record's, which would otherwise outlive the run until the machine's next heartbeat.
 */
export function withDoctor(prior: MachineRecord, r: DoctorReport): MachineRecord {
  const { repo: _repo, repos: _repos, ...rest } = prior;
  return { ...rest, ...doctorFields(r) };
}

/** A report as record fields: the checks without their fix text (a record never carries it). */
export function doctorFields(r: DoctorReport): Partial<MachineRecord> {
  const pick = <K extends keyof DoctorReport>(k: K) =>
    isObject(r[k]) ? { [k]: r[k] } : ({} as Record<string, never>);
  return {
    checks: keptChecks(r.checks).map(({ id, ok, severity, detail, repo }) => ({
      id,
      ok,
      severity,
      detail,
      ...(repo !== undefined ? { repo } : {}),
    })),
    ...pick("versions"),
    ...pick("auth"),
    ...pick("repo"),
    ...(Array.isArray(r.repos) ? { repos: r.repos.slice(0, MAX_REPOS) } : {}),
    ...pick("memory"),
    ...pick("disk"),
    ...(Array.isArray(r.claude_logins) ? { claude_logins: r.claude_logins.slice(0, 16) } : {}),
    doctor_at: r.doctor_at,
  };
}

/**
 * The supervisor's own doctor (#436) runs once per running wave's clone (`--repo <dir>`); its
 * reports fold into one: the machine-level fields and checks from the first, and per clone its
 * `repo.*` checks (tagged with its slug) and one `repos[]` entry, the first clone of a slug
 * winning. A clone whose slug is unknown (a repository not on GitHub) keeps its checks untagged.
 * The legacy `repo` is kept only when exactly one clone ran, as a peer's doctor does.
 */
export function foldOwnDoctor(
  runs: { slug?: string | undefined; report: DoctorReport }[],
): DoctorReport | null {
  const first = runs[0]?.report;
  if (first === undefined) return null;
  const isRepoCheck = (c: { id: string; repo?: string }) =>
    c.repo !== undefined || c.id.startsWith("repo.");
  const checks: DoctorReport["checks"] = first.checks.filter((c) => !isRepoCheck(c));
  const repos: MachineRepo[] = [];
  for (const { slug, report } of runs) {
    if (slug !== undefined && repos.some((r) => r.slug.toLowerCase() === slug.toLowerCase())) {
      continue;
    }
    const own = report.checks.filter(isRepoCheck);
    checks.push(...(slug === undefined ? own : own.map((c) => ({ ...c, repo: c.repo ?? slug }))));
    if (slug === undefined) continue;
    const reported = report.repos?.find((r) => r.slug.toLowerCase() === slug.toLowerCase());
    if (reported !== undefined) repos.push({ ...reported, slug });
    else if (report.repo !== undefined) {
      const r = report.repo;
      repos.push({
        slug,
        path: r.path,
        exists: r.exists,
        ...(r.origin !== undefined ? { origin: r.origin } : {}),
        managed: false,
        fetched_at: r.fetched_at ?? null,
        ...(r.release_branch !== undefined ? { release_branch: r.release_branch } : {}),
        // `--repo` runs no per-repository toolchain check: nothing is held against it.
        toolchain: { ok: true, missing: [], outdated: [] },
      });
    }
  }
  const { repo: _repo, repos: _repos, checks: _checks, ...rest } = first;
  return {
    ...rest,
    checks,
    ...(runs.length === 1 && first.repo !== undefined ? { repo: first.repo } : {}),
    ...(repos.length > 0 ? { repos } : {}),
  };
}

/**
 * The own doctor's clones whose run failed this time (`failed`, by slug) keep what the last
 * report said of them (#436): their `repos[]` entry and their `repo.*` checks, so a clone the
 * machine has is never judged absent over a failed run. The legacy `repo` goes once more than
 * one clone is held.
 */
export function carryFailedClones(
  folded: DoctorReport | null,
  prior: DoctorReport | null | undefined,
  failed: string[],
): DoctorReport | null {
  if (folded === null || !prior || failed.length === 0) return folded;
  const same = (a: string) => (b: string) => a.toLowerCase() === b.toLowerCase();
  const held = (slug: string) => (folded.repos ?? []).some((r) => same(r.slug)(slug));
  const carry = failed.filter((slug) => !held(slug));
  const repos = (prior.repos ?? []).filter((r) => carry.some(same(r.slug)));
  if (repos.length === 0) return folded;
  const checks = prior.checks.filter((c) => c.repo !== undefined && carry.some(same(c.repo)));
  const { repo: _repo, ...rest } = folded;
  return {
    ...rest,
    checks: [...folded.checks, ...checks],
    repos: [...(folded.repos ?? []), ...repos],
  };
}
