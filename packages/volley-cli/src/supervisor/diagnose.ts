/**
 * Why the supervisor does not answer: the ladder internet → private network → tunnel → broker →
 * volleyd, read from what the probes (probes.ts) found. Pure: the first failing rung decides, and
 * each reason has one exact cause and one fix line. A command that cannot reach the supervisor
 * prints them, submits nothing and exits 69 (`SUPERVISOR_UNREACHABLE`, EX_UNAVAILABLE).
 */

export const REASONS = [
  "offline",
  "network_down",
  "tunnel_down",
  "broker_down",
  "daemon_silent",
  "no_broker_here",
] as const;
export type Reason = (typeof REASONS)[number];

/** Printed for a machine with no setup and no broker on its own loopback (unchanged since v0.1). */
export const MOSQUITTO_INSTALL_HINT =
  "Hint: install mosquitto with `brew install mosquitto && brew services start mosquitto` " +
  "(or run any MQTT broker on the URL given by --broker-url / $VOLLEY_BROKER_URL).";

/** Where this command runs, as probes.ts `whereAmI` derives it. */
export interface Where {
  /**
   * `peer`: a paired machine (peer.json); `coordinator`: the coordinator role's session
   * (`VOLLEY_AGENT_ID=coordinator` with `VOLLEY_BROKER_URL`); `supervisor`: setup.json with a
   * layout; `other`: none of them.
   */
  kind: "supervisor" | "peer" | "coordinator" | "other";
  /** peer.json's machine name. */
  machine?: string;
  brokerUrl: string;
  /** A paired machine's tunnel port (peer.json's `remote_port`, when it runs ssh). */
  tunnelPort?: number;
  /** setup.json's `network` record. */
  network?: { kind: string; name?: string; address?: string };
  /** The namespace the command addressed (its volleyd status topic is `volley/<ns>/volleyd/status`). */
  namespace?: string;
}

export interface DiagnoseInput {
  internet: boolean;
  network: "up" | "down" | "unknown";
  /** `none`: no tunnel on this machine (that rung is skipped). */
  tunnel: "up" | "down" | "none";
  broker: "up" | "down";
  /** `unknown`: not asked (the broker answered nothing the probe could read). */
  daemon: "live" | "silent" | "unknown";
  where: Where;
}

export interface Diagnosis {
  reason: Reason;
  cause: string;
  fix: string;
}

/** A broker on this machine's own loopback (a URL's hostname may be bracketed, `[::1]`). */
export const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const RESTART_VOLLEYD =
  "on the supervisor's machine run `launchctl kickstart -k gui/$UID/systems.volley.volleyd` (or `systemctl --user restart volleyd`) or `volley deploy --latest`";

/** How to bring the private network up, by setup.json's network record. */
function networkUp(kind: string | undefined): { cause: string; fix: string } {
  if (kind === "tailscale")
    return { cause: "Tailscale is not running: `tailscale up`", fix: "`tailscale up`" };
  if (kind === "manual") return { cause: "connect your VPN", fix: "connect your VPN" };
  return {
    cause: "Tailscale is not running: `tailscale up`; or connect your VPN",
    fix: "`tailscale up` (or connect your VPN)",
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function diagnosis(reason: Reason, where: Where): Diagnosis {
  switch (reason) {
    case "offline":
      return {
        reason,
        cause: "You are offline. Nothing can reach the supervisor until you are online.",
        fix: "get online, then re-run",
      };
    case "network_down": {
      const how = networkUp(where.network?.kind);
      return {
        reason,
        cause: `The private network is not up on this machine (${how.cause}).`,
        fix: `${how.fix}, then re-run`,
      };
    }
    case "tunnel_down": {
      const port = where.tunnelPort ?? Number(new URL(where.brokerUrl).port);
      return {
        reason,
        cause: `This machine's tunnel to the broker is down (\`127.0.0.1:${port}\` refuses). \`volley peer doctor\` shows why; the service restarts it on its own (\`launchctl kickstart -k gui/$UID/systems.volley.peer\` or \`systemctl --user restart volley-peer\`).`,
        fix: "`volley peer doctor`; or restart the service: `launchctl kickstart -k gui/$UID/systems.volley.peer` (macOS) or `systemctl --user restart volley-peer` (Linux)",
      };
    }
    case "broker_down":
      return {
        reason,
        cause: `The broker at ${where.brokerUrl} does not answer. On the supervisor's machine: \`volley setup --check\`; from elsewhere: check that machine is up.`,
        fix: "on the supervisor's machine: `volley setup --check`; from elsewhere: check that machine is up",
      };
    case "daemon_silent": {
      const ns =
        where.namespace === undefined
          ? ""
          : ` in namespace '${where.namespace}' (no live status at \`volley/${where.namespace}/volleyd/status\`; check --namespace / $VOLLEY_NAMESPACE)`;
      return {
        reason,
        cause: `The broker answers but volleyd is silent${ns}: ${RESTART_VOLLEYD}.`,
        fix: "on the supervisor's machine: `launchctl kickstart -k gui/$UID/systems.volley.volleyd` (or `systemctl --user restart volleyd`) or `volley deploy --latest`",
      };
    }
    case "no_broker_here":
      return {
        reason,
        cause: `No broker answers at ${where.brokerUrl}, and this machine has no Volley setup.`,
        fix: MOSQUITTO_INSTALL_HINT,
      };
  }
}

/** The first failing rung's reason, cause and fix; null when every rung answered. */
export function diagnose(input: DiagnoseInput): Diagnosis | null {
  const { where } = input;
  if (!input.internet) return diagnosis("offline", where);
  if (input.network === "down") return diagnosis("network_down", where);
  if (input.tunnel === "down") return diagnosis("tunnel_down", where);
  if (input.broker === "down") {
    // A machine Volley was never set up on, pointed at its own loopback: install a broker.
    const local = LOOPBACK.has(hostOf(where.brokerUrl) ?? "");
    return diagnosis(where.kind === "other" && local ? "no_broker_here" : "broker_down", where);
  }
  if (input.daemon === "silent") return diagnosis("daemon_silent", where);
  return null;
}

/** A command that reached the broker but found no live volleyd: the earlier rungs passed. */
export const silentInput = (where: Where): DiagnoseInput => ({
  internet: true,
  network: "unknown",
  tunnel: where.tunnelPort !== undefined ? "up" : "none",
  broker: "up",
  daemon: "silent",
  where,
});

/** The stderr form: `<command>: supervisor unreachable (<reason>): <cause>` and the fix line. */
export const unreachableText = (command: string, d: Diagnosis): string =>
  `${command}: supervisor unreachable (${d.reason}): ${d.cause}\n  fix: ${d.fix}\n`;

/** The `--json` form, on stdout. */
export function unreachableJson(d: Diagnosis, input: DiagnoseInput) {
  const { where, ...probes } = input;
  return {
    error: "SUPERVISOR_UNREACHABLE" as const,
    reason: d.reason,
    cause: d.cause,
    fix: d.fix,
    where,
    probes,
  };
}

/**
 * Print `input`'s diagnosis as `command` (stderr; with `json`, the object on stdout too). False when
 * every rung answered: nothing printed, the caller reports its own error. Both CLIs (volley,
 * volleyd) print through this, so their output stays the same.
 */
export function printUnreachable(
  io: { stdout(s: string): void; stderr(s: string): void },
  command: string,
  json: boolean,
  input: DiagnoseInput,
): boolean {
  const d = diagnose(input);
  if (d === null) return false;
  if (json) io.stdout(`${JSON.stringify(unreachableJson(d, input), null, 2)}\n`);
  io.stderr(unreachableText(command, d));
  return true;
}
