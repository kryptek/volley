import { hostname } from "node:os";

/**
 * The supervisor's own machine name (SPEC §4.6.15), as pure logic. `local` is only a token: a
 * wave file's `host: local` and an `agent_spawned` without a host mean the supervisor's machine,
 * which machine records, placement and lease state name by `localMachineName` instead. Map the
 * token at the boundary, never publish it.
 */

/** The wave-file / spawn token for the supervisor's own machine. Never a machine name. */
export const LOCAL_HOST = "local";

/** Names a machine never has: the tokens a wave file's `host:` reserves. */
const RESERVED = new Set([LOCAL_HOST, "auto"]);
/** Names a derived name falls back from: the reserved tokens and the fixed identities. */
const NOT_DERIVED = new Set([...RESERVED, "volleyd", "desk", "coordinator"]);
const FALLBACK = "supervisor";

const MACHINE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A valid `fleet.local_name` (config.schema.json): `[a-z0-9][a-z0-9_-]{0,62}`, never reserved. */
export const isMachineName = (s: string): boolean => MACHINE_NAME.test(s) && !RESERVED.has(s);

/**
 * The name derived from a host name: its first DNS label, lowercased, every character outside
 * `[a-z0-9_-]` replaced by `-`, leading characters that are not `[a-z0-9]` dropped, cut to 63;
 * an empty, reserved or fixed-identity result becomes `supervisor`.
 */
export function deriveMachineName(host: string): string {
  const name = (host.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return name === "" || NOT_DERIVED.has(name) ? FALLBACK : name;
}

/**
 * The supervisor's own machine name: `fleet.local_name` when it is set (and valid), else derived
 * from the machine's host name.
 */
export function localMachineName(localName?: string | null, host: string = hostname()): string {
  return typeof localName === "string" && isMachineName(localName)
    ? localName
    : deriveMachineName(host);
}
