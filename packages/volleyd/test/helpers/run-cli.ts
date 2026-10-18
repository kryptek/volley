import { main } from "../../src/cli";
import { makeBufferIO } from "../../src/io";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI in-process with a buffer IO. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const io = makeBufferIO();
  const exitCode = await main({ argv, env, io });
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
}
