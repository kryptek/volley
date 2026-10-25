import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parseEnvelope } from "volley-mcp/envelope";
import { resolveBrokerUrl } from "../args";
import { LAYOUTS, type Layout, type LayoutName } from "../auth/config";
import { type AuthContext, readCredentials, realAuthDeps, volleydHome } from "../auth/context";
import { openClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import { askHidden } from "../hidden-input";
import type { IO } from "../io";
import { probeReach, reachChecks } from "../peer/checks/reach";
import { planAccounts, planPhone } from "../setup/accounts";
import { countLiveAgents, planDetect, planSecurity, probeAnonymous } from "../setup/broker";
import {
  type CheckRow,
  checkDeps,
  checkExit,
  checkReport,
  checkSteps,
  renderCheck,
} from "../setup/check";
import { planClaudeCode } from "../setup/claude-code";
import { type FirstWaveOptions, type WaveView, planFirstWave } from "../setup/first-wave";
import { ghRepoDeleteLine } from "../setup/first-wave-repo";
import {
  appendSetupLog,
  readDeskPort,
  readNetworkRecord,
  readSetupInstall,
  setupLogFile,
  writeSetupInstall,
} from "../setup/journal";
import { SetupMeter, completeLine, setupMetricsFile, writeSetupMetrics } from "../setup/metrics";
import { NETWORK_KINDS, isNetworkKind, planNetwork, privateDeskLine } from "../setup/network";
import { peerBrokerUrl, planPeerService } from "../setup/peer-service";
import { planServices } from "../setup/services";
import { planSignin, simulatedExec } from "../setup/signin";
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
import { planTerminal } from "../setup/terminal";
import { realProbes } from "../supervisor/probes";
import { defaultAuthDir } from "./auth";
import { findRepoRoot } from "./dash";
import { DESK_PORT } from "./desk-serve";
import { type PeerConfig, peerFile, peerReach, readPeerConfig } from "./peer";

export { type HiddenInput, hiddenKeys } from "../hidden-input";

/**
 * `volley setup`: the first-run (and repair) wizard. Ten steps, each planned (what it found,
 * what it would change), shown, confirmed (or `--yes`), applied, then checked:
 *
 *   1. Broker    find mosquitto (install, version, what the listeners do, running agents)
 *   2. Security  the Dynamic Security config (diff shown, old one backed up), the plugin's
 *                state file with its admin login, a restart; both listeners must refuse
 *                anonymous clients
 *   3. Accounts  the shared roles and the fixed identities (existing ones kept, drifted roles
 *                offered `migrate --roles`), credential files, the keychain, a one-time admin token
 *   4. Network   how this machine is reached from outside its network: Tailscale (installed and
 *                signed in), the person's own VPN (`manual`), or none; recorded in setup.json
 *   5. Sign-ins  Claude Code and GitHub signed in (a browser each), the checkout readable by
 *                Claude Code (`permissions.additionalDirectories`)
 *   6. Claude Code  the coordinator name, the volley MCP server registered without a secret,
 *                the skills, the hooks
 *   7. Terminal  the terminal volleyd starts local agents in: cmux (macOS, when installed; its
 *                socket checked the way the service reaches it) or tmux, put on record in
 *                config.yaml (`fleet.local_terminal`) and setup.json
 *   8. Services  `volley` + `volleyd` installed in ~/.volley/bin, volleyd, the hooks for
 *                coordinator sessions, the Desk built and served
 *   9. Phone     a one-time steer sign-in link as a QR code
 *  10. Test wave  a 1-issue wave on a scratch private repository (or `--repo`), followed until
 *                volleyd merged its PR (first-wave.ts); `--simulated` against volley-sim's fakes
 *
 * Idempotent: a rerun plans nothing for what is in place. Every step is journaled to
 * $VOLLEYD_HOME/setup.log (summaries only, never a secret); every run's cost to
 * setup-metrics.json. `--check` plans every step and reports it, changing and asking nothing.
 */

const STEPS: [StepName, Planner][] = [
  ["detect", planDetect],
  ["security", planSecurity],
  ["accounts", planAccounts],
  ["network", planNetwork],
  ["signin", planSignin],
  ["claude-code", planClaudeCode],
  ["terminal", planTerminal],
  ["services", planServices],
  ["phone", planPhone],
  ["first-wave", planFirstWave],
];

/**
 * `volley setup --peer`: a machine that joins a supervisor's fleet (`install.sh --peer`, `volley
 * machine add`). No broker, accounts, Desk or phone of its own: the sign-ins, the Network,
 * Claude Code's profile (the skills, the hooks at the tunnel; no coordinator), the Terminal, and
 * `volley peer run` as the service in place of volleyd.
 */
const PEER_STEPS: [StepName, Planner][] = [
  ["signin", planSignin],
  ["network", planNetwork],
  ["claude-code", planClaudeCode],
  ["terminal", planTerminal],
  ["peer-service", planPeerService],
];

/** The flags about this machine's own broker, Desk or phone: not for `--peer`. */
const HUB_FLAGS = [
  "lan",
  "no-lan",
  "dir",
  "layout",
  "config",
  "state-file",
  "broker-url",
  "desk-host",
  "desk-port",
] as const;

/** The test wave's flags: not for `--peer` (a peer runs no test wave of its own). */
const FIRST_WAVE_FLAGS = ["repo", "issue", "simulated", "no-first-wave"] as const;

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

/** A command run for real: argv only, never a shell. */
const spawnExec: SetupDeps["exec"] = (argv, opts) =>
  new Promise((resolve) => {
    const [bin, ...args] = argv;
    // Without input, stdin stays the terminal's: sudo or a service manager may prompt. A
    // browser sign-in gets the whole terminal.
    const child = spawn(bin as string, args, {
      stdio:
        opts?.tty === true
          ? "inherit"
          : [opts?.input !== undefined ? "pipe" : "inherit", "pipe", "pipe"],
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
  });

/**
 * The retained wave state, read with the coordinator's login from the auth dir (setup made it);
 * null while there is none.
 */
const readWaveState =
  (url: string, authDir: string) =>
  async (wave: string): Promise<WaveView | null> => {
    let creds: ReturnType<typeof readCredentials> = null;
    try {
      creds = readCredentials(join(authDir, "coordinator.json"));
    } catch {}
    const b = await openClient(url, creds);
    try {
      const raw = await b.queryRetained(`volley/_waves/${wave}/state`, 2_000);
      const payload = raw === null ? null : parseEnvelope(raw)?.payload;
      return typeof payload === "object" && payload !== null ? (payload as WaveView) : null;
    } finally {
      await b.disconnect().catch(() => {});
    }
  };

export const realSetupDeps = (env: Record<string, string | undefined>): SetupDeps => ({
  auth: realAuthDeps,
  // VOLLEY_SIMULATED=1 (the soak, CI): the sign-ins are answered by fakes and nothing opens.
  exec: env.VOLLEY_SIMULATED === "1" ? simulatedExec(spawnExec) : spawnExec,
  probeAnonymous: (url) => probeAnonymous(url),
  // The soak and CI (VOLLEY_SIMULATED=1) probe nothing outside the machine.
  ...(env.VOLLEY_SIMULATED === "1" ? {} : { reach: realProbes(env) }),
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
  ask: async (prompt) => {
    if (process.stdin.isTTY !== true) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  },
  hostname: () => hostname(),
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
        check: { type: "boolean" },
        peer: { type: "boolean" },
        json: { type: "boolean" },
        "show-email": { type: "boolean" },
        lan: { type: "boolean" },
        "no-lan": { type: "boolean" },
        network: { type: "string" },
        "network-address": { type: "string" },
        step: { type: "string", multiple: true },
        dir: { type: "string" },
        layout: { type: "string" },
        config: { type: "string" },
        "state-file": { type: "string" },
        "broker-url": { type: "string" },
        "desk-host": { type: "string" },
        "desk-port": { type: "string" },
        repo: { type: "string" },
        issue: { type: "string" },
        simulated: { type: "boolean" },
        "no-first-wave": { type: "boolean" },
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
  const check = values.check === true;
  const peer = values.peer === true;
  const hubFlag = HUB_FLAGS.find((f) => values[f] !== undefined);
  if (peer && hubFlag !== undefined) {
    io.stderr(
      `volley setup: --${hubFlag} is about this machine's own broker or Desk; --peer has neither\n`,
    );
    return EXIT.USAGE;
  }
  const waveFlag = FIRST_WAVE_FLAGS.find((f) => values[f] !== undefined);
  if (peer && waveFlag !== undefined) {
    io.stderr(
      `volley setup: --${waveFlag} is the test wave's, which runs on the supervisor's machine; --peer has none\n`,
    );
    return EXIT.USAGE;
  }
  if (check && (values.yes === true || values.repair === true)) {
    io.stderr(
      `volley setup: --check changes nothing: it does not take ${values.yes === true ? "--yes" : "--repair"}\n`,
    );
    return EXIT.USAGE;
  }
  if (values.json === true && !check) {
    io.stderr("volley setup: --json is for --check\n");
    return EXIT.USAGE;
  }
  // The test wave's flags.
  const firstWave: FirstWaveOptions = {};
  const issueText = str("issue");
  if (issueText !== undefined) {
    if (!/^[1-9]\d*$/.test(issueText)) {
      io.stderr("volley setup: --issue must be an issue number\n");
      return EXIT.USAGE;
    }
    if (str("repo") === undefined) {
      io.stderr("volley setup: --issue names an issue of the --repo clone: give --repo too\n");
      return EXIT.USAGE;
    }
    firstWave.issue = Number(issueText);
  }
  if (str("repo") !== undefined) firstWave.repo = resolve(str("repo") as string);
  if (values["no-first-wave"] === true) {
    if (firstWave.repo !== undefined || values.simulated === true) {
      io.stderr(
        `volley setup: --no-first-wave runs no test wave: it does not take ${firstWave.repo !== undefined ? "--repo" : "--simulated"}\n`,
      );
      return EXIT.USAGE;
    }
    firstWave.skip = true;
  }
  if (values.simulated === true) firstWave.simulated = true;
  // --simulated: the sign-ins are answered by the fakes too, as under VOLLEY_SIMULATED=1.
  const given =
    injected ?? realSetupDeps(firstWave.simulated ? { ...env, VOLLEY_SIMULATED: "1" } : env);
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
  const ALL = peer ? PEER_STEPS : STEPS;
  const names = ALL.map(([n]) => n as string);
  const unknown = only.filter((s) => !names.includes(s));
  if (unknown.length > 0) {
    io.stderr(
      `volley setup: --step must be one of ${names.join(", ")} (got ${unknown.join(", ")})\n`,
    );
    return EXIT.USAGE;
  }
  const portText =
    str("desk-port") ??
    String(
      (fromRecord ? saved.desk_port : saved === null ? readDeskPort(home) : undefined) ?? DESK_PORT,
    );
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    io.stderr("volley setup: --desk-port must be a port number (1..65535)\n");
    return EXIT.USAGE;
  }

  if (values.lan === true && values["no-lan"] === true) {
    io.stderr("volley setup: --lan and --no-lan contradict each other\n");
    return EXIT.USAGE;
  }
  const network = str("network");
  if (network !== undefined && !isNetworkKind(network)) {
    io.stderr(`volley setup: --network must be one of ${NETWORK_KINDS.join(", ")}\n`);
    return EXIT.USAGE;
  }
  if (str("network-address") !== undefined && network !== "manual") {
    io.stderr(
      "volley setup: --network-address is your own VPN's address for this machine: it goes with --network manual\n",
    );
    return EXIT.USAGE;
  }

  // The broker: --broker-url, else the env's, else the one the last finished run used.
  // A peer's: the tunnel `volley peer join` sets up (peer.json's port, else its default).
  const peerUrl = peer ? peerBrokerUrl(sudoHome ?? env.HOME ?? homedir()) : undefined;
  const url =
    peerUrl ??
    resolveBrokerUrl(
      str("broker-url"),
      env.VOLLEY_BROKER_URL === undefined && saved?.broker_url !== undefined
        ? { ...env, VOLLEY_BROKER_URL: saved.broker_url }
        : env,
    );
  const listeners = listenerUrls(url);
  if ("error" in listeners) {
    io.stderr(`volley setup: ${listeners.error}\n`);
    return EXIT.USAGE;
  }
  // Every command goes through the fence: the exact commands the steps run, nothing else.
  const fence = setupFence({ restart: layout.restart, repoRoot: given.repoRoot, bun: given.bun });
  // What the run costs the person, counted around what they see (a check asks nothing).
  const meter = new SetupMeter(() => io.now());
  const seen = check ? checkDeps(given) : meter.wrap(given);
  const deps: SetupDeps = { ...seen, exec: fencedExec(seen.exec, fence) };
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
  // The test wave follows its wave on the broker with the coordinator's login.
  deps.waveState ??= readWaveState(url, auth.dir);
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
    ...(isNetworkKind(network) ? { network } : {}),
    ...(str("network-address") !== undefined
      ? { networkAddress: str("network-address") as string }
      : {}),
    deskHost: str("desk-host") ?? deps.lanHost(),
    deskPort: Number(portText),
    ...(check ? { check: true } : {}),
    ...(str("broker-url") !== undefined ? { brokerFlag: str("broker-url") as string } : {}),
    // The hooks of a peer's profile name its tunnel.
    ...(peerUrl !== undefined ? { brokerFlag: peerUrl, peer: true as const } : {}),
    ...(values["show-email"] === true ? { showEmail: true } : {}),
    metrics: {
      signIn: () => meter.signIn(),
      firstWave: (m) => {
        meter.firstWave = m;
      },
    },
    firstWave,
  };
  const steps = ALL.filter(([n]) => only.length === 0 || only.includes(n));

  if (check) {
    const rows = await checkSteps(ctx, steps);
    // A paired machine: whether it reaches its supervisor, under the Network row (text only).
    if (peer && values.json !== true) await addReachLines(ctx, rows);
    if (values.json === true) {
      io.stdout(`${JSON.stringify(checkReport(rows, ctx.volleydHome), null, 2)}\n`);
    } else {
      io.stdout(
        peer
          ? `volley setup --peer --check: ${PEER_HEADER}\n`
          : `volley setup --check: broker ${url}, ${layout.name} layout, auth dir ${auth.dir}\n`,
      );
      io.stdout(renderCheck(rows, peer ? "volley setup --peer" : "volley setup"));
    }
    return checkExit(rows) === 0 ? EXIT.OK : EXIT.ERROR;
  }

  const logFile = setupLogFile(ctx.volleydHome);
  const journal = (step: StepName, event: string, summary?: string) =>
    appendSetupLog(ctx, { step, event, ...(summary !== undefined ? { summary } : {}) });

  io.stdout(
    peer
      ? `volley setup --peer: ${PEER_HEADER}\n`
      : `volley setup${ctx.repair ? " --repair" : ""}: broker ${url}, ${layout.name} layout${fromRecord && layoutFlag === undefined ? " (from the last volley setup)" : ""}, auth dir ${auth.dir}\n`,
  );
  const yes = ctx.yes;
  // A run that stops once the Terminal step has checked cmux (often at the cmux change itself:
  // the runs where its mode matters most) still records the mode it found, and replaces an
  // earlier run's; and the terminal it put on record.
  const metricsFile = setupMetricsFile(ctx.volleydHome);
  let endStep: (changes: number) => void = () => {};
  // The changes the current step applied before it stopped: what its metrics record.
  let applied = 0;
  const stopped = () => {
    endStep(applied);
    writeSetupMetrics(ctx, meter.done());
    if (
      !peer &&
      (ctx.cmuxSocketMode !== undefined ||
        ctx.terminal !== undefined ||
        ctx.coordinator !== undefined)
    ) {
      writeSetupInstall(ctx, metricsFile);
    }
    return EXIT.ERROR;
  };
  const skipped: string[] = [];
  for (const [name, planner] of steps) {
    const i = ALL.findIndex(([n]) => n === name);
    endStep = meter.begin(name);
    applied = 0;
    let plan: StepPlan;
    try {
      plan = await planner(ctx);
    } catch (e) {
      journal(name, "failed", e instanceof Error ? e.message : String(e));
      io.stderr(`volley setup: ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
      return stopped();
    }
    io.stdout(`\n[${i + 1}/${ALL.length}] ${plan.title}\n`);
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
      endStep(0);
      continue;
    }
    if (plan.changes.length === 0) {
      journal(name, "done");
      io.stdout("  ✓ already done\n");
      endStep(0);
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
    if (!yes && plan.confirmed !== true && !(await deps.confirm(question))) {
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
        applied++;
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
    endStep(n);
  }
  // A finished run's install: what volleyd plans the Desk's setup with, a later run's default.
  const metrics = meter.done();
  writeSetupMetrics(ctx, metrics);
  const finished =
    skipped.length === 0
      ? completeLine(metrics)
      : `Setup finished, except the step${skipped.length === 1 ? "" : "s"} skipped above (${skipped.join(", ")}): see there for why and what to run.`;
  if (peer) {
    // setup.json is the supervisor's install record (volleyd plans the Desk's setup with it).
    io.stdout(
      [
        "",
        finished,
        ...(existsSync(join(ctx.home, ".volley", "peer.json"))
          ? []
          : [
              "Next: pair this machine: `volley peer join <code> --to <user@supervisor>` with a code from",
              "`volley peer invite` there (or run `volley machine add <user@this-machine>` there instead).",
            ]),
        `Metrics: ${metricsFile}.`,
        `Journal: ${logFile}. Rerun \`volley setup --peer\` any time to check and fix.`,
        "",
      ].join("\n"),
    );
    return EXIT.OK;
  }
  writeSetupInstall(ctx, metricsFile);
  const reach = ctx.networkRecord ?? readNetworkRecord(ctx.volleydHome);
  io.stdout(
    [
      "",
      finished,
      privateDeskLine(ctx.deskHost, ctx.deskPort, reach) ??
        `Desk: http://${ctx.deskHost.includes(":") ? `[${ctx.deskHost}]` : ctx.deskHost}:${ctx.deskPort}`,
      ...(ctx.firstWaveScratch !== undefined
        ? [
            `The test wave's scratch repository is ${ctx.firstWaveScratch}: delete it with \`${ghRepoDeleteLine(ctx.firstWaveScratch)}\`.`,
          ]
        : []),
      "Coordinator sessions log in with coordinator.json from the auth dir",
      `(${join(auth.dir, "coordinator.json")}): the MCP registration names the dir, never a`,
      "password. The volley and volleyd commands on this machine use that login on their own",
      "(keychain, then coordinator.json).",
      `Metrics: ${metricsFile}.`,
      `Journal: ${logFile}. Rerun \`volley setup --repair\` any time to check and fix.`,
      "",
    ].join("\n"),
  );
  return EXIT.OK;
}

/**
 * `--peer --check` on a paired machine: the doctor's reach rows (`network.internet`, `tunnel.up`,
 * `supervisor.live`) as lines under the Network row, each failing one with its fix line.
 */
async function addReachLines(ctx: SetupContext, rows: CheckRow[]): Promise<void> {
  const row = rows.find((r) => r.name === "network");
  if (row === undefined || ctx.deps.reach === undefined) return;
  let cfg: PeerConfig;
  try {
    if (!existsSync(peerFile(ctx.home))) return;
    cfg = readPeerConfig(ctx.home);
  } catch {
    return;
  }
  for (const c of reachChecks(await probeReach(ctx.deps.reach, peerReach(cfg)))) {
    row.lines.push(`${c.ok ? "✓" : "!"} ${c.id}: ${c.detail}`);
    if (!c.ok && c.fix !== undefined) row.lines.push(`  fix: ${c.fix.command}`);
  }
}

const PEER_HEADER = "this machine joins a supervisor's fleet (paired with `volley peer join`)";

export const SETUP_HELP = `Usage: volley setup [--yes] [--repair] [options]
       volley setup --check [--json] [--step <name>]...
       volley setup --peer [--yes] [--check] [--step <name>]...

First-run (and repair) wizard: ten steps, each showing what it found and what it will change
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
  4. Network   how this machine is reached from outside your network (--network, else asked
               once: "Reach this machine from outside this network? [Tailscale (recommended) /
               my own VPN / no]"; --yes alone means no): tailscale installs Tailscale (macOS:
               brew install --cask tailscale; Linux: needs sudo, so install.sh --network
               tailscale installs it, or the step prints the command) and signs it in
               (\`tailscale up\` prints a link to open), then records its MagicDNS name and
               address in setup.json; manual records your own VPN's address for this machine
               (--network-address; it must be one of this machine's); none records that. Never
               a public listener, a relay or Tailscale Funnel
  5. Sign-ins  Claude Code and GitHub signed in (each opens your browser: \`claude auth
               login\`, \`gh auth login --web\` then \`gh auth setup-git\`), and Claude Code
               allowed to read this checkout (permissions.additionalDirectories, the old
               settings.json backed up); skipped under --yes with nobody at the terminal
  6. Claude Code  the coordinator name (asked once, saved in setup.json), the volley MCP server
               registered at user scope with no password in it (its login is coordinator.json
               in the auth dir it names; an entry with settings of your own is left as is),
               the volley, volley-issues and volley-wait skills, the Volley hooks
  7. Terminal  where volleyd starts local agents: cmux on a Mac that has it (checked the
               way volleyd's service reaches it; the socket password it needs is asked for,
               hidden), else tmux (stops, printing the install line, when tmux is missing);
               recorded as fleet.local_terminal in $VOLLEYD_HOME/config.yaml
  8. Services  the volley and volleyd commands installed in ~/.volley/bin (on the services'
               PATH, a fixed list: the same from any terminal), volleyd (launchd / systemd
               --user), the Volley hooks for coordinator sessions (your status line keeps
               working), the Desk built and served by \`volley desk serve\` on 0.0.0.0:${DESK_PORT}
               (stops if another program listens on that port)
  9. Phone     a one-time steer sign-in link (10 minutes, single use) as a QR code; skipped
               when a phone cannot reach the WebSocket listener (LAN access off)
  10. Test wave a 1-issue test wave, asked once ("Run a 1-issue test wave now?", Enter: yes):
               a scratch private repository volley-hello-<4> (gh repo create), a README, one
               issue, a release branch, \`volley repo add … --wait\`, .volley/waves/hello-<4>.yaml
               (volleyd validate, volleyd run --owner <coordinator>; every run its own wave),
               followed until volleyd merged its PR (at most 15 minutes from the submit); the
               end prints \`gh repo delete …\` to remove it

Rerunning changes nothing that is in place. The one-time admin token and the phone's link
count as in place while they are pending or once redeemed: a rerun after they expired unused
issues new ones. Every step is journaled to $VOLLEYD_HOME/setup.log, and every run's cost (wall
time, questions, sign-ins, sudo prompts, each step's time) to $VOLLEYD_HOME/setup-metrics.json.

--peer sets up a machine that joins a supervisor's fleet (\`install.sh --peer\`, \`volley machine
add\`): no broker, accounts, Desk or phone of its own. Its steps: Sign-ins, Network, Claude Code
(the profile only: the skills, and the hooks for the tunnel \`volley peer join\` sets up; no
coordinator name, no MCP registration), Terminal, and Peer service (\`volley peer run\` as the
user service in place of volleyd; skipped until the machine is paired, since join installs it).

--check plans every step without changing or asking anything and prints each as done, pending
(with the changes a run would make), blocked (and why) or skipped (and why); it exits 0 only
when nothing is pending or blocked. --json prints that as { version, steps, setup_at } for CI.

Options:
  -y, --yes            Apply every step without asking
  --repair             Check and fix only: no new admin token, no phone link
  --check              Report what is missing; change nothing (not with --yes or --repair)
  --peer               This machine joins a supervisor's fleet (above): not with the broker's,
                       accounts' or Desk's flags
  --json               With --check: the report as JSON on stdout
  --show-email         The Sign-ins step names the Claude login's e-mail
  --lan                Open the WebSocket listener (9001) to your network (for the phone)
  --no-lan             Keep it on this machine only (the default under --yes)
  --network <kind>     tailscale | manual | none: how this machine is reached from outside
                       your network (default: the last run's, else asked; none under --yes)
  --network-address <host-or-ip>
                       With --network manual: this machine's address on your own VPN
  --step <name>        Only this step (repeatable): detect, security, accounts, network,
                       signin, claude-code, terminal, services, phone, first-wave (--peer:
                       signin, network, claude-code, terminal, peer-service)
  --no-first-wave      Skip the test wave (run it later: volley setup --step first-wave)
  --repo <path>        The test wave on this clone (its origin's repository) instead of a
                       scratch repository
  --issue <n>          With --repo: the issue the test wave implements (default: a new one)
  --simulated          The test wave against volley-sim's fake gh and claude (CI): no GitHub
  --dir <dir>          The auth dir (env: VOLLEY_AUTH_DIR; default <mosquitto config dir>/volley)
  --layout <name>      brew-arm64 | brew-intel | snap | etc | container (default: detected)
  --config <path>      The mosquitto.conf to manage (default: the layout's)
  --state-file <path>  The Dynamic Security state file (default: the layout's)
  --broker-url <url>   The broker, mqtt:// (env: VOLLEY_BROKER_URL; default: the last run's, else
                       mqtt://localhost:1883); re-points the MCP registration and the hooks
  --desk-host <host>   The address in the phone's link (default: this machine's LAN address)
  --desk-port <n>      The Desk's port (default ${DESK_PORT})
  -h, --help           Show this help and exit
`;
