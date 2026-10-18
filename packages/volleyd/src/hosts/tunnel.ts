import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";

/**
 * Broker reachability for remote hosts. Agents on a box reach the daemon's broker through a
 * reverse SSH tunnel: `ssh -N -R <remote_port>:<broker host>:<broker port> <target>`, so the box's
 * `127.0.0.1:<remote_port>` (loopback only: no bind address) is the broker. Both classes are keyed
 * by the forward, `<target>:<remote_port>` (tunnelKey), not the box: two ports on one box are two
 * tunnels with their own checks. `TunnelSupervisor` keeps each tunnel up (restarting it with
 * backoff) and knows whether its ssh is failing; `TunnelChecks` caches each forward's check result
 * (`nc -z` on the box, SshTmuxHost.tunnelUp), which gates new spawns on that host. Neither ever
 * touches a running agent.
 */

/** One forward: `<target>:<remote_port>`. */
export const tunnelKey = (target: string, remotePort: number) => `${target}:${remotePort}`;

/** The reverse tunnel's argv. Throws for a broker URL that is not `mqtt://host[:port]`. */
export function tunnelArgv(target: string, remotePort: number, brokerUrl: string): string[] {
  const u = new URL(brokerUrl);
  if (u.protocol !== "mqtt:" || u.hostname === "" || u.hostname.startsWith("[")) {
    throw new Error(
      `cannot tunnel to broker ${brokerUrl}: remote hosts need an mqtt://host:port broker`,
    );
  }
  const port = u.port !== "" ? u.port : String(DAEMON_DEFAULTS.mqtt_default_port);
  return [
    "ssh",
    "-N",
    "-R",
    `${remotePort}:${u.hostname}:${port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ServerAliveInterval=${DAEMON_DEFAULTS.ssh_alive_interval_s}`,
    "-o",
    `ConnectTimeout=${DAEMON_DEFAULTS.ssh_connect_timeout_s}`,
    target,
  ];
}

export interface TunnelSupervisorDeps {
  /** The fenced exec (`ssh -N -R …` is on the fence's allow-list). */
  exec: ExecFn;
  log?: (line: string) => void;
  /**
   * Called when a tunnel's ssh exits (it is restarted after a backoff). `streak` counts the
   * exits since the tunnel last stayed up past the settle time: 2 or more means the forward
   * keeps failing (e.g. the box's port is taken).
   */
  onExit?: (exit: TunnelExit) => void;
  /** Injectable wait (tests); resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** How long a fresh ssh may take to bring its forward up. Default tunnel_settle_ms. */
  settleMs?: number;
}

export interface TunnelExit {
  target: string;
  remotePort: number;
  code: number;
  stderr: string;
  streak: number;
}

/**
 * A supervised tunnel's own view: `ok` (its ssh has been up past the settle time, or it is not
 * supervised), `settling` (just started or restarting: a failed check means nothing yet),
 * `failing` (its ssh keeps exiting, so whatever answers on the port is not this tunnel).
 */
export type TunnelHealth = "ok" | "settling" | "failing";

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

interface Supervised {
  abort: AbortController;
  done: Promise<void>;
  running: boolean;
  startedAt: number;
  streak: number;
}

/** Keeps one reverse tunnel per forward up until `stop()`. */
export class TunnelSupervisor {
  private readonly tunnels = new Map<string, Supervised>();
  constructor(private readonly deps: TunnelSupervisorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Start the forward's tunnel unless it is already supervised. */
  ensure(target: string, remotePort: number, brokerUrl: string): void {
    const key = tunnelKey(target, remotePort);
    if (this.tunnels.has(key)) return;
    const argv = tunnelArgv(target, remotePort, brokerUrl);
    const t: Supervised = {
      abort: new AbortController(),
      done: Promise.resolve(),
      running: false,
      startedAt: this.now(),
      streak: 0,
    };
    this.tunnels.set(key, t);
    t.done = this.loop(target, remotePort, argv, t);
  }

  /** True when the forward's tunnel is supervised. */
  has(target: string, remotePort: number): boolean {
    return this.tunnels.has(tunnelKey(target, remotePort));
  }

  /** Forwards (`<target>:<remote_port>`) with a supervised tunnel. */
  targets(): string[] {
    return [...this.tunnels.keys()];
  }

  health(target: string, remotePort: number): TunnelHealth {
    const t = this.tunnels.get(tunnelKey(target, remotePort));
    if (t === undefined) return "ok";
    const settle = this.deps.settleMs ?? DAEMON_DEFAULTS.tunnel_settle_ms;
    if (t.running && this.now() - t.startedAt >= settle) return "ok";
    return t.streak >= 2 ? "failing" : "settling";
  }

  private async loop(
    target: string,
    remotePort: number,
    argv: string[],
    t: Supervised,
  ): Promise<void> {
    const { signal } = t.abort;
    const sleep = this.deps.sleep ?? abortableSleep;
    const settle = this.deps.settleMs ?? DAEMON_DEFAULTS.tunnel_settle_ms;
    let backoff: number = DAEMON_DEFAULTS.tunnel_restart_ms;
    while (!signal.aborted) {
      t.startedAt = this.now();
      t.running = true;
      this.deps.log?.(`tunnel ${target}: ${argv.join(" ")}`);
      const r = await this.deps.exec(argv, { signal }).catch((e: unknown) => ({
        code: -1,
        stderr: e instanceof Error ? e.message : String(e),
      }));
      t.running = false;
      if (signal.aborted) break;
      const lasted = this.now() - t.startedAt;
      t.streak = lasted >= settle ? 1 : t.streak + 1;
      this.deps.log?.(`tunnel ${target} exited ${r.code}: ${r.stderr.trim()}`);
      this.deps.onExit?.({ target, remotePort, code: r.code, stderr: r.stderr, streak: t.streak });
      // A tunnel that stayed up a while starts its backoff over.
      if (lasted > DAEMON_DEFAULTS.tunnel_restart_max_ms) {
        backoff = DAEMON_DEFAULTS.tunnel_restart_ms;
      }
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, DAEMON_DEFAULTS.tunnel_restart_max_ms);
    }
  }

  /** Abort every tunnel (its ssh is killed) and wait for the loops to end. */
  async stop(): Promise<void> {
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const t of all) t.abort.abort();
    await Promise.all(all.map((t) => t.done));
  }
}

export type TunnelStatus = "unknown" | "up" | "down";

export interface TunnelChecksDeps {
  now: () => number;
  /** Called when a forward's status changes (after a completed check). */
  onChange: (key: string, status: TunnelStatus) => void;
  log?: (line: string) => void;
}

/**
 * The last tunnel check per forward (tunnelKey); a check runs when due and none is in flight.
 * A check that answers `unknown` (the tunnel is still settling) leaves the status as it was and
 * is due again at once.
 */
export class TunnelChecks {
  private readonly state = new Map<
    string,
    { status: TunnelStatus; checkedAt: number; inFlight: boolean }
  >();
  constructor(private readonly deps: TunnelChecksDeps) {}

  status(key: string): TunnelStatus {
    return this.state.get(key)?.status ?? "unknown";
  }

  /** Make the forward's next poke run its check (its tunnel just exited). */
  invalidate(key: string): void {
    const s = this.state.get(key);
    if (s !== undefined) s.checkedAt = 0;
  }

  /** Run `check` for the forward if its last result is older than the check interval. */
  poke(key: string, check: () => Promise<TunnelStatus>): void {
    const s = this.state.get(key) ?? { status: "unknown", checkedAt: 0, inFlight: false };
    this.state.set(key, s);
    const due =
      s.status === "unknown" ||
      s.checkedAt === 0 ||
      this.deps.now() - s.checkedAt >= DAEMON_DEFAULTS.tunnel_check_ms;
    if (s.inFlight || !due) return;
    s.inFlight = true;
    void check()
      .catch((): TunnelStatus => "down")
      .then((next) => {
        s.inFlight = false;
        if (next === "unknown") {
          s.checkedAt = 0;
          return;
        }
        s.checkedAt = this.deps.now();
        if (next === s.status) return;
        s.status = next;
        this.deps.log?.(`tunnel ${key} ${next}`);
        this.deps.onChange(key, next);
      });
  }
}
