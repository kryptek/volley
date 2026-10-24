import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PathError, toPathErrors, validator } from "../schemas";

/**
 * The machine roles record (SPEC §4.6.24): which machine runs the broker, the supervisor and the
 * Desk. Kept in `$VOLLEYD_HOME/roles.json`; the daemon publishes it retained on
 * `volley/_system/roles`. Pure except for `readRoles` / `writeRoles`, the file's one reader and
 * writer.
 */

export const MACHINE_ROLES = ["broker", "supervisor", "desk"] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

export interface RolesRecord {
  broker: {
    machine: string;
    address: { ssh: string | null; mqtt_port: number; ws_port: number };
    lan: boolean;
  };
  supervisor: { machine: string };
  desk: { machine: string; url: string };
  version: number;
  updated_at: string;
  updated_by: string;
}

/** `updated_by` of the record a supervisor writes on its first start. */
export const DEFAULTS_BY = "volleyd-defaults";

export const rolesFile = (home: string) => join(home, "roles.json");

/** What the first start's record is made of: everything on the supervisor's own machine. */
export interface RolesDefaults {
  /** The supervisor's own machine name (`fleet.local_name`). */
  machine: string;
  mqttPort: number;
  wsPort: number;
  /** `setup.json`'s `lan` (false without one). */
  lan: boolean;
  deskUrl: string;
  now: string;
}

export function defaultRoles(d: RolesDefaults): RolesRecord {
  return {
    broker: {
      machine: d.machine,
      address: { ssh: null, mqtt_port: d.mqttPort, ws_port: d.wsPort },
      lan: d.lan,
    },
    supervisor: { machine: d.machine },
    desk: { machine: d.machine, url: d.deskUrl },
    version: 1,
    updated_at: d.now,
    updated_by: DEFAULTS_BY,
  };
}

/** The machines a record may name: the supervisor's own and every configured host. */
export interface KnownMachines {
  localName: string;
  hosts: readonly string[];
}

export type RolesVerdict = { ok: true; record: RolesRecord } | { ok: false; errors: PathError[] };

/** The record against `roles.schema.json`, then each role's machine against `known`. */
export function validateRoles(value: unknown, known: KnownMachines): RolesVerdict {
  const v = validator("roles.schema.json#/allOf/1/properties/payload");
  if (!v(value)) return { ok: false, errors: toPathErrors(v.errors) };
  const record = value as RolesRecord;
  const errors: PathError[] = [];
  for (const role of MACHINE_ROLES) {
    const m = record[role].machine;
    if (m === known.localName || known.hosts.includes(m)) continue;
    errors.push({
      path: `${role}.machine`,
      reason: `"${m}" is neither this machine (fleet.local_name: ${known.localName}) nor a configured host (hosts.${m})`,
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, record };
}

export type RolesRead =
  | { ok: true; record: RolesRecord; created: boolean }
  | { ok: false; error: string };

/**
 * `$VOLLEYD_HOME/roles.json`, validated. A missing file is the first start: the default is
 * written (`created: true`) so every later start reads the same record. An unreadable or invalid
 * file is refused with the reason, path-qualified, and left as it is.
 */
export function readRoles(home: string, known: KnownMachines, defaults: RolesDefaults): RolesRead {
  const file = rolesFile(home);
  if (!existsSync(file)) {
    const record = defaultRoles(defaults);
    writeRoles(home, record);
    return { ok: true, record, created: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `roles.json: ${(e as Error).message}` };
  }
  const v = validateRoles(value, known);
  if (!v.ok)
    return {
      ok: false,
      error: `roles.json: ${v.errors.map((e) => `${e.path}: ${e.reason}`).join("; ")}`,
    };
  return { ok: true, record: v.record, created: false };
}

/** The two calls a write makes; tests pass their own. */
export interface RolesFs {
  writeFileSync(path: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
}

const nodeFs: RolesFs = { writeFileSync, renameSync };

/** Atomic: a temp file beside `roles.json`, renamed over it. */
export function writeRoles(home: string, record: RolesRecord, fs: RolesFs = nodeFs): void {
  const file = rolesFile(home);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Whether two records put every role in the same place (version and authorship aside). */
export function sameRoles(a: RolesRecord, b: RolesRecord): boolean {
  // Field by field: a record read back from a file may hold its keys in another order.
  const where = (r: RolesRecord) => {
    const { machine, address, lan } = r.broker;
    return JSON.stringify([
      [machine, address.ssh, address.mqtt_port, address.ws_port, lan],
      r.supervisor.machine,
      [r.desk.machine, r.desk.url],
    ]);
  };
  return where(a) === where(b);
}
