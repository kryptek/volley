import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { reloadLaunchd } from "volley-cli/setup/launchd";
import { stableServicePath } from "volley-cli/setup/service-path";
import { type Clock, systemClock } from "../clock";
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
The plist keeps VOLLEYD_HOME, VOLLEY_BROKER_URL, VOLLEY_NAMESPACE and, when set, VOLLEY_AUTH_DIR
(the auth dir volleyd's \`volley auth\` calls use) from the environment you run it in. Its PATH is
a fixed list, never your shell's: ~/.volley/bin, bun's directory, Homebrew's, /usr/local/bin, the
cmux app's bin, ~/.local/bin, ~/.bun/bin and the other install dirs that exist on this machine,
/usr/bin:/bin:/usr/sbin:/sbin. The same from any terminal.
The cmux socket password (\`volley setup\` stores it) never goes in the plist either: volleyd
reads $VOLLEYD_HOME/cmux.json (mode 0600) each time it runs cmux.
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

/**
 * Write the plist and (re)load it: bootout a loaded instance, wait until launchd has let it go,
 * then bootstrap (retrying launchd's EIO meanwhile: volley-cli's setup/launchd.ts). A plist that
 * will not load is replaced by the previous one, loaded again, so a rerun never leaves volleyd down.
 */
export async function installService(
  p: ServicePaths,
  io: IO,
  run: ExecFn = realExec,
  clock: Clock = systemClock,
): Promise<ExitCode> {
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.launchAgentsDir, { recursive: true });
  const file = plistPath(p.launchAgentsDir);
  const before = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const text = renderPlist(p);
  writeFileSync(file, text);
  const d = {
    exec: (argv: string[]) => run(argv),
    sleep: (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms)),
  };
  const domain = `gui/${p.uid}`;
  const r = await reloadLaunchd(d, domain, SERVICE_LABEL, file);
  if (!r.ok) {
    let state = `volleyd is not loaded: launchctl bootstrap ${domain} ${file}`;
    if (before !== "" && before !== text) {
      writeFileSync(file, before);
      const back = await reloadLaunchd(d, domain, SERVICE_LABEL, file);
      state = back.ok
        ? "restored the previous plist and loaded it again: volleyd runs as before"
        : `restored the previous plist, but it did not load either (${back.error}): ${state}`;
    }
    io.stderr(`volleyd install: ${r.error}; ${state}\n`);
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
  const userHome = env.HOME ?? homedir();
  const bun = findBun(env.PATH ?? "", process.execPath);
  return {
    launchAgentsDir: join(userHome, "Library", "LaunchAgents"),
    home: volleydHome(env),
    uid: process.getuid?.() ?? 0,
    bun,
    // Never the shell's whole PATH (per-terminal entries would make every rerun a change).
    path: stableServicePath({ home: userHome, bun, tmpdir: env.TMPDIR }),
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
