import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolveBrokerUrl } from "../args";
import { LAYOUTS, type Layout, type LayoutName } from "../auth/config";
import { type AuthContext, ensureOwnedDir, realAuthDeps, volleydHome } from "../auth/context";
import { openClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { planAccounts, planPhone } from "../setup/accounts";
import { planDetect, planSecurity, probeAnonymous } from "../setup/broker";
import { planServices } from "../setup/services";
import type { Planner, SetupContext, SetupDeps, StepName, StepPlan } from "../setup/step";
import { defaultAuthDir } from "./auth";
import { findRepoRoot } from "./dash";
import { DESK_PORT } from "./desk-serve";

/**
 * `volley setup`: the first-run (and repair) wizard. Five steps, each planned (what it found,
 * what it would change), shown, confirmed (or `--yes`), applied, then checked:
 *
 *   1. Broker    find mosquitto (install, version, what the listeners do, registered agents)
 *   2. Security  the Dynamic Security config (diff shown, old one backed up), the plugin's
 *                state file with its admin login, a restart; both listeners must refuse
 *                anonymous clients
 *   3. Accounts  the shared roles and the fixed identities (existing ones kept, drifted roles
 *                offered `migrate --roles`), credential files, the keychain, a one-time admin token
 *   4. Services  volleyd, the hooks for coordinator sessions, the Desk built and served
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

/** The first non-internal IPv4 address (what a phone on the LAN reaches), else the hostname. */
function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return hostname();
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
      // stdin stays the terminal's: sudo or a service manager may prompt.
      const child = spawn(bin as string, args, {
        stdio: ["inherit", "pipe", "pipe"],
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
    }),
  probeAnonymous: (url) => probeAnonymous(url),
  liveAgents: async (url, creds) => {
    const b = await openClient(url, creds);
    try {
      const entries = await b.subscribeCollect("volley/_system/registry/+", 10_000, 1_000);
      return entries.filter((e) => e.payload !== "").length;
    } finally {
      await b.disconnect().catch(() => {});
    }
  },
  confirm: async (question) => {
    if (process.stdin.isTTY !== true) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
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
  const deps = injected ?? realSetupDeps(env);
  let layout: Layout = deps.auth.layout();
  const layoutFlag = str("layout");
  if (layoutFlag !== undefined) {
    if (!Object.hasOwn(LAYOUTS, layoutFlag)) {
      io.stderr(`volley setup: --layout must be one of ${Object.keys(LAYOUTS).join(", ")}\n`);
      return EXIT.USAGE;
    }
    layout = LAYOUTS[layoutFlag as LayoutName];
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
  const portText = str("desk-port") ?? String(DESK_PORT);
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    io.stderr("volley setup: --desk-port must be a port number (1..65535)\n");
    return EXIT.USAGE;
  }

  const url = resolveBrokerUrl(str("broker-url"), env);
  const broker = new URL(url);
  const invoker = deps.auth.invokingUser(env);
  const sudoHome = typeof invoker === "object" && invoker !== null ? invoker.home : undefined;
  const auth: AuthContext = {
    dir: str("dir") ?? env.VOLLEY_AUTH_DIR ?? defaultAuthDir(layout),
    layout,
    url,
    io,
    env,
    deps: deps.auth,
  };
  const ctx: SetupContext = {
    auth,
    deps,
    config: str("config") ?? layout.config,
    stateFile: str("state-file") ?? layout.stateFile,
    tcpUrl: url,
    wsUrl: `ws://${broker.hostname.includes(":") ? `[${broker.hostname}]` : broker.hostname}:9001`,
    home: sudoHome ?? env.HOME ?? homedir(),
    volleydHome: volleydHome(env, sudoHome),
    repair: values.repair === true,
    deskHost: str("desk-host") ?? deps.lanHost(),
    deskPort: Number(portText),
  };

  const logFile = join(ctx.volleydHome, "setup.log");
  const journal = (step: StepName, event: string, summary?: string) => {
    try {
      const owner = typeof invoker === "object" ? invoker : null;
      ensureOwnedDir(deps.auth, ctx.volleydHome, owner);
      appendFileSync(
        logFile,
        `${JSON.stringify({ at: io.now().toISOString(), step, event, ...(summary !== undefined ? { summary } : {}) })}\n`,
        { mode: 0o600 },
      );
      // Under sudo the journal is the invoking user's, like the rest of $VOLLEYD_HOME.
      if (owner !== null) deps.auth.chown(logFile, owner.uid, owner.gid);
    } catch {
      // The journal is a record, not a gate: an unwritable home never stops the setup.
    }
  };

  io.stdout(
    `volley setup${ctx.repair ? " --repair" : ""}: broker ${url}, ${layout.name} layout, auth dir ${auth.dir}\n`,
  );
  const yes = values.yes === true;
  for (const [i, [name, planner]] of STEPS.entries()) {
    if (only.length > 0 && !only.includes(name)) continue;
    let plan: StepPlan;
    try {
      plan = await planner(ctx);
    } catch (e) {
      journal(name, "failed", e instanceof Error ? e.message : String(e));
      io.stderr(`volley setup: ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.ERROR;
    }
    io.stdout(`\n[${i + 1}/${STEPS.length}] ${plan.title}\n`);
    for (const f of plan.found) io.stdout(`  · ${f}\n`);
    if (plan.blocked !== undefined) {
      journal(name, "blocked", plan.blocked.split("\n")[0]);
      io.stdout(`  ✗ Blocked: ${plan.blocked}\n`);
      return EXIT.ERROR;
    }
    if (plan.skipped !== undefined) {
      journal(name, "skipped", plan.skipped);
      io.stdout(`  – skipped: ${plan.skipped}\n`);
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
        `  Nothing was changed. Rerun \`volley setup\` to continue${process.stdin.isTTY === true ? "" : " (not a terminal: pass --yes to apply)"}.\n`,
      );
      return EXIT.ERROR;
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
        return EXIT.ERROR;
      }
    }
    const problems = (await plan.verify?.()) ?? [];
    if (problems.length > 0) {
      journal(name, "failed", problems.join("; "));
      io.stderr(
        `volley setup: ${plan.title}: after the changes:\n${problems.map((p) => `  - ${p}\n`).join("")}`,
      );
      return EXIT.ERROR;
    }
    journal(name, "verified");
  }
  io.stdout(
    [
      "",
      "Setup complete. Coordinator sessions: VOLLEY_AUTH_USERNAME=coordinator with the password in",
      `${join(auth.dir, "coordinator.json")} (in the MCP server env and your shell profile).`,
      `Journal: ${logFile}. Rerun \`volley setup --repair\` any time to check and fix.`,
      "",
    ].join("\n"),
  );
  return EXIT.OK;
}

export const SETUP_HELP = `Usage: volley setup [--yes] [--repair] [options]

First-run (and repair) wizard: five steps, each showing what it found and what it will change
before changing anything.

  1. Broker    find mosquitto (>= 2.1), its listeners, the registered agents
  2. Security  write the Dynamic Security broker config (the diff is shown; the old file is
               backed up), create the plugin's state file and admin login, restart the broker,
               then check both listeners refuse anonymous clients
  3. Accounts  Volley's shared roles and the fixed identities volleyd, desk, coordinator
               (existing logins kept; drifted roles offered \`volley auth migrate --roles\`),
               their credential files, the coordinator's login in the macOS keychain, and a
               one-time admin token for the Desk (printed here only)
  4. Services  volleyd (launchd / systemd --user), the Volley hooks for coordinator sessions,
               the Desk built and served by \`volley desk serve\` on 0.0.0.0:${DESK_PORT}
  5. Phone     a one-time steer sign-in link (10 minutes, single use) as a QR code

Rerunning changes nothing that is in place. Every step is journaled to
$VOLLEYD_HOME/setup.log.

Options:
  -y, --yes            Apply every step without asking
  --repair             Check and fix only: no new admin token, no phone link
  --step <name>        Only this step (repeatable): detect, security, accounts, services, phone
  --dir <dir>          The auth dir (env: VOLLEY_AUTH_DIR; default <mosquitto config dir>/volley)
  --layout <name>      brew-arm64 | brew-intel | snap | etc | container (default: detected)
  --config <path>      The mosquitto.conf to manage (default: the layout's)
  --state-file <path>  The Dynamic Security state file (default: the layout's)
  --broker-url <url>   The broker (env: VOLLEY_BROKER_URL; default mqtt://localhost:1883)
  --desk-host <host>   The address in the phone's link (default: this machine's LAN address)
  --desk-port <n>      The Desk's port (default ${DESK_PORT})
  -h, --help           Show this help and exit
`;
