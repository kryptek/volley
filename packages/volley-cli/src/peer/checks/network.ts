import type { Check, Facts } from "../doctor";

/**
 * The private network (`volley setup`'s Network step): whether this machine is reachable the way
 * its setup.json says, from outside its own network. Informational: a warning at most, never a
 * blocker (readiness never reads it).
 */

export function networkChecks(f: Facts): Check[] {
  const n = f.network;
  const step = `volley setup${n.peer ? " --peer" : ""} --step network`;
  const check = (ok: boolean, detail: string, command = step): Check => ({
    id: "network.private",
    ok,
    severity: "warn",
    detail,
    ...(ok ? {} : { fix: { command } }),
  });
  const r = n.record;
  if (r === null) {
    return [check(false, "no private network on record (volley setup's Network step has not run)")];
  }
  // A rerun with no flag keeps a `none` record, so the fix names the kind that changes it.
  if (r.kind === "none") {
    return [check(false, "none: reached on its own network only", `${step} --network tailscale`)];
  }
  if (r.kind === "manual") {
    return [
      n.bound !== null
        ? check(true, `manual: ${r.address ?? "?"} (on ${n.bound})`)
        : check(false, `manual: ${r.address ?? "?"} is not an address of this machine`),
    ];
  }
  if (n.tailscale === null) return [check(false, "tailscale: not installed")];
  if (!n.tailscale.running) {
    return [check(false, `tailscale: not signed in (${n.tailscale.state})`)];
  }
  return [
    check(
      true,
      `tailscale: ${n.tailscale.name ?? r.name ?? "?"} (${n.tailscale.address ?? r.address ?? "no IPv4 address"})`,
    ),
  ];
}
