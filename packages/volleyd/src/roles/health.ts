import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecResult } from "../exec";

/**
 * A role move's health checks (SPEC §4.6.24): volleyd makes no http calls of its own, so the
 * machine that should now run the role checks itself (`volley desk check`), or the check is a
 * retained status the new process publishes. Each retries a few times
 * (`role_health_attempts` × `role_health_wait_ms`) before the move is failed and rolled back.
 */

/** The last line a command printed (stderr first: that is where a check says why). */
export function lastLine(r: Pick<ExecResult, "stdout" | "stderr" | "code">): string {
  const text = (r.stderr.trim() || r.stdout.trim()).split("\n").pop()?.trim() ?? "";
  return text !== "" ? text : `exit ${r.code}`;
}

/**
 * `volley desk check --url http://127.0.0.1:<port> --version <v>` on the Desk's machine (`run`
 * runs it there), until it exits 0; throws with its last line when it never does.
 */
export async function deskCheck(
  run: (argv: string[]) => Promise<ExecResult>,
  port: number,
  version: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const argv = deskCheckArgv(port, version);
  let last = "";
  for (let i = 0; i < DAEMON_DEFAULTS.role_health_attempts; i++) {
    if (i > 0) await sleep(DAEMON_DEFAULTS.role_health_wait_ms);
    const r = await run(argv);
    if (r.code === 0) return `the Desk answers on port ${port} at version ${version}`;
    last = lastLine(r);
  }
  throw new Error(`the Desk did not answer its health check: ${last}`);
}

/** The Desk's health check, as its machine runs it. */
export const deskCheckArgv = (port: number, version: string) => [
  "volley",
  "desk",
  "check",
  "--url",
  `http://127.0.0.1:${port}`,
  "--version",
  version,
];

/**
 * Wait until `read` answers `want` (a retained status), on the move's clock; throws naming what
 * it saw last when it never does.
 */
export async function waitForStatus(
  read: () => Promise<string | null>,
  want: string,
  what: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  let seen: string | null = null;
  for (let i = 0; i < DAEMON_DEFAULTS.role_health_attempts; i++) {
    if (i > 0) await sleep(DAEMON_DEFAULTS.role_health_wait_ms);
    seen = await read();
    if (seen === want) return `${what} is ${want}`;
  }
  throw new Error(`${what} is ${seen ?? "not published"}, not ${want}`);
}
