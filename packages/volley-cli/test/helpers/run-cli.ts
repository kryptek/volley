import { main } from "../../src/cli";
import { makeBufferIO } from "../../src/io";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI in-process with a buffer IO, returning what would have been written + the exit code. */
export async function runCli(opts: {
  argv: string[];
  env?: Record<string, string | undefined>;
}): Promise<RunResult> {
  const io = makeBufferIO();
  const exitCode = await main({
    argv: opts.argv,
    env: opts.env ?? {},
    io,
  });
  return { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
}
