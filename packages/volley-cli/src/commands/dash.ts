import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

const DEFAULT_BROKER_URL = "ws://localhost:9001";
/** Dev-only Desk sign-in variables: Vite inlines `VITE_*` into a built bundle, so a build drops them. */
const DEV_ONLY_CREDENTIALS = [
  "VITE_VOLLEY_BROKER_USERNAME",
  "VITE_VOLLEY_BROKER_PASSWORD",
] as const;

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
        legacy: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
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
  // The Desk replaced the dashboard; `--legacy` keeps the old one reachable until its removal.
  const pkg = parsed.values.legacy === true ? "volley-dash" : "volley-desk";
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

  const host = parsed.values.host as string | undefined;
  if (host === "") {
    io.stderr("volley dash: --host needs an address, e.g. --host 0.0.0.0\n");
    return EXIT.USAGE;
  }
  // Served on the LAN without --broker-url, the Desk connects to port 9001 on the host its page
  // came from, so a phone reaches the laptop's broker instead of its own localhost.
  const explicitBroker = parsed.values["broker-url"] as string | undefined;
  const pageHostBroker = host !== undefined && pkg === "volley-desk";
  const brokerUrl = explicitBroker ?? (pageHostBroker ? undefined : DEFAULT_BROKER_URL);

  // Default: open in dev, don't open in build. Explicit flags override.
  let shouldOpen = !buildMode;
  if (openFlag) shouldOpen = true;
  if (noOpenFlag) shouldOpen = false;

  const repoRoot = findRepoRoot();
  if (repoRoot === null) {
    io.stderr("volley dash: could not locate repo root (no bun.lock found walking up from CLI)\n");
    return EXIT.ERROR;
  }

  const cwd = resolve(repoRoot, "packages", pkg);
  const childEnv: Record<string, string | undefined> = { ...env };
  if (brokerUrl !== undefined) childEnv.VITE_VOLLEY_BROKER_URL = brokerUrl;
  if (buildMode) {
    const dropped = DEV_ONLY_CREDENTIALS.filter((k) => childEnv[k] !== undefined);
    for (const k of dropped) delete childEnv[k];
    if (dropped.length > 0) {
      io.stderr(
        `volley dash: --build ignores ${dropped.join(", ")} (Vite would inline it into the bundle); sign in from the browser instead\n`,
      );
    }
  }

  // Vite-level passthrough args (forwarded after `--` so bun's `run` doesn't eat them).
  const viteArgs: string[] = [];
  if (port !== null) viteArgs.push("--port", String(port));
  if (host !== undefined) viteArgs.push("--host", host);
  if (shouldOpen) viteArgs.push("--open");

  // `bun run <script>` in the package directory runs its Vite; bun forwards
  // everything after the script name (dropping the `--`) to the script.
  const run = (script: string, extra: string[] = []) =>
    runChild(
      spawn,
      "bun",
      ["run", script, ...(extra.length > 0 ? ["--", ...extra] : [])],
      { cwd, env: childEnv, stdio: "inherit" },
      io,
    );

  if (buildMode) {
    if ((await run("build")) !== 0) return EXIT.ERROR;
    return (await run("preview", viteArgs)) === 0 ? EXIT.OK : EXIT.ERROR;
  }

  return (await run("dev", viteArgs)) === 0 ? EXIT.OK : EXIT.ERROR;
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

Launches the Volley Desk (packages/volley-desk; Vite dev server by default).

Options:
  --legacy             Launch the old dashboard (packages/volley-dash) instead;
                       deprecated, removed in a later release
  --build              Run vite build + preview the production bundle
  --port <N>           Override Vite's port (dev default: 5174, 5173 with --legacy;
                       --build: Vite preview's 4173)
  --host <addr>        Listen on <addr> (e.g. 0.0.0.0) to open the Desk from a
                       phone or another machine; without --broker-url the
                       Desk then connects to port 9001 on the host it was
                       loaded from
  --broker-url <url>   MQTT broker URL passed to the Desk via
                       VITE_VOLLEY_BROKER_URL (default: ws://localhost:9001)

The Desk asks for broker credentials on first load (the desk identity from
volley auth init). VITE_VOLLEY_BROKER_USERNAME/PASSWORD skip that in dev mode
only; --build drops them so no password is inlined into the bundle.
  --open               Open browser on start (default in dev mode)
  --no-open            Don't open browser
  --help               Show this help

Exit codes:
  0    Vite exited cleanly
  1    Vite exited non-zero, or spawn failed
  2    Invalid flags
`;
