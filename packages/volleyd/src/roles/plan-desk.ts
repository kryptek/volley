import { DESK_PORT } from "volley-cli/commands/desk-serve";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { type RoleDeps, hostOf, machineBlockers, runOn } from "./deps";
import type { Blocker, MoveStep, RolePlan } from "./engine";
import { deskCheck, lastLine } from "./health";
import type { RolesRecord } from "./record";

/**
 * The Desk move's planner (SPEC §4.6.24): `role_plan { role: "desk", to, port? }`. Fresh each
 * time, changing nothing. Its blockers: the target not paired, down, behind the supervisor's
 * version (its record's doctor `versions.volley`), `bun` off its ssh PATH, or the port taken
 * there (`nc -z 127.0.0.1 <port>` over ssh). Its steps, in order:
 *
 *   1. install  (target)  `volley desk install --port <p> --broker-host <broker>`; undo: uninstall
 *   2. check    (target)  `volley desk check --url http://127.0.0.1:<p> --version <supervisor's>`
 *   3. record   (here)    the roles record names the target and the new address; undo: the old one
 *   4. signin   (here)    a sign-in link (role steer) for the new address, for the requester
 *   5. unload   (old)     the old Desk's service stopped, kept for a rollback; LAST, so a browser
 *                         still on the old address sees the Desk's banner until then
 *
 * Every device signs in again at the new address (its origin's storage stays with the old one).
 */

/** What a Desk move hands its requester once it is done: the sign-in link's token, never logged. */
export interface DeskIssued {
  token?: string;
  url: string;
  /** The LAN address beside a private `url` (a rollback to a Desk served on the tailnet). */
  lan_url?: string;
}

/** The Desk's own service on the supervisor's machine: unloaded, kept, reloaded on a rollback. */
const deskUnit = (d: RoleDeps) =>
  d.platform === "darwin"
    ? {
        stop: ["launchctl", "bootout", `gui/${d.uid}/systems.volley.desk`],
        start: [
          "launchctl",
          "bootstrap",
          `gui/${d.uid}`,
          `${d.home}/Library/LaunchAgents/systems.volley.desk.plist`,
        ],
      }
    : {
        stop: ["systemctl", "--user", "stop", "volley-desk.service"],
        start: ["systemctl", "--user", "start", "volley-desk.service"],
      };

/** The port a Desk URL names (its default when it names none). */
export function deskPortOf(url: string): number {
  try {
    const u = new URL(url);
    return u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return DESK_PORT;
  }
}

/** The Desk's address once it runs on `machine` at `port`. */
export function deskUrlOn(d: RoleDeps, machine: string, port: number): string {
  const target = d.hosts[machine]?.target;
  const host = machine === d.localName || target === undefined ? d.localHost : hostOf(target);
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

const installArgv = (port: number, brokerHost: string) => [
  "volley",
  "desk",
  "install",
  "--port",
  String(port),
  "--broker-host",
  brokerHost,
];
const UNINSTALL = ["volley", "desk", "uninstall"];

/** A step's command, or its failure with the command's last line. */
async function must(d: RoleDeps, where: string, argv: string[]): Promise<string> {
  const r = await runOn(d, where, argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} on ${where}: ${lastLine(r)}`);
  return lastLine({ ...r, stderr: "" });
}

/** The roles record with the Desk on `machine` at `url` (and `lanUrl`), one version on. */
export function withDesk(
  r: RolesRecord,
  machine: string,
  url: string,
  by: string,
  now: Date,
  lanUrl?: string,
) {
  return {
    ...r,
    desk: lanUrl !== undefined ? { machine, url, lan_url: lanUrl } : { machine, url },
    version: r.version + 1,
    updated_at: now.toISOString(),
    updated_by: by,
  };
}

/**
 * The steps that put the Desk on `to` at `port` and take it off `from` (the old one at
 * `fromPort`): a move's, and a rollback's (the same steps the other way).
 */
export function deskSteps(
  d: RoleDeps,
  o: { from: string; to: string; port: number; fromPort: number; by: string; signin: boolean },
  issued: DeskIssued,
): MoveStep[] {
  const { from, to, port } = o;
  const install = installArgv(port, d.brokerHost);
  const before = d.roles;
  const local = from === d.localName;
  const unit = deskUnit(d);
  const steps: MoveStep[] = [
    {
      id: "install",
      title: `Install the Desk on ${to} (port ${port})`,
      where: to,
      detail: install.join(" "),
      run: () => must(d, to, install),
      undo: async () => {
        await must(d, to, UNINSTALL);
      },
    },
    {
      id: "check",
      title: `Check the Desk answers on ${to}`,
      where: to,
      detail: `volley desk check --url http://127.0.0.1:${port} --version ${d.version}`,
      health: true,
      run: () => deskCheck((argv) => runOn(d, to, argv), port, d.version, d.sleep),
    },
    {
      id: "record",
      title: `Record the Desk on ${to} at ${issued.url}`,
      where: d.localName,
      detail: `desk: ${to} ${issued.url}`,
      run: async () => {
        await d.writeRoles(withDesk(before, to, issued.url, o.by, d.now(), issued.lan_url));
        return `the roles record names ${to} (${issued.url})`;
      },
      undo: async () => {
        const { machine, url, lan_url } = before.desk;
        await d.writeRoles(withDesk(before, machine, url, o.by, d.now(), lan_url));
      },
    },
  ];
  if (o.signin)
    steps.push({
      id: "signin",
      title: `A sign-in link for ${issued.url}`,
      where: d.localName,
      detail: "volley auth signin-link --role steer",
      run: async () => {
        const r = await d.exec([
          "volley",
          "auth",
          "signin-link",
          "--role",
          "steer",
          "--label",
          `desk@${to}`,
          "--ttl",
          String(DAEMON_DEFAULTS.role_signin_ttl_s),
          "--json",
        ]);
        let token: unknown;
        try {
          token = (JSON.parse(r.stdout) as { token?: unknown }).token;
        } catch {}
        if (r.code !== 0 || typeof token !== "string")
          throw new Error(`volley auth signin-link: ${lastLine(r)}`);
        issued.token = token;
        return "a sign-in link for the requester (sealed to it)";
      },
    });
  steps.push({
    id: "unload",
    title: `Stop the Desk on ${from} (kept for a rollback)`,
    where: from,
    detail: local ? unit.stop.join(" ") : UNINSTALL.join(" "),
    run: async () => {
      if (!local) return must(d, from, UNINSTALL);
      // Not loaded (stopped by hand, say) is no failure: it is off either way.
      const r = await d.exec(unit.stop);
      return r.code === 0 ? "stopped" : `not running (${lastLine(r)})`;
    },
    undo: async () => {
      if (!local) {
        await must(d, from, installArgv(o.fromPort, d.brokerHost));
        return;
      }
      const r = await d.exec(unit.start);
      if (r.code !== 0) throw new Error(`${unit.start.slice(0, 2).join(" ")}: ${lastLine(r)}`);
    },
  });
  return steps;
}

/** `role_plan { role: "desk", to, port? }`: the plan, or a refusal (a string). */
export async function planDesk(
  d: RoleDeps,
  p: { to: string; port?: number; by: string },
  issued: DeskIssued,
): Promise<RolePlan | string> {
  const { to } = p;
  const from = d.roles.desk.machine;
  if (to !== d.localName && !Object.hasOwn(d.hosts, to))
    return `unknown machine "${to}": neither this machine (${d.localName}) nor a configured host`;
  if (to === from) return `desk already runs on ${to}`;
  const port = p.port ?? DESK_PORT;
  issued.url = deskUrlOn(d, to, port);
  const blocked: Blocker[] = machineBlockers(d, to);
  if (!blocked.some((b) => b.why.startsWith(`${to} is down`)))
    blocked.push(...(await probes(d, to, port)));
  // The Desk's own port: its LAN address names it (a private https address names 443).
  const fromPort = deskPortOf(d.roles.desk.lan_url ?? d.roles.desk.url);
  // The target's private address, when its Network step recorded Tailscale (its machine record).
  const net = d.record(to)?.network;
  const reach =
    net?.kind === "tailscale" && net.name !== undefined
      ? ` On ${to}'s private network it is https://${net.name} once \`volley desk install --tailscale\` runs there.`
      : "";
  return {
    role: "desk",
    from,
    to,
    steps: deskSteps(d, { from, to, port, fromPort, by: p.by, signin: true }, issued),
    blocked,
    warnings: [],
    terminal: [],
    after: [
      `The Desk's address becomes ${issued.url}: every device signs in again there (the move's sign-in link, or Settings › Devices).${reach}`,
    ],
    kept: { desk: d.roles.desk, port, from_port: fromPort },
  };
}

/** The target's own checks: `bun` on its ssh PATH, and the port free there. */
async function probes(d: RoleDeps, to: string, port: number): Promise<Blocker[]> {
  if (to === d.localName) {
    return (await d.localPortBusy(port))
      ? [{ why: `port ${port} is taken on ${to}`, fix: "pass another port" }]
      : [];
  }
  const host = d.remote(to);
  if (typeof host === "string") return [{ why: `${to}: ${host}` }];
  const out: Blocker[] = [];
  try {
    const path = await host.probePath();
    if (!path.bun)
      out.push({
        why: `bun is not on ${to}'s ssh PATH (the Desk's service runs it)`,
        fix: `install bun on ${to}, or run \`volley peer doctor --fix\` there`,
      });
  } catch (e) {
    out.push({
      why: `could not check ${to}'s PATH: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const r = await host
    .run([{ argv: ["nc", "-z", "127.0.0.1", String(port)] }], {
      timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms,
    })
    .catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
  if (r.code === 0) out.push({ why: `port ${port} is taken on ${to}`, fix: "pass another port" });
  else if (r.code !== 1) out.push({ why: `could not check port ${port} on ${to}: ${lastLine(r)}` });
  return out;
}
