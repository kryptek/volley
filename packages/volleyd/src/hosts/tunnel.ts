import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";

/**
 * Broker reachability for remote hosts. Agents on a box reach the daemon's broker through a
 * reverse SSH tunnel: `ssh -N -R <remote_port>:<broker host>:<broker port> <target>`, so the box's
 * `127.0.0.1:<remote_port>` (loopback only: no bind address) is the broker. `TunnelSupervisor`
 * keeps one such tunnel per target up (restarting it with backoff); `TunnelChecks` caches the
 * result of each target's tunnel check (`nc -z` on the box, SshTmuxHost.tunnelUp), which gates
 * new spawns on that host. Neither ever touches a running agent.
 */

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
  /** Called when a tunnel's ssh exits (it is restarted after a backoff). */
  onExit?: (target: string, code: number, stderr: string) => void;
  /** Injectable wait (tests); resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

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

/** Keeps one reverse tunnel per target up until `stop()`. */
export class TunnelSupervisor {
  private readonly tunnels = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(private readonly deps: TunnelSupervisorDeps) {}

  /** Start the target's tunnel unless it is already supervised. */
  ensure(target: string, remotePort: number, brokerUrl: string): void {
    if (this.tunnels.has(target)) return;
    const argv = tunnelArgv(target, remotePort, brokerUrl);
    const abort = new AbortController();
    this.tunnels.set(target, { abort, done: this.loop(target, argv, abort.signal) });
  }

  /** Targets with a supervised tunnel. */
  targets(): string[] {
    return [...this.tunnels.keys()];
  }

  private async loop(target: string, argv: string[], signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? abortableSleep;
    let backoff: number = DAEMON_DEFAULTS.tunnel_restart_ms;
    while (!signal.aborted) {
      const started = Date.now();
      this.deps.log?.(`tunnel ${target}: ${argv.join(" ")}`);
      const r = await this.deps.exec(argv, { signal }).catch((e: unknown) => ({
        code: -1,
        stderr: e instanceof Error ? e.message : String(e),
      }));
      if (signal.aborted) break;
      this.deps.log?.(`tunnel ${target} exited ${r.code}: ${r.stderr.trim()}`);
      this.deps.onExit?.(target, r.code, r.stderr);
      // A tunnel that stayed up a while starts its backoff over.
      if (Date.now() - started > DAEMON_DEFAULTS.tunnel_restart_max_ms) {
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
  /** Called when a target's status changes (after a completed check). */
  onChange: (target: string, status: TunnelStatus) => void;
  log?: (line: string) => void;
}

/** The last tunnel check per target; a check runs when due and none is in flight. */
export class TunnelChecks {
  private readonly state = new Map<
    string,
    { status: TunnelStatus; checkedAt: number; inFlight: boolean }
  >();
  constructor(private readonly deps: TunnelChecksDeps) {}

  status(target: string): TunnelStatus {
    return this.state.get(target)?.status ?? "unknown";
  }

  /** Run `check` for `target` if its last result is older than the check interval. */
  poke(target: string, check: () => Promise<boolean>): void {
    const s = this.state.get(target) ?? { status: "unknown", checkedAt: 0, inFlight: false };
    this.state.set(target, s);
    const due =
      s.status === "unknown" || this.deps.now() - s.checkedAt >= DAEMON_DEFAULTS.tunnel_check_ms;
    if (s.inFlight || !due) return;
    s.inFlight = true;
    void check()
      .catch(() => false)
      .then((up) => {
        s.inFlight = false;
        s.checkedAt = this.deps.now();
        const next: TunnelStatus = up ? "up" : "down";
        if (next === s.status) return;
        s.status = next;
        this.deps.log?.(`tunnel to ${target} ${next}`);
        this.deps.onChange(target, next);
      });
  }
}
