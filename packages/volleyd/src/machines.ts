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
}

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
  };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at?: string | null;
  };
  checks?: MachineCheck[];
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
  return e.payload;
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

/** `incoming`, with `prior`'s doctor fields when `prior` holds a newer doctor run. */
function keepNewerDoctor(incoming: MachineRecord, prior: MachineRecord | undefined): MachineRecord {
  if (prior?.doctor_at === undefined || incoming.doctor_at === undefined) return incoming;
  if (incoming.doctor_at >= prior.doctor_at) return incoming;
  const { versions, auth, repo, checks, doctor_at } = prior;
  return {
    ...incoming,
    ...(versions !== undefined ? { versions } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(repo !== undefined ? { repo } : {}),
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
   * run's fields.
   */
  observe(incoming: MachineRecord): void {
    const prior = this.machines.get(incoming.name);
    const status = statusOf(incoming);
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
    const heardAt = status === "up" ? this.deps.now() : (prior?.heardAt ?? this.deps.now());
    const downAt =
      status === "up" ? undefined : prior?.status === "down" ? prior.downAt : this.deps.now();
    this.machines.set(record.name, {
      record,
      status,
      heardAt,
      ...(downAt !== undefined ? { downAt } : {}),
    });
    if (prior?.status !== status) this.deps.onChange(record.name, status, record);
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
  memory?: MachineRecord["memory"];
  disk?: MachineRecord["disk"];
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

/** A report as record fields: the checks without their fix text (a record never carries it). */
export function doctorFields(r: DoctorReport): Partial<MachineRecord> {
  const pick = <K extends keyof DoctorReport>(k: K) =>
    isObject(r[k]) ? { [k]: r[k] } : ({} as Record<string, never>);
  return {
    checks: r.checks
      .slice(0, 32)
      .map(({ id, ok, severity, detail }) => ({ id, ok, severity, detail })),
    ...pick("versions"),
    ...pick("auth"),
    ...pick("repo"),
    ...pick("memory"),
    ...pick("disk"),
    doctor_at: r.doctor_at,
  };
}
