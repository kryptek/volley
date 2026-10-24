import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  // Who listens on the Desk's port.
  a[0] === "lsof" ||
  a[0] === "ss";

/** What the run's last lines say once every step is in place. */
const COMPLETE = "Setup complete.";

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

  it("prints the planned diff and writes nothing before the confirmation", async () => {
    m.answers = [false, false];
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("[1/6] Broker");
    expect(r.stdout).toContain("[2/6] Security");
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
      "terminal",
      "services",
      "services",
      "services",
      "services",
      "services",
      "phone",
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
    expect(journal().slice(-1)[0]).toMatchObject({ step: "phone", event: "skipped" });
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
    expect(again.stdout.match(/already done/g)?.length ?? 0).toBeLessThan(6);
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
    expect(r.stdout.match(/already done/g)).toHaveLength(6);
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
    expect(r.stdout.match(/already done/g)).toHaveLength(5);
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
    m.answers = [true, true, true, true, true, true];
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(m.questions).toEqual([
      LAN_QUESTION,
      "Apply these 3 changes (Security)?",
      "Apply these 3 changes (Accounts)?",
      "Apply this change (Terminal)?",
      "Apply these 5 changes (Services)?",
      "Apply this change (Phone)?",
    ]);
  });

  it("stops at a blocked step, naming why", async () => {
    m.auth.binaryVersion = "mosquitto version 2.0.22";
    const r = await run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("BROKER_TOO_OLD");
    expect(r.stdout).not.toContain("[2/6]");
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
    expect(r.stdout).not.toContain("[3/6]");
  });

  it("--step runs only the steps it names", async () => {
    const r = await run(["--step", "services", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[5/6] Services");
    expect(r.stdout).not.toContain("[1/6]");
    expect(r.stdout).not.toContain("[4/6]");
    expect(r.stdout).not.toContain("[6/6]");
    expect(m.loaded.has("systems.volley.desk")).toBe(true);
    expect((await run(["--step", "nope"])).code).toBe(2);
  });

  it("records the terminal it chose in setup.json and volleyd's config.yaml", async () => {
    mkdirSync(m.ctx.volleydHome, { recursive: true });
    const config = join(m.ctx.volleydHome, "config.yaml");
    writeFileSync(config, "spawn:\n  ceiling: 3\n");
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[4/6] Terminal");
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
    expect(r.stdout).not.toContain("[5/6]");
    expect(journal().slice(-1)[0]).toMatchObject({ step: "terminal", event: "blocked" });
    expect(existsSync(join(m.ctx.volleydHome, "config.yaml"))).toBe(false);
  });

  it("--check shows a row per step, the Terminal's included, and changes nothing", async () => {
    const before = await run(["--check"]);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain("volley setup --check: broker");
    expect(before.stdout).toMatch(
      /^ {2}Terminal {2}→ tmux \(\/usr\/bin\/tmux\); 1 change to make: Record the local terminal in .*config\.yaml \(fleet\.local_terminal: tmux\)$/m,
    );
    expect(before.stdout).toContain("Run `volley setup`");
    expect(m.questions).toEqual([]);
    expect(m.execCalls.every(READ_ONLY)).toBe(true);
    expect(existsSync(join(m.ctx.volleydHome, "setup.log"))).toBe(false);
    expect(existsSync(join(m.ctx.volleydHome, "config.yaml"))).toBe(false);
    expect(existsSync(join(m.ctx.volleydHome, "setup.json"))).toBe(false);

    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const log = readFileSync(join(m.ctx.volleydHome, "setup.log"), "utf-8");
    const after = await run(["--check"]);
    expect(after.stdout).toMatch(/^ {2}Terminal {2}✓ tmux \(\/usr\/bin\/tmux\)$/m);
    expect(after.stdout).toMatch(/^ {2}Services {2}✓ in place$/m);
    expect(after.stdout).toContain("Everything is in place.");
    expect(after.code).toBe(0);
    expect(readFileSync(join(m.ctx.volleydHome, "setup.log"), "utf-8")).toBe(log);

    // tmux gone: the row says what is missing and how to install it.
    m.present.delete("/usr/bin/tmux");
    const missing = await run(["--check", "--step", "terminal"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(
      /^ {2}Terminal {2}✗ missing: cmux or tmux \(brew install tmux\)$/m,
    );
  });

  it("under sudo, skips the user services and still ends with the phone's link", async () => {
    m.auth.invokingUser = () => ({ uid: 501, gid: 20, home: m.ctx.home });
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("– skipped: running as root");
    expect(r.stdout).toContain(
      "Setup finished, except the steps skipped above (Terminal, Services)",
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
