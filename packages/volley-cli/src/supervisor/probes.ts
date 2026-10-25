import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { randomSuffix } from "volley-mcp/util";
import { volleydHome } from "../auth/context";
import { type NetworkRecord, readNetworkRecord, readSetupInstall } from "../setup/journal";
import { parseTailscaleStatus } from "../setup/network";
import { type DiagnoseInput, LOOPBACK, type Where, diagnose } from "./diagnose";

/**
 * The probes behind diagnose.ts's ladder, each bounded and injectable. They run only after a
 * connect already failed (or the daemon did not answer), in a fixed order, and the first failure
 * stops the ladder: about fifteen seconds at worst. None of them sends anything to the broker.
 */

export const PROBE_DEFAULTS = {
  /** The internet rung: a TCP connect here (`VOLLEY_INTERNET_PROBE=<host>:<port>` overrides). */
  internet: { host: "github.com", port: 443 },
  internet_ms: 2_000,
  tailscale_ms: 5_000,
  manual_ms: 3_000,
  tunnel_ms: 2_000,
  broker_ms: 3_000,
  daemon_ms: 10_000,
} as const;

/** The daemon's status (SPEC §4.6: the daemon is agent `volleyd`), live while it is one of these. */
const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

/** What a TCP connect found: `open`, `refused` (something answered with a reset), or `none`. */
export type TcpResult = "open" | "refused" | "none";
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<TcpResult>;

export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((done) => {
    const socket = createConnection({ host, port });
    const end = (r: TcpResult) => {
      socket.destroy();
      done(r);
    };
    socket.setTimeout(timeoutMs, () => end("none"));
    socket.once("connect", () => end("open"));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      end(e.code === "ECONNREFUSED" ? "refused" : "none"),
    );
  });

export type ProbeExec = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string }>;

/** Run `argv` with a bound; 127 when it is not installed, -1 when it ran out of time. */
export const probeExec: ProbeExec = (argv, timeoutMs) =>
  new Promise((done) => {
    const [bin, ...args] = argv;
    if (bin === undefined) return done({ code: 127, stdout: "" });
    let stdout = "";
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout });
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ code: e.code === "ENOENT" ? 127 : -1, stdout });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout });
    });
  });

/** `host:port` or `[v6]:port` (the internet probe's override), or null when it is not one. */
function hostPort(s: string | undefined): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|(.+)):(\d{1,5})$/.exec(s ?? "");
  if (m === null) return null;
  const port = Number(m[3]);
  return port >= 1 && port <= 65_535 ? { host: (m[1] ?? m[2]) as string, port } : null;
}

/** Online: a TCP connect to github.com:443 (or `$VOLLEY_INTERNET_PROBE`) within two seconds. */
export async function internetUp(
  opts: {
    env?: Record<string, string | undefined>;
    tcp?: TcpProbe;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const t = hostPort(opts.env?.VOLLEY_INTERNET_PROBE) ?? PROBE_DEFAULTS.internet;
  const r = await (opts.tcp ?? tcpProbe)(
    t.host,
    t.port,
    opts.timeoutMs ?? PROBE_DEFAULTS.internet_ms,
  );
  return r === "open";
}

/**
 * The private network setup.json records: Tailscale `Running` (`tailscale status --json`), or the
 * manual address answering on `port` (a reset counts: the address is reachable, nothing listens).
 * `unknown` for `none` or no record.
 */
export async function networkUp(
  record: NetworkRecord | null,
  opts: {
    port: number;
    exec?: ProbeExec;
    tcp?: TcpProbe;
    tailscaleMs?: number;
    manualMs?: number;
  },
): Promise<"up" | "down" | "unknown"> {
  if (record === null || record.kind === "none") return "unknown";
  if (record.kind === "tailscale") {
    const r = await (opts.exec ?? probeExec)(
      ["tailscale", "status", "--json"],
      opts.tailscaleMs ?? PROBE_DEFAULTS.tailscale_ms,
    );
    if (r.code === 127) return "down";
    return parseTailscaleStatus(r.stdout)?.running === true ? "up" : "down";
  }
  if (record.address === undefined) return "unknown";
  const r = await (opts.tcp ?? tcpProbe)(
    record.address,
    opts.port,
    opts.manualMs ?? PROBE_DEFAULTS.manual_ms,
  );
  return r === "none" ? "down" : "up";
}

/** A paired machine's tunnel: `127.0.0.1:<port>` accepts a connection within two seconds. */
export async function tunnelUp(
  port: number,
  opts: { tcp?: TcpProbe; timeoutMs?: number } = {},
): Promise<boolean> {
  const r = await (opts.tcp ?? tcpProbe)(
    "127.0.0.1",
    port,
    opts.timeoutMs ?? PROBE_DEFAULTS.tunnel_ms,
  );
  return r === "open";
}

/** The broker's host and port, from its URL (mqtt 1883, mqtts 8883, ws 80, wss 443). */
export function brokerAddress(url: string): { host: string; port: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const fallback: Record<string, number> = {
    "mqtt:": 1883,
    "tcp:": 1883,
    "mqtts:": 8883,
    "ws:": 80,
    "wss:": 443,
  };
  const port = u.port !== "" ? Number(u.port) : fallback[u.protocol];
  if (port === undefined) return null;
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
}

/** The broker's port answers a TCP connect within three seconds. */
export async function brokerUp(
  url: string,
  opts: { tcp?: TcpProbe; timeoutMs?: number } = {},
): Promise<boolean> {
  const a = brokerAddress(url);
  if (a === null) return false;
  const r = await (opts.tcp ?? tcpProbe)(
    a.host,
    a.port,
    opts.timeoutMs ?? PROBE_DEFAULTS.broker_ms,
  );
  return r === "open";
}

/**
 * volleyd's retained `volley/<ns>/volleyd/status` is live, read within ten seconds. Connects as a
 * transient client and only reads; false when it cannot connect or nothing live is retained.
 */
export async function daemonLive(
  url: string,
  auth: BrokerAuth | null,
  opts: { namespace?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? PROBE_DEFAULTS.daemon_ms;
  const broker = new VolleyBroker();
  try {
    await broker.connect({
      url,
      agentId: `cli-reach-${randomSuffix(6)}`,
      connectTimeoutMs: timeoutMs,
      ...(auth ?? {}),
    });
  } catch {
    return false;
  }
  try {
    const raw = await broker.queryRetained(
      `volley/${opts.namespace ?? "default"}/volleyd/status`,
      timeoutMs,
    );
    const env = raw === null ? null : parseEnvelope(raw);
    return env !== null && LIVE_STATUS.has(env.type);
  } catch {
    return false;
  } finally {
    await broker.disconnect().catch(() => {});
  }
}

/**
 * Where this command runs, derived from what is on disk: `~/.volley/peer.json` → `peer` (its
 * tunnel port unless it says `tunnel: none`); `VOLLEY_AGENT_ID=coordinator` with
 * `VOLLEY_BROKER_URL` → `coordinator`; setup.json with a layout → `supervisor`; else `other`.
 */
export function whereAmI(
  home: string,
  env: Record<string, string | undefined>,
  brokerUrl: string,
): Where {
  const vhome = volleydHome(env, home);
  const record = readNetworkRecord(vhome);
  const network = record !== null ? { network: { ...record } } : {};
  const peerJson = join(home, ".volley", "peer.json");
  if (existsSync(peerJson)) {
    let cfg: { name?: unknown; remote_port?: unknown; tunnel?: unknown } = {};
    try {
      cfg = JSON.parse(readFileSync(peerJson, "utf-8")) as typeof cfg;
    } catch {}
    const tunnel = cfg.tunnel !== "none" && typeof cfg.remote_port === "number";
    return {
      kind: "peer",
      ...(typeof cfg.name === "string" ? { machine: cfg.name } : {}),
      brokerUrl,
      ...(tunnel ? { tunnelPort: cfg.remote_port as number } : {}),
      ...network,
    };
  }
  if (env.VOLLEY_AGENT_ID === "coordinator" && env.VOLLEY_BROKER_URL !== undefined) {
    return { kind: "coordinator", brokerUrl, ...network };
  }
  if (readSetupInstall(vhome) !== null) return { kind: "supervisor", brokerUrl, ...network };
  return { kind: "other", brokerUrl, ...network };
}

export interface Probes {
  internetUp: () => Promise<boolean>;
  networkUp: (record: NetworkRecord | null, port: number) => Promise<"up" | "down" | "unknown">;
  tunnelUp: (port: number) => Promise<boolean>;
  brokerUp: (url: string) => Promise<boolean>;
  /** volleyd's status in `namespace` (unset: the env's `VOLLEY_NAMESPACE`, else `default`). */
  daemonLive: (url: string, auth: BrokerAuth | null, namespace?: string) => Promise<boolean>;
}

/** The real probes (`env` carries `VOLLEY_INTERNET_PROBE` and the namespace). */
export function realProbes(env: Record<string, string | undefined>): Probes {
  return {
    internetUp: () => internetUp({ env }),
    networkUp: (record, port) => networkUp(record, { port }),
    tunnelUp: (port) => tunnelUp(port),
    brokerUp: (url) => brokerUp(url),
    daemonLive: (url, auth, namespace) =>
      daemonLive(url, auth, { namespace: namespace ?? env.VOLLEY_NAMESPACE ?? "default" }),
  };
}

/**
 * Climb the ladder for `where`, stopping at the first rung that fails; the rungs not reached read
 * as passing (`up`, `unknown`). A broker on this machine's own loopback with no tunnel (the
 * supervisor's own machine) needs neither the internet nor the private network: those rungs are
 * skipped. `daemon` is asked only when `askDaemon`, which only tests set: every production caller
 * leaves it unset (a command that reached the broker asks the daemon itself and reports
 * `silentInput`).
 */
export async function climb(
  where: Where,
  probes: Probes,
  opts: { auth?: BrokerAuth | null; askDaemon?: boolean } = {},
): Promise<DiagnoseInput> {
  const input: DiagnoseInput = {
    internet: true,
    network: "unknown",
    tunnel: where.tunnelPort !== undefined ? "up" : "none",
    broker: "up",
    daemon: "unknown",
    where,
  };
  const addr = brokerAddress(where.brokerUrl);
  const local = addr !== null && LOOPBACK.has(addr.host) && where.tunnelPort === undefined;
  if (!local) {
    if (!(await probes.internetUp())) return { ...input, internet: false };
    const record = where.network !== undefined ? (where.network as NetworkRecord) : null;
    input.network = await probes.networkUp(record, addr?.port ?? 1883);
    if (input.network === "down") return input;
  }
  if (where.tunnelPort !== undefined && !(await probes.tunnelUp(where.tunnelPort))) {
    return { ...input, tunnel: "down" };
  }
  if (!(await probes.brokerUp(where.brokerUrl))) return { ...input, broker: "down" };
  if (opts.askDaemon === true) {
    input.daemon = (await probes.daemonLive(where.brokerUrl, opts.auth ?? null))
      ? "live"
      : "silent";
  }
  return input;
}

/**
 * The ladder's result after a connect that failed: when every rung answered (the broker's port is
 * open but its MQTT does not answer), the broker is down all the same.
 */
export const connectFailed = (input: DiagnoseInput): DiagnoseInput =>
  diagnose(input) === null ? { ...input, broker: "down" } : input;

/** `whereAmI` for this process: `$HOME` (or the OS's) and its environment. */
export const whereHere = (env: Record<string, string | undefined>, brokerUrl: string): Where =>
  whereAmI(env.HOME ?? homedir(), env, brokerUrl);
