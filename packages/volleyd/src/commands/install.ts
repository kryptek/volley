import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { resolveTarget } from "../control";
import { type ExecFn, exec as realExec } from "../exec";
import { SERVICE_LABEL } from "../fence";
import { type CommandArgs, EXIT, type ExitCode, type IO } from "../io";

const TEMPLATE = fileURLToPath(
  new URL("../../launchd/systems.volley.volleyd.plist.tmpl", import.meta.url),
);
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

const HELP = `Usage:
  volleyd install [--dry-run] [--broker-url <url>] [--namespace <ns>]
  volleyd uninstall

install writes ~/Library/LaunchAgents/${SERVICE_LABEL}.plist (RunAtLoad, KeepAlive, logs to
$VOLLEYD_HOME/volleyd.log) and loads it with \`launchctl bootstrap gui/$UID\`. --dry-run prints
the plist instead. Restart the service with:
  launchctl kickstart -k gui/$UID/${SERVICE_LABEL}
uninstall unloads the service (\`launchctl bootout\`) and removes the plist; journals stay.
The plist keeps VOLLEYD_HOME, VOLLEY_BROKER_URL, VOLLEY_NAMESPACE, PATH and, when set,
VOLLEY_AUTH_DIR (the auth dir volleyd's \`volley auth\` calls use) from the environment you run it in.
Broker credentials never go in the plist: the daemon reads $VOLLEYD_HOME/broker.json (mode 0600,
written by \`volley auth init --volleyd-file\`).
`;

export interface ServicePaths {
  /** ~/Library/LaunchAgents */
  launchAgentsDir: string;
  home: string;
  uid: number;
  bun: string;
  brokerUrl: string;
  namespace: string;
  path: string;
  /** The auth dir volleyd's `volley auth` calls use (`VOLLEY_AUTH_DIR`); unset: theirs to detect. */
  authDir?: string;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fill the plist template. Pure; values are XML-escaped. */
export function renderPlist(
  p: ServicePaths,
  template: string = readFileSync(TEMPLATE, "utf-8"),
): string {
  const vars: Record<string, string> = {
    LABEL: SERVICE_LABEL,
    BUN: p.bun,
    CLI,
    VOLLEYD_HOME: p.home,
    BROKER_URL: p.brokerUrl,
    NAMESPACE: p.namespace,
    PATH: p.path,
    LOG: join(p.home, "volleyd.log"),
  };
  // An optional entry: the whole key/string pair, or nothing.
  const raw: Record<string, string> = {
    AUTH_DIR_ENTRY:
      p.authDir === undefined
        ? ""
        : `\n    <key>VOLLEY_AUTH_DIR</key>\n    <string>${xml(p.authDir)}</string>`,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => {
    const r = raw[k];
    if (r !== undefined) return r;
    const v = vars[k];
    return v === undefined ? m : xml(v);
  });
}

export const plistPath = (launchAgentsDir: string) =>
  join(launchAgentsDir, `${SERVICE_LABEL}.plist`);

/** Write the plist and (re)load it: bootout any previous instance, then bootstrap. */
export async function installService(
  p: ServicePaths,
  io: IO,
  run: ExecFn = realExec,
): Promise<ExitCode> {
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.launchAgentsDir, { recursive: true });
  const file = plistPath(p.launchAgentsDir);
  writeFileSync(file, renderPlist(p));
  await run(["launchctl", "bootout", `gui/${p.uid}/${SERVICE_LABEL}`]); // not loaded yet is fine
  const r = await run(["launchctl", "bootstrap", `gui/${p.uid}`, file]);
  if (r.code !== 0) {
    io.stderr(`volleyd install: launchctl bootstrap failed (${r.code}): ${r.stderr.trim()}\n`);
    return EXIT.ERROR;
  }
  io.stdout(`installed ${file}\nlogs: ${join(p.home, "volleyd.log")}\n`);
  return EXIT.OK;
}

export async function uninstallService(
  p: Pick<ServicePaths, "launchAgentsDir" | "uid">,
  io: IO,
  run: ExecFn = realExec,
): Promise<ExitCode> {
  const file = plistPath(p.launchAgentsDir);
  await run(["launchctl", "bootout", `gui/${p.uid}/${SERVICE_LABEL}`]);
  if (existsSync(file)) rmSync(file);
  io.stdout(`uninstalled ${SERVICE_LABEL}\n`);
  return EXIT.OK;
}

/**
 * The bun to put in the plist: the first `bun` on PATH (e.g. a package manager's stable symlink),
 * not `process.execPath`, which resolves to a versioned install that disappears on upgrade.
 */
export function findBun(path: string, fallback: string): string {
  for (const dir of path.split(":")) {
    if (dir !== "" && existsSync(join(dir, "bun"))) return join(dir, "bun");
  }
  return fallback;
}

function servicePaths(
  values: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ServicePaths {
  const target = resolveTarget(values, env);
  return {
    launchAgentsDir: join(env.HOME ?? homedir(), "Library", "LaunchAgents"),
    home: volleydHome(env),
    uid: process.getuid?.() ?? 0,
    bun: findBun(env.PATH ?? "", process.execPath),
    path: env.PATH ?? "/usr/bin:/bin",
    ...(env.VOLLEY_AUTH_DIR !== undefined && env.VOLLEY_AUTH_DIR !== ""
      ? { authDir: env.VOLLEY_AUTH_DIR }
      : {}),
    ...target,
  };
}

export async function install({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let values: Record<string, unknown>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", default: false },
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }).values;
  } catch (e) {
    io.stderr(`volleyd install: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const p = servicePaths(values, env);
  if (values["dry-run"] === true) {
    io.stdout(`# ${plistPath(p.launchAgentsDir)}\n${renderPlist(p)}`);
    return EXIT.OK;
  }
  return installService(p, io);
}

export async function uninstall({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (argv.length > 0) {
    io.stderr(`volleyd uninstall: unexpected arguments\n${HELP}`);
    return EXIT.USAGE;
  }
  return uninstallService(servicePaths({}, env), io);
}
