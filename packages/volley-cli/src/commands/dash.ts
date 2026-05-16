import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

const DEFAULT_BROKER_URL = "ws://localhost:9001";

/**
 * Injectable child-process surface — production calls `node:child_process.spawn`;
 * tests inject a recorder. Only the `(event, cb) => this` shape used here is
 * required of the returned child, so any test double can be a plain object.
 */
export interface DashSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: "inherit";
}
export interface DashChildProcess {
  on(event: "close", cb: (code: number | null) => void): DashChildProcess;
  on(event: "error", cb: (err: Error) => void): DashChildProcess;
}
export type DashSpawnFn = (cmd: string, args: string[], opts: DashSpawnOptions) => DashChildProcess;

export interface DashArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  spawn?: DashSpawnFn;
}

export async function dash({
  argv,
  env,
  io,
  spawn = nodeSpawn as unknown as DashSpawnFn,
}: DashArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        build: { type: "boolean" },
        port: { type: "string" },
        "broker-url": { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley dash: ${e instanceof Error ? e.message : String(e)}\n${DASH_HELP}`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(DASH_HELP);
    return EXIT.OK;
  }

  const buildMode = parsed.values.build === true;
  const openFlag = parsed.values.open === true;
  const noOpenFlag = parsed.values["no-open"] === true;
  if (openFlag && noOpenFlag) {
    io.stderr("volley dash: --open and --no-open are mutually exclusive\n");
    return EXIT.USAGE;
  }

  const portStr = parsed.values.port as string | undefined;
  let port: number | null = null;
  if (portStr !== undefined) {
    if (!/^[1-9][0-9]*$/.test(portStr)) {
      io.stderr(`volley dash: --port must be a positive integer, got "${portStr}"\n`);
      return EXIT.USAGE;
    }
    port = Number.parseInt(portStr, 10);
  }

  const brokerUrl = (parsed.values["broker-url"] as string | undefined) ?? DEFAULT_BROKER_URL;

  // Default: open in dev, don't open in build. Explicit flags override.
  let shouldOpen = !buildMode;
  if (openFlag) shouldOpen = true;
  if (noOpenFlag) shouldOpen = false;

  const repoRoot = findRepoRoot();
  if (repoRoot === null) {
    io.stderr("volley dash: could not locate repo root (no bun.lock found walking up from CLI)\n");
    return EXIT.ERROR;
  }

  const childEnv: Record<string, string | undefined> = {
    ...env,
    VITE_VOLLEY_BROKER_URL: brokerUrl,
  };

  // Vite-level passthrough args (forwarded after `--` so bun's `run` doesn't eat them).
  const viteArgs: string[] = [];
  if (port !== null) viteArgs.push("--port", String(port));
  if (shouldOpen) viteArgs.push("--open");

  if (buildMode) {
    const buildExit = await runChild(
      spawn,
      "bun",
      ["run", "--filter", "volley-dash", "build"],
      { cwd: repoRoot, env: childEnv, stdio: "inherit" },
      io,
    );
    if (buildExit !== 0) return EXIT.ERROR;

    const previewArgs = ["run", "--filter", "volley-dash", "preview"];
    if (viteArgs.length > 0) previewArgs.push("--", ...viteArgs);
    const previewExit = await runChild(
      spawn,
      "bun",
      previewArgs,
      { cwd: repoRoot, env: childEnv, stdio: "inherit" },
      io,
    );
    return previewExit === 0 ? EXIT.OK : EXIT.ERROR;
  }

  const devArgs = ["run", "--filter", "volley-dash", "dev"];
  if (viteArgs.length > 0) devArgs.push("--", ...viteArgs);
  const devExit = await runChild(
    spawn,
    "bun",
    devArgs,
    { cwd: repoRoot, env: childEnv, stdio: "inherit" },
    io,
  );
  return devExit === 0 ? EXIT.OK : EXIT.ERROR;
}

function runChild(
  spawn: DashSpawnFn,
  cmd: string,
  args: string[],
  opts: DashSpawnOptions,
  io: IO,
): Promise<number> {
  return new Promise((resolveFn) => {
    let child: DashChildProcess;
    try {
      child = spawn(cmd, args, opts);
    } catch (e) {
      io.stderr(`volley dash: spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      resolveFn(1);
      return;
    }
    child.on("error", (e) => {
      io.stderr(`volley dash: spawn error: ${e.message}\n`);
      resolveFn(1);
    });
    child.on("close", (code) => {
      resolveFn(code ?? 1);
    });
  });
}

/**
 * Walk up looking for `bun.lock`. The CLI may be installed via a symlinked
 * bin shim, so try both `import.meta.url` (the source file's location) and
 * `realpathSync(process.argv[1])` (the entry point's real path).
 */
function findRepoRoot(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(import.meta.url));
  } catch {
    // import.meta.url should resolve under ESM/Bun; ignore unlikely failures.
  }
  const entry = process.argv[1];
  if (typeof entry === "string") {
    try {
      candidates.push(realpathSync(entry));
    } catch {
      // entry point missing on disk (rare); skip.
    }
  }
  for (const start of candidates) {
    const root = walkUpToBunLock(start);
    if (root !== null) return root;
  }
  return null;
}

function walkUpToBunLock(start: string): string | null {
  let dir = dirname(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(resolve(dir, "bun.lock"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const DASH_HELP = `Usage: volley dash [options]

Launches the Volley dashboard (Vite dev server by default).

Options:
  --build              Run vite build + preview the production bundle
  --port <N>           Override Vite's port (default: Vite's default 5173)
  --broker-url <url>   MQTT broker URL passed to the dashboard via
                       VITE_VOLLEY_BROKER_URL (default: ws://localhost:9001)
  --open               Open browser on start (default in dev mode)
  --no-open            Don't open browser
  --help               Show this help

Exit codes:
  0    Vite exited cleanly
  1    Vite exited non-zero, or spawn failed
  2    Invalid flags
`;
