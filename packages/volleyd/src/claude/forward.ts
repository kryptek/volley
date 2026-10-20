import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import type { SigninForwardToken } from "../fence";

/**
 * A paired machine's sign-in forward: `ssh -N -L 127.0.0.1:<p>:127.0.0.1:<p> <target>`, so the
 * browser's redirect to `http://localhost:<p>/callback` on the supervisor's machine reaches
 * Claude Code's own listener on the box. One lifetime, like a broker tunnel without the restarts
 * (hosts/tunnel.ts): it runs from the moment the sign-in's URL is known until the sign-in ends.
 * The same port on both ends (the OAuth redirect must match verbatim); its bytes are never read
 * or logged: an opaque encrypted pipe. Started only with the token remote-signin.ts mints.
 */

/** The forward's argv (the one shape the fence allows with a SigninForwardToken). */
export function forwardArgv(target: string, port: number): string[] {
  return [
    "ssh",
    "-N",
    "-L",
    `127.0.0.1:${port}:127.0.0.1:${port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ConnectTimeout=${DAEMON_DEFAULTS.ssh_connect_timeout_s}`,
    target,
  ];
}

/** What ssh prints when the local end cannot listen: the port is taken on this machine. */
const PORT_BUSY =
  /address already in use|cannot listen to port|could not request local forwarding/i;

export interface Forward {
  /** Kill the ssh and wait for it to exit (at once when it already has). */
  stop(): Promise<void>;
}

export type ForwardStart =
  | { ok: true; forward: Forward }
  | { ok: false; busy: boolean; reason: string };

/**
 * Start the forward and wait `settle` (ExitOnForwardFailure makes a failed bind exit at once): up
 * when it is still running then, else why it exited (`busy`: the local port is taken).
 */
export async function openForward(
  exec: ExecFn,
  token: SigninForwardToken,
  settle: () => Promise<void>,
): Promise<ForwardStart> {
  const abort = new AbortController();
  const exited = exec(forwardArgv(token.target, token.port), {
    forward: token,
    signal: abort.signal,
  }).catch(
    (e: unknown): ExecResult => ({
      code: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
    }),
  );
  const early = await Promise.race([exited, settle().then(() => null)]);
  if (early !== null) {
    const reason = early.stderr.trim().split("\n").at(-1) || `ssh exited ${early.code}`;
    return { ok: false, busy: PORT_BUSY.test(early.stderr), reason };
  }
  return {
    ok: true,
    forward: {
      stop: async () => {
        abort.abort();
        await exited;
      },
    },
  };
}
