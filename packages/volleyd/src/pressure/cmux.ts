import { cmuxEnv } from "volley-cli/setup/cmux";
import type { Sample } from "../admission";
import { systemClock } from "../clock";
import { volleydHome } from "../config-store";
import type { ExecFn } from "../exec";
import { bounded } from "./run";

/** A round trip over the terminal multiplexer's socket. */
export const CMUX_PING_ARGV = ["cmux", "ping"] as const;

/**
 * Wall time of `cmux ping`, in ms. A ping that times out IS the measurement — a socket that
 * stopped answering is exactly the pressure this signal watches — so it reports the time waited
 * (`timeoutMs`, which the caller sets above the threshold). No cmux binary, or a ping that
 * fails outright, is unknown. `env` carries the cmux socket password `volley setup` stored (read
 * each time), which cmux asks of volleyd as a service.
 */
export async function sampleCmuxPing(
  exec: ExecFn,
  timeoutMs: number,
  // real clock: the default: the ping times a real child process
  now: () => number = systemClock.mono,
  env: Record<string, string | undefined> | undefined = cmuxEnv(
    volleydHome(process.env),
    process.env,
  ),
): Promise<Sample> {
  const started = now();
  try {
    const r = await exec(CMUX_PING_ARGV, {
      timeoutMs,
      killGraceMs: 0,
      ...(env !== undefined ? { env } : {}),
    });
    const ms = Math.round(now() - started);
    if (r.timedOut) return { ok: true, value: ms, raw: `cmux ping timed out after ${ms} ms` };
    if (r.code !== 0) {
      return {
        ok: false,
        raw: bounded(r.stdout),
        error: `cmux ping exited ${r.code}: ${bounded(r.stderr)}`,
      };
    }
    return { ok: true, value: ms, raw: bounded(r.stdout) };
  } catch (e) {
    return { ok: false, raw: "", error: e instanceof Error ? e.message : String(e) };
  }
}
