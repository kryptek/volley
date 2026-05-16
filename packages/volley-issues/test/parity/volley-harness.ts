import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VOLLEY_ISSUES_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_ENTRY = `${VOLLEY_ISSUES_ROOT}/../volley-cli/src/cli.ts`;

export interface VolleyDetection {
  /** When `volley wait` exited 0 (Date.now()). */
  detectedAt: number;
}

/**
 * Spawns the real `volley wait` binary as a child process, blocks until it exits
 * 0 (terminal status reached) or throws if it exits non-zero. Records the wall
 * clock at exit — that's the coordinator's detection moment.
 */
export async function runVolleyHarness(
  brokerUrl: string,
  namespace: string,
  agentId: string,
  timeoutSeconds = 60,
): Promise<VolleyDetection> {
  return new Promise((resolve, reject) => {
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v;
    }
    const proc = spawn(
      "bun",
      [
        "run",
        CLI_ENTRY,
        "wait",
        "--broker-url",
        brokerUrl,
        "--namespace",
        namespace,
        "--agent-id",
        agentId,
        "--timeout",
        String(timeoutSeconds),
      ],
      { cwd: VOLLEY_ISSUES_ROOT, env: baseEnv },
    );
    // Capture stderr so a non-zero exit's diagnostics surface in the test failure
    // message — mirroring the volley-cli spawn-cli.ts pattern. Without this,
    // CI failures show "volley wait exited 1 for X" and nothing more, which is
    // very painful to debug on a remote runner.
    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      const detectedAt = Date.now();
      if (code === 0) {
        resolve({ detectedAt });
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        // `code` is null when the process was killed by a signal; surface that.
        const exitDesc = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
        reject(new Error(`volley wait ${exitDesc} for ${agentId}${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}
