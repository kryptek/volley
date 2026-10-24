import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../config-defaults";
import type { RemoteHost, RemoteHostSpec } from "../hosts/ssh-tmux";
import { type BundleSources, makeBundle } from "./bundle";
import { type RoleDeps, machineBlockers, runOn } from "./deps";
import { type Blocker, type MoveRecord, type MoveStep, type RolePlan, moveDir } from "./engine";
import { lastLine } from "./health";
import type { RolesRecord } from "./record";

/**
 * The supervisor move (SPEC §4.6.24; #247 / #248): the supervisor and its home go to a paired
 * machine, and the old machine becomes one of the new supervisor's paired machines.
 *
 * Preflight: a quiet fleet (no wave running, paused or releasing; no agent live), else what is
 * not quiet is shown and a `role_move { drain: true }` waits for it; the target paired, up, at
 * the supervisor's version, no failing `block` check, `gh` with write access and its Claude
 * default profile signed in (its record's `auth`); ssh from the target to every other paired
 * machine (one probe each); and the target's terminal: cmux, else tmux, else the warning that
 * agents will not run there (`fleet.local_agents: never` on the receive).
 *
 * Steps, the old supervisor's first:
 *   1. bundle    (here)    the move's handover.json, then the bundle (bundle.ts)
 *   2. copy      (target)  the bundle, as base64 on the script's stdin, to
 *                          `~/.volley/roles/<move_id>/bundle.tgz` there
 *   3. receive   (target)  `volley role receive supervisor <bundle> --from <here> …`: restores the
 *                          home, rotates volleyd's login (this process can never reconnect),
 *                          starts volleyd there
 *   4. handover  (here)    this supervisor stops (its own service unloaded); the new one goes on
 * then the new supervisor's (handover.ts, from its copy of handover.json):
 *   5. working   (target)  its own retained status is `working`
 *   6. repair    (old)     the old machine re-paired as an ssh-tmux peer (`peer join … --tunnel
 *                          none`: the broker stays there); a failure ends `done` with a warning
 *   7. record    (target)  the roles record names the target as the supervisor
 *
 * A receive that fails changes nothing on the target and the move ends `failed`; one that fails
 * after rotating volleyd's login (exit 3) has this supervisor rotate it again and restart, so the
 * old service comes back with a login no other machine knows.
 */

/** `volley role receive`'s exit when it failed after rotating volleyd's login. */
export const RECEIVE_ROTATED = 3;

/** What only the supervisor move needs of the daemon, beside `RoleDeps`. */
export interface SupervisorDeps {
  /** The waves that are not quiet: running, paused or releasing. */
  busyWaves: () => { wave: string; status: string }[];
  /** The live (or spawning) supervised agents and the machine each runs on. */
  liveAgents: () => { agent_id: string; machine: string }[];
  /** What travels (bundle.ts). */
  bundle: BundleSources;
  /** This supervisor's volley checkout (the old machine's `volley_dir` once it is re-paired). */
  volleyDir: string;
  /** Rotate this supervisor's own broker login and write its broker.json (a failed receive). */
  rotateOwn: () => Promise<void>;
  /** This supervisor is handing itself over: losing the broker is expected from now on. */
  handingOver: (moveId: string) => void;
}

/** What the old supervisor leaves the new one, in the bundle (`roles/<move_id>/handover.json`). */
export interface Handover {
  move_id: string;
  role: "supervisor";
  from: string;
  to: string;
  by: string;
  /** How the old machine reaches the target over ssh (its `hosts.<to>.target`). */
  new_target: string;
  /** How the target reaches the old machine (the target's peer.json `host`; the receive adds it). */
  old_target?: string;
  /** The old machine's volley checkout. */
  volley_dir: string;
  /** The broker port the old machine's agents reach (it stays there: `tunnel: none`). */
  broker_port: number;
  /** The terminal the old machine re-pairs with (cmux falls back to tmux over ssh for now). */
  terminal: "cmux" | "tmux";
  /** The move's record as the old supervisor left it (its steps done so far). */
  record: MoveRecord | null;
  /** Set by the new supervisor once it took the move on. */
  continued?: boolean;
}

export const handoverFile = (home: string, moveId: string) =>
  join(moveDir(home, moveId), "handover.json");

/** The step ids the old supervisor runs; the rest are the new one's (handover.ts). */
export const OLD_STEPS = ["bundle", "copy", "receive", "handover"] as const;

/** The target's terminal from its record: cmux, else tmux, else none. */
export function targetTerminal(d: RoleDeps, to: string): "cmux" | "tmux" | null {
  const v = (d.record(to)?.versions ?? {}) as Record<string, string | null | undefined>;
  if (typeof v.cmux === "string") return "cmux";
  if (typeof v.tmux === "string") return "tmux";
  return null;
}

/** The receive's argv on the target. */
export function receiveArgv(
  bundle: string,
  from: string,
  terminal: "cmux" | "tmux" | null,
  brokerPort: number,
): string[] {
  return [
    "volley",
    "role",
    "receive",
    "supervisor",
    bundle,
    "--from",
    from,
    ...(terminal !== null ? ["--local-terminal", terminal] : ["--local-agents", "never"]),
    "--broker-url",
    `mqtt://127.0.0.1:${brokerPort}`,
  ];
}

/** `role_plan { role: "supervisor", to, terminal? }`: the plan, or a refusal (a string). */
export async function planSupervisor(
  d: RoleDeps,
  s: SupervisorDeps,
  p: { to: string; terminal?: "cmux" | "tmux"; by: string },
): Promise<RolePlan | string> {
  const { to } = p;
  const from = d.roles.supervisor.machine;
  if (to === from || to === d.localName) return `supervisor already runs on ${to}`;
  if (!Object.hasOwn(d.hosts, to))
    return `unknown machine "${to}": neither this machine (${d.localName}) nor a configured host`;
  const waits: Blocker[] = [
    ...s.busyWaves().map(({ wave, status }) => ({
      why: `wave ${wave} is ${status}`,
      fix: `stop it (\`volleyd stop ${wave}\`; it resumes on the new supervisor with \`volleyd resume ${wave}\`), or move when idle (drain: true)`,
    })),
    ...s.liveAgents().map(({ agent_id, machine }) => ({
      why: `agent ${agent_id} is live on ${machine}`,
      fix: "let it finish, or move when idle (drain: true)",
    })),
  ];
  const blocked = machineBlockers(d, to);
  const warnings: string[] = [];
  const up = !blocked.some((b) => b.why.startsWith(`${to} is down`));
  const record = d.record(to);
  if (up && record !== undefined) {
    const gh = record.auth?.gh;
    if (gh !== "ok")
      blocked.push({
        why:
          gh === "no_write"
            ? `${to}'s gh login has no write access to the repositories`
            : `${to}'s gh is ${gh ?? "not checked yet"}`,
        fix: `\`gh auth login\` on ${to} with an account that can push`,
      });
    if (record.auth?.claude !== "signed_in")
      blocked.push({
        why: `${to}'s Claude default profile is ${record.auth?.claude ?? "not checked yet"}`,
        fix: `sign it in: \`claude\` on ${to}, or Settings › Claude accounts`,
      });
    for (const c of record.checks ?? [])
      if (!c.ok && c.severity === "block")
        blocked.push({ why: `${to}: ${c.detail}`, fix: `\`volley peer doctor --fix\` on ${to}` });
    blocked.push(...(await sshBack(d, to)));
  }
  const terminal = up ? targetTerminal(d, to) : null;
  if (up && terminal === null)
    warnings.push(
      `agents will not run on ${to}: it has neither cmux nor tmux (fleet.local_agents: never there)`,
    );
  const repair = p.terminal ?? "tmux";
  if (repair === "cmux")
    warnings.push(
      `${from} re-pairs as a tmux machine over ssh: running its agents in cmux over ssh is not supported yet`,
    );
  return {
    role: "supervisor",
    from,
    to,
    steps: supervisorSteps(d, s, { from, to, terminal, repair, by: p.by }),
    blocked,
    waits,
    warnings,
    terminal: [],
    after: [
      `The supervisor runs on ${to}; ${from} becomes one of its paired machines (agents there run in tmux over ssh).`,
      "Stopped waves come back stopped: resume each with `volleyd resume <wave>`.",
      "What does not travel: worktrees, cmux.json, logs, Claude sign-ins and profile directories.",
    ],
    kept: { roles: d.roles },
  };
}

/** The ssh-back probe: the target must reach every other paired machine (it will spawn there). */
async function sshBack(d: RoleDeps, to: string): Promise<Blocker[]> {
  const host = d.remote(to);
  if (typeof host === "string") return [{ why: `${to}: ${host}` }];
  const others = Object.entries(d.hosts).filter(
    ([name, h]) => name !== to && typeof h.target === "string",
  );
  const probes = await Promise.all(
    others.map(async ([name, h]) => {
      const argv = [
        "ssh",
        "-n",
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${DAEMON_DEFAULTS.role_ssh_probe_timeout_s}`,
        h.target as string,
        "true",
      ];
      const r = await host
        .run([{ argv }], { timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms })
        .catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
      return r.code === 0
        ? null
        : ({
            why: `${to} cannot ssh to ${name} (${h.target}): ${lastLine(r)}`,
            fix: `authorise ${to}'s ssh key on ${name}`,
          } as Blocker);
    }),
  );
  return probes.filter((b): b is Blocker => b !== null);
}

/** Every step of the move; the new supervisor's (5-7) run from handover.ts. */
export function supervisorSteps(
  d: RoleDeps,
  s: SupervisorDeps,
  o: {
    from: string;
    to: string;
    terminal: "cmux" | "tmux" | null;
    repair: "cmux" | "tmux";
    by: string;
  },
): MoveStep[] {
  const { from, to } = o;
  const brokerPort = d.hosts[to]?.tunnel?.remote_port ?? REMOTE_HOST_DEFAULTS.remote_port;
  let moveId = "";
  let remoteBundle = "";
  const target = (): RemoteHost => {
    const h = d.remote(to);
    if (typeof h === "string") throw new Error(h);
    return h;
  };
  const old: MoveStep[] = [
    {
      id: "bundle",
      title: `Bundle the supervisor's home on ${from}`,
      where: from,
      detail: "tar -czf <bundle> (waves, config, registries, the auth dir's logins)",
      run: async ({ move_id }) => {
        moveId = move_id;
        const dir = moveDir(d.volleydHome, moveId);
        const record = readRecord(dir);
        const handover: Handover = {
          move_id: moveId,
          role: "supervisor",
          from,
          to,
          by: o.by,
          new_target: d.hosts[to]?.target ?? to,
          volley_dir: s.volleyDir,
          broker_port: d.roles.broker.address.mqtt_port,
          terminal: o.repair,
          record,
        };
        writeFileSync(
          handoverFile(d.volleydHome, moveId),
          `${JSON.stringify(handover, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        const b = await makeBundle(d.exec, s.bundle, {
          move_id: moveId,
          from,
          to,
          with_broker: false,
          dir,
        });
        return `${b.manifest.files.length} files bundled`;
      },
    },
    {
      id: "copy",
      title: `Copy the bundle to ${to}`,
      where: to,
      detail: "base64 -d > ~/.volley/roles/<move_id>/bundle.tgz",
      run: async () => {
        const h = target();
        const home = await h.run([{ argv: ["printenv", "HOME"] }]);
        const dir = home.stdout.trim();
        if (home.code !== 0 || !dir.startsWith("/"))
          throw new Error(`no home directory on ${to}: ${lastLine(home)}`);
        remoteBundle = `${dir}/.volley/roles/${moveId}/bundle.tgz`;
        const bytes = readFileSync(join(moveDir(d.volleydHome, moveId), "bundle.tgz"));
        const r = await h.run(
          [
            { argv: ["mkdir", "-p", `${dir}/.volley/roles/${moveId}`] },
            { argv: ["base64", "-d"], stdin: bytes.toString("base64"), stdout: remoteBundle },
          ],
          { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms },
        );
        if (r.code !== 0) throw new Error(`copy to ${to}: ${lastLine(r)}`);
        return `${bytes.length} bytes at ${remoteBundle}`;
      },
    },
    {
      id: "receive",
      title: `Receive the supervisor on ${to}`,
      where: to,
      detail: receiveArgv("<bundle>", from, o.terminal, brokerPort).join(" "),
      run: async () => {
        s.handingOver(moveId);
        const r = await runOn(d, to, receiveArgv(remoteBundle, from, o.terminal, brokerPort));
        if (r.code === 0) return "volleyd started there";
        if (r.code === RECEIVE_ROTATED) await s.rotateOwn();
        throw new Error(`volley role receive on ${to}: ${lastLine(r)}`);
      },
    },
    {
      id: "handover",
      title: `Stop the supervisor on ${from}; ${to} continues the move`,
      where: from,
      detail: "unload volleyd here",
      handover: true,
      run: async () => "handing over",
    },
  ];
  return [...old, ...newSteps(o.from, o.to)];
}

/** The new supervisor's steps as the plan shows them (handover.ts gives them their runners). */
export function newSteps(from: string, to: string): MoveStep[] {
  const pending = async (): Promise<string> => {
    throw new Error("runs on the new supervisor");
  };
  return [
    {
      id: "working",
      title: `The supervisor on ${to} is working`,
      where: to,
      detail: "status working",
      health: true,
      run: pending,
    },
    {
      id: "repair",
      title: `Re-pair ${from} as a paired machine`,
      where: from,
      detail: "volley peer join --tunnel none",
      run: pending,
    },
    {
      id: "record",
      title: `Record the supervisor on ${to}`,
      where: to,
      detail: `supervisor: ${to}`,
      run: pending,
    },
  ];
}

function readRecord(dir: string): MoveRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, "move.json"), "utf-8")) as MoveRecord;
  } catch {
    return null;
  }
}

/** The roles record with the supervisor on `machine`, one version on. */
export function withSupervisor(
  r: RolesRecord,
  machine: string,
  by: string,
  now: Date,
): RolesRecord {
  return {
    ...r,
    supervisor: { machine },
    version: r.version + 1,
    updated_at: now.toISOString(),
    updated_by: by,
  };
}

/** The old machine as a remote host for the re-pairing (it is not a configured host yet). */
export const oldMachineSpec = (h: Handover): RemoteHostSpec => ({
  name: h.from,
  target: h.old_target ?? h.from,
  volley_dir: h.volley_dir,
  tunnel: { remote_port: h.broker_port, supervise: false },
});
