import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realAuthDeps } from "../../src/auth/context";
import { cmd } from "../../src/auth/dynsec";
import { SETUP_HELP, lanAddress, setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import { LAN_QUESTION } from "../../src/setup/broker";
import { readSetupInstall } from "../../src/setup/journal";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { ANONYMOUS_CONFIG, type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  a.includes("--dry-run") ||
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "security" && a[1] === "find-generic-password");

/** What the run's last lines say once every step is in place. */
const COMPLETE = "Setup complete.";

describe("volley setup", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  let probes: string[];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-setup-"));
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
    rmSync(dir, { recursive: true, force: true });
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
    expect(r.stdout).toContain("[1/5] Broker");
    expect(r.stdout).toContain("[2/5] Security");
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
    });
    expect(readSetupInstall(m.ctx.volleydHome)).toEqual(saved);
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

  it("a second run reports every step as already done and changes nothing", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const calls = m.execCalls.length;
    const clients = fake.clients();
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout.match(/already done/g)).toHaveLength(5);
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
    expect(r.stdout.match(/already done/g)).toHaveLength(4);
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
    m.answers = [true, true, true, true, true];
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(m.questions).toEqual([
      LAN_QUESTION,
      "Apply these 3 changes (Security)?",
      "Apply these 3 changes (Accounts)?",
      "Apply these 5 changes (Services)?",
      "Apply this change (Phone)?",
    ]);
  });

  it("stops at a blocked step, naming why", async () => {
    m.auth.binaryVersion = "mosquitto version 2.0.22";
    const r = await run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("BROKER_TOO_OLD");
    expect(r.stdout).not.toContain("[2/5]");
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
    expect(r.stdout).not.toContain("[3/5]");
  });

  it("--step runs only the steps it names", async () => {
    const r = await run(["--step", "services", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[4/5] Services");
    expect(r.stdout).not.toContain("[1/5]");
    expect(r.stdout).not.toContain("[5/5]");
    expect(m.loaded.has("systems.volley.desk")).toBe(true);
    expect((await run(["--step", "nope"])).code).toBe(2);
  });

  it("under sudo, skips the user services and still ends with the phone's link", async () => {
    m.auth.invokingUser = () => ({ uid: 501, gid: 20, home: m.ctx.home });
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("– skipped: running as root");
    expect(r.stdout).toContain("Setup finished, except the step skipped above (Services)");
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
