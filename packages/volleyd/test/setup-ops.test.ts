import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAYOUTS, type Layout, generateConfig } from "volley-cli/auth/config";
import { realAuthDeps } from "volley-cli/auth/context";
import { planAccounts } from "volley-cli/setup/accounts";
import { planServicesForDesk as planServices } from "volley-cli/setup/services";
import type { SetupContext } from "volley-cli/setup/step";
import { CMUX_CHECK_SCRIPT } from "volley-cli/setup/terminal";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { Daemon } from "../src/daemon";
import type { ExecFn } from "../src/exec";
import { readJournalFile } from "../src/journal";
import {
  KEYCHAIN_STALE,
  KEYCHAIN_UNCHECKED,
  SetupOps,
  type SetupOpsOptions,
  TERMINAL_ONLY_PREFIXES,
  terminalOnly,
} from "../src/setup-ops";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { NO_PRESSURE } from "./helpers/daemon-env";
import { type FakeDynsec, startFakeDynsec } from "./helpers/fake-dynsec";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const NS = "setup-ops-test";
const pw = (u: string) => `${u}-pw`;
const BUN = "/opt/bun/bin/bun";
// The planners' broker: nothing listens there (connectAdmin goes to the fake Dynamic Security,
// the probes are faked), so a planner path that ever opened a real client could not reach a live
// broker by accident.
const BROKER = "mqtt://127.0.0.1:1";
const BROKER_PORT = Number(new URL(BROKER).port);
const HOOKED = `${JSON.stringify({ hooks: { SessionStart: [] } }, null, 2)}\n`;
const RESTART_ARGV = ["brew", "services", "restart", "mosquitto"];

type Reply = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  result?: Record<string, unknown>;
  sealed?: string;
};
interface WireStep {
  step: string;
  title: string;
  found: string[];
  notes?: string[];
  changes: { summary: string; detail?: string; terminal?: { reason: string; command: string } }[];
  blocked?: string;
  skipped?: string;
  plan_id: string;
  lan?: { planned: boolean; current: boolean | null };
}

/**
 * The machine `volley setup` runs on, faked: temp dirs for the broker config, the auth dir, home
 * and the checkout; the in-process Dynamic Security stand-in the planners log in to; and an exec
 * answering the commands the steps run (`volley auth`, the broker restart, launchctl, the hooks
 * installer, the Desk build). Every argv still passes volleyd's real fence (fakeExec).
 */
interface Machine {
  dir: string;
  layout: Layout;
  home: string;
  repo: string;
  volleydHome: string;
  fake: FakeExec;
  exec: ExecFn;
  anonymous: { tcp: "refused" | "accepted"; ws: "refused" | "accepted" };
  loaded: Set<string>;
  /** Holds the broker restart until released (null: no hold). */
  restartGate: Promise<void> | null;
  /** Holds the Desk build until released (null: no hold). */
  buildGate: Promise<void> | null;
  restarts: number;
}

function machine(root: string, layoutName: "brew-arm64" | "etc" | "snap" = "brew-arm64"): Machine {
  const layout: Layout = {
    ...LAYOUTS[layoutName],
    config: join(root, "mosquitto.conf"),
    authDir: join(root, "auth"),
    stateFile: join(root, "dynamic-security.json"),
  };
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "packages", "volley-desk"), { recursive: true });
  const m = {
    dir: root,
    layout,
    home,
    repo,
    volleydHome: join(root, "volleyd"),
    anonymous: { tcp: "refused", ws: "refused" },
    loaded: new Set<string>(),
    restartGate: null,
    buildGate: null,
    restarts: 0,
  } as Machine;
  const hooks = join(repo, "packages", "volley-hooks", "scripts", "install.sh");
  const settings = join(home, ".claude", "settings.json");
  m.fake = fakeExec()
    .on(["volley", "auth"], (argv) => {
      if (argv[2] !== "list") return { code: 1, stderr: `unexpected ${argv.join(" ")}` };
      const accounts = [
        ["admin-1", "admin"],
        ["steer-1", "steer"],
      ].map(([name, role]) => ({ name, role, kind: "device", created: "2026-10-18T12:00:00Z" }));
      return { stdout: `${JSON.stringify({ accounts })}\n` };
    })
    .on(["mosquitto", "-h"], () => ({ stdout: "mosquitto version 2.1.2\n" }))
    .on(RESTART_ARGV, () => {
      m.restarts++;
      m.anonymous = { tcp: "refused", ws: "refused" };
      return {};
    })
    .on([BUN, join(repo, "packages", "volleyd", "src", "cli.ts"), "install"], () => ({
      stdout: `# ${join(home, "Library", "LaunchAgents", "systems.volley.volleyd.plist")}\n<plist>volleyd</plist>\n`,
    }))
    .on(["launchctl"], (argv) => {
      const label = (argv[2] ?? "").split("/").pop() ?? "";
      if (argv[1] === "print") return m.loaded.has(label) ? {} : { code: 113 };
      if (argv[1] === "bootout") m.loaded.delete(label);
      if (argv[1] === "bootstrap") m.loaded.add(basename(argv[3] ?? "", ".plist"));
      return {};
    })
    .on(["bash", hooks], (argv) => {
      if (argv[2] === "--dry-run") return { stdout: HOOKED };
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(settings, HOOKED);
      return { stdout: `installed volley-hooks into ${settings}\n` };
    })
    // Nothing is active under systemd until a step starts it.
    .on(["systemctl", "--user", "is-active"], () => ({ code: 3 }))
    .on([BUN, "run", "build"], (_argv, opts) => {
      mkdirSync(join(opts.cwd as string, "dist"), { recursive: true });
      writeFileSync(join(opts.cwd as string, "dist", "index.html"), "<!doctype html>");
      return {};
    });
  m.exec = async (argv, opts) => {
    if (argv.join(" ") === RESTART_ARGV.join(" ") && m.restartGate !== null) await m.restartGate;
    if (argv.join(" ") === `${BUN} run build` && m.buildGate !== null) await m.buildGate;
    return m.fake.exec(argv, opts);
  };
  return m;
}

/** After the terminal's first run (detect + security): Volley's config, the admin login. */
function secured(m: Machine, fake: FakeDynsec, lan = false) {
  const local = generateConfig({ ...m.layout });
  writeFileSync(m.layout.config, lan ? generateConfig({ ...m.layout, wsBind: "" }) : local);
  mkdirSync(m.layout.authDir, { recursive: true });
  writeFileSync(join(m.layout.authDir, "admin.json"), JSON.stringify(fake.admin), { mode: 0o600 });
  writeFileSync(m.layout.stateFile, "{}\n");
}

describe("setup ops: volleyd runs `volley setup`'s planners and steps for the Desk", () => {
  let broker: TestBroker;
  let fake: FakeDynsec;
  let root: string;
  let m: Machine;
  let daemon: Daemon | undefined;
  const clients: VolleyBroker[] = [];
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const replyKey = keys.publicKey.export({ format: "jwk" });
  const unseal = (sealed: unknown) =>
    JSON.parse(
      privateDecrypt(
        { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(sealed as string, "base64url"),
      ).toString("utf-8"),
    ) as Record<string, unknown>;

  let platform: NodeJS.Platform = "darwin";
  /** Paths outside the test's root that exist (the cmux app): never the real machine's. */
  let present: Set<string>;
  const setupOptions = (): Partial<SetupOpsOptions> => ({
    brokerUrl: BROKER,
    authDir: m.layout.authDir,
    env: { HOME: m.home, PATH: "/usr/bin:/bin" },
    deskPort: 5199,
    liveAgents: async () => 2,
    brokerVersion: () => null,
    sleep: async () => {},
    deps: {
      platform,
      uid: 501,
      lanHost: () => "desk.example",
      repoRoot: m.repo,
      bun: BUN,
      exists: (p) => (p.startsWith(`${root}/`) ? existsSync(p) : present.has(p)),
      probeAnonymous: async (url) =>
        url.startsWith("ws:")
          ? url.includes("desk.example")
            ? "unreachable"
            : m.anonymous.ws
          : m.anonymous.tcp,
      auth: {
        layout: () => m.layout,
        connectAdmin: (_url, creds) => realAuthDeps.connectAdmin(fake.url, creds),
        invokingUser: () => null,
        brokerOwner: () => null,
        chown: () => {},
      },
    },
  });
  const start = async () => {
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home: m.volleydHome,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      auth: { username: "volleyd", password: pw("volleyd") },
      authExec: m.exec,
      setup: setupOptions(),
    });
  };

  beforeEach(async () => {
    broker = await startTestBroker({
      users: Object.fromEntries(["volleyd", "admin-1", "steer-1"].map((u) => [u, pw(u)])),
    });
    fake = await startFakeDynsec({ version: "2.1.2" });
    platform = "darwin";
    present = new Set();
    root = tempDir("volleyd-setup-ops-");
    m = machine(root);
    secured(m, fake);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
    await daemon?.stop();
    daemon = undefined;
    await fake.close();
    await broker.close();
  });

  /** The setup ops as the daemon builds them, without the daemon (no MQTT in between). */
  const direct = () =>
    new SetupOps({
      exec: m.exec,
      volleydHome: m.volleydHome,
      brokerUrl: BROKER,
      env: {},
      now: () => new Date(),
      sleep: async () => {},
      liveAgents: async () => 2,
      brokerVersion: () => null,
      ...setupOptions(),
    });

  /** One account op from `user`; resolves with volleyd's answer (null on timeout). */
  async function op(user: string, payload: Record<string, unknown>, timeoutMs = 15_000) {
    const c = new VolleyBroker();
    const cid = randomUUID();
    await c.connect({
      url: broker.url,
      agentId: `desk-${cid.slice(0, 6)}`,
      username: user,
      password: pw(user),
    });
    clients.push(c);
    let resolve!: (r: Reply | null) => void;
    const reply = new Promise<Reply | null>((r) => {
      resolve = r;
    });
    // Subscribed (SUBACKed) before the request goes out, so a fast answer is not missed.
    await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const env = parseEnvelope(raw);
      if (env?.type === "ack" && env.correlation_id === cid) resolve(env.payload as Reply);
    });
    const env = buildEnvelope({
      agentId: user,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload,
    });
    await c.publish(authOpsTopic(user), JSON.stringify(env), { qos: 1, retain: false });
    // broker round-trip: volleyd answers over MQTT; a request it never answers ends as null.
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const r = await reply;
    clearTimeout(timer);
    return r;
  }
  const plan = async (fields: Record<string, unknown> = {}) => {
    const r = await op("admin-1", { op: "setup_plan", reply_key: replyKey, ...fields });
    expect(r?.ok, r?.error).toBe(true);
    return r?.result as { steps: WireStep[]; last_setup?: string; broker?: unknown };
  };
  const step = (steps: WireStep[], name: string) => steps.find((s) => s.step === name) as WireStep;
  /**
   * cmux installed and answering the service-like check with `said` (exit `code`). volleyd's own
   * fence refuses that check; this stands in for a volleyd that could run it, so the planners
   * offer their cmux changes.
   */
  const cmuxSays = (code: number, said: string) => {
    const bin = "/Applications/cmux.app/Contents/Resources/bin";
    present.add(bin);
    present.add(`${bin}/cmux`);
    const inner = m.exec;
    m.exec = async (argv, opts) => {
      if (argv[0] === "sh" && argv[2] === CMUX_CHECK_SCRIPT) {
        // `cmux capabilities --json` and `cmux list-workspaces` both answer `said`.
        writeFileSync(
          argv[4] as string,
          `${said}\nvolley-cmux-caps=${code}\n${said}\nvolley-cmux-exit=${code}\n`,
        );
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      return inner(argv, opts);
    };
  };
  const apply = (name: string, planId: string, fields: Record<string, unknown> = {}) =>
    op("admin-1", {
      op: "setup_apply",
      step: name,
      plan_id: planId,
      reply_key: replyKey,
      ...fields,
    });
  const setupLog = () =>
    existsSync(join(m.volleydHome, "setup.log"))
      ? readFileSync(join(m.volleydHome, "setup.log"), "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, string>)
      : [];
  const systemEvents = () =>
    readJournalFile(join(m.volleydHome, "waves", "_system", "journal.jsonl"));
  /** The restart runs after the answer: poll for its effects, bounded. */
  const until = (ok: () => boolean, deadlineMs?: number) =>
    eventually(ok, { ...(deadlineMs !== undefined ? { deadlineMs } : {}), what: "the restart" });

  it("setup_plan from an admin answers the five steps in order, as `volley setup` plans them", async () => {
    mkdirSync(m.volleydHome, { recursive: true });
    writeFileSync(
      join(m.volleydHome, "setup.log"),
      `${JSON.stringify({ at: "2026-10-18T09:00:00.000Z", step: "security", event: "verified" })}\n`,
    );
    await start();
    const r = await plan();
    expect(schemaErrors("setup-result.schema.json#/$defs/plan", r)).toEqual([]);
    expect(r.steps.map((s) => s.step)).toEqual([
      "detect",
      "security",
      "accounts",
      "services",
      "phone",
    ]);
    expect(r.last_setup).toBe("2026-10-18T09:00:00.000Z");
    expect(r.broker).toEqual({
      accounts_required: true,
      listeners: [
        { port: BROKER_PORT, anonymous: "refused" },
        { port: 9001, anonymous: "refused" },
      ],
    });
    const detect = step(r.steps, "detect");
    expect(detect.found.join("\n")).toContain("mosquitto 2.1.2");
    const security = step(r.steps, "security");
    expect(security.changes).toEqual([]);
    expect(security.lan).toEqual({ planned: false, current: false });
    // Accounts: what O3 plans; only the keychain copy is a terminal's.
    const accounts = step(r.steps, "accounts");
    expect(accounts.changes.map((c) => [c.summary, c.terminal?.command])).toEqual([
      [
        "Create Volley's 8 shared roles and the identities volleyd, desk, coordinator (desk's password is not shown here: Setup & Security › New desk password issues one, shown once)",
        undefined,
      ],
      [
        "Store the coordinator's broker login in the macOS keychain (service volley-broker)",
        "volley setup --step accounts",
      ],
      [
        "Issue a one-time admin token (10 minutes, single use) to sign in to the Desk as admin",
        undefined,
      ],
    ]);
    expect(accounts.changes[1]?.terminal?.reason).toContain("keychain");
    // Services: volleyd's own service is a terminal's; the hooks and the Desk are not.
    const services = step(r.steps, "services");
    expect(services.changes.map((c) => [c.summary, c.terminal?.command])).toEqual([
      [
        `Install the volley and volleyd commands in ${join(m.home, ".volley", "bin")} (volleyd runs \`volley auth\` to redeem the Desk's sign-in links)`,
        undefined,
      ],
      ["Install volleyd as a launchd service (volleyd install)", "volley setup --step services"],
      [
        `Install the Volley hooks for coordinator sessions into ${join(m.home, ".claude", "settings.json")}`,
        undefined,
      ],
      ["Build the Desk (vite build in packages/volley-desk)", undefined],
      ["Install `volley desk serve` as a launchd service on 0.0.0.0:5199", undefined],
    ]);
    expect(step(r.steps, "phone").skipped).toContain(
      "cannot reach the broker's WebSocket listener",
    );
    for (const s of r.steps) expect(s.plan_id).toMatch(new RegExp(`^${s.step}-[0-9a-f]{16}$`));
    // What the planners themselves plan on the same machine, never rewritten on the way out.
    const ctx = direct().context({}) as SetupContext;
    for (const [name, planner] of [
      ["accounts", planAccounts],
      ["services", planServices],
    ] as const) {
      const own = await planner(ctx);
      expect(step(r.steps, name).changes.map((c) => c.summary)).toEqual(
        own.changes.map((c) => c.summary),
      );
      expect(step(r.steps, name).found).toEqual(own.found.filter((f) => f !== ""));
    }
    expect(
      accounts.changes.some(
        (c) =>
          c.summary.includes("shown once)") &&
          !c.summary.includes("desk's password is not shown here"),
      ),
    ).toBe(false);
    // Planning changed nothing and read no keychain.
    expect(m.fake.argvs(["security"])).toEqual([]);
    expect([...fake.clients().keys()]).toEqual([fake.admin.username]);
    expect(setupLog()).toHaveLength(1);
  });

  it("setup_plan and setup_apply from a steer sender are refused", async () => {
    await start();
    const r = await op("steer-1", { op: "setup_plan", reply_key: replyKey });
    expect(r).toMatchObject({ ok: false, op: "setup_plan" });
    expect(r?.error).toMatch(/steer-1.*steer.*admin/);
    const a = await op("steer-1", {
      op: "setup_apply",
      step: "accounts",
      plan_id: "accounts-0",
      reply_key: replyKey,
    });
    expect(a).toMatchObject({ ok: false, op: "setup_apply" });
    expect(a?.error).toMatch(/admin/);
  });

  it("setup_apply accounts applies the step, seals the admin token, journals, and leaves the keychain to a terminal", async () => {
    await start();
    const accounts = step((await plan()).steps, "accounts");
    const r = await apply("accounts", accounts.plan_id);
    expect(r?.ok, r?.error).toBe(true);
    expect(schemaErrors("setup-result.schema.json#/$defs/applied", r?.result)).toEqual([]);
    const result = r?.result as {
      lines: string[];
      problems: string[];
      terminal: { summary: string; reason: string; command: string }[];
    };
    // The token: sealed to this browser only.
    const { token } = unseal(r?.sealed);
    expect(token).toMatch(/^vly_admin_[0-9a-f]{8}_[0-9a-f]{32}$/);
    const id = (token as string).split("_")[2];
    expect(result.lines).toContain(
      `Issued a one-time admin token (${id}, until ${
        JSON.parse(readFileSync(join(m.layout.authDir, "tokens.json"), "utf-8")).tokens[0]
          .expires_at
      }).`,
    );
    // The identities exist, with their credential files; the Desk never sees a password.
    for (const u of ["volleyd", "desk", "coordinator"]) expect(fake.clients().has(u)).toBe(true);
    expect(existsSync(join(m.layout.authDir, "coordinator.json"))).toBe(true);
    const coordinator = JSON.parse(
      readFileSync(join(m.layout.authDir, "coordinator.json"), "utf-8"),
    );
    expect(JSON.stringify(r)).not.toContain(coordinator.password);
    expect(result.lines.join("\n")).toContain(
      "The new login desk got a password the Desk does not show (no file keeps it): Setup & Security › New desk password issues one, shown once",
    );
    // The keychain copy: listed for a terminal, never run.
    expect(result.terminal).toEqual([
      {
        summary:
          "Store the coordinator's broker login in the macOS keychain (service volley-broker)",
        reason: expect.stringContaining("keychain"),
        command: "volley setup --step accounts",
      },
    ]);
    expect(m.fake.argvs(["security"])).toEqual([]);
    expect(result.problems).toEqual([]);
    // setup.log: the terminal's lines, plus who ran them; never a secret.
    expect(setupLog().map((e) => [e.step, e.event, e.by])).toEqual([
      ["accounts", "planned", "desk:admin-1"],
      ["accounts", "applied", "desk:admin-1"],
      ["accounts", "applied", "desk:admin-1"],
      ["accounts", "left", "desk:admin-1"],
    ]);
    expect(setupLog()[3]?.summary).toBe(
      "Store the coordinator's broker login in the macOS keychain (service volley-broker)",
    );
    expect(setupLog()[0]?.summary).toBe(accounts.changes.map((c) => c.summary).join("; "));
    const ev = systemEvents().find((e) => e.type === "setup_step_applied");
    expect(ev?.data).toEqual({
      by: "admin-1",
      step: "accounts",
      summaries: [accounts.changes[0]?.summary, accounts.changes[2]?.summary],
    });
    for (const text of [
      readFileSync(join(m.volleydHome, "setup.log"), "utf-8"),
      JSON.stringify(systemEvents()),
      JSON.stringify(result),
    ]) {
      expect(text).not.toContain(token as string);
      expect(text).not.toContain(coordinator.password);
    }
    // The plan after it: the Desk wrote the coordinator a password no terminal has stored in the
    // keychain since, so the copy there is stale. The plan says so, with the command.
    const again = step((await plan()).steps, "accounts");
    expect(schemaErrors("setup-result.schema.json#/$defs/step", again)).toEqual([]);
    expect(again.changes.map((c) => c.terminal?.command)).toEqual(["volley setup --step accounts"]);
    expect(again.notes).toEqual([KEYCHAIN_STALE]);
    expect(again.found).not.toContain(KEYCHAIN_STALE);
    expect(m.fake.argvs(["security"])).toEqual([]);
    expect(existsSync(join(m.volleydHome, "broker.json"))).toBe(true);
    expect(existsSync(join(m.volleydHome, "dynsec-admin.json"))).toBe(true);
    // With the coordinator's login on file, the detect step counts the running agents.
    expect(step((await plan()).steps, "detect").found).toContain("2 agents running on the broker");
  });

  it("a keychain copy volleyd cannot check is a note, in its own field; one the Desk made stale says so; Linux has none", async () => {
    const ops = direct();
    const planAccountsStep = async () => {
      const r = await ops.handle("admin-1", { op: "setup_plan" });
      expect(r.reply.ok, r.reply.error).toBe(true);
      const s = step((r.reply.result as { steps: WireStep[] }).steps, "accounts");
      expect(schemaErrors("setup-result.schema.json#/$defs/step", s)).toEqual([]);
      return s;
    };
    const keychainChange = (s: WireStep) =>
      s.changes.find((c) =>
        c.summary.startsWith("Store the coordinator's broker login in the macOS keychain"),
      );
    // A fresh coordinator login is new: its keychain copy is a terminal's change, not unknown.
    const fresh = await planAccountsStep();
    expect(keychainChange(fresh)?.terminal?.command).toBe("volley setup --step accounts");
    expect(fresh.notes).toBeUndefined();
    const applied = await ops.handle("admin-1", {
      op: "setup_apply",
      step: "accounts",
      plan_id: fresh.plan_id,
      reply_key: replyKey,
    });
    expect(applied.reply.ok, applied.reply.error).toBe(true);
    // The Desk made the login, so the keychain cannot hold its password: stale, for a terminal.
    const stale = await planAccountsStep();
    expect(keychainChange(stale)?.terminal?.command).toBe("volley setup --step accounts");
    expect(stale.notes).toEqual([KEYCHAIN_STALE]);
    expect(KEYCHAIN_STALE).toContain("`volley setup --step accounts`");
    // The terminal's run of the accounts step stores it (setup.log: its line has no `by`).
    const log = join(m.volleydHome, "setup.log");
    writeFileSync(
      log,
      `${readFileSync(log, "utf-8")}${JSON.stringify({ at: new Date().toISOString(), step: "accounts", event: "verified" })}\n`,
    );
    // From then on volleyd cannot tell: neither pending nor done, a note in `notes`, never in
    // `found` (display text the Desk never parses).
    const after = await planAccountsStep();
    expect(after.changes).toEqual([]);
    expect(after.notes).toEqual([KEYCHAIN_UNCHECKED]);
    expect(after.found).not.toContain(KEYCHAIN_UNCHECKED);
    // The Desk rotates the coordinator's password (its file is gone): stale again.
    rmSync(join(m.layout.authDir, "coordinator.json"));
    const rotate = await planAccountsStep();
    expect(rotate.changes.map((c) => c.summary)).toEqual([
      expect.stringMatching(/^New password for coordinator, /),
      expect.stringMatching(/^Store the coordinator's broker login in the macOS keychain/),
    ]);
    const rotated = await ops.handle("admin-1", {
      op: "setup_apply",
      step: "accounts",
      plan_id: rotate.plan_id,
      reply_key: replyKey,
    });
    expect(rotated.reply.ok, rotated.reply.error).toBe(true);
    const staleAgain = await planAccountsStep();
    expect(staleAgain.notes).toEqual([KEYCHAIN_STALE]);
    expect(keychainChange(staleAgain)?.terminal).toBeDefined();
    platform = "linux";
    const linux = await direct().handle("admin-1", { op: "setup_plan" });
    const onLinux = step((linux.reply.result as { steps: WireStep[] }).steps, "accounts");
    expect(onLinux.notes).toBeUndefined();
    expect(onLinux.found.join("\n")).toContain("no OS keychain here");
    expect(m.fake.argvs(["security"])).toEqual([]);
  });

  it("setup_apply without a usable reply_key is refused before anything runs", async () => {
    await start();
    const accounts = step((await plan()).steps, "accounts");
    const r = await op("admin-1", {
      op: "setup_apply",
      step: "accounts",
      plan_id: accounts.plan_id,
    });
    expect(r).toMatchObject({ ok: false, op: "setup_apply" });
    expect(r?.error).toContain("reply_key");
    expect([...fake.clients().keys()]).toEqual([fake.admin.username]);
    expect(existsSync(join(m.layout.authDir, "tokens.json"))).toBe(false);
    expect(setupLog()).toEqual([]);
  });

  it("setup_apply refuses a plan the machine changed under since it was shown", async () => {
    await start();
    expect((await apply("accounts", step((await plan()).steps, "accounts").plan_id))?.ok).toBe(
      true,
    );
    const shown = step((await plan()).steps, "accounts");
    // The machine changes between the plan shown and its apply: the coordinator's file is gone.
    const file = join(m.layout.authDir, "coordinator.json");
    const before = fake.clients().get("coordinator")?.password;
    rmSync(file);
    const log = setupLog().length;
    const r = await apply("accounts", shown.plan_id);
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toMatch(/^plan changed\b/);
    expect(fake.clients().get("coordinator")?.password).toBe(before);
    expect(existsSync(file)).toBe(false);
    expect(setupLog()).toHaveLength(log);
  });

  it("desk_password gives the desk login a new password, sealed to the admin who asked", async () => {
    await start();
    expect((await apply("accounts", step((await plan()).steps, "accounts").plan_id))?.ok).toBe(
      true,
    );
    const before = fake.clients().get("desk")?.password;
    const r = await op("admin-1", { op: "desk_password", reply_key: replyKey });
    expect(r?.ok, r?.error).toBe(true);
    expect(r?.result).toEqual({ username: "desk" });
    const { username, password } = unseal(r?.sealed);
    expect(username).toBe("desk");
    expect(password).not.toBe(before);
    expect(fake.clients().get("desk")?.password).toBe(password);
    expect(JSON.stringify(r)).not.toContain(password as string);
    const ev = systemEvents().find((e) => e.type === "desk_password_issued");
    expect(ev?.data).toEqual({ by: "admin-1" });
    expect(JSON.stringify(systemEvents())).not.toContain(password as string);
    // The plan after it is unchanged: the login exists, no file is expected to keep it.
    expect(step((await plan()).steps, "accounts").changes.filter((c) => !c.terminal)).toEqual([]);
  });

  it("desk_password is refused from a steer sender, without a reply_key, and before the login exists", async () => {
    await start();
    const steer = await op("steer-1", { op: "desk_password", reply_key: replyKey });
    expect(steer).toMatchObject({ ok: false, op: "desk_password" });
    expect(steer?.error).toMatch(/admin/);
    const noKey = await op("admin-1", { op: "desk_password" });
    expect(noKey).toMatchObject({ ok: false });
    expect(noKey?.error).toContain("reply_key");
    const missing = await op("admin-1", { op: "desk_password", reply_key: replyKey });
    expect(missing).toMatchObject({ ok: false });
    expect(missing?.error).toMatch(/no desk login .*accounts step/);
    expect(fake.clients().has("desk")).toBe(false);
    expect(systemEvents().some((e) => e.type === "desk_password_issued")).toBe(false);
  });

  it("services: the hooks and the Desk are applied, volleyd's own service never is", async () => {
    await start();
    const services = step((await plan()).steps, "services");
    const r = await apply("services", services.plan_id);
    expect(r?.ok, r?.error).toBe(true);
    const result = r?.result as {
      terminal: { summary: string; command: string }[];
      problems: string[];
    };
    expect(result.terminal.map((t) => [t.summary, t.command])).toEqual([
      ["Install volleyd as a launchd service (volleyd install)", "volley setup --step services"],
    ]);
    // Only volleyd's dry run (the plan's probe) ran; its install and its launchctl never did.
    const volleydCli = join(m.repo, "packages", "volleyd", "src", "cli.ts");
    expect(m.fake.argvs([BUN, volleydCli]).every((a) => a.includes("--dry-run"))).toBe(true);
    expect(
      m.fake
        .argvs(["launchctl"])
        .filter((a) => a[1] !== "print")
        .map((a) => a.join(" ")),
    ).toEqual([
      // Not loaded yet: nothing to boot out.
      `launchctl bootstrap gui/501 ${join(m.home, "Library", "LaunchAgents", "systems.volley.desk.plist")}`,
    ]);
    expect(existsSync(join(m.home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(m.repo, "packages", "volley-desk", "dist", "index.html"))).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("services: cmux's socket password is a terminal's, with the command, and never fails on Apply", async () => {
    cmuxSays(1, "ERROR: Invalid password");
    await start();
    const services = step((await plan()).steps, "services");
    const cmux = services.changes.find((c) =>
      c.summary.startsWith("Give volleyd the cmux socket password"),
    );
    expect(cmux?.terminal).toEqual({
      reason: expect.stringContaining("hidden prompt"),
      command: "volley setup --step terminal",
    });
    expect(services.found.join("\n")).toContain("(cmux said: ERROR: Invalid password)");
    const r = await apply("services", services.plan_id);
    expect(r?.ok, r?.error).toBe(true);
    const result = r?.result as { terminal: { summary: string; command: string }[] };
    expect(result.terminal.map((t) => t.summary)).toContain(cmux?.summary);
    // cmux not answering: the change that checks again is a terminal's too.
    expect(
      terminalOnly(
        "services",
        "Make volleyd's service reach cmux (cmux's socket is not answering): checked again when applied",
        { auth: { layout: LAYOUTS["brew-arm64"] } } as unknown as SetupContext,
      )?.command,
    ).toBe("volley setup --step terminal");
  });

  it("services: the Desk shows cmux's socket mode, and its Services run records it in setup.json", async () => {
    // An earlier terminal run recorded Automation mode; cmux has since been put in Password mode.
    mkdirSync(m.volleydHome, { recursive: true });
    const file = join(m.volleydHome, "setup.json");
    writeFileSync(
      file,
      JSON.stringify({
        layout: "brew-arm64",
        config: m.layout.config,
        state_file: m.layout.stateFile,
        auth_dir: m.layout.authDir,
        cmux_socket_mode: "automation",
      }),
    );
    cmuxSays(1, "ERROR: Invalid password");
    await start();
    const services = step((await plan()).steps, "services");
    expect(services.found.join("\n")).toContain("(cmux's socket control mode: Password mode)");
    // Planning changes nothing on the machine.
    expect(JSON.parse(readFileSync(file, "utf-8")).cmux_socket_mode).toBe("automation");
    const r = await apply("services", services.plan_id);
    expect(r?.ok, r?.error).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).cmux_socket_mode).toBe("password");
  });

  it("services: cmux in Automation mode shows as such in the Desk's found lines", async () => {
    cmuxSays(0, '{"access_mode":"automation"}');
    await start();
    const services = step((await plan()).steps, "services");
    expect(services.found.join("\n")).toContain("(cmux's socket control mode: Automation mode)");
  });

  it("a sudo layout's security changes are listed for a terminal, with the command, and never run", async () => {
    m = machine(root, "etc");
    writeFileSync(m.layout.config, "listener 1883\nallow_anonymous true\n");
    m.anonymous = { tcp: "accepted", ws: "accepted" };
    mkdirSync(m.layout.authDir, { recursive: true });
    writeFileSync(join(m.layout.authDir, "admin.json"), JSON.stringify(fake.admin));
    writeFileSync(m.layout.stateFile, "{}\n");
    await start();
    const security = step((await plan({ lan: true })).steps, "security");
    expect(security.lan).toEqual({ planned: true, current: null });
    expect(security.changes.length).toBeGreaterThan(0);
    for (const c of security.changes) {
      expect(c.terminal?.command).toBe("sudo volley setup --step security --lan");
      expect(c.terminal?.reason).toContain("sudo");
    }
    const r = await apply("security", security.plan_id, { lan: true });
    expect(r?.ok, r?.error).toBe(true);
    const result = r?.result as { terminal: unknown[]; lines: string[]; restarting?: boolean };
    expect(result.terminal).toHaveLength(security.changes.length);
    expect(result.restarting).toBeUndefined();
    expect(readFileSync(m.layout.config, "utf-8")).toBe("listener 1883\nallow_anonymous true\n");
    expect(m.fake.argvs(["sudo"])).toEqual([]);
    expect(m.fake.calls.some((c) => c.argv.includes("restart"))).toBe(false);
    expect(systemEvents().some((e) => e.type === "setup_step_applied")).toBe(false);
    // Nothing was applied: setup.log (and so last_setup) has nothing to say.
    expect(setupLog()).toEqual([]);
  });

  it("a brew security apply answers with restarting: true, then restarts; another apply meanwhile is refused", async () => {
    writeFileSync(m.layout.config, "listener 1883\nallow_anonymous true\n");
    m.anonymous = { tcp: "accepted", ws: "accepted" };
    let release = () => {};
    m.restartGate = new Promise<void>((r) => {
      release = r;
    });
    await start();
    const security = step((await plan({ lan: false })).steps, "security");
    expect(security.changes.map((c) => c.summary.split(" (")[0])).toEqual([
      `Write ${m.layout.config}`,
      "Restart the broker",
    ]);
    expect(security.changes.every((c) => c.terminal === undefined)).toBe(true);
    // The answer arrives while the restart is held: it was published first.
    const r = await apply("security", security.plan_id, { lan: false });
    expect(r?.ok, r?.error).toBe(true);
    const result = r?.result as { lines: string[]; restarting?: boolean };
    expect(result.restarting).toBe(true);
    expect(result.lines).toContain(
      "The broker restarts after this answer (brew services restart mosquitto); the Desk reconnects on its own.",
    );
    // The Desk runs `volley setup`'s steps: the header names it.
    expect(readFileSync(m.layout.config, "utf-8")).toBe(
      generateConfig({ ...m.layout, by: "volley setup" }),
    );
    expect(readdirSync(root).some((f) => f.startsWith("mosquitto.conf.volley-backup-"))).toBe(true);
    // One at a time: the step is still running until its restart is done.
    const second = await apply("accounts", "accounts-0");
    expect(second).toMatchObject({ ok: false });
    expect(second?.error).toContain("another setup_apply is still running");
    expect(m.restarts).toBe(0);
    release();
    await until(() => setupLog().some((e) => e.event === "verified"));
    expect(m.restarts).toBe(1);
    expect(setupLog().map((e) => e.event)).toEqual(["planned", "applied", "applied", "verified"]);
    expect(setupLog()[2]?.summary).toBe("Restart the broker (brew services restart mosquitto)");
    const ev = systemEvents().find((e) => e.type === "setup_step_applied");
    expect(ev?.data.summaries).toEqual(security.changes.map((c) => c.summary));
  });

  it("setup_apply phone is refused with a pointer at signin_link", async () => {
    await start();
    const r = await apply("phone", "phone-0");
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toContain("signin_link");
    expect(r?.error).toContain("Desk on phone");
  });

  it("a blocked earlier step refuses the later one, before anything runs", async () => {
    rmSync(join(m.layout.authDir, "admin.json"));
    await start();
    const steps = (await plan()).steps;
    expect(step(steps, "security").blocked).toMatch(/exists but .*admin\.json does not/);
    const r = await apply("services", step(steps, "services").plan_id);
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toMatch(/^Security is blocked/);
    expect(m.fake.argvs(["bash"]).every((a) => a.includes("--dry-run"))).toBe(true);
    expect(setupLog()).toEqual([]);
  });

  it("snap on Linux: volleyd's own systemd service is a terminal's, the Desk's is applied", async () => {
    platform = "linux";
    m = machine(root, "snap");
    secured(m, fake);
    await start();
    const services = step((await plan()).steps, "services");
    expect(services.changes.map((c) => [c.summary, c.terminal?.command])).toEqual([
      [
        `Install the volley and volleyd commands in ${join(m.home, ".volley", "bin")} (volleyd runs \`volley auth\` to redeem the Desk's sign-in links)`,
        undefined,
      ],
      [
        "Install volleyd as a systemd user service (volleyd.service)",
        "volley setup --step services",
      ],
      [
        `Install the Volley hooks for coordinator sessions into ${join(m.home, ".claude", "settings.json")}`,
        undefined,
      ],
      ["Build the Desk (vite build in packages/volley-desk)", undefined],
      [
        "Install `volley desk serve` as a systemd user service (volley-desk.service) on 0.0.0.0:5199",
        undefined,
      ],
    ]);
    const r = await apply("services", services.plan_id);
    expect(r?.ok, r?.error).toBe(true);
    expect(
      (r?.result as { terminal: { summary: string }[] }).terminal.map((t) => t.summary),
    ).toEqual(["Install volleyd as a systemd user service (volleyd.service)"]);
    // Only probes ever touched volleyd.service; the Desk's unit was enabled and started.
    const systemctl = m.fake.argvs(["systemctl"]).map((a) => a.slice(2).join(" "));
    expect(systemctl.filter((a) => a.includes("volleyd.service"))).toEqual(
      systemctl.filter((a) => a === "is-active volleyd.service"),
    );
    expect(systemctl).toContain("enable volley-desk.service");
    expect(systemctl).toContain("restart volley-desk.service");
  });

  it("a command killed at setup_apply_timeout_ms is reported as timed out", async () => {
    m.fake.on([BUN, "run", "build"], () => ({
      code: 143,
      stderr: "vite: building…\n",
      timedOut: true,
    }));
    await start();
    const r = await apply("services", step((await plan()).steps, "services").plan_id);
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toContain("vite: building… (killed after 110 s)");
  });

  it("a re-delivered setup_apply is applied and answered once; queued ops are answered meanwhile", async () => {
    let release = () => {};
    m.buildGate = new Promise<void>((r) => {
      release = r;
    });
    await start();
    const services = step((await plan()).steps, "services");
    const c = new VolleyBroker();
    const cid = randomUUID();
    await c.connect({
      url: broker.url,
      agentId: "desk-redeliver",
      username: "admin-1",
      password: pw("admin-1"),
    });
    clients.push(c);
    const answers: Reply[] = [];
    await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const env = parseEnvelope(raw);
      if (env?.type === "ack" && env.correlation_id === cid) answers.push(env.payload as Reply);
    });
    const env = JSON.stringify(
      buildEnvelope({
        agentId: "admin-1",
        parentId: null,
        channel: "_system/auth",
        type: "query",
        correlationId: cid,
        payload: {
          op: "setup_apply",
          step: "services",
          plan_id: services.plan_id,
          reply_key: replyKey,
        },
      }),
    );
    await c.publish(authOpsTopic("admin-1"), env, { qos: 1, retain: false });
    // broker round-trip: wait until the step is held in the build, then deliver it again.
    await until(
      () =>
        m.fake.argvs([BUN, "run", "build"]).length === 0 &&
        m.fake.argvs(["bash"]).some((a) => a.length === 2),
    );
    await c.publish(authOpsTopic("admin-1"), env, { qos: 1, retain: false });
    // Beside the queue: an account op is answered while the step is still held.
    const list = await op("admin-1", { op: "account_list", reply_key: replyKey });
    expect(list?.ok, list?.error).toBe(true);
    expect(answers).toEqual([]);
    release();
    await until(() => answers.length > 0, 10_000);
    // broker round-trip: give a second (wrong) answer time to arrive.
    await new Promise((r) => setTimeout(r, 300));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.ok, answers[0]?.error).toBe(true);
    expect(m.fake.argvs([BUN, "run", "build"])).toHaveLength(1);
    expect(setupLog().filter((e) => e.event === "planned")).toHaveLength(1);
  });

  it("every terminal-only rule still matches a change the planners make (a reworded summary fails here)", async () => {
    const flagged: string[] = [];
    const collect = async () => {
      const r = await direct().handle("admin-1", { op: "setup_plan" });
      expect(r.reply.ok, r.reply.error).toBe(true);
      for (const s of (r.reply.result as { steps: WireStep[] }).steps) {
        for (const c of s.changes) if (c.terminal !== undefined) flagged.push(c.summary);
      }
    };
    // brew on macOS: the keychain copy and volleyd's own service.
    await collect();
    // volleyd's own password, once its file is gone.
    const accounts = direct();
    const planned = await accounts.handle("admin-1", { op: "setup_plan" });
    const id = (planned.reply.result as { steps: WireStep[] }).steps.find(
      (s) => s.step === "accounts",
    )?.plan_id;
    expect(
      (
        await accounts.handle("admin-1", {
          op: "setup_apply",
          step: "accounts",
          plan_id: id,
          reply_key: replyKey,
        })
      ).reply.ok,
    ).toBe(true);
    rmSync(join(m.volleydHome, "broker.json"));
    await collect();
    // cmux refusing volleyd's service (in Password mode, then in its default mode), then not
    // answering: the password, then the rechecks.
    cmuxSays(1, "ERROR: Invalid password");
    await collect();
    cmuxSays(1, "Access denied - only processes started inside cmux can connect");
    await collect();
    cmuxSays(1, "Failed to connect to /tmp/cmux.sock: Connection refused");
    await collect();
    // A root-owned broker (etc) not secured yet: its config, its state file and its restart.
    m = machine(root, "etc");
    writeFileSync(m.layout.config, "listener 1883\nallow_anonymous true\n");
    rmSync(m.layout.stateFile);
    rmSync(join(m.layout.authDir, "admin.json"));
    m.anonymous = { tcp: "accepted", ws: "accepted" };
    await collect();
    for (const prefix of TERMINAL_ONLY_PREFIXES) {
      expect(
        flagged.some((f) => f.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it("plans with the install `volley setup` recorded, not the layout volleyd detects", () => {
    // setup ran with --layout container --config … --dir …; volleyd itself would detect brew.
    const c = join(root, "container");
    mkdirSync(m.volleydHome, { recursive: true });
    writeFileSync(
      join(m.volleydHome, "setup.json"),
      JSON.stringify({
        layout: "container",
        config: join(c, "mosquitto.conf"),
        state_file: join(c, "dynamic-security.json"),
        auth_dir: join(c, "volley"),
      }),
    );
    const { authDir: _given, ...opts } = setupOptions();
    const ctx = new SetupOps({
      exec: m.exec,
      volleydHome: m.volleydHome,
      brokerUrl: BROKER,
      env: {},
      now: () => new Date(),
      sleep: async () => {},
      liveAgents: async () => 2,
      brokerVersion: () => null,
      ...opts,
    }).context({}) as SetupContext;
    expect(ctx.auth.layout.name).toBe("container");
    expect(ctx.config).toBe(join(c, "mosquitto.conf"));
    expect(ctx.stateFile).toBe(join(c, "dynamic-security.json"));
    expect(ctx.auth.layout.stateFile).toBe(join(c, "dynamic-security.json"));
    expect(ctx.auth.dir).toBe(join(c, "volley"));
    // Without a record (a broker set up by hand) the detected layout stands.
    rmSync(join(m.volleydHome, "setup.json"));
    const detected = direct().context({}) as SetupContext;
    expect(detected.auth.layout.name).toBe("brew-arm64");
    expect(detected.config).toBe(m.layout.config);
  });

  it("setup_plan: nothing pending in Security for the container install setup recorded; without the record, detection plans changes", async () => {
    // What `volley setup --layout container --config … --dir …` left behind: its config (header
    // naming `volley setup`), the plugin's state file and admin login, and the record.
    const c = join(root, "container");
    mkdirSync(c, { recursive: true });
    const install = {
      layout: "container",
      config: join(c, "mosquitto.conf"),
      state_file: m.layout.stateFile,
      auth_dir: m.layout.authDir,
    };
    writeFileSync(
      install.config,
      generateConfig({
        ...LAYOUTS.container,
        config: install.config,
        stateFile: install.state_file,
        authDir: install.auth_dir,
        by: "volley setup",
      }),
    );
    mkdirSync(m.volleydHome, { recursive: true });
    writeFileSync(join(m.volleydHome, "setup.json"), JSON.stringify(install));
    // The layout volleyd detects has no config of its own (as /etc/mosquitto on that box).
    rmSync(m.layout.config);
    const { authDir: _given, ...opts } = setupOptions();
    const ops = new SetupOps({
      exec: m.exec,
      volleydHome: m.volleydHome,
      brokerUrl: BROKER,
      env: {},
      now: () => new Date(),
      sleep: async () => {},
      liveAgents: async () => 2,
      brokerVersion: () => null,
      ...opts,
      // The container's listeners (and its LAN address) refuse anonymous clients, as after setup.
      deps: { ...opts.deps, probeAnonymous: async () => "refused" as const },
    });
    const plan = async () => {
      const r = await ops.handle("admin-1", { op: "setup_plan" });
      return (r.reply.result as { steps: WireStep[] }).steps;
    };
    const recorded = await plan();
    expect(step(recorded, "detect").found.join("\n")).toContain(
      `Install: container (config ${install.config})`,
    );
    expect(step(recorded, "security").blocked).toBeUndefined();
    expect(step(recorded, "security").changes).toEqual([]);
    rmSync(join(m.volleydHome, "setup.json"));
    // Without the record volleyd plans the layout it detects: the "pending" the Desk showed.
    const detected = step(await plan(), "security");
    expect(detected.changes.map((c) => c.summary.split(" (")[0])).toContain(
      `Write ${m.layout.config}`,
    );
  });

  it("a container broker's state file and restart are a terminal's (the fence runs neither)", () => {
    const ctx = {
      auth: { layout: { ...LAYOUTS.etc, name: "container", restart: "docker restart mosquitto" } },
      config: "/c/mosquitto.conf",
      stateFile: "/c/dynamic-security.json",
    } as unknown as SetupContext;
    expect(
      terminalOnly("security", "Restart the broker (docker restart mosquitto)", ctx)?.command,
    ).toBe("docker restart mosquitto");
    expect(
      terminalOnly(
        "security",
        "Create /c/dynamic-security.json with the admin login dynsec-admin",
        ctx,
      )?.command,
    ).toBe("volley setup --step security");
    expect(
      terminalOnly("security", "Write /c/mosquitto.conf (Dynamic Security, …)", ctx),
    ).toBeUndefined();
  });
});
