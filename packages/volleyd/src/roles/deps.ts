import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import type { RemoteHost } from "../hosts/ssh-tmux";
import type { MachineRecord } from "../machines";
import type { RemoteHostConfig } from "../types";
import type { RolesRecord } from "./record";

/**
 * What the role planners (plan-desk.ts, plan-supervisor.ts) read and run: the daemon's view of
 * its machines, its fenced exec here, a remote host for each paired machine, and the roles
 * record's writer. Nothing here is the daemon itself, so the planners test on fakes.
 */
export interface RoleDeps {
  /** The supervisor's own machine name (`fleet.local_name`). */
  localName: string;
  /** The configured hosts (`hosts`). */
  hosts: Record<string, RemoteHostConfig>;
  /** Whether this supervisor paired machine `name` (`peers.json`). */
  paired: (name: string) => boolean;
  /** Machine `name`'s record as the supervisor holds it (its own: the record it publishes). */
  record: (name: string) => MachineRecord | undefined;
  /** The supervisor's own volley version. */
  version: string;
  /** The machine roles record now. */
  roles: RolesRecord;
  /** Machine `name` as a remote host, or why it cannot be. */
  remote: (name: string) => RemoteHost | string;
  /** volleyd's fenced exec, for the steps that run on the supervisor's own machine. */
  exec: ExecFn;
  platform: NodeJS.Platform;
  uid: number;
  /** The user's home (the Desk's launchd plist is under it). */
  home: string;
  /** `$VOLLEYD_HOME`. */
  volleydHome: string;
  /** The bare host a Desk page reaches the broker's WebSocket listener at. */
  brokerHost: string;
  /** The supervisor's own machine's address on the LAN (a Desk URL there). */
  localHost: string;
  /** Whether something listens on `port` on the supervisor's own machine. */
  localPortBusy: (port: number) => Promise<boolean>;
  /** Write the roles record, journal `roles_changed` and publish it. */
  writeRoles: (r: RolesRecord) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/** The host part of an ssh destination (`user@host` → `host`). */
export const hostOf = (target: string) => target.slice(target.lastIndexOf("@") + 1);

/** Whether `have` is an older version than `want` (dot-separated numbers; the rest ignored). */
export function versionBehind(have: string, want: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const a = parts(have);
  const b = parts(want);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return have !== want;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Run `argv` on machine `where`: through the fenced exec on the supervisor's own machine, else as
 * one step of a remote script in its volley checkout. Throws when ssh itself fails.
 */
export async function runOn(d: RoleDeps, where: string, argv: string[]): Promise<ExecResult> {
  if (where === d.localName)
    return d.exec(argv, { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms });
  const host = d.remote(where);
  if (typeof host === "string") throw new Error(host);
  return host.run([{ argv, cwd: host.spec.volley_dir }], {
    timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms,
  });
}

/**
 * Why machine `to` cannot take a role now, beside the planner's own checks: not paired, down, no
 * record, behind the supervisor's version. Nothing for the supervisor's own machine.
 */
export function machineBlockers(d: RoleDeps, to: string): { why: string; fix?: string }[] {
  if (to === d.localName) return [];
  const out: { why: string; fix?: string }[] = [];
  if (!d.paired(to))
    out.push({
      why: `${to} is not a paired machine`,
      fix: `pair it: \`volley peer invite\` here, then \`volley peer join <code> --to <this machine>\` on ${to}`,
    });
  const r = d.record(to);
  if (r === undefined || r.tunnel === "down") {
    out.push({
      why: `${to} is down${r === undefined ? " (no machine record)" : ""}`,
      fix: `start its service: \`volley peer run\` on ${to}`,
    });
    return out;
  }
  const have = r.versions?.volley ?? null;
  if (have === null)
    out.push({
      why: `${to}'s volley version is not known yet (no doctor run in its record)`,
      fix: `run \`volley peer doctor\` on ${to}`,
    });
  else if (versionBehind(have, d.version))
    out.push({
      why: `${to} runs volley ${have}, behind the supervisor's ${d.version}`,
      fix: `update it: \`volley peer doctor --fix\` on ${to}`,
    });
  return out;
}
