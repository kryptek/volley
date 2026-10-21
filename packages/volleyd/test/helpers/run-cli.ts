import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli";
import { makeBufferIO } from "../../src/io";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A default env that can never reach the live broker or the real `~/.volley/volleyd`: port 1 on
 * loopback refuses connections, and the home is a path under the temp dir that is never created.
 */
export const SAFE_ENV = {
  VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1",
  VOLLEYD_HOME: join(tmpdir(), "volleyd-test-no-home"),
};

/** Invoke the CLI in-process with a buffer IO. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = SAFE_ENV,
): Promise<RunResult> {
  const io = makeBufferIO();
  const exitCode = await main({ argv, env, io });
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
}

/** `run`'s stderr without its ownerless-wave warning (a test that submits without an owner). */
export const withoutOwnerWarning = (stderr: string): string =>
  stderr
    .split(/(?<=\n)/)
    .filter((l) => !/^warning: wave \S+ has no owner: /.test(l))
    .join("");
