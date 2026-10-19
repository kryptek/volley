import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAYOUTS, type Layout, generateConfig } from "volley-cli/auth/config";
import { realAuthDeps } from "volley-cli/auth/context";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { Daemon } from "../src/daemon";
import type { ExecFn } from "../src/exec";
import { readJournalFile } from "../src/journal";
import type { SetupOpsOptions } from "../src/setup-ops";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE } from "./helpers/daemon-env";
import { type FakeDynsec, startFakeDynsec } from "./helpers/fake-dynsec";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { schemaErrors } from "./helpers/schema";

const NS = "setup-ops-test";
const pw = (u: string) => `${u}-pw`;
const BUN = "/opt/bun/bin/bun";
const BROKER = "mqtt://127.0.0.1:1883";
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
  restarts: number;
}

function machine(root: string, layoutName: "brew-arm64" | "etc" = "brew-arm64"): Machine {
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
    .on([BUN, "run", "build"], (_argv, opts) => {
      mkdirSync(join(opts.cwd as string, "dist"), { recursive: true });
      writeFileSync(join(opts.cwd as string, "dist", "index.html"), "<!doctype html>");
      return {};
    });
  m.exec = async (argv, opts) => {
    if (argv.join(" ") === RESTART_ARGV.join(" ") && m.restartGate !== null) await m.restartGate;
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

  const setupOptions = (): Partial<SetupOpsOptions> => ({
    brokerUrl: BROKER,
    authDir: m.layout.authDir,
    env: { HOME: m.home, PATH: "/usr/bin:/bin" },
    deskPort: 5199,
    liveAgents: async () => 2,
    brokerVersion: () => null,
    sleep: async () => {},
    deps: {
      platform: "darwin",
      uid: 501,
      lanHost: () => "desk.example",
      repoRoot: m.repo,
      bun: BUN,
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
    root = mkdtempSync(join(tmpdir(), "volleyd-setup-ops-"));
    m = machine(root);
    secured(m, fake);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
    await daemon?.stop();
    daemon = undefined;
    await fake.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
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
  const until = async (ok: () => boolean, ms = 5000) => {
    // broker round-trip: the restart runs after the answer; poll for its effects, bounded.
    for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25));
    expect(ok()).toBe(true);
  };

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
        { port: 1883, anonymous: "refused" },
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
        "Create Volley's 8 shared roles and the identities volleyd, desk, coordinator (passwords shown once)",
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
    expect(result.lines.join("\n")).toContain("desk got a password the Desk does not show");
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
    ]);
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
    // The plan after it: the step is done but for the terminal's change.
    const again = step((await plan()).steps, "accounts");
    expect(again.changes.map((c) => c.terminal !== undefined)).toEqual([true]);
    expect(existsSync(join(m.volleydHome, "broker.json"))).toBe(true);
    expect(existsSync(join(m.volleydHome, "dynsec-admin.json"))).toBe(true);
    // With the coordinator's login on file, the detect step counts the running agents.
    expect(step((await plan()).steps, "detect").found).toContain("2 agents running on the broker");
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

  it("setup_apply refuses a plan that changed since it was shown", async () => {
    await start();
    const r = await apply("accounts", "accounts-0000000000000000");
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toMatch(/^plan changed\b/);
    expect([...fake.clients().keys()]).toEqual([fake.admin.username]);
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
      "launchctl bootout gui/501/systems.volley.desk",
      `launchctl bootstrap gui/501 ${join(m.home, "Library", "LaunchAgents", "systems.volley.desk.plist")}`,
    ]);
    expect(existsSync(join(m.home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(m.repo, "packages", "volley-desk", "dist", "index.html"))).toBe(true);
    expect(result.problems).toEqual([]);
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
    expect(readFileSync(m.layout.config, "utf-8")).toBe(generateConfig({ ...m.layout }));
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
});
