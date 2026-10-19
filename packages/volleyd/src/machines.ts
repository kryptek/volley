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

/** One `machine.schema.json` payload. */
export interface MachineRecord {
  name: string;
  os: string;
  arch?: string;
  cores: number;
  tunnel: "up" | "down";
  reason?: "disconnect" | "heartbeat_timeout";
  load: [number, number, number];
  agents: number;
  remote_port?: number;
  last_seen: string;
}

export type MachineStatus = "up" | "down";

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
}

export class MachineHealth {
  private readonly machines = new Map<string, Entry>();
  constructor(private readonly deps: MachineHealthDeps) {}

  /**
   * Fold in a record from the broker. A down record after an up one keeps the last heartbeat's
   * values: the machine's LWT was built when it connected, so its `last_seen`, `load` and
   * `agents` may be hours old.
   */
  observe(incoming: MachineRecord): void {
    const prior = this.machines.get(incoming.name);
    const status: MachineStatus = incoming.tunnel;
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
        : incoming;
    const heardAt = status === "up" ? this.deps.now() : (prior?.heardAt ?? this.deps.now());
    this.machines.set(record.name, { record, status, heardAt });
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
      if (e.status !== "up" || now - e.heardAt < limit) continue;
      const record: MachineRecord = { ...e.record, tunnel: "down", reason: "heartbeat_timeout" };
      this.machines.set(name, { ...e, record, status: "down" });
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
