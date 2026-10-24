import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolveBrokerUrl } from "../args";
import { LAYOUTS, type Layout, type LayoutName } from "../auth/config";
import { type AuthContext, realAuthDeps, volleydHome } from "../auth/context";
import { openClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import { askHidden } from "../hidden-input";
import type { IO } from "../io";
import { planAccounts, planPhone } from "../setup/accounts";
import { countLiveAgents, planDetect, planSecurity, probeAnonymous } from "../setup/broker";
import {
  appendSetupLog,
  readSetupInstall,
  setupLogFile,
  writeSetupInstall,
} from "../setup/journal";
import { planServices } from "../setup/services";
import {
  type Planner,
  type SetupContext,
  type SetupDeps,
  type StepName,
  type StepPlan,
  fencedExec,
  listenerUrls,
  setupFence,
} from "../setup/step";
import { defaultAuthDir } from "./auth";
import { findRepoRoot } from "./dash";
import { DESK_PORT } from "./desk-serve";

export { type HiddenInput, hiddenKeys } from "../hidden-input";

/**
 * `volley setup`: the first-run (and repair) wizard. Five steps, each planned (what it found,
 * what it would change), shown, confirmed (or `--yes`), applied, then checked:
 *
 *   1. Broker    find mosquitto (install, version, what the listeners do, running agents)
 *   2. Security  the Dynamic Security config (diff shown, old one backed up), the plugin's
 *                state file with its admin login, a restart; both listeners must refuse
 *                anonymous clients
 *   3. Accounts  the shared roles and the fixed identities (existing ones kept, drifted roles
 *                offered `migrate --roles`), credential files, the keychain, a one-time admin token
 *   4. Services  `volley` + `volleyd` installed in ~/.volley/bin, volleyd, the hooks for
 *                coordinator sessions, the Desk built and served
 *   5. Phone     a one-time steer sign-in link as a QR code
 *
 * Idempotent: a rerun plans nothing for what is in place. Every step is journaled to
 * $VOLLEYD_HOME/setup.log (summaries only, never a secret).
 */

const STEPS: [StepName, Planner][] = [
  ["detect", planDetect],
  ["security", planSecurity],
  ["accounts", planAccounts],
  ["services", planServices],
  ["phone", planPhone],
];

export interface SetupArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

const indent = (text: string, by = "      ") =>
  text
    .split("\n")
    .map((l) => (l === "" ? l : `${by}${l}`))
    .join("\n");

/** Interfaces a phone on the LAN does not reach this machine through (containers, VMs, VPNs). */
const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|tailscale|wg|zt|lxc|lxd|cni|flannel|podman)/;

/**
 * The first non-internal IPv4 address on a physical-looking interface (what a phone on the LAN
 * reaches), else any non-internal one, else the hostname. `--desk-host` overrides it.
 */
export function lanAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  const v4 = Object.entries(interfaces).flatMap(([name, addrs]) =>
    (addrs ?? [])
      .filter((a) => a.family === "IPv4" && !a.internal)
      .map((a) => ({ name, address: a.address })),
  );
  return (v4.find((a) => !VIRTUAL_IFACE.test(a.name)) ?? v4[0])?.address ?? hostname();
}

function findBun(path: string): string {
  for (const dir of path.split(":")) {
    if (dir !== "" && existsSync(join(dir, "bun"))) return join(dir, "bun");
  }
  return process.execPath;
}

export const realSetupDeps = (env: Record<string, string | undefined>): SetupDeps => ({
  auth: realAuthDeps,
  exec: (argv, opts) =>
    new Promise((resolve) => {
      const [bin, ...args] = argv;
      // Without input, stdin stays the terminal's: sudo or a service manager may prompt.
      const child = spawn(bin as string, args, {
        stdio: [opts?.input !== undefined ? "pipe" : "inherit", "pipe", "pipe"],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (opts?.input !== undefined) {
        child.stdin?.on("error", () => {}); // the command exited early: its code says why
        child.stdin?.end(opts.input);
      }
    }),
  probeAnonymous: (url) => probeAnonymous(url),
  liveAgents: async (url, creds) => {
    const b = await openClient(url, creds);
    try {
      return countLiveAgents(await b.subscribeCollect("volley/+/+/status", 10_000, 1_000));
    } finally {
      await b.disconnect().catch(() => {});
    }
  },
  confirm: async (question, defaultYes = false) => {
    if (process.stdin.isTTY !== true) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim();
      return answer === "" ? defaultYes : /^y(es)?$/i.test(answer);
    } finally {
      rl.close();
    }
  },
  interactive: process.stdin.isTTY === true,
  askSecret: (prompt) => askHidden(prompt),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  lanHost: lanAddress,
  repoRoot: findRepoRoot(),
  bun: findBun(env.PATH ?? ""),
});

export async function setup({ argv, env, io }: SetupArgs, injected?: SetupDeps): Promise<ExitCode> {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        yes: { type: "boolean", short: "y" },
        repair: { type: "boolean" },
        lan: { type: "boolean" },
        "no-lan": { type: "boolean" },
        step: { type: "string", multiple: true },
        dir: { type: "string" },
        layout: { type: "string" },
        config: { type: "string" },
        "state-file": { type: "string" },
        "broker-url": { type: "string" },
        "desk-host": { type: "string" },
        "desk-port": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`volley setup: ${e instanceof Error ? e.message : String(e)}\n${SETUP_HELP}`);
    return EXIT.USAGE;
  }
  if (values.help === true) {
    io.stdout(SETUP_HELP);
    return EXIT.OK;
  }
  const str = (k: string) => values[k] as string | undefined;
  const given = injected ?? realSetupDeps(env);
  const invoker = given.auth.invokingUser(env);
  const sudoHome = typeof invoker === "object" && invoker !== null ? invoker.home : undefined;
  const home = volleydHome(env, sudoHome);
  // The install the last finished run used: without --layout (or with the same one) it is the
  // default, so `volley setup --step services` after a `sudo volley setup --layout …` keeps it.
  const saved = readSetupInstall(home);
  let layout: Layout = given.auth.layout();
  const layoutFlag = str("layout");
  if (layoutFlag !== undefined) {
    if (!Object.hasOwn(LAYOUTS, layoutFlag)) {
      io.stderr(`volley setup: --layout must be one of ${Object.keys(LAYOUTS).join(", ")}\n`);
      return EXIT.USAGE;
    }
    layout = LAYOUTS[layoutFlag as LayoutName];
  }
  const fromRecord = saved !== null && (layoutFlag ?? saved.layout) === saved.layout;
  if (fromRecord && layoutFlag === undefined) {
    layout = {
      ...LAYOUTS[saved.layout],
      config: saved.config,
      stateFile: saved.state_file,
      authDir: saved.auth_dir,
    };
  }
  const only = (values.step as string[] | undefined) ?? [];
  const names = STEPS.map(([n]) => n as string);
  const unknown = only.filter((s) => !names.includes(s));
  if (unknown.length > 0) {
    io.stderr(
      `volley setup: --step must be one of ${names.join(", ")} (got ${unknown.join(", ")})\n`,
    );
    return EXIT.USAGE;
  }
  const portText =
    str("desk-port") ?? String((fromRecord ? saved.desk_port : undefined) ?? DESK_PORT);
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    io.stderr("volley setup: --desk-port must be a port number (1..65535)\n");
    return EXIT.USAGE;
  }

  if (values.lan === true && values["no-lan"] === true) {
    io.stderr("volley setup: --lan and --no-lan contradict each other\n");
    return EXIT.USAGE;
  }

  const url = resolveBrokerUrl(str("broker-url"), env);
  const listeners = listenerUrls(url);
  if ("error" in listeners) {
    io.stderr(`volley setup: ${listeners.error}\n`);
    return EXIT.USAGE;
  }
  // Every command goes through the fence: the exact commands the steps run, nothing else.
  const fence = setupFence({ restart: layout.restart, repoRoot: given.repoRoot, bun: given.bun });
  const deps: SetupDeps = { ...given, exec: fencedExec(given.exec, fence) };
  const auth: AuthContext = {
    dir:
      str("dir") ??
      env.VOLLEY_AUTH_DIR ??
      (fromRecord ? saved.auth_dir : undefined) ??
      defaultAuthDir(layout),
    layout,
    url,
    io,
    env,
    deps: deps.auth,
  };
  const ctx: SetupContext = {
    auth,
    deps,
    config: str("config") ?? (fromRecord ? saved.config : layout.config),
    stateFile: str("state-file") ?? (fromRecord ? saved.state_file : layout.stateFile),
    ...listeners,
    home: sudoHome ?? env.HOME ?? homedir(),
    volleydHome: home,
    repair: values.repair === true,
    yes: values.yes === true,
    ...(values.lan === true ? { lan: true } : values["no-lan"] === true ? { lan: false } : {}),
    deskHost: str("desk-host") ?? deps.lanHost(),
    deskPort: Number(portText),
  };

  const logFile = setupLogFile(ctx.volleydHome);
  const journal = (step: StepName, event: string, summary?: string) =>
    appendSetupLog(ctx, { step, event, ...(summary !== undefined ? { summary } : {}) });

  io.stdout(
    `volley setup${ctx.repair ? " --repair" : ""}: broker ${url}, ${layout.name} layout${fromRecord && layoutFlag === undefined ? " (from the last volley setup)" : ""}, auth dir ${auth.dir}\n`,
  );
  const yes = ctx.yes;
  // A run that stops once the Services step has checked cmux (often at the cmux change itself:
  // the runs where its mode matters most) still records the mode it found, and replaces an
  // earlier run's.
  const stopped = () => {
    if (ctx.cmuxSocketMode !== undefined) writeSetupInstall(ctx);
    return EXIT.ERROR;
  };
  const skipped: string[] = [];
  for (const [i, [name, planner]] of STEPS.entries()) {
    if (only.length > 0 && !only.includes(name)) continue;
    let plan: StepPlan;
    try {
      plan = await planner(ctx);
    } catch (e) {
      journal(name, "failed", e instanceof Error ? e.message : String(e));
      io.stderr(`volley setup: ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
      return stopped();
    }
    io.stdout(`\n[${i + 1}/${STEPS.length}] ${plan.title}\n`);
    for (const f of plan.found) io.stdout(`  · ${f}\n`);
    if (plan.blocked !== undefined) {
      journal(name, "blocked", plan.blocked.split("\n")[0]);
      io.stdout(`  ✗ Blocked: ${plan.blocked}\n`);
      return stopped();
    }
    if (plan.skipped !== undefined) {
      journal(name, "skipped", plan.skipped);
      io.stdout(`  – skipped: ${plan.skipped}\n`);
      skipped.push(plan.title);
      continue;
    }
    if (plan.changes.length === 0) {
      journal(name, "done");
      io.stdout("  ✓ already done\n");
      continue;
    }
    journal(name, "planned", plan.changes.map((c) => c.summary).join("; "));
    io.stdout("  Changes:\n");
    for (const c of plan.changes) {
      io.stdout(`    → ${c.summary}\n`);
      if (c.detail !== undefined && c.detail !== "") io.stdout(`${indent(c.detail)}\n`);
    }
    const n = plan.changes.length;
    const question = `Apply ${n === 1 ? "this change" : `these ${n} changes`} (${plan.title})?`;
    if (!yes && !(await deps.confirm(question))) {
      journal(name, "declined");
      io.stdout(
        `  Nothing was changed. Rerun \`volley setup\` to continue${deps.interactive ? "" : " (not a terminal: pass --yes to apply)"}.\n`,
      );
      return stopped();
    }
    for (const c of plan.changes) {
      try {
        const lines = await c.apply();
        journal(name, "applied", c.summary);
        io.stdout(`  ✓ ${c.summary}\n`);
        for (const l of lines) if (l !== "") io.stdout(`${indent(l)}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        journal(name, "failed", `${c.summary}: ${msg}`);
        io.stderr(`volley setup: ${plan.title}: ${c.summary}: ${msg}\n`);
        return stopped();
      }
    }
    const problems = (await plan.verify?.()) ?? [];
    if (problems.length > 0) {
      journal(name, "failed", problems.join("; "));
      io.stderr(
        `volley setup: ${plan.title}: after the changes:\n${problems.map((p) => `  - ${p}\n`).join("")}`,
      );
      return stopped();
    }
    for (const line of plan.verified ?? []) io.stdout(`  ✓ ${line}\n`);
    journal(name, "verified");
  }
  // A finished run's install: what volleyd plans the Desk's setup with, a later run's default.
  writeSetupInstall(ctx);
  io.stdout(
    [
      "",
      skipped.length === 0
        ? "Setup complete."
        : `Setup finished, except the step${skipped.length === 1 ? "" : "s"} skipped above (${skipped.join(", ")}): see there for why and what to run.`,
      "Coordinator sessions: VOLLEY_AUTH_USERNAME=coordinator with the password in",
      `${join(auth.dir, "coordinator.json")}, in the MCP server's env. The volley and volleyd`,
      "commands on this machine use that login on their own (keychain, then coordinator.json).",
      `Journal: ${logFile}. Rerun \`volley setup --repair\` any time to check and fix.`,
      "",
    ].join("\n"),
  );
  return EXIT.OK;
}

export const SETUP_HELP = `Usage: volley setup [--yes] [--repair] [options]

First-run (and repair) wizard: five steps, each showing what it found and what it will change
before changing anything.

  1. Broker    find mosquitto (>= 2.1), its listeners, the running agents
  2. Security  write the Dynamic Security broker config (the diff is shown; the old file is
               backed up), create the plugin's state file and admin login, restart the broker,
               then check both listeners refuse anonymous clients. Asks whether devices on
               your network may reach the WebSocket listener (port 9001: needed for the Desk on
               a phone; logins required, not encrypted until TLS is set up), unless --lan or
               --no-lan says; TCP (1883) stays on this machine either way
  3. Accounts  Volley's shared roles and the fixed identities volleyd, desk, coordinator
               (existing logins kept; drifted roles offered \`volley auth migrate --roles\`),
               their credential files, a copy of the coordinator's login in the macOS
               keychain, and a one-time admin token for the Desk (printed here only)
  4. Services  the volley and volleyd commands installed in ~/.volley/bin (on the services'
               PATH, a fixed list: the same from any terminal), volleyd (launchd / systemd
               --user), on macOS the cmux socket password volleyd's service needs (asked for,
               hidden), the Volley hooks for coordinator sessions (your status line keeps
               working), the Desk built and served by \`volley desk serve\` on 0.0.0.0:${DESK_PORT}
               (stops if another program listens on that port)
  5. Phone     a one-time steer sign-in link (10 minutes, single use) as a QR code; skipped
               when a phone cannot reach the WebSocket listener (LAN access off)

Rerunning changes nothing that is in place. The one-time admin token and the phone's link
count as in place while they are pending or once redeemed: a rerun after they expired unused
issues new ones. Every step is journaled to $VOLLEYD_HOME/setup.log.

Options:
  -y, --yes            Apply every step without asking
  --repair             Check and fix only: no new admin token, no phone link
  --lan                Open the WebSocket listener (9001) to your network (for the phone)
  --no-lan             Keep it on this machine only (the default under --yes)
  --step <name>        Only this step (repeatable): detect, security, accounts, services, phone
  --dir <dir>          The auth dir (env: VOLLEY_AUTH_DIR; default <mosquitto config dir>/volley)
  --layout <name>      brew-arm64 | brew-intel | snap | etc | container (default: detected)
  --config <path>      The mosquitto.conf to manage (default: the layout's)
  --state-file <path>  The Dynamic Security state file (default: the layout's)
  --broker-url <url>   The broker, mqtt:// (env: VOLLEY_BROKER_URL; default mqtt://localhost:1883)
  --desk-host <host>   The address in the phone's link (default: this machine's LAN address)
  --desk-port <n>      The Desk's port (default ${DESK_PORT})
  -h, --help           Show this help and exit
`;
