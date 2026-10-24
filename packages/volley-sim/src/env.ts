import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the simulator lives and how a shell turns it on. The fakes (`bin/claude`, `bin/gh`) answer
 * only under `VOLLEY_SIMULATED=1`; anywhere else they hand the call to the real program further
 * down PATH, so the directory on PATH by accident never fakes anything.
 */

/** `packages/volley-sim/bin`: the directory `volley sim env` puts first on PATH. */
export const SIM_BIN = fileURLToPath(new URL("../bin", import.meta.url));

export type Env = Record<string, string | undefined>;

/** `$VOLLEY_SIM_HOME`, else `~/.volley/sim`: the world file, its lock, unknown.jsonl, origins. */
export function simHome(env: Env = process.env): string {
  const set = env.VOLLEY_SIM_HOME;
  if (set !== undefined && set !== "") return resolve(set);
  return join(env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir(), ".volley", "sim");
}

/** True when the fakes answer (`VOLLEY_SIMULATED=1`). */
export const isSimulated = (env: Env = process.env) => env.VOLLEY_SIMULATED === "1";

/** Single-quote for a POSIX shell. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The line `volley sim env` prints for `eval "$(volley sim env)"`: the fakes' bin first on PATH,
 * the world's home, and the switch.
 */
export function simEnvLine(home: string, bin: string = SIM_BIN): string {
  return `export PATH=${shq(bin)}:"$PATH" VOLLEY_SIM_HOME=${shq(home)} VOLLEY_SIMULATED=1`;
}

/** What `volley sim reset` removes from the home: the world, its lock, the log, the origins. */
export const WORLD_ENTRIES = ["world.json", "world.json.lock", "unknown.jsonl", "origins"];

/** Clear the world: every entry the simulator wrote in `home` (nothing else there). */
export function resetWorld(home: string): string[] {
  const removed = WORLD_ENTRIES.filter((e) => existsSync(join(home, e)));
  for (const e of removed) rmSync(join(home, e), { recursive: true, force: true });
  return removed;
}

/** The next `name` on PATH that is not one of the simulator's own (null: none). */
export function realProgram(name: string, env: Env = process.env): string | null {
  const own = resolve(SIM_BIN);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || resolve(dir) === own) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/**
 * Not simulated: run the real `name` with the same argv and stdio, and return its exit code (127
 * when there is none, the way a shell says it).
 */
export function passThrough(name: string, argv: string[], env: Env = process.env): number {
  const real = realProgram(name, env);
  if (real === null) {
    process.stderr.write(`${name}: command not found (volley-sim: VOLLEY_SIMULATED is not 1)\n`);
    return 127;
  }
  const r = spawnSync(real, argv, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
  return r.status ?? 1;
}
