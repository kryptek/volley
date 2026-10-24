import { constants, accessSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LayoutName } from "volley-cli/auth/config";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { RemoteHost } from "../hosts/ssh-tmux";
import { isSshDestination } from "../peers";
import { makeBrokerBundle } from "./bundle";
import { type RoleDeps, hostOf, machineBlockers, runOn } from "./deps";
import { type Blocker, type MoveRecord, type MoveStep, type RolePlan, moveDir } from "./engine";
import { lastLine } from "./health";
import { deskPortOf } from "./plan-desk";
import type { RolesRecord } from "./record";

/**
 * The broker move (SPEC §4.6.24): the MQTT broker goes from the supervisor's machine to a paired
 * machine, and every client is re-pointed at it. The most invasive move: every connection,
 * volleyd's own and the requester's, ends when the old broker stops, so the move is answered as
 * it starts (`handing_over`, as a supervisor move is) and volleyd goes on without a broker,
 * reconnecting once the move ends (its service manager restarts it on the lost connection; at
 * start it republishes every retained topic it owns, the move's included).
 *
 * Preflight: a quiet fleet (or `drain`); the broker on the supervisor's own machine as
 * `volley setup` recorded it, its state file readable here; the target paired, up, at the
 * supervisor's version; one probe there (`volley broker probe`: mosquitto ≥ 2.1 and its layout,
 * from volley-cli's layouts); ssh from the supervisor's machine and from every other paired
 * machine to `address` (one `ssh -o BatchMode=yes <address> true` each, every paired machine up);
 * with `lan`, the target's port 9001 reachable from the Desk's host (anonymous refused or
 * accepted, never unreachable: setup's `probeAnonymous`). A target whose install is root's
 * (`snap`, `etc`) gets its receive as a terminal command (`sudo volley broker receive …`), which
 * the move waits for.
 *
 * Steps:
 *   1. stop      (here)    the old broker stopped through its layout (`brew services stop
 *                          mosquitto`, `sudo -n snap stop mosquitto`, `sudo -n systemctl stop
 *                          mosquitto`); undo: started again
 *   2. bundle    (here)    its state file, admin login and the choices (bundle.ts); its
 *                          persistence DB never travels: the new broker starts empty
 *   3. copy      (target)  to `~/.volley/roles/broker/bundle.tgz` there
 *   4. receive   (target)  `volley broker receive <bundle> --lan|--no-lan`, or the owner's
 *                          terminal step waited for (`--check`)
 *   5. tunnel    (here)    this machine's own tunnel to `address` at the broker's old port, and
 *                          volleyd's unit pointed at it; undo: `volley broker tunnel --off`
 *   6. health    (here)    volleyd's login through the tunnel, `$SYS/broker/version`, both
 *                          listeners refuse anonymous clients
 *   7. retarget-N (each)   `peer_retarget` every paired machine (the target: `tunnel: none`),
 *                          each up through the new broker within the grace; undo: back to the
 *                          tunnel it had (`volley broker tunnel --show` read it first)
 *   8. desk      (Desk's)  `volley desk install --port <p> --broker-host <new host>`, idempotent
 *   9. record    (here)    `roles.broker` names the target and `address`
 *
 * A failure undoes the steps done, in reverse: every peer back, the own tunnel off, the old
 * broker started. `role_rollback` after a done move does the same from the move's record.
 */

/** The listeners `volley broker receive` sets up (auth/config.ts generateConfig: 1883, 9001). */
const NEW_MQTT = DAEMON_DEFAULTS.mqtt_default_port;
const NEW_WS = DAEMON_DEFAULTS.ws_default_port;
const ROOT_LAYOUTS: readonly string[] = ["snap", "etc"];
/** Where the bundle goes on the target, under its home (a path the owner can type as `~/…`). */
const BUNDLE_REL = ".volley/roles/broker/bundle.tgz";

/** What only a broker move needs of the daemon, beside `RoleDeps`. */
export interface BrokerDeps {
  /** The waves that are not quiet: running, paused or releasing. */
  busyWaves: () => { wave: string; status: string }[];
  /** The live (or spawning) supervised agents and the machine each runs on. */
  liveAgents: () => { agent_id: string; machine: string }[];
  /** The broker install here as `volley setup` recorded it (setup.json), or null. */
  install: () => { layout: LayoutName; stateFile: string; authDir: string } | null;
  /** volleyd's own broker URL (what its service's `VOLLEY_BROKER_URL` names). */
  brokerUrl: string;
  /**
   * Point volleyd's own service at `url` for its next start (a systemd unit: rewritten and
   * reloaded); the step's line, and how to put it back.
   */
  unitUrl: (url: string) => Promise<{ line: string; undo: () => Promise<void> }>;
  /** A login as volleyd at `url` (the health check's; a peer's record read through it). */
  connect: (url: string) => Promise<ProbeLink>;
  /** An anonymous CONNECT to a listener (setup's `probeAnonymous`). */
  probeAnonymous: (url: string) => Promise<"refused" | "accepted" | "unreachable">;
  /**
   * `peer_retarget { name, address, port?, tunnel? }` as `by`: null once it ran and `up` said the
   * machine came up, else why not.
   */
  retarget: (
    r: { name: string; address: string; port?: number; tunnel?: "ssh" | "none" },
    by: string,
    up: (name: string, since: number) => Promise<boolean>,
  ) => Promise<string | null>;
  /** The broker moves under volleyd from now until `null`: its lost connection waits for it. */
  moving: (moveId: string | null) => void;
}

/** A connection as volleyd to one broker. */
export interface ProbeLink {
  /** The broker's retained `$SYS/broker/version`, or null. */
  sysVersion: () => Promise<string | null>;
  /** Machine `name`'s retained record there, or null. */
  machine: (name: string) => Promise<{ tunnel: string; last_seen: string } | null>;
  close: () => Promise<void>;
}

/** The tunnel a paired machine had before the move (`volley broker tunnel --show`). */
interface PeerTunnelWas {
  host: string;
  remote_port: number;
  tunnel: "ssh" | "none";
}

/** What a broker move keeps for its rollback (the move record's `kept`); steps add to it. */
export interface BrokerKept {
  roles: RolesRecord;
  address: string;
  lan: boolean;
  layout: LayoutName;
  /** The broker's port on the supervisor's machine: its own tunnel's end afterwards. */
  port: number;
  /** The Desk's broker host before the move, and its port. */
  desk_broker_host: string;
  desk_port: number;
  /** Each paired machine's tunnel before the move, by name (the retarget steps fill it). */
  peers: Record<string, PeerTunnelWas>;
  /** volleyd's own broker URL before the move. */
  unit_url: string;
}

/** The old broker's service, stopped and started through its layout here. */
export function brokerServiceArgv(layout: LayoutName, verb: "stop" | "start"): string[] | null {
  if (layout === "brew-arm64" || layout === "brew-intel")
    return ["brew", "services", verb, "mosquitto"];
  if (layout === "snap") return ["sudo", "-n", "snap", verb, "mosquitto"];
  if (layout === "etc") return ["sudo", "-n", "systemctl", verb, "mosquitto"];
  return null;
}

/** `ssh -n -o BatchMode=yes -o ConnectTimeout=<s> <dest> true`: can this machine reach `dest`. */
export const sshProbeArgv = (dest: string) => [
  "ssh",
  "-n",
  "-o",
  "BatchMode=yes",
  "-o",
  `ConnectTimeout=${DAEMON_DEFAULTS.role_ssh_probe_timeout_s}`,
  dest,
  "true",
];

/** The supervisor's own tunnel to the broker's new machine (volley-cli's `volley broker tunnel`). */
export const tunnelArgv = (address: string, port: number, name: string) => [
  "volley",
  "broker",
  "tunnel",
  "--to",
  address,
  "--port",
  String(port),
  "--name",
  name,
  "--broker-port",
  String(NEW_MQTT),
];
export const TUNNEL_OFF = ["volley", "broker", "tunnel", "--off"];
const TUNNEL_SHOW = ["volley", "broker", "tunnel", "--show"];

/** The receive on the target (`--check`: whether the owner's terminal step ran). */
export const receiveArgv = (bundle: string, lan: boolean | "check") => [
  "volley",
  "broker",
  "receive",
  bundle,
  lan === "check" ? "--check" : lan ? "--lan" : "--no-lan",
];

/** The roles record with the broker on `machine` at `address`, one version on. */
export function withBroker(
  r: RolesRecord,
  broker: RolesRecord["broker"],
  by: string,
  now: Date,
): RolesRecord {
  return { ...r, broker, version: r.version + 1, updated_at: now.toISOString(), updated_by: by };
}

/** A step's command, or its failure with the command's last line. */
async function must(d: RoleDeps, where: string, argv: string[]): Promise<string> {
  const r = await runOn(d, where, argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} on ${where}: ${lastLine(r)}`);
  return lastLine({ ...r, stderr: "" });
}

const wsUrl = (host: string, port: number) =>
  `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

/** The paired machines a broker move re-points (each one's peer service holds a tunnel). */
const pairedHosts = (d: RoleDeps) =>
  Object.keys(d.hosts)
    .filter((n) => d.paired(n))
    .sort();

/** `role_plan { role: "broker", to, address?, lan? }`: the plan, or a refusal (a string). */
export async function planBroker(
  d: RoleDeps,
  b: BrokerDeps,
  p: { to: string; address?: string; lan?: boolean; by: string },
): Promise<RolePlan | string> {
  const { to } = p;
  const from = d.roles.broker.machine;
  if (to === from) return `broker already runs on ${to}`;
  if (to !== d.localName && !Object.hasOwn(d.hosts, to))
    return `unknown machine "${to}": neither this machine (${d.localName}) nor a configured host`;
  const address = p.address ?? d.hosts[to]?.target ?? to;
  if (!isSshDestination(address))
    return "address must be an ssh destination ([user@]host, never starting with -)";
  const lan = p.lan ?? d.roles.broker.lan;
  const port = d.roles.broker.address.mqtt_port;
  const waits: Blocker[] = [
    ...b.busyWaves().map(({ wave, status }) => ({
      why: `wave ${wave} is ${status}`,
      fix: `stop it (\`volleyd stop ${wave}\`, then \`volleyd resume ${wave}\` once the broker moved), or move when idle (drain: true)`,
    })),
    ...b.liveAgents().map(({ agent_id, machine }) => ({
      why: `agent ${agent_id} is live on ${machine}`,
      fix: "let it finish, or move when idle (drain: true)",
    })),
  ];
  const blocked: Blocker[] = [];
  const terminal: RolePlan["terminal"] = [];
  const warnings: string[] = [];
  const install = b.install();
  if (from !== d.localName)
    blocked.push({
      why: `the broker runs on ${from}, not on the supervisor's machine (${d.localName}): moving it from a paired machine is not supported yet`,
      fix: "roll back the move that put it there (`volley role rollback <move_id>`), then move it from here",
    });
  else if (install === null)
    blocked.push({
      why: `no broker install is recorded on ${d.localName} (setup.json)`,
      fix: "run `volley setup` here first",
    });
  else if (brokerServiceArgv(install.layout, "stop") === null)
    blocked.push({
      why: `the broker on ${d.localName} runs in a container: volleyd cannot stop it`,
      fix: "move a broker installed with Homebrew, snap or the distribution package",
    });
  else
    for (const f of [install.stateFile, join(install.authDir, "admin.json")])
      try {
        accessSync(f, constants.R_OK);
      } catch {
        blocked.push({
          why: `volleyd cannot read ${f} on ${d.localName} (the move bundles it)`,
          fix: `let volleyd's user read it (it is ${install.layout === "snap" || install.layout === "etc" ? "root's on this install" : "missing"})`,
        });
      }
  if (from === d.localName && install !== null && ROOT_LAYOUTS.includes(install.layout))
    warnings.push(
      `the broker here is a ${install.layout} install: volleyd stops and restarts it with \`sudo -n\`, which needs a sudo rule without a password for \`${(brokerServiceArgv(install.layout, "stop") ?? []).slice(2).join(" ")}\``,
    );
  if (port !== NEW_MQTT)
    blocked.push({
      why: `the broker listens on port ${port} here; the moved broker listens on ${NEW_MQTT}, and every tunnel keeps its far end`,
      fix: `move the broker to port ${NEW_MQTT} here first (\`volley setup --broker-url mqtt://127.0.0.1:${NEW_MQTT}\`)`,
    });
  const ownUrl = `mqtt://127.0.0.1:${port}`;
  if (d.platform === "darwin" && b.brokerUrl !== ownUrl)
    blocked.push({
      why: `volleyd's launchd service reaches the broker at ${b.brokerUrl}: after the move it reaches it through its tunnel at ${ownUrl}`,
      fix: `\`volleyd install --broker-url ${ownUrl}\` here first (the same broker, by its loopback address)`,
    });
  blocked.push(...machineBlockers(d, to));
  const up = !blocked.some((x) => x.why.startsWith(`${to} is down`));
  let needsRoot = false;
  if (up && to !== d.localName) {
    const probed = await probeTarget(d, to);
    if (typeof probed === "string")
      blocked.push({
        why: `${to}: ${probed}`,
        fix: `install mosquitto 2.1 or newer on ${to} (macOS: \`brew install mosquitto\`; Linux: \`sudo snap install mosquitto\`)`,
      });
    else if (probed.layout === "container")
      blocked.push({ why: `${to}'s mosquitto is a container's: not supported by a broker move` });
    else needsRoot = probed.needs_root;
  }
  if (needsRoot)
    terminal.push({
      where: to,
      reason: `${to}'s mosquitto is root's (snap or the distribution package): run this there when the move's receive step waits for it`,
      command: `sudo volley broker receive ~/${BUNDLE_REL} ${lan ? "--lan" : "--no-lan"}`,
    });
  blocked.push(...(await sshProbes(d, to, address)));
  if (lan) {
    const url = wsUrl(hostOf(address), NEW_WS);
    if ((await b.probeAnonymous(url)) === "unreachable")
      blocked.push({
        why: `${url} is not reachable from ${d.localName}, where the Desk's page loads (lan: true)`,
        fix: `open port ${NEW_WS} on ${to} to the LAN, or move with lan: false`,
      });
  } else
    warnings.push(
      `lan: false: the broker's WebSocket listener stays on ${to}'s loopback, so the Desk works only in a browser on ${to}`,
    );
  if (from === d.localName)
    warnings.push(
      `the broker leaves the supervisor's machine (${d.localName}): volleyd reaches it through an ssh tunnel to ${address} from now on (moving the supervisor too is a second move)`,
    );
  const kept: BrokerKept = {
    roles: d.roles,
    address,
    lan,
    layout: install?.layout ?? "brew-arm64",
    port,
    desk_broker_host: d.brokerHost,
    desk_port: deskPortOf(d.roles.desk.url),
    peers: {},
    unit_url: b.brokerUrl,
  };
  return {
    role: "broker",
    from,
    to,
    steps: brokerSteps(d, b, { from, to, address, lan, needsRoot, by: p.by, kept }),
    blocked,
    waits,
    warnings,
    terminal,
    after: [
      `The broker runs on ${to}; every machine reaches it through its tunnel to ${address}, ${to} itself at 127.0.0.1:${NEW_MQTT}.`,
      `Your Claude Code sessions on ${from} reach it through ${from}'s tunnel: re-register them there with \`volley setup --step claude-code --broker-url mqtt://127.0.0.1:${port}\`.`,
      `The broker on ${from} is stopped, not removed: \`volley role rollback <move_id>\` within 7 days starts it again.`,
      "Retained topics start empty on the new broker: volleyd and every machine republish theirs; stopped waves resume with `volleyd resume <wave>`.",
    ],
    kept: kept as unknown as Record<string, unknown>,
  };
}

/** `volley broker probe` on the target: its layout and whether it needs root, or why not. */
async function probeTarget(
  d: RoleDeps,
  to: string,
): Promise<{ layout: string; needs_root: boolean } | string> {
  const r = await runOn(d, to, ["volley", "broker", "probe"]).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
    timedOut: false,
  }));
  let j: { layout?: unknown; needs_root?: unknown; mosquitto?: unknown; error?: unknown } = {};
  try {
    j = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as typeof j;
  } catch {}
  if (r.code !== 0 || typeof j.mosquitto !== "string")
    return typeof j.error === "string" ? j.error : `volley broker probe: ${lastLine(r)}`;
  return { layout: String(j.layout), needs_root: j.needs_root === true };
}

/** ssh to `address` from the supervisor's machine and from every other paired machine. */
async function sshProbes(d: RoleDeps, to: string, address: string): Promise<Blocker[]> {
  const argv = sshProbeArgv(address);
  const fail = (e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
    timedOut: false,
  });
  const here = (async (): Promise<Blocker | null> => {
    const r = await d.exec(argv, { timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms }).catch(fail);
    return r.code === 0
      ? null
      : {
          why: `${d.localName} cannot ssh to ${address}: ${lastLine(r)}`,
          fix: `authorise ${d.localName}'s ssh key on ${to}`,
        };
  })();
  const others = pairedHosts(d)
    .filter((n) => n !== to)
    .map(async (name): Promise<Blocker | null> => {
      const rec = d.record(name);
      if (rec === undefined || rec.tunnel === "down")
        return {
          why: `${name} is down: its tunnel cannot be re-pointed`,
          fix: `start its service (\`volley peer run\` on ${name}), or remove it (\`volley peer remove ${name}\`)`,
        };
      const host = d.remote(name);
      if (typeof host === "string") return { why: `${name}: ${host}` };
      const r = await host
        .run([{ argv }], { timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms })
        .catch(fail);
      return r.code === 0
        ? null
        : {
            why: `${name} cannot ssh to ${address}: ${lastLine(r)}`,
            fix: `authorise ${name}'s ssh key on ${to}`,
          };
    });
  return (await Promise.all([here, ...others])).filter((x): x is Blocker => x !== null);
}

/** Wait until `name` publishes an `up` record at `since` or later, read through `link`. */
async function upThrough(
  d: RoleDeps,
  link: ProbeLink,
  name: string,
  since: number,
): Promise<boolean> {
  const end = d.now().getTime() + DAEMON_DEFAULTS.peer_retarget_grace_ms;
  for (;;) {
    const r = await link.machine(name).catch(() => null);
    if (r !== null && r.tunnel === "up" && Date.parse(r.last_seen) >= since) return true;
    if (d.now().getTime() >= end) return false;
    await d.sleep(DAEMON_DEFAULTS.role_health_wait_ms);
  }
}

/**
 * The health check: volleyd's login at `url` and the broker's version, then both listeners
 * refuse anonymous clients (the WebSocket one checked from here when it is open to the LAN).
 */
async function brokerHealth(
  d: RoleDeps,
  b: BrokerDeps,
  url: string,
  ws: string | null,
): Promise<string> {
  let last = "";
  for (let i = 0; i < DAEMON_DEFAULTS.role_health_attempts; i++) {
    if (i > 0) await d.sleep(DAEMON_DEFAULTS.role_health_wait_ms);
    let version: string | null;
    try {
      const link = await b.connect(url);
      try {
        version = await link.sysVersion();
      } finally {
        await link.close().catch(() => {});
      }
    } catch (e) {
      last = `volleyd cannot log in at ${url}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    const probes = [url, ...(ws !== null ? [ws] : [])];
    const open: string[] = [];
    for (const u of probes) {
      const r = await b.probeAnonymous(u);
      if (r !== "refused")
        open.push(`${u} ${r === "accepted" ? "accepts anonymous clients" : "is unreachable"}`);
    }
    if (open.length > 0) {
      last = open.join("; ");
      continue;
    }
    return `${version ?? "the broker"} answers volleyd at ${url}; ${probes.length === 2 ? "both listeners refuse" : "it refuses"} anonymous clients`;
  }
  throw new Error(`the broker did not pass its health check: ${last}`);
}

/** Every step of the move. `o.kept` is the move record's `kept`: the retarget steps add to it. */
export function brokerSteps(
  d: RoleDeps,
  b: BrokerDeps,
  o: {
    from: string;
    to: string;
    address: string;
    lan: boolean;
    needsRoot: boolean;
    by: string;
    kept: BrokerKept;
  },
): MoveStep[] {
  const { from, to, address, lan, kept } = o;
  const port = kept.port;
  const ownUrl = `mqtt://127.0.0.1:${port}`;
  const stop = brokerServiceArgv(kept.layout, "stop") ?? [];
  const start = brokerServiceArgv(kept.layout, "start") ?? [];
  const newHost = hostOf(address);
  let moveId = "";
  let remoteBundle = "";
  let unitUndo: (() => Promise<void>) | null = null;
  const target = (): RemoteHost => {
    const h = d.remote(to);
    if (typeof h === "string") throw new Error(h);
    return h;
  };
  const steps: MoveStep[] = [
    {
      id: "stop",
      title: `Stop the broker on ${from}`,
      where: from,
      detail: stop.join(" "),
      run: async ({ move_id }) => {
        moveId = move_id;
        // From here on volleyd's own connection ends with the broker: it waits for the move.
        b.moving(move_id);
        const r = await d.exec(stop, { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms });
        if (r.code !== 0) throw new Error(`${stop.join(" ")}: ${lastLine(r)}`);
        return "stopped (its state file stays where it is)";
      },
      undo: async () => {
        const r = await d.exec(start, { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms });
        if (r.code !== 0) throw new Error(`${start.join(" ")}: ${lastLine(r)}`);
      },
    },
    {
      id: "bundle",
      title: `Bundle the broker's logins on ${from}`,
      where: from,
      detail: "tar -czf <bundle> (the Dynamic Security state file, its admin login, lan)",
      run: async () => {
        const install = b.install();
        if (install === null) throw new Error("no broker install recorded here (setup.json)");
        await makeBrokerBundle(
          d.exec,
          {
            stateFile: install.stateFile,
            adminFile: join(install.authDir, "admin.json"),
            lan,
          },
          { move_id: moveId, from, to, dir: moveDir(d.volleydHome, moveId) },
        );
        let logins = 0;
        try {
          const s = JSON.parse(readFileSync(install.stateFile, "utf-8")) as { clients?: unknown };
          logins = Array.isArray(s.clients) ? s.clients.length : 0;
        } catch {}
        return `${logins} logins bundled`;
      },
    },
    {
      id: "copy",
      title: `Copy the bundle to ${to}`,
      where: to,
      detail: `base64 -d > ~/${BUNDLE_REL}`,
      run: async () => {
        const h = target();
        const home = await h.run([{ argv: ["printenv", "HOME"] }]);
        const dir = home.stdout.trim();
        if (home.code !== 0 || !dir.startsWith("/"))
          throw new Error(`no home directory on ${to}: ${lastLine(home)}`);
        remoteBundle = `${dir}/${BUNDLE_REL}`;
        const bytes = readFileSync(join(moveDir(d.volleydHome, moveId), "bundle.tgz"));
        const r = await h.run(
          [
            { argv: ["mkdir", "-p", remoteBundle.slice(0, -"/bundle.tgz".length)] },
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
      title: o.needsRoot
        ? `Wait for \`sudo volley broker receive\` on ${to}`
        : `Receive the broker on ${to}`,
      where: to,
      detail: receiveArgv(`~/${BUNDLE_REL}`, o.needsRoot ? "check" : lan).join(" "),
      run: async () => {
        if (!o.needsRoot) return must(d, to, receiveArgv(remoteBundle, lan));
        // The owner's terminal step (root's install): polled until it ran, or given up.
        const end = d.now().getTime() + DAEMON_DEFAULTS.role_broker_receive_wait_ms;
        for (;;) {
          const r = await runOn(d, to, receiveArgv(remoteBundle, "check")).catch(() => null);
          if (r?.code === 0) return `received on ${to} (the owner's sudo step)`;
          if (d.now().getTime() >= end)
            throw new Error(
              `nobody ran \`sudo volley broker receive ${remoteBundle} ${lan ? "--lan" : "--no-lan"}\` on ${to} within ${Math.round(DAEMON_DEFAULTS.role_broker_receive_wait_ms / 60_000)} min`,
            );
          await d.sleep(DAEMON_DEFAULTS.role_health_wait_ms);
        }
      },
    },
    {
      id: "tunnel",
      title: `Tunnel ${from} to the broker on ${to}`,
      where: from,
      detail: `${tunnelArgv(address, port, d.localName).join(" ")}; VOLLEY_BROKER_URL=${ownUrl}`,
      run: async () => {
        const line = await must(d, from, tunnelArgv(address, port, d.localName));
        const unit = await b.unitUrl(ownUrl);
        unitUndo = unit.undo;
        return `${line} ${unit.line}`;
      },
      undo: async () => {
        await unitUndo?.();
        await must(d, from, TUNNEL_OFF);
      },
    },
    {
      id: "health",
      title: `Check the broker on ${to} answers volleyd`,
      where: from,
      detail: `connect ${ownUrl} as volleyd; $SYS/broker/version; anonymous refused${lan ? ` (and ${wsUrl(newHost, NEW_WS)})` : ""}`,
      health: true,
      run: () => brokerHealth(d, b, ownUrl, lan ? wsUrl(newHost, NEW_WS) : null),
    },
  ];
  pairedHosts(d).forEach((name, i) => {
    const self = name === to;
    steps.push({
      id: `retarget-${i + 1}`,
      title: self
        ? `Re-point ${name} at its own broker (no tunnel)`
        : `Re-point ${name}'s tunnel at ${address}`,
      where: name,
      detail: self
        ? `peer_retarget ${name} --to ${address} --port ${NEW_MQTT} --tunnel none`
        : `peer_retarget ${name} --to ${address} --tunnel ssh`,
      run: async () => {
        const shown = await must(d, name, TUNNEL_SHOW);
        let was: PeerTunnelWas;
        try {
          was = JSON.parse(shown) as PeerTunnelWas;
        } catch {
          throw new Error(`${name}'s tunnel is not known: ${shown}`);
        }
        kept.peers[name] = was;
        const link = await b.connect(ownUrl);
        try {
          const why = await b.retarget(
            {
              name,
              address,
              ...(self ? { port: NEW_MQTT, tunnel: "none" as const } : { tunnel: "ssh" as const }),
            },
            o.by,
            (n, since) => upThrough(d, link, n, since),
          );
          if (why !== null) throw new Error(why);
        } finally {
          await link.close().catch(() => {});
        }
        return `${name} is up through the broker on ${to}`;
      },
      undo: async () => {
        const was = kept.peers[name];
        if (was === undefined) return;
        // The old broker is not back yet (it starts last): nothing waits for the record.
        const why = await b.retarget(
          { name, address: was.host, port: was.remote_port, tunnel: was.tunnel },
          o.by,
          async () => true,
        );
        if (why !== null) throw new Error(why);
      },
    });
  });
  const deskAt = d.roles.desk.machine;
  const deskInstall = (host: string) => [
    "volley",
    "desk",
    "install",
    "--port",
    String(kept.desk_port),
    "--broker-host",
    host,
  ];
  steps.push(
    {
      id: "desk",
      title: `Tell the Desk on ${deskAt} the broker's host (${newHost})`,
      where: deskAt,
      detail: deskInstall(newHost).join(" "),
      run: () => must(d, deskAt, deskInstall(newHost)),
      undo: async () => {
        await must(d, deskAt, deskInstall(kept.desk_broker_host));
      },
    },
    {
      id: "record",
      title: `Record the broker on ${to} at ${address}`,
      where: d.localName,
      detail: `broker: ${to} ${address} lan ${lan}`,
      run: async () => {
        await d.writeRoles(
          withBroker(
            kept.roles,
            {
              machine: to,
              address: { ssh: address, mqtt_port: NEW_MQTT, ws_port: NEW_WS },
              lan,
            },
            o.by,
            d.now(),
          ),
        );
        return `the roles record names ${to} (${address})`;
      },
      undo: async () => {
        await d.writeRoles(withBroker(kept.roles, kept.roles.broker, o.by, d.now()));
      },
    },
  );
  return steps;
}

/**
 * A done broker move undone from its record (`role_rollback`): the own tunnel off, the old broker
 * started here, its health, every paired machine back to the tunnel it had, the Desk told the old
 * host, the roles record back. The broker on the target keeps running (stop it there by hand);
 * the old state file was never removed.
 */
export function brokerRollbackSteps(
  d: RoleDeps,
  b: BrokerDeps,
  rec: Pick<MoveRecord, "from" | "to">,
  kept: BrokerKept,
  by: string,
): MoveStep[] {
  const here = rec.from;
  const ownUrl = `mqtt://127.0.0.1:${kept.port}`;
  const start = brokerServiceArgv(kept.layout, "start") ?? [];
  const stop = brokerServiceArgv(kept.layout, "stop") ?? [];
  let unitUndo: (() => Promise<void>) | null = null;
  const steps: MoveStep[] = [
    {
      id: "tunnel",
      title: `Take ${here}'s tunnel to ${rec.to} down`,
      where: here,
      detail: `${TUNNEL_OFF.join(" ")}; VOLLEY_BROKER_URL=${kept.unit_url}`,
      run: async ({ move_id }) => {
        b.moving(move_id);
        const unit = await b.unitUrl(kept.unit_url);
        unitUndo = unit.undo;
        return `${await must(d, here, TUNNEL_OFF)} ${unit.line}`;
      },
      undo: async () => {
        await unitUndo?.();
        await must(d, here, tunnelArgv(kept.address, kept.port, d.localName));
      },
    },
    {
      id: "start",
      title: `Start the broker on ${here} again`,
      where: here,
      detail: start.join(" "),
      run: async () => {
        const r = await d.exec(start, { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms });
        if (r.code !== 0) throw new Error(`${start.join(" ")}: ${lastLine(r)}`);
        return "started";
      },
      undo: async () => {
        await d.exec(stop, { timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms });
      },
    },
    {
      id: "health",
      title: `Check the broker on ${here} answers volleyd`,
      where: here,
      detail: `connect ${ownUrl} as volleyd; $SYS/broker/version; anonymous refused`,
      health: true,
      run: () => brokerHealth(d, b, ownUrl, kept.lan ? wsUrl(d.localHost, NEW_WS) : null),
    },
  ];
  Object.keys(kept.peers)
    .sort()
    .forEach((name, i) => {
      const was = kept.peers[name] as PeerTunnelWas;
      steps.push({
        id: `retarget-${i + 1}`,
        title: `Re-point ${name}'s tunnel back at ${was.host}`,
        where: name,
        detail: `peer_retarget ${name} --to ${was.host} --port ${was.remote_port} --tunnel ${was.tunnel}`,
        run: async () => {
          const link = await b.connect(ownUrl);
          try {
            const why = await b.retarget(
              { name, address: was.host, port: was.remote_port, tunnel: was.tunnel },
              by,
              (n, since) => upThrough(d, link, n, since),
            );
            if (why !== null) throw new Error(why);
          } finally {
            await link.close().catch(() => {});
          }
          return `${name} is up through the broker on ${here}`;
        },
      });
    });
  const deskAt = d.roles.desk.machine;
  const desk = [
    "volley",
    "desk",
    "install",
    "--port",
    String(kept.desk_port),
    "--broker-host",
    kept.desk_broker_host,
  ];
  steps.push(
    {
      id: "desk",
      title: `Tell the Desk on ${deskAt} the broker's host (${kept.desk_broker_host})`,
      where: deskAt,
      detail: desk.join(" "),
      run: () => must(d, deskAt, desk),
    },
    {
      id: "record",
      title: `Record the broker on ${here}`,
      where: d.localName,
      detail: `broker: ${here}`,
      run: async () => {
        await d.writeRoles(withBroker(d.roles, kept.roles.broker, by, d.now()));
        return `the roles record names ${here}; the broker on ${rec.to} still runs (stop it there)`;
      },
    },
  );
  return steps;
}
