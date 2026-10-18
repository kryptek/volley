import { spawn } from "node:child_process";
import { type FenceOptions, assertAllowed } from "./fence";

export interface ExecOptions extends FenceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Kill the child (SIGTERM) after this many ms; the result then has `timedOut: true`. */
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  assertAllowed(argv, opts.consent !== undefined ? { consent: opts.consent } : {});
  const [cmd, ...args] = argv as string[];
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd as string, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      // No input → no stdin pipe at all, so nothing can EPIPE.
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, opts.timeoutMs)
        : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    if (child.stdin !== null) {
      // A child may exit without reading its input; the write then fails with EPIPE, which must
      // not become an uncaught exception in the daemon. The exit code is the result that matters.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
};
