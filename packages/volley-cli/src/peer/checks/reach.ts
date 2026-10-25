import type { BrokerAuth } from "volley-mcp/config";
import { diagnose } from "../../supervisor/diagnose";
import type { Probes } from "../../supervisor/probes";
import type { Check, Facts } from "../doctor";

/**
 * Whether this paired machine reaches its supervisor (the ladder of supervisor/diagnose.ts, as
 * rows): online, its tunnel accepting, volleyd live behind it. Each failing row carries the fix
 * line the unreachable-supervisor diagnosis prints. Informational: warnings, never blockers
 * (`network.private`, P1a's, sits between the internet and the tunnel).
 */

export type Reach = NonNullable<Facts["reach"]>;
export type ReachProbes = Pick<Probes, "internetUp" | "tunnelUp" | "daemonLive">;

/** Each rung probed in order, a later one only when the earlier passed. */
export async function probeReach(
  p: ReachProbes,
  o: { brokerUrl: string; tunnelPort: number | null; auth: BrokerAuth | null },
): Promise<Reach> {
  const internet = await p.internetUp();
  const tunnel =
    o.tunnelPort !== null
      ? { port: o.tunnelPort, up: internet && (await p.tunnelUp(o.tunnelPort)) }
      : null;
  const reached = internet && (tunnel === null || tunnel.up);
  const supervisor = reached && (await p.daemonLive(o.brokerUrl, o.auth));
  return { brokerUrl: o.brokerUrl, internet, tunnel, supervisor };
}

/** The fix line `diagnose` gives `reason` on this machine. */
function fixOf(f: Reach, reason: "offline" | "tunnel" | "daemon"): string {
  const d = diagnose({
    internet: reason !== "offline",
    network: "unknown",
    tunnel: reason === "tunnel" ? "down" : "none",
    broker: "up",
    daemon: reason === "daemon" ? "silent" : "live",
    where: {
      kind: "peer",
      brokerUrl: f.brokerUrl,
      ...(f.tunnel !== null ? { tunnelPort: f.tunnel.port } : {}),
    },
  });
  return d?.fix ?? "";
}

export function reachChecks(r: Facts["reach"]): Check[] {
  if (r === null) return [];
  const check = (id: string, ok: boolean, detail: string, fix: string): Check => ({
    id,
    ok,
    severity: "warn",
    detail,
    ...(ok ? {} : { fix: { command: fix } }),
  });
  const rows: Check[] = [
    check(
      "network.internet",
      r.internet,
      r.internet ? "online" : "offline: nothing can reach the supervisor",
      fixOf(r, "offline"),
    ),
  ];
  if (r.tunnel !== null) {
    rows.push(
      check(
        "tunnel.up",
        r.tunnel.up,
        `127.0.0.1:${r.tunnel.port} ${r.tunnel.up ? "accepts" : "refuses"}`,
        fixOf(r, "tunnel"),
      ),
    );
  }
  const reached = r.internet && (r.tunnel === null || r.tunnel.up);
  rows.push(
    check(
      "supervisor.live",
      r.supervisor,
      r.supervisor
        ? `volleyd is live at ${r.brokerUrl}`
        : reached
          ? `volleyd is silent at ${r.brokerUrl}`
          : "not reached (see above)",
      reached ? fixOf(r, "daemon") : fixOf(r, r.internet ? "tunnel" : "offline"),
    ),
  );
  return rows;
}
