import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realAuthDeps } from "../../src/auth/context";
import { cmd } from "../../src/auth/dynsec";
import {
  type HiddenInput,
  SETUP_HELP,
  hiddenKeys,
  lanAddress,
  setup,
} from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import { LAN_QUESTION } from "../../src/setup/broker";
import { readSetupInstall } from "../../src/setup/journal";
import { NETWORK_QUESTION } from "../../src/setup/network";
import { setupFence } from "../../src/setup/step";
import { CMUX_CHECK_SCRIPT } from "../../src/setup/terminal";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { ANONYMOUS_CONFIG, type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  a.includes("--dry-run") ||
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "security" && a[1] === "find-generic-password") ||
  // The sign-ins' status, and who gh is signed in as.
  (a[0] === "claude" && a[1] === "auth" && a[2] === "status") ||
  (a[0] === "gh" && a[1] === "auth" && a[2] === "status") ||
  (a[0] === "gh" && a[1] === "api" && a[2] === "user") ||
  // git's commit identity (the Sign-ins step, the test wave).
  a.join(" ") === "git var GIT_COMMITTER_IDENT" ||
  // Who listens on the Desk's port.
  a[0] === "lsof" ||
  a[0] === "ss";

/** What the run's last lines say once every step is in place. */
const COMPLETE = "Setup complete in ";

describe("volley setup", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  let probes: string[];
  beforeEach(async () => {
    dir = tempDir("volley-setup-");
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir);
    probes = [];
    const probe = m.deps.probeAnonymous;
    m.deps.probeAnonymous = async (url) => {
      probes.push(url);
      return probe(url);
    };
  });
  afterEach(async () => {
    await fake.close();
  });

  const env = () => ({
    HOME: m.ctx.home,
    VOLLEYD_HOME: m.ctx.volleydHome,
    VOLLEY_AUTH_DIR: m.layout.authDir,
    VOLLEY_BROKER_URL: fake.url,
  });
  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const code = await setup({ argv, env: env(), io }, m.deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  const journal = () =>
    readFileSync(join(m.ctx.volleydHome, "setup.log"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { at: string; step: string; event: string; summary?: string });

  it("--yes --network tailscale with Tailscale running records its name and address; the end names both Desk addresses", async () => {
    m.tailscale.installed = true;
    m.tailscale.state = "Running";
    const r = await run(["--yes", "--lan", "--network", "tailscale"]);
    expect(r.code).toBe(0);
    expect(readSetupInstall(m.ctx.volleydHome)?.network).toEqual({
      kind: "tailscale",
      name: "studio.example.ts.net",
      address: "100.64.0.2",
    });
    expect(
      journal()
        .filter((e) => e.step === "network" && e.event === "applied")
        .map((e) => e.summary),
    ).toEqual([
      "Record this machine's private address in setup.json (tailscale: studio.example.ts.net, 100.64.0.2)",
    ]);
    expect(m.execCalls.some((a) => a.includes("up") || a.includes("--cask"))).toBe(false);
    // The Services step serves the Desk on the tailnet: two loopback-only serves, never Funnel.
    expect(
      journal()
        .filter((e) => e.step === "services" && e.event === "applied")
        .map((e) => e.summary),
    ).toContain("Serve the Desk on your private network (https://studio.example.ts.net)");
    expect(m.tailscale.serves).toEqual(
      new Map([
        [443, "http://127.0.0.1:5199"],
        [8443, "http://127.0.0.1:9001"],
      ]),
    );
    expect(m.execCalls.some((a) => a.includes("funnel"))).toBe(false);
    expect(readSetupInstall(m.ctx.volleydHome)?.desk_private_url).toBe(
      "https://studio.example.ts.net",
    );
    expect(r.stdout).toContain("Desk: http://desk.example:5199 · https://studio.example.ts.net");
    // A rerun without the flag keeps the record and changes nothing there.
    const again = await run(["--yes", "--step", "network"]);
    expect(again.stdout).toContain("already done");
    expect(readSetupInstall(m.ctx.volleydHome)?.network?.kind).toBe("tailscale");
  });

  it("--network manual with an address this machine does not have fails the step and records nothing", async () => {
    const r = await run([
      "--yes",
      "--step",
      "network",
      "--network",
      "manual",
      "--network-address",
      "203.0.113.7",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "203.0.113.7 is not an address of this machine (interfaces: en0 192.0.2.10)",
    );
    expect(existsSync(join(m.ctx.volleydHome, "setup.json"))).toBe(false);
  });

  it("--network takes tailscale, manual or none; --network-address goes with manual", async () => {
    expect((await run(["--network", "funnel"])).stderr).toContain(
      "--network must be one of tailscale, manual, none",
    );
    const stray = await run(["--network", "tailscale", "--network-address", "192.0.2.10"]);
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("it goes with --network manual");
  });

  it("prints the planned diff and writes nothing before the confirmation", async () => {
    m.answers = [false, false];
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("[1/10] Broker");
    expect(r.stdout).toContain("[2/10] Security");
    expect(r.stdout).toContain("-allow_anonymous true");
    expect(r.stdout).toContain("+allow_anonymous false");
    expect(r.stdout).toContain("Nothing was changed");
    expect(m.questions).toEqual([LAN_QUESTION, "Apply these 3 changes (Security)?"]);
    expect(r.stdout).not.toContain("not a terminal");
    expect(readFileSync(m.layout.config, "utf-8")).toBe(ANONYMOUS_CONFIG);
    expect(readdirSync(dir).some((f) => f.includes("volley-backup"))).toBe(false);
    expect(m.auth.ctrlCalls).toEqual([]);
    expect(m.execCalls.every(READ_ONLY)).toBe(true);
    expect(journal().map((e) => [e.step, e.event])).toEqual([
      ["detect", "done"],
      ["security", "planned"],
      ["security", "declined"],
    ]);
  });

  it("with --yes --lan: backs up and writes the config, restarts the broker, checks anonymous is refused, and finishes", async () => {
    const r = await run(["--yes", "--lan"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(m.questions).toEqual([]);
    const backups = readdirSync(dir).filter((f) => f.startsWith("mosquitto.conf.volley-backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0] as string), "utf-8")).toBe(ANONYMOUS_CONFIG);
    expect(readFileSync(m.layout.config, "utf-8")).toContain("allow_anonymous false");
    expect(m.execCalls).toContainEqual(["brew", "services", "restart", "mosquitto"]);
    // The anonymous check runs again after the restart, on both listeners.
    const restartAt = m.execCalls.findIndex((a) => a.join(" ") === m.layout.restart);
    expect(restartAt).toBeGreaterThanOrEqual(0);
    expect(probes.filter((u) => u.startsWith("ws:")).length).toBeGreaterThanOrEqual(3);
    // LAN on: 9001 is open to the network, 1883 stays on loopback, and the phone's reach is checked.
    expect(readFileSync(m.layout.config, "utf-8")).toMatch(/^listener 9001$/m);
    expect(readFileSync(m.layout.config, "utf-8")).toContain("listener 1883 127.0.0.1");
    expect(probes).toContain("ws://desk.example:9001");
    // Accounts: passwords once, the admin token; then the services and the phone's QR code.
    expect(r.stdout).toContain("New passwords (shown ONCE");
    expect(r.stdout).toMatch(/vly_admin_[0-9a-f]{8}_[0-9a-f]{32}/);
    expect(r.stdout).toMatch(/http:\/\/desk\.example:5199\/#signin=vly_signin_/);
    expect(r.stdout).toContain(COMPLETE);
    // The security step says what it checked once it passed.
    expect(r.stdout).toContain(
      `  ✓ Listener ${new URL(fake.url).port}: refuses anonymous clients\n`,
    );
    expect(r.stdout).toContain("  ✓ Listener 9001: refuses anonymous clients\n");
    expect(r.stdout).toContain(
      "  ✓ Listener 9001 from the LAN (ws://desk.example:9001): reachable, refuses anonymous clients\n",
    );
    // The CLIs here find the coordinator's login themselves: no password for a shell profile.
    expect(r.stdout).not.toContain("shell profile");
    expect(r.stdout).toContain("use that login on their own");
    expect(m.loaded.has("systems.volley.desk")).toBe(true);
    // The journal records every step, never a secret.
    const log = readFileSync(join(m.ctx.volleydHome, "setup.log"), "utf-8");
    expect(log).not.toMatch(/vly_(admin|signin)_/);
    expect(log).not.toMatch(/pw-\d/);
    expect(
      journal()
        .filter((e) => e.event === "applied")
        .map((e) => e.step),
    ).toEqual([
      "security",
      "security",
      "security",
      "accounts",
      "accounts",
      "accounts",
      "network",
      "signin",
      "claude-code",
      "claude-code",
      "claude-code",
      "claude-code",
      "terminal",
      "services",
      "services",
      "services",
      "services",
      "phone",
      "first-wave",
    ]);
  });

  it("with --yes alone: keeps the WebSocket listener local, skips the phone step and says so", async () => {
    const r = await run(["--yes"]);
    expect(r.code).toBe(0);
    expect(m.questions).toEqual([]);
    expect(readFileSync(m.layout.config, "utf-8")).toContain("listener 9001 127.0.0.1");
    expect(r.stdout).toContain("LAN access: off");
    expect(r.stdout).toContain("– skipped: a phone cannot reach the broker's WebSocket listener");
    // No phone link (the admin token's link to this machine's Desk is printed either way).
    expect(r.stdout).not.toMatch(/#signin=vly_signin_/);
    expect(r.stdout).not.toContain(COMPLETE);
    expect(r.stdout).toContain("Setup finished, except the step skipped above (Phone)");
    const tokens = JSON.parse(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).tokens;
    expect(tokens.map((t: { kind: string }) => t.kind)).toEqual(["admin"]);
    expect(journal().find((e) => e.step === "phone")).toMatchObject({ event: "skipped" });
  });

  it("a later --lan opens the listener and then issues the phone's link", async () => {
    expect((await run(["--yes"])).code).toBe(0);
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(readFileSync(m.layout.config, "utf-8")).toMatch(/^listener 9001$/m);
    expect(r.stdout).toMatch(/#signin=vly_signin_/);
    expect(r.stdout).toContain(COMPLETE);
  });

  it("refuses --lan with --no-lan, and a TLS broker URL it cannot probe", async () => {
    expect((await run(["--lan", "--no-lan"])).code).toBe(2);
    const tls = await run(["--broker-url", "mqtts://broker.example:8883"]);
    expect(tls.code).toBe(2);
    expect(tls.stderr).toContain("TLS is not supported by `volley setup` yet");
    expect(existsSync(join(m.ctx.volleydHome, "setup.log"))).toBe(false);
  });

  it("says to pass --yes when nobody is at the terminal", async () => {
    m.deps.interactive = false;
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("(not a terminal: pass --yes to apply)");
  });

  it("runs only commands the fence allows", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const fence = setupFence({ restart: m.layout.restart, repoRoot: m.deps.repoRoot, bun: "bun" });
    const desk = join(m.deps.repoRoot as string, "packages", "volley-desk");
    for (const argv of m.execCalls) {
      expect(() => fence(argv, argv[1] === "run" ? { cwd: desk } : undefined)).not.toThrow();
    }
  });

  it("records the install it used (layout, config, state file, auth dir, Desk, LAN) for volleyd's Desk plans", async () => {
    expect((await run(["--yes", "--lan", "--desk-port", "5288"])).code).toBe(0);
    const saved = JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8"));
    expect(saved).toEqual({
      layout: m.layout.name,
      config: m.layout.config,
      state_file: m.layout.stateFile,
      auth_dir: m.layout.authDir,
      desk_host: "desk.example",
      desk_port: 5288,
      lan: true,
      terminal: "tmux",
      coordinator: "coord-studio",
      namespace: "default",
      broker_url: fake.url,
      metrics: join(m.ctx.volleydHome, "setup-metrics.json"),
      network: { kind: "none" },
    });
    expect(readSetupInstall(m.ctx.volleydHome)).toEqual(saved);
  });

  it("records cmux's socket mode in setup.json, and a run that did not check cmux keeps it", async () => {
    const bin = join(m.ctx.home, "Applications", "cmux.app", "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cmux"), "");
    const inner = m.deps.exec;
    m.deps.exec = async (argv, o) => {
      if (argv[0] === "sh" && argv[2] === CMUX_CHECK_SCRIPT) {
        writeFileSync(
          argv[4] as string,
          '{"access_mode":"automation"}\nvolley-cmux-caps=0\nworkspace:1\nvolley-cmux-exit=0\n',
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return inner(argv, o);
    };
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cmux's socket control mode: Automation mode");
    expect(readSetupInstall(m.ctx.volleydHome)?.cmux_socket_mode).toBe("automation");
    expect((await run(["--step", "security"])).code).toBe(0);
    expect(readSetupInstall(m.ctx.volleydHome)?.cmux_socket_mode).toBe("automation");
  });

  it("a later run without the flags (`--step services` as the user) keeps and uses the record", async () => {
    expect((await run(["--yes", "--lan", "--desk-port", "5288"])).code).toBe(0);
    const file = join(m.ctx.volleydHome, "setup.json");
    // As if setup had run with --layout container --config … --dir …: what volleyd plans with.
    const recorded = { ...JSON.parse(readFileSync(file, "utf-8")), layout: "brew-intel" };
    writeFileSync(file, JSON.stringify(recorded));
    const r = await run(["--yes", "--step", "services"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("brew-intel layout (from the last volley setup)");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(recorded);
  });

  it("keeps the port of a record only `volley desk install` wrote (no layout yet)", async () => {
    const file = join(m.ctx.volleydHome, "setup.json");
    mkdirSync(m.ctx.volleydHome, { recursive: true });
    writeFileSync(file, '{"desk_port":5300,"broker_host":"box-a"}\n');
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({
      desk_port: 5300,
      broker_host: "box-a",
    });
  });

  it("records nothing for a run that stops before it finishes", async () => {
    m.auth.mosquittoVersion = async () => null;
    const r = await run(["--yes"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(m.ctx.volleydHome, "setup.json"))).toBe(false);
  });

  it("a run that stops at cmux replaces an earlier run's cmux mode in setup.json", async () => {
    const bin = join(m.ctx.home, "Applications", "cmux.app", "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cmux"), "");
    let answer = '{"access_mode":"automation"}\nvolley-cmux-caps=0\nok\nvolley-cmux-exit=0\n';
    const inner = m.deps.exec;
    m.deps.exec = async (argv, o) => {
      if (argv[0] === "sh" && argv[2] === CMUX_CHECK_SCRIPT) {
        writeFileSync(argv[4] as string, answer);
        return { code: 0, stdout: "", stderr: "" };
      }
      return inner(argv, o);
    };
    m.deps.interactive = false;
    const recorded = () =>
      JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8")).cmux_socket_mode;
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    expect(recorded()).toBe("automation");
    // cmux set back to Password mode: the rerun stops at cmux, and says so in setup.json too.
    answer =
      "ERROR: Invalid password\nvolley-cmux-caps=1\nERROR: Invalid password\nvolley-cmux-exit=1\n";
    expect((await run(["--yes", "--step", "terminal"])).code).toBe(1);
    expect(recorded()).toBe("password");
  });

  it("prints the admin token as a link to the Desk it serves (its --desk-port)", async () => {
    const r = await run(["--yes", "--desk-port", "5288"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /Open the Desk with it on this machine: http:\/\/localhost:5288\/#signin=vly_admin_[0-9a-f]+_[0-9a-f]+/,
    );
    // From another device: the address the phone's link uses.
    expect(r.stdout).toMatch(
      /From another device: http:\/\/desk\.example:5288\/#signin=vly_admin_/,
    );
  });

  it("when cmux refuses volleyd's service and nobody can answer, it never says done or complete", async () => {
    const bin = join(m.ctx.home, "Applications", "cmux.app", "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cmux"), "");
    const inner = m.deps.exec;
    m.deps.exec = async (argv, o) => {
      if (argv[0] === "sh" && argv[2] === CMUX_CHECK_SCRIPT) {
        // cmux in Password mode, and volleyd has no password.
        writeFileSync(
          argv[4] as string,
          "ERROR: Invalid password\nvolley-cmux-caps=1\nERROR: Invalid password\nvolley-cmux-exit=1\n",
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return inner(argv, o);
    };
    m.deps.interactive = false;
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain(COMPLETE);
    expect(r.stdout).toContain("(cmux said: ERROR: Invalid password)");
    expect(r.stderr).toContain("Give volleyd the cmux socket password");
    expect(r.stderr).toContain("volley setup --step terminal");
    // The run stopped at cmux, and setup.json records the mode the check found.
    const recorded = () =>
      JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8")).cmux_socket_mode;
    expect(recorded()).toBe("password");
    // The choice is on record; the run stopped before the Services step.
    expect(readFileSync(join(m.ctx.volleydHome, "config.yaml"), "utf-8")).toBe(
      "fleet:\n  local_terminal: cmux\n",
    );
    expect(JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8")).terminal).toBe(
      "cmux",
    );
    expect(
      existsSync(join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist")),
    ).toBe(false);
    // A rerun does not call the Services step done either.
    const again = await run([]);
    expect(again.stdout).not.toContain(COMPLETE);
    expect(again.stdout.match(/already done/g)?.length ?? 0).toBeLessThan(7);
  });

  it("a rerun whose Desk plist launchd will not load exits non-zero, with the Desk still loaded", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const plist = join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.desk.plist");
    writeFileSync(plist, "<plist>older</plist>\n");
    const inner = m.deps.exec;
    m.deps.exec = async (argv, o) =>
      argv[1] === "bootstrap" && readFileSync(plist, "utf-8").includes("0.0.0.0")
        ? { code: 1, stdout: "", stderr: "Bootstrap failed: 1: Operation not permitted" }
        : inner(argv, o);
    const r = await run(["--yes", "--step", "services"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain(COMPLETE);
    expect(r.stderr).toContain("Operation not permitted");
    expect(r.stderr).toContain("loaded it again");
    expect(m.loaded.has("systems.volley.desk")).toBe(true);
    expect(journal().slice(-1)[0]).toMatchObject({ step: "services", event: "failed" });
  });

  it("a second run reports every step as already done and changes nothing", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const calls = m.execCalls.length;
    const clients = fake.clients();
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout.match(/already done/g)).toHaveLength(10);
    expect(m.questions).toEqual([]);
    expect(m.execCalls.slice(calls).every(READ_ONLY)).toBe(true);
    expect(fake.clients()).toEqual(clients);
    expect(r.stdout).toContain(COMPLETE);
  });

  it("a rerun after the admin token and phone link expired unused issues new ones", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const file = join(m.layout.authDir, "tokens.json");
    const t = JSON.parse(readFileSync(file, "utf-8"));
    for (const x of t.tokens) x.expires_at = "2026-10-18T11:00:00.000Z";
    writeFileSync(file, JSON.stringify(t));
    const r = await run(["--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/vly_admin_/);
    expect(r.stdout).toMatch(/#signin=vly_signin_/);
  });

  it("--repair re-creates a missing account only", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const admin = JSON.parse(readFileSync(join(m.layout.authDir, "admin.json"), "utf-8"));
    const link = await realAuthDeps.connectAdmin(fake.url, admin);
    await link.session.run([cmd.deleteClient("desk")]);
    await link.close();
    const before = fake.clients();
    const tokens = readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8");
    const calls = m.execCalls.length;

    const r = await run(["--repair", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Create the missing identity desk");
    expect(r.stdout.match(/already done/g)).toHaveLength(9);
    const after = fake.clients();
    expect([...after.keys()].sort()).toEqual([...before.keys(), "desk"].sort());
    for (const [u, c] of before) expect(after.get(u)?.password).toBe(c.password);
    // No new token, no new phone link, no command beyond the read-only checks.
    expect(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).toBe(tokens);
    expect(m.execCalls.slice(calls).every(READ_ONLY)).toBe(true);
    expect(
      journal()
        .filter((e) => e.event === "applied")
        .slice(-1)
        .map((e) => e.summary),
    ).toEqual(["Create the missing identity desk (password shown once)"]);
  });

  it("asks once per step with changes, interactively", async () => {
    m.answers = [true, true, true, true, true, true, true, true, true, true];
    m.typed = ["no", "coord-main"];
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(m.questions).toEqual([
      LAN_QUESTION,
      "Apply these 3 changes (Security)?",
      "Apply these 3 changes (Accounts)?",
      "Apply this change (Network)?",
      "Apply this change (Sign-ins)?",
      "Apply these 4 changes (Claude Code)?",
      "Apply this change (Terminal)?",
      "Apply these 4 changes (Services)?",
      "Apply this change (Phone)?",
      "Run a 1-issue test wave now?",
    ]);
    // The coordinator name is asked once, typed visibly.
    expect(m.asked).toEqual([`${NETWORK_QUESTION} `, "Coordinator name [coord-studio]: "]);
    expect(readSetupInstall(m.ctx.volleydHome)?.coordinator).toBe("coord-main");
    expect(r.stdout).toMatch(
      /Setup complete in \d+ m \d+ s \(12 questions, 0 sign-ins, 0 sudo\); test wave merged in /,
    );
  });

  it("stops at a blocked step, naming why", async () => {
    m.auth.binaryVersion = "mosquitto version 2.0.22";
    const r = await run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("BROKER_TOO_OLD");
    expect(r.stdout).not.toContain("[2/10]");
    expect(readFileSync(m.layout.config, "utf-8")).toBe(ANONYMOUS_CONFIG);
  });

  it("stops when a change fails, and the journal says which", async () => {
    const exec = m.deps.exec;
    m.deps.exec = async (argv, o) =>
      argv.join(" ") === m.layout.restart
        ? { code: 1, stdout: "", stderr: "Error: no such service" }
        : exec(argv, o);
    const r = await run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such service");
    expect(journal().slice(-1)[0]).toMatchObject({ step: "security", event: "failed" });
    expect(r.stdout).not.toContain("[3/10]");
  });

  it("--step runs only the steps it names", async () => {
    const r = await run(["--step", "services", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[8/10] Services");
    expect(r.stdout).not.toContain("[1/10]");
    expect(r.stdout).not.toContain("[7/10]");
    expect(r.stdout).not.toContain("[9/10]");
    expect(m.loaded.has("systems.volley.desk")).toBe(true);
    expect((await run(["--step", "nope"])).code).toBe(2);
  });

  it("records the terminal it chose in setup.json and volleyd's config.yaml", async () => {
    mkdirSync(m.ctx.volleydHome, { recursive: true });
    const config = join(m.ctx.volleydHome, "config.yaml");
    writeFileSync(config, "spawn:\n  ceiling: 3\n");
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[7/10] Terminal");
    expect(r.stdout).toContain("cmux is not installed");
    expect(readFileSync(config, "utf-8")).toBe(
      "spawn:\n  ceiling: 3\nfleet:\n  local_terminal: tmux\n",
    );
    expect(readSetupInstall(m.ctx.volleydHome)?.terminal).toBe("tmux");
    // A later run that leaves the Terminal step out keeps the choice on record.
    expect((await run(["--yes", "--step", "security"])).code).toBe(0);
    expect(readSetupInstall(m.ctx.volleydHome)?.terminal).toBe("tmux");
  });

  it("stops at the Terminal step when tmux is missing, printing the install line", async () => {
    m.present.delete("/usr/bin/tmux");
    const r = await run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "  ✗ Blocked: neither cmux nor tmux is installed, and volleyd starts local agents in one of them: install tmux (brew install tmux)",
    );
    expect(r.stdout).not.toContain("[8/10]");
    expect(journal().slice(-1)[0]).toMatchObject({ step: "terminal", event: "blocked" });
    expect(existsSync(join(m.ctx.volleydHome, "config.yaml"))).toBe(false);
  });

  it("under sudo, skips the user services and still ends with the phone's link", async () => {
    m.auth.invokingUser = () => ({ uid: 501, gid: 20, home: m.ctx.home });
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("– skipped: running as root");
    expect(r.stdout).toContain(
      "Setup finished, except the steps skipped above (Sign-ins, Claude Code, Terminal, Services, Test wave)",
    );
    expect(r.stdout).toMatch(/#signin=vly_signin_/);
    expect(m.loaded.size).toBe(0);
  });

  it("finds the LAN address on a physical interface, not a container bridge", () => {
    const v4 = (address: string) => [
      { address, family: "IPv4", internal: false, netmask: "", mac: "", cidr: null },
    ];
    expect(
      lanAddress({
        lo: [
          {
            address: "127.0.0.1",
            family: "IPv4",
            internal: true,
            netmask: "",
            mac: "",
            cidr: null,
          },
        ],
        docker0: v4("172.17.0.1"),
        "br-1a2b": v4("172.18.0.1"),
        eth0: v4("192.168.1.20"),
      } as never),
    ).toBe("192.168.1.20");
    expect(lanAddress({ docker0: v4("172.17.0.1") } as never)).toBe("172.17.0.1");
  });

  describe("the broker steps through sudo on a Linux install whose broker files are root's (#591)", () => {
    /** The argv the run took as root, by the child's own argv (after the CLI's path). */
    let children: string[][];
    beforeEach(() => {
      m = fakeMachine(fake, tempDir("volley-setup-snap-"), {
        platform: "linux",
        layout: "snap",
        uid: 1000,
      });
      children = [];
      // The child as the real one: `volley setup` itself, run as root (uid 0).
      m.rootChild = async (argv) => {
        children.push(argv);
        expect(argv[0]).toBe("setup");
        const io = makeBufferIO({ now: () => new Date(NOW) });
        const code = await setup({ argv: argv.slice(1), env: env(), io }, { ...m.deps, uid: 0 });
        return { code, stdout: io.readStdout(), stderr: io.readStderr() };
      };
    });
    /** The end of a --no-lan run as the user: everything but the phone's link. */
    const DONE_NO_LAN = "\nSetup finished, except the step skipped above (Phone)";
    const isSudo = (a: string[]) => a[0] === "sudo" && a.includes("setup");
    const sudoCalls = () => m.execCalls.filter(isSudo);

    it("--yes --no-lan: announces why, runs `sudo -n` first, then continues as the user to the end", async () => {
      const r = await run(["--yes", "--no-lan"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      // The probe decides by its exit code (sudo's own message is translated under a locale).
      expect(m.execCalls[0]).toEqual(["sudo", "-n", "true"]);
      const first = m.execCalls[1] ?? [];
      expect(first.slice(0, 3)).toEqual(["sudo", "-n", "bun"]);
      expect(first.slice(4)).toEqual([
        "setup",
        "--step",
        "detect",
        "--step",
        "security",
        "--step",
        "accounts",
        "--yes",
        "--no-lan",
        "--broker-url",
        fake.url,
        "--dir",
        m.layout.authDir,
      ]);
      expect(sudoCalls()).toHaveLength(1);
      expect(children).toHaveLength(1);
      expect(m.questions).toEqual([]);
      const why = r.stdout.indexOf("sudo is needed to:");
      expect(why).toBeGreaterThan(-1);
      expect(r.stdout.indexOf("Running: sudo ")).toBeGreaterThan(why);
      expect(r.stdout).toContain(`write ${m.layout.config}`);
      expect(r.stdout).toContain("restart the broker (sudo snap restart mosquitto)");
      // The user's own Security and Accounts find the child's work in place.
      const security = r.stdout.slice(r.stdout.lastIndexOf("] Security"));
      expect(security.split("\n").slice(0, 12).join("\n")).toContain("✓ already done");
      expect(r.stdout).toContain(DONE_NO_LAN);
      const metrics = JSON.parse(
        readFileSync(join(m.ctx.volleydHome, "setup-metrics.json"), "utf-8"),
      );
      expect(metrics.sudo_prompts).toBe(0);
    });

    it("asks once (not the steps' own questions) without --yes, then runs it", async () => {
      // The LAN question, then the sudo one; then every later step's own confirmation.
      m.answers = [false, true, ...Array(10).fill(true)];
      const r = await run([]);
      expect(r.code).toBe(0);
      expect(m.questions.slice(0, 2)).toEqual([LAN_QUESTION, "Run these steps with sudo?"]);
      expect(m.questions.filter((q) => /\(Security\)|\(Accounts\)/.test(q))).toEqual([]);
      expect(sudoCalls()[0]).toContain("--no-lan");
    });

    it("declined: nothing runs, the run stops", async () => {
      m.answers = [false, false];
      const r = await run([]);
      expect(r.code).toBe(1);
      expect(sudoCalls()).toEqual([]);
      expect(r.stdout).toContain("Nothing was changed.");
      expect(journal().at(-1)).toMatchObject({ step: "security", event: "declined" });
    });

    it("a password at a terminal: `sudo -n` fails, then one `sudo` (one prompt)", async () => {
      m.sudo.passwordless = false;
      const r = await run(["--yes", "--no-lan"]);
      expect(r.code).toBe(0);
      // The probe fails (in any language), then the one `sudo` that prompts.
      expect(m.execCalls[0]).toEqual(["sudo", "-n", "true"]);
      const calls = sudoCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe("bun");
      expect(r.stdout).toContain(DONE_NO_LAN);
      const metrics = JSON.parse(
        readFileSync(join(m.ctx.volleydHome, "setup-metrics.json"), "utf-8"),
      );
      expect(metrics.sudo_prompts).toBe(1);
    });

    it("a password and no terminal: stops before Security with the two commands, nothing else run", async () => {
      m.sudo.passwordless = false;
      m.deps.interactive = false;
      const r = await run(["--yes", "--no-lan", "--simulated"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "volley setup: Security: the broker's config and state file are root's on this install (snap), and sudo needs your password, which this run cannot ask for. In a terminal, run:\n  sudo volley setup --step detect --step security --step accounts --yes --no-lan\nthen run `volley setup --yes --no-lan --simulated` again.\n",
      );
      expect(m.execCalls).toHaveLength(1);
      expect(children).toEqual([]);
      expect(journal().at(-1)).toMatchObject({ step: "security", event: "blocked" });
      expect(readFileSync(m.layout.config, "utf-8")).toBe(ANONYMOUS_CONFIG);
    });

    it("a child that fails under passwordless sudo is the child's failure, not a password", async () => {
      m.rootChild = async () => ({ code: 3, stdout: "", stderr: "Fehler: kein Passwort\n" });
      m.deps.interactive = false;
      const r = await run(["--yes", "--no-lan"]);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("the broker steps under sudo failed (exit 3)");
      expect(r.stderr).not.toContain("sudo needs your password");
    });

    it("passes the config and state file it planned with (from the last run's record), absolute", async () => {
      const config = join(m.ctx.home, "elsewhere", "mosquitto.conf");
      const stateFile = join(m.ctx.home, "elsewhere", "dynamic-security.json");
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, ANONYMOUS_CONFIG);
      mkdirSync(m.ctx.volleydHome, { recursive: true });
      writeFileSync(
        join(m.ctx.volleydHome, "setup.json"),
        JSON.stringify({
          layout: "snap",
          config,
          state_file: stateFile,
          auth_dir: m.layout.authDir,
          broker_url: fake.url,
        }),
      );
      m.rootChild = async () => ({ code: 1, stdout: "", stderr: "" });
      await run(["--yes", "--no-lan"]);
      const child = sudoCalls()[0] ?? [];
      expect(child.slice(child.indexOf("--config"), child.indexOf("--config") + 2)).toEqual([
        "--config",
        config,
      ]);
      expect(child).toContain("--state-file");
      expect(child[child.indexOf("--state-file") + 1]).toBe(stateFile);
    });

    it("a relative --config reaches the child as an absolute path", async () => {
      m.rootChild = async () => ({ code: 1, stdout: "", stderr: "" });
      const rel = relative(process.cwd(), m.layout.config);
      await run(["--yes", "--no-lan", "--config", rel]);
      const child = sudoCalls()[0] ?? [];
      expect(child[child.indexOf("--config") + 1]).toBe(m.layout.config);
      expect(child).not.toContain("--state-file");
    });

    it.skipIf(process.getuid?.() === 0)(
      "a config the user cannot read: escalates, and continues once root's run made it readable",
      async () => {
        chmodSync(m.layout.config, 0o000);
        const real = m.rootChild as NonNullable<typeof m.rootChild>;
        m.rootChild = async (argv) => {
          chmodSync(m.layout.config, 0o644);
          return real(argv);
        };
        const r = await run(["--yes", "--no-lan"]);
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(children).toHaveLength(1);
        expect(r.stdout).toContain(DONE_NO_LAN);
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "a config still unreadable after root's run: stops clearly, before the step loop",
      async () => {
        chmodSync(m.layout.config, 0o000);
        m.rootChild = async () => ({ code: 0, stdout: "", stderr: "" });
        const r = await run(["--yes", "--no-lan"]);
        chmodSync(m.layout.config, 0o644);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          `volley setup: Security: the broker steps ran as root, but you still cannot read the broker's files`,
        );
        expect(r.stderr).toContain(`sudo chmod a+r ${m.layout.config}`);
        expect(r.stdout).not.toContain("[1/10]");
        expect(journal().at(-1)).toMatchObject({ step: "security", event: "failed" });
      },
    );

    it("names ~/.volley/bin/volley in that command once it is installed", async () => {
      m.sudo.passwordless = false;
      m.deps.interactive = false;
      mkdirSync(join(m.ctx.home, ".volley", "bin"), { recursive: true });
      writeFileSync(join(m.ctx.home, ".volley", "bin", "volley"), "#!/bin/sh\n");
      const r = await run(["--yes"]);
      expect(r.stderr).toContain("  sudo ~/.volley/bin/volley setup --step detect");
      expect(r.stderr).toContain("then run `volley setup --yes` again.");
    });

    it("a child that fails stops the run with its exit code", async () => {
      m.rootChild = async () => ({ code: 1, stdout: "", stderr: "volley setup: Security: boom\n" });
      const r = await run(["--yes", "--no-lan"]);
      expect(r.code).toBe(1);
      // The child's own messages went to the terminal it shares (tty: true).
      expect(r.stderr).toContain("see the output above");
      expect(r.stdout).not.toContain("[1/10]");
    });

    it("the security step already in place: no sudo at all", async () => {
      expect((await run(["--yes", "--no-lan"])).code).toBe(0);
      m.execCalls.length = 0;
      const again = await run(["--yes"]);
      expect(again.code).toBe(0);
      expect(sudoCalls()).toEqual([]);
    });

    it.each([
      ["--check", ["--check"]],
      ["--peer", ["--peer", "--yes"]],
      ["no security step", ["--yes", "--step", "network"]],
    ])("%s: no sudo", async (_, argv) => {
      await run(argv);
      expect(sudoCalls()).toEqual([]);
    });

    it("as root, or on the brew layout: no sudo", async () => {
      m.deps.uid = 0;
      expect((await run(["--yes", "--no-lan"])).code).toBe(0);
      expect(sudoCalls()).toEqual([]);
      m = fakeMachine(fake, tempDir("volley-setup-brew-"), { platform: "linux", uid: 1000 });
      expect((await run(["--yes", "--no-lan"])).code).toBe(0);
      expect(sudoCalls()).toEqual([]);
    });
  });

  describe("--peer: a machine that joins a supervisor's fleet (#462)", () => {
    const peerJson = () => join(m.ctx.home, ".volley", "peer.json");
    const paired = (port = 21883) => {
      mkdirSync(join(m.ctx.home, ".volley"), { recursive: true });
      writeFileSync(
        peerJson(),
        JSON.stringify({ name: "box-a", host: "me@hub", remote_port: port, broker: {} }),
      );
    };
    const plist = () => join(m.ctx.home, "Library", "LaunchAgents", "systems.volley.peer.plist");
    /**
     * What a peer's setup must never talk about: it has no broker, Desk or phone of its own (the
     * hooks' `VOLLEY_BROKER_URL=` is the tunnel's, and no word of its own).
     */
    const HUB_ONLY = /\bbroker|\bdesk\b|phone|admin token|mosquitto/i;

    it("runs the sign-ins, Claude Code (its profile only), the Terminal and the peer service", async () => {
      paired();
      const r = await run(["--peer", "--yes"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      for (const s of [
        "[1/5] Sign-ins",
        "[2/5] Network",
        "[3/5] Claude Code",
        "[4/5] Terminal",
        "[5/5] Peer",
      ]) {
        expect(r.stdout).toContain(s);
      }
      expect(r.stdout).not.toMatch(HUB_ONLY);
      // No broker detection: nothing is probed, no account touched.
      expect(probes).toEqual([]);
      expect(m.auth.ctrlCalls).toEqual([]);
      // Profile only: no coordinator name, no MCP registration; the hooks at the tunnel.
      expect(m.asked).toEqual([]);
      expect(m.execCalls.filter((a) => a[0] === "claude" && a[1] === "mcp")).toEqual([]);
      expect(readSetupInstall(m.ctx.volleydHome)?.coordinator).toBeUndefined();
      expect(readFileSync(m.settingsFile, "utf-8")).toContain(
        "VOLLEY_BROKER_URL=mqtt://127.0.0.1:21883 ",
      );
      // The service is `volley peer run`, not volleyd.
      expect(m.loaded.has("systems.volley.peer")).toBe(true);
      expect(m.loaded.has("systems.volley.volleyd")).toBe(false);
      const text = readFileSync(plist(), "utf-8");
      expect(text).toContain(
        `<string>${join(m.deps.repoRoot as string, "packages", "volley-cli", "src", "cli.ts")}</string>`,
      );
      expect(text).toContain("<string>peer</string>\n    <string>run</string>");
      expect(r.stdout).toContain(COMPLETE);
      // setup.json is the supervisor's install record: a peer writes none.
      expect(readSetupInstall(m.ctx.volleydHome)).toBeNull();
    });

    it("before the pairing, the service step is skipped: join installs it", async () => {
      const r = await run(["--peer", "--yes"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        "– skipped: not paired yet: `volley peer join <code> --to <host>` installs `volley peer run` as the service",
      );
      expect(r.stdout).not.toMatch(HUB_ONLY);
      expect(r.stdout).toContain("Next: pair this machine");
      expect(m.loaded.size).toBe(0);
      // The hooks are for the tunnel join sets up (its default port).
      expect(readFileSync(m.settingsFile, "utf-8")).toContain(
        "VOLLEY_BROKER_URL=mqtt://127.0.0.1:21883 ",
      );
    });

    it("a rerun changes nothing", async () => {
      paired();
      expect((await run(["--peer", "--yes"])).code).toBe(0);
      const calls = m.execCalls.length;
      const r = await run(["--peer"]);
      expect(r.code).toBe(0);
      expect(r.stdout.match(/already done/g)).toHaveLength(5);
      expect(m.questions).toEqual([]);
      expect(m.execCalls.slice(calls).every(READ_ONLY)).toBe(true);
    });

    it("--check reports the peer steps only", async () => {
      const r = await run(["--peer", "--check"]);
      expect(r.stdout).not.toMatch(HUB_ONLY);
      expect(m.loaded.size).toBe(0);
    });

    it("--check on a paired machine prints the reach rows under its Network row", async () => {
      mkdirSync(join(m.ctx.home, ".volley"), { recursive: true });
      writeFileSync(
        peerJson(),
        JSON.stringify({
          name: "box-a",
          host: "me@hub",
          username: "peer-box-a",
          password: "pw",
          remote_port: 21883,
          broker: {},
        }),
      );
      const asked: string[] = [];
      m.deps.reach = {
        internetUp: async () => {
          asked.push("internet");
          return true;
        },
        tunnelUp: async (port) => {
          asked.push(`tunnel:${port}`);
          return false;
        },
        daemonLive: async () => {
          asked.push("daemon");
          return true;
        },
      };
      try {
        const r = await run(["--peer", "--check"]);
        const lines = r.stdout.split("\n");
        const at = lines.findIndex((l) => /^ {2}\S Network\b/.test(l));
        expect(at).toBeGreaterThan(-1);
        const after = lines.slice(at + 1).join("\n");
        expect(after).toContain("      ✓ network.internet: online");
        expect(after).toContain("      ! tunnel.up: 127.0.0.1:21883 refuses");
        expect(after).toContain("        fix: `volley peer doctor`");
        expect(after).toContain("      ! supervisor.live: not reached (see above)");
        expect(asked).toEqual(["internet", "tunnel:21883"]);
        // --json carries exactly the steps (no reach rows).
        const j = await run(["--peer", "--check", "--json"]);
        expect(j.stdout).not.toContain("tunnel.up");
      } finally {
        Reflect.deleteProperty(m.deps, "reach");
      }
    });

    it("refuses the hub's flags and steps", async () => {
      for (const extra of [
        ["--lan"],
        ["--layout", "snap"],
        ["--desk-port", "5200"],
        ["--step", "security"],
        ["--broker-url", "mqtt://127.0.0.1:1883"],
      ]) {
        const r = await run(["--peer", ...extra]);
        expect(r.code, extra.join(" ")).toBe(2);
      }
      expect((await run(["--peer", "--step", "peer-service", "--yes"])).code).toBe(0);
    });
  });

  it("prints its help and refuses unknown flags", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(SETUP_HELP);
    expect((await run(["--frobnicate"])).code).toBe(2);
    expect(existsSync(join(m.ctx.volleydHome, "setup.log"))).toBe(false);
  });
});

describe("the hidden password prompt", () => {
  const type = (...chunks: string[]) => {
    const state: HiddenInput = { value: "", skip: "" };
    let end: ReturnType<typeof hiddenKeys> = null;
    for (const c of chunks) end = end ?? hiddenKeys(state, c);
    return { value: state.value, end };
  };

  it("ends on Enter, edits on Backspace", () => {
    expect(type("hunter", "3\u007f2\r")).toEqual({ value: "hunter2", end: "enter" });
  });

  it("drops arrow and function keys whole, even split across reads", () => {
    expect(type("ab\u001b[A\u001b[1;5Cc\u001bOP", "\u001b", "[", "D", "d\r")).toEqual({
      value: "abcd",
      end: "enter",
    });
  });

  it("Ctrl-C cancels, Ctrl-D gives up", () => {
    expect(type("abc\u0003")).toEqual({ value: "abc", end: "cancel" });
    expect(type("\u0004")).toEqual({ value: "", end: "eof" });
  });
});
