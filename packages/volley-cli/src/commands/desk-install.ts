import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveBrokerUrl } from "../args";
import { type AuthContext, volleydHome } from "../auth/context";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { parseBrokerHost } from "../setup/desk-build";
import {
  forgetDeskPrivateUrl,
  readDeskPort,
  readDeskPrivateUrl,
  recordDeskInstall,
} from "../setup/journal";
import { unloadLaunchd } from "../setup/launchd";
import { DESK_LABEL, planDeskInstall } from "../setup/services";
import { type SetupContext, type SetupDeps, fencedExec, setupFence } from "../setup/step";
import { removeDeskServes } from "../setup/tailscale-serve";
import { defaultAuthDir } from "./auth";

/**
 * `volley desk install | uninstall | check`: the Desk's own install as commands, for a machine
 * that serves the Desk without the rest of `volley setup` (volleyd runs them over ssh to move
 * it). `install` is the Services step's Desk part (`planDeskInstall`): the build without the
 * `VITE_VOLLEY_BROKER_*` variables, its stamp, and `volley desk serve` as this platform's
 * service, with `--broker-host` when given; it records the port and the broker host in
 * setup.json, so a later `volley setup` keeps them. Idempotent. `uninstall` stops and removes
 * the service and keeps the build. `check` is the health check the target runs on itself
 * (volleyd makes no http calls): `/` answers 200 and `/version.json` is the version.
 *
 * `install --tailscale` also serves the Desk on the private network (tailscale-serve.ts): the
 * two loopback-only `tailscale serve` targets, `--ws-url wss://<name>:8443` on the service, and
 * the private address in setup.json (`desk_private_url`) and the roles record. It needs the
 * Network step's Tailscale record. A later install without the flag keeps a recorded one;
 * `uninstall` takes the two serves off (nothing else).
 */

export interface DeskInstallArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  /** setup's deps (tests fake the machine); default the real ones. */
  setupDeps?: SetupDeps;
  /** The health check's fetch (tests); default the global one. */
  fetch?: typeof fetch;
}

const PORT = /^\d+$/;

/** What `volley desk check` waits for each request. */
const CHECK_TIMEOUT_MS = 10_000;

const port = (text: string) =>
  PORT.test(text) && Number(text) >= 1 && Number(text) <= 65_535 ? Number(text) : null;

/** A context for the Desk's planner alone: setup's, without the broker steps' parts. */
async function deskContext(
  env: Record<string, string | undefined>,
  io: IO,
  given: SetupDeps | undefined,
  desk: { port: number; brokerHost: string | null; root?: string; serve?: boolean },
): Promise<SetupContext> {
  const real = given ?? (await import("./setup")).realSetupDeps(env);
  const repoRoot = desk.root ?? real.repoRoot;
  const fence = setupFence({ restart: "", repoRoot, bun: real.bun });
  const deps: SetupDeps = { ...real, repoRoot, exec: fencedExec(real.exec, fence) };
  const layout = deps.auth.layout();
  const auth: AuthContext = {
    dir: env.VOLLEY_AUTH_DIR ?? defaultAuthDir(layout),
    layout,
    url: resolveBrokerUrl(undefined, env),
    io,
    env,
    deps: deps.auth,
  };
  return {
    auth,
    deps,
    config: layout.config,
    stateFile: layout.stateFile,
    tcpUrl: auth.url,
    wsUrl: "ws://127.0.0.1:9001",
    home: env.HOME ?? homedir(),
    volleydHome: volleydHome(env),
    repair: false,
    yes: true,
    deskHost: "0.0.0.0",
    deskPort: desk.port,
    brokerHost: desk.brokerHost,
    ...(desk.serve !== undefined ? { deskServe: desk.serve } : {}),
  };
}

/** `volley desk install [--port <n>] [--broker-host <host>] [--root <checkout>] [--tailscale]`. */
export async function deskInstall({
  argv,
  env,
  io,
  setupDeps,
}: DeskInstallArgs): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        "broker-host": { type: "string" },
        root: { type: "string" },
        tailscale: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`volley desk install: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const { DESK_PORT } = await import("./desk-serve");
  const p = port((values.port as string | undefined) ?? String(DESK_PORT));
  if (p === null) {
    io.stderr("volley desk install: --port must be a port number (1..65535)\n");
    return EXIT.USAGE;
  }
  const hostText = values["broker-host"] as string | undefined;
  const brokerHost = hostText === undefined ? null : parseBrokerHost(hostText);
  if (hostText !== undefined && brokerHost === null) {
    io.stderr(
      `volley desk install: --broker-host must be a bare host (a name or an IP address; no scheme, path, port or login), got ${JSON.stringify(hostText)}\n`,
    );
    return EXIT.USAGE;
  }
  const root = values.root as string | undefined;
  if (root !== undefined && !existsSync(join(root, "packages", "volley-desk"))) {
    io.stderr(
      `volley desk install: --root ${root} is not a Volley checkout (no packages/volley-desk)\n`,
    );
    return EXIT.USAGE;
  }
  const ctx = await deskContext(env, io, setupDeps, {
    port: p,
    brokerHost,
    ...(root !== undefined ? { root } : {}),
    serve: values.tailscale === true || readDeskPrivateUrl(volleydHome(env)) !== null,
  });
  if (ctx.deps.platform !== "darwin" && ctx.deps.platform !== "linux") {
    io.stderr(
      `volley desk install: no launchd or systemd here (${ctx.deps.platform}): run \`volley desk serve --host 0.0.0.0\` yourself\n`,
    );
    return EXIT.ERROR;
  }
  const plan = await planDeskInstall(ctx);
  for (const f of plan.found) io.stdout(`· ${f}\n`);
  if (plan.blocked !== undefined) {
    io.stderr(`volley desk install: ${plan.blocked}\n`);
    return EXIT.ERROR;
  }
  for (const c of plan.changes) {
    io.stdout(`→ ${c.summary}\n`);
    try {
      for (const line of await c.apply()) io.stdout(`  ${line}\n`);
    } catch (e) {
      io.stderr(`volley desk install: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.ERROR;
    }
  }
  const at = `0.0.0.0:${p}${ctx.deskPrivateUrl != null ? ` and on your private network at ${ctx.deskPrivateUrl}` : ""}`;
  if (plan.changes.length === 0) {
    recordDeskInstall(ctx, { port: p, brokerHost });
    io.stdout(`The Desk is already installed on ${at}.\n`);
    return EXIT.OK;
  }
  const left = (await plan.verify?.()) ?? [];
  if (left.length > 0) {
    for (const l of left) io.stderr(`volley desk install: ${l}\n`);
    return EXIT.ERROR;
  }
  recordDeskInstall(ctx, { port: p, brokerHost });
  io.stdout(`Installed the Desk on ${at}.\n`);
  return EXIT.OK;
}

/** `volley desk uninstall`: the service stopped and removed; the build kept. */
export async function deskUninstall({
  argv,
  env,
  io,
  setupDeps,
}: DeskInstallArgs): Promise<ExitCode> {
  if (argv.length > 0) {
    io.stderr(`volley desk uninstall: takes no arguments (got ${argv.join(" ")})\n`);
    return EXIT.USAGE;
  }
  const home = volleydHome(env);
  const { DESK_PORT } = await import("./desk-serve");
  const ctx = await deskContext(env, io, setupDeps, {
    port: readDeskPort(home) ?? DESK_PORT,
    brokerHost: null,
  });
  const { deps } = ctx;
  // The private network's serves first: they point at the Desk's port, whatever the service.
  if (readDeskPrivateUrl(home) !== null) {
    try {
      for (const l of await removeDeskServes(ctx, ctx.deskPort)) io.stdout(`${l}\n`);
    } catch (e) {
      io.stderr(`volley desk uninstall: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.ERROR;
    }
    forgetDeskPrivateUrl(ctx);
  }
  if (deps.platform === "darwin") {
    const plist = join(ctx.home, "Library", "LaunchAgents", `${DESK_LABEL}.plist`);
    const domain = `gui/${deps.uid}`;
    const loaded = (await deps.exec(["launchctl", "print", `${domain}/${DESK_LABEL}`])).code === 0;
    if (!loaded && !existsSync(plist)) {
      io.stdout("The Desk's service is not installed.\n");
      return EXIT.OK;
    }
    await unloadLaunchd({ exec: (a) => deps.exec(a), sleep: deps.sleep }, domain, DESK_LABEL);
    rmSync(plist, { force: true });
    io.stdout(`Booted ${DESK_LABEL} out and removed ${plist} (the build is kept).\n`);
    return EXIT.OK;
  }
  if (deps.platform === "linux") {
    const unit = join(
      env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"),
      "systemd",
      "user",
      "volley-desk.service",
    );
    if (!existsSync(unit)) {
      io.stdout("The Desk's service is not installed.\n");
      return EXIT.OK;
    }
    const off = await deps.exec(["systemctl", "--user", "disable", "--now", "volley-desk.service"]);
    if (off.code !== 0) {
      io.stderr(
        `volley desk uninstall: \`systemctl --user disable --now volley-desk.service\` failed (exit ${off.code}): ${(off.stderr || off.stdout).trim()}\n`,
      );
      return EXIT.ERROR;
    }
    rmSync(unit, { force: true });
    await deps.exec(["systemctl", "--user", "daemon-reload"]);
    io.stdout(`Stopped volley-desk.service and removed ${unit} (the build is kept).\n`);
    return EXIT.OK;
  }
  io.stderr(`volley desk uninstall: no launchd or systemd here (${deps.platform})\n`);
  return EXIT.ERROR;
}

/** `volley desk check --url <u> --version <v>`: exit 0 when the Desk at `u` serves version `v`. */
export async function deskCheck({
  argv,
  io,
  fetch: fetchFn = fetch,
}: DeskInstallArgs): Promise<ExitCode> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: { url: { type: "string" }, version: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`volley desk check: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const url = values.url as string | undefined;
  const version = values.version as string | undefined;
  if (url === undefined || version === undefined || version === "") {
    io.stderr("volley desk check: needs --url <http://host:port> and --version <v>\n");
    return EXIT.USAGE;
  }
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    base = new URL("invalid:");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    io.stderr(`volley desk check: --url must be an http(s) URL (got ${url})\n`);
    return EXIT.USAGE;
  }
  const at = (path: string) => new URL(path, base).toString();
  const get = (path: string) =>
    fetchFn(at(path), { cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  try {
    const index = await get("/");
    if (index.status !== 200) {
      io.stderr(`volley desk check: ${at("/")} answered ${index.status}\n`);
      return EXIT.ERROR;
    }
    const v = await get("/version.json");
    let served: unknown = null;
    try {
      served = v.status === 200 ? ((await v.json()) as { version?: unknown }).version : null;
    } catch {
      served = null;
    }
    if (served !== version) {
      io.stderr(
        `volley desk check: ${at("/version.json")} is ${typeof served === "string" ? served : "not a version"}, not ${version}\n`,
      );
      return EXIT.ERROR;
    }
  } catch (e) {
    io.stderr(
      `volley desk check: cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return EXIT.ERROR;
  }
  io.stdout(`The Desk at ${url} serves ${version}.\n`);
  return EXIT.OK;
}
