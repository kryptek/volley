import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The paired machines as `volley deploy` reaches them (SPEC §4.6.14): each name in
 * `$VOLLEYD_HOME/peers.json` (not being removed) with its `hosts.<name>` entry's ssh target and
 * volley checkout from `$VOLLEYD_HOME/config.yaml`. Read-only, from the files: the deploy runs on
 * the supervisor's machine and needs no running daemon.
 */

export interface PairedHost {
  name: string;
  /** ssh destination: `hosts.<name>.target`, else the one the pairing recorded. */
  target: string;
  /** The machine's volley checkout (absolute). */
  volley_dir: string;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function pairedHosts(home: string): {
  hosts: PairedHost[];
  problems: { name: string; why: string }[];
} {
  const hosts: PairedHost[] = [];
  const problems: { name: string; why: string }[] = [];
  const pairedFile = join(home, "peers.json");
  if (!existsSync(pairedFile)) return { hosts, problems };
  let file: Record<string, unknown>;
  try {
    file = obj(JSON.parse(readFileSync(pairedFile, "utf-8")));
  } catch {
    return { hosts, problems };
  }
  const paired = obj(file.peers);
  const removing = obj(file.removing);
  const names = Object.keys(paired)
    .filter((n) => !Object.hasOwn(removing, n))
    .sort();
  if (names.length === 0) return { hosts, problems };
  const configFile = join(home, "config.yaml");
  let configured: Record<string, unknown> = {};
  try {
    if (existsSync(configFile)) {
      configured = obj(obj(parse(readFileSync(configFile, "utf-8"))).hosts);
    }
  } catch (e) {
    const why = `cannot read ${configFile}: ${(e as Error).message.split("\n")[0]}`;
    return { hosts, problems: names.map((name) => ({ name, why })) };
  }
  for (const name of names) {
    if (!Object.hasOwn(configured, name)) {
      problems.push({ name, why: `no hosts.${name} in config.yaml` });
      continue;
    }
    const h = obj(configured[name]);
    const target = typeof h.target === "string" ? h.target : obj(paired[name]).target;
    if (typeof h.volley_dir !== "string" || !h.volley_dir.startsWith("/")) {
      problems.push({ name, why: `hosts.${name} has no volley_dir` });
    } else if (typeof target !== "string" || target === "" || target.startsWith("-")) {
      problems.push({ name, why: `hosts.${name} has no ssh target` });
    } else hosts.push({ name, target, volley_dir: h.volley_dir });
  }
  return { hosts, problems };
}
