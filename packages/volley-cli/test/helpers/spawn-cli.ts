import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_ENTRY = `${PACKAGE_ROOT}/src/cli.ts`;

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the real CLI via `bun run src/cli.ts ...args` against the given env, capturing
 * stdout/stderr.
 *
 * We use `node:child_process` rather than `Bun.spawn` because vitest 2.x runs tests in
 * Node worker threads — the `Bun` global is not injected into those workers even when
 * the test runner is launched via `bun run vitest`. The `import.meta.main` check in
 * `cli.ts` makes the same observation from the other direction (it stays `false` under
 * vitest because the worker is not the real Bun main process).
 */
export async function spawnCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<SpawnResult> {
  // process.env is Record<string, string | undefined>; spawn's env option also accepts
  // that shape, but stripping undefineds up front keeps the merged record exact.
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", CLI_ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...baseEnv, ...env },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });
  });
}
