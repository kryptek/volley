import { spawn } from "node:child_process";
import { type TimerHandle, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { FenceError, type FenceOptions, assertAllowed, renderRemoteScript } from "./fence";

export interface ExecOptions extends FenceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. Not with `remote` (that is the stdin). */
  input?: string;
  /** Kills the child (SIGTERM, then SIGKILL after the grace) when aborted: long-lived children. */
  signal?: AbortSignal;
  /**
   * Kill the child after this many ms: SIGTERM, then after `killGraceMs` SIGKILL, and resolve
   * with the output so far even if a grandchild still holds the pipes open. The result then has
   * `timedOut: true`.
   */
  timeoutMs?: number;
  /** Default `DAEMON_DEFAULTS.exec_kill_grace_ms`. */
  killGraceMs?: number;
  /** Cap on captured stdout and stderr (each); default `DAEMON_DEFAULTS.exec_output_max_bytes`. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when stdout or stderr exceeded the cap and was cut short (the child keeps running). */
  truncated?: true;
}

/** Signature of `exec`, for injecting a fake in tests. */
export type ExecFn = (argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/**
 * Run one external command. This is the ONLY place volleyd spawns a child process (a test greps
 * for it): every argv passes the authority fence first, and is spawned without a shell so the
 * fenced argv is exactly what runs. A non-zero exit resolves; only the fence and spawn failures
 * (command not found) reject.
 */
export const exec: ExecFn = async (argv, opts = {}) => {
  assertAllowed(argv, {
    ...(opts.consent !== undefined ? { consent: opts.consent } : {}),
    ...(opts.script !== undefined ? { script: opts.script } : {}),
    ...(opts.remote !== undefined ? { remote: opts.remote } : {}),
    ...(opts.launch !== undefined ? { launch: opts.launch } : {}),
    ...(opts.modelSwitch !== undefined ? { modelSwitch: opts.modelSwitch } : {}),
    ...(opts.signin !== undefined ? { signin: opts.signin } : {}),
    ...(opts.setup !== undefined ? { setup: opts.setup } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  if (opts.remote !== undefined && opts.input !== undefined) {
    throw new FenceError("ssh bash -s", "a raw input next to a fenced remote script");
  }
  // A fenced remote script reaches ssh's stdin exactly as it was checked.
  const input = opts.remote !== undefined ? renderRemoteScript(opts.remote) : opts.input;
  const [cmd, ...args] = argv as string[];
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd as string, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      // No input → no stdin pipe at all, so nothing can EPIPE.
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const max = opts.maxOutputBytes ?? DAEMON_DEFAULTS.exec_output_max_bytes;
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const size = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    const collect = (which: "stdout" | "stderr") => (d: Buffer) => {
      const room = max - size[which];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const chunk = d.length > room ? d.subarray(0, room) : d;
      if (chunk.length < d.length) truncated = true;
      out[which].push(chunk);
      size[which] += chunk.length;
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    // Real timers: they bound a real child process.
    // real clock: a child process runs on the real clock, so its timeout does too
    const clock = systemClock;
    let killer: TimerHandle | undefined;
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      clock.clearTimeout(killer);
      opts.signal?.removeEventListener("abort", abort);
      resolve({
        code,
        stdout: Buffer.concat(out.stdout).toString(),
        stderr: Buffer.concat(out.stderr).toString(),
        timedOut,
        ...(truncated ? { truncated: true as const } : {}),
      });
    };
    const timer =
      opts.timeoutMs !== undefined
        ? clock.setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killer = clock.setTimeout(() => {
              child.kill("SIGKILL");
              child.stdout?.destroy();
              child.stderr?.destroy();
              settle(child.exitCode ?? 1);
            }, opts.killGraceMs ?? DAEMON_DEFAULTS.exec_kill_grace_ms);
          }, opts.timeoutMs)
        : undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killer ??= clock.setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(child.exitCode ?? 1);
      }, opts.killGraceMs ?? DAEMON_DEFAULTS.exec_kill_grace_ms);
    };
    if (opts.signal?.aborted === true) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      clock.clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => settle(code ?? 1));
    if (child.stdin !== null) {
      // A child may exit without reading its input; the write then fails with EPIPE, which must
      // not become an uncaught exception in the daemon. The exit code is the result that matters.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
};
