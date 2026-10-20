import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAYOUTS, type Layout, generateConfig } from "../../src/auth/config";
import { ACCOUNT_ROLE_MAP, VOLLEY_ROLES, roleName } from "../../src/auth/roles";
import { auth } from "../../src/commands/auth";
import { makeBufferIO } from "../../src/io";
import { type TestDeps, fakeDeps } from "../helpers/auth-deps";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const AGENTS = ["w1-t1-implementer-1", "w1-t2-reviewer-1"];

describe("volley auth migrate (acl_file + password_file → Dynamic Security)", () => {
  let dir: string;
  let fake: FakeDynsec;
  let layout: Layout;
  let authDir: string;
  let worktrees: string;
  let home: string;
  const agentJson = (id: string) =>
    join(worktrees, "w1", id.replace(/^w1-/, "").replace(/-1$/, ""), ".volley", "agent.json");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-migrate-"));
    fake = await startFakeDynsec();
    authDir = join(dir, "etc", "volley");
    worktrees = join(dir, "worktrees");
    home = join(dir, "volleyd-home");
    layout = {
      ...LAYOUTS.etc,
      config: join(dir, "etc", "mosquitto.conf"),
      authDir,
      stateFile: join(dir, "lib", "dynamic-security.json"),
    };
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(dir, "lib"));
    mkdirSync(home, { recursive: true });
    // The file-based setup: three fixed identities, two minted agents, two accounts, a token.
    writeFileSync(
      join(authDir, "passwd"),
      ["volleyd", "desk", "coordinator", ...AGENTS, "tablet", "ci", "redeem-0000beef", "backup-bot"]
        .map((u) => `${u}:$7$x`)
        .join("\n"),
    );
    writeFileSync(
      join(authDir, "acl.conf"),
      "pattern read volley/#\nuser volleyd\ntopic readwrite volley/#\n",
    );
    writeFileSync(
      join(authDir, "accounts.json"),
      JSON.stringify({
        accounts: [
          { name: "tablet", role: "watch", kind: "device", created: "2026-10-01T00:00:00.000Z" },
          { name: "ci", role: "supervisor", kind: "service", created: "2026-10-01T00:00:00.000Z" },
        ],
      }),
    );
    writeFileSync(
      join(authDir, "tokens.json"),
      JSON.stringify({
        tokens: [
          {
            id: "0000beef",
            kind: "admin",
            role: "admin",
            hash: "x",
            created: "2026-10-18T11:59:00.000Z",
            expires_at: "2026-10-18T12:09:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      join(authDir, "coordinator.json"),
      JSON.stringify({ username: "coordinator", password: "old" }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, "broker.json"),
      JSON.stringify({ username: "volleyd", password: "old" }),
      {
        mode: 0o600,
      },
    );
    writeFileSync(
      layout.config,
      `listener 1883 127.0.0.1\nallow_anonymous false\npassword_file ${authDir}/passwd\nacl_file ${authDir}/acl.conf\n`,
    );
    for (const id of AGENTS) {
      mkdirSync(join(agentJson(id), ".."), { recursive: true });
      writeFileSync(
        agentJson(id),
        JSON.stringify({
          agent_id: id,
          namespace: "default",
          broker: { username: id, password: "old" },
        }),
        { mode: 0o600 },
      );
    }
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (argv: string[], deps: TestDeps) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const code = await auth(
      {
        argv: [...argv, "--worktrees", worktrees],
        env: { VOLLEYD_HOME: home, HOME: dir, VOLLEY_AUTH_DIR: authDir },
        io,
      },
      deps,
    );
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };
  const json = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

  it("roles, fixed clients, agent and account logins, credential files, config with backup", async () => {
    const deps = fakeDeps(fake, layout);
    const r = await run(["migrate"], deps);
    expect(r.code).toBe(0);
    const clients = fake.clients();

    expect([...fake.roles().keys()].filter((x) => x.startsWith("volley-")).sort()).toEqual(
      VOLLEY_ROLES.map(roleName).sort(),
    );
    // Fixed identities with NEW passwords, written where their clients already read them.
    expect(json(join(authDir, "coordinator.json")).password).toBe(
      clients.get("coordinator")?.password,
    );
    expect(json(join(home, "broker.json")).password).toBe(clients.get("volleyd")?.password);
    expect(json(join(home, "broker.json")).password).not.toBe("old");
    expect(json(join(home, "dynsec-admin.json"))).toEqual(json(join(authDir, "admin.json")));
    // One agent login per live agent, with the password its .volley/agent.json already holds:
    // the running agent's MCP server and hooks keep working after the broker restart.
    for (const id of AGENTS) {
      expect(clients.get(id)?.roles).toEqual(["volley-agent"]);
      expect(clients.get(id)?.password).toBe("old");
      const file = json(agentJson(id));
      expect(file.broker).toEqual({ username: id, password: "old" });
      expect(file.namespace).toBe("default");
      expect(statSync(agentJson(id)).mode & 0o777).toBe(0o600);
    }
    // A passwd user that is none of Volley's identities is named, not silently dropped.
    expect(r.stdout).toContain("not migrated: backup-bot");
    expect(r.stdout).not.toContain("redeem-0000beef");
    // O2's accounts become logins of their role's roles; their new passwords are printed once.
    expect(clients.get("tablet")?.roles).toEqual(ACCOUNT_ROLE_MAP.watch.map(roleName));
    expect(clients.get("ci")?.roles).toEqual(ACCOUNT_ROLE_MAP.supervisor.map(roleName));
    expect(r.stdout).toContain(`tablet         ${clients.get("tablet")?.password}`);
    expect(r.stdout).toContain("1 pending one-time token(s) were not migrated");
    // The config: rewritten (no password_file / acl_file), the old one backed up.
    const conf = readFileSync(layout.config, "utf-8");
    expect(conf).toContain("plugin_opt_config_file");
    expect(conf).not.toContain("password_file");
    const backups = readdirSync(join(dir, "etc")).filter((f) => f.includes(".volley-backup-"));
    expect(backups).toHaveLength(1);
    expect(r.stdout).toContain("sudo systemctl restart mosquitto");
  });

  it("a second run changes nothing", async () => {
    const deps = fakeDeps(fake, layout);
    expect((await run(["migrate"], deps)).code).toBe(0);
    const before = {
      clients: fake.clients(),
      edits: fake.roleEdits(),
      files: [
        join(authDir, "coordinator.json"),
        join(home, "broker.json"),
        layout.config,
        ...AGENTS.map(agentJson),
      ].map((p) => readFileSync(p, "utf-8")),
      backups: readdirSync(join(dir, "etc")).length,
    };
    const sent = fake.controlMessages.length;
    const again = await run(["migrate"], deps);
    expect(again.code).toBe(0);
    expect(fake.clients()).toEqual(before.clients);
    expect(fake.roleEdits()).toBe(before.edits);
    expect(
      [
        join(authDir, "coordinator.json"),
        join(home, "broker.json"),
        layout.config,
        ...AGENTS.map(agentJson),
      ].map((p) => readFileSync(p, "utf-8")),
    ).toEqual(before.files);
    expect(readdirSync(join(dir, "etc")).length).toBe(before.backups);
    // Nothing that changes a login or a role was even sent (creates came back "exists").
    const rerun = fake.controlMessages
      .slice(sent)
      .flat()
      .map((c) => c.command);
    for (const c of [
      "setClientPassword",
      "deleteClient",
      "addRoleACL",
      "removeRoleACL",
      "addClientRole",
    ]) {
      expect(rerun).not.toContain(c);
    }
  });

  it("leaves a config `volley setup` wrote alone: only the header names another tool", async () => {
    const deps = fakeDeps(fake, layout);
    expect((await run(["migrate"], deps)).code).toBe(0);
    const bySetup = generateConfig({ ...layout, by: "volley setup" });
    writeFileSync(layout.config, bySetup);
    const backups = readdirSync(join(dir, "etc")).length;
    const again = await run(["migrate"], deps);
    expect(again.code).toBe(0);
    expect(readFileSync(layout.config, "utf-8")).toBe(bySetup);
    expect(readdirSync(join(dir, "etc")).length).toBe(backups);
  });

  it("keeps a LAN WebSocket listener from the old config, and shows the change before writing", async () => {
    writeFileSync(
      layout.config,
      `listener 1883 127.0.0.1\nlistener 9001\nprotocol websockets\nallow_anonymous false\npassword_file ${authDir}/passwd\nacl_file ${authDir}/acl.conf\n`,
    );
    const r = await run(["migrate"], fakeDeps(fake, layout));
    expect(r.code).toBe(0);
    const conf = readFileSync(layout.config, "utf-8");
    expect(conf).toMatch(/^listener 9001$/m);
    expect(conf).toMatch(/^listener 1883 127\.0\.0\.1$/m);
    expect(r.stdout).toContain(`-password_file ${authDir}/passwd`);
    expect(r.stdout).toContain("open to the LAN");
    expect(r.stdout.indexOf(`--- ${layout.config}`)).toBeLessThan(
      r.stdout.indexOf(`Wrote ${layout.config}`),
    );
  });

  it("an agent.json without a password gets a new one, written before its login exists", async () => {
    const id = AGENTS[0] as string;
    writeFileSync(
      agentJson(id),
      JSON.stringify({ agent_id: id, namespace: "default", broker: { username: id } }),
      { mode: 0o600 },
    );
    const r = await run(["migrate"], fakeDeps(fake, layout));
    expect(r.code).toBe(0);
    const pw = fake.clients().get(id)?.password;
    expect(pw).toMatch(/^pw-/);
    expect(json(agentJson(id)).broker).toEqual({ username: id, password: pw });
    expect(r.stdout).toContain(`restart these agents: ${id}`);
  });

  it("skips an agent.json whose id add-agent would refuse", async () => {
    const bad = join(worktrees, "w9", "x", ".volley", "agent.json");
    mkdirSync(join(bad, ".."), { recursive: true });
    writeFileSync(
      bad,
      JSON.stringify({ agent_id: "registry", broker: { username: "registry", password: "old" } }),
    );
    const r = await run(["migrate"], fakeDeps(fake, layout));
    expect(r.code).toBe(0);
    expect(fake.clients().has("registry")).toBe(false);
    expect(r.stdout).toContain(`Skipped ${bad}: "registry" is reserved`);
  });

  it("under sudo: finds agents under the invoking user's home and keeps their files theirs", async () => {
    const userHome = join(dir, "user-home");
    const root = join(userHome, ".volley", "worktrees");
    const id = "w2-t1-implementer-1";
    const file = join(root, "w2", "t1-implementer", ".volley", "agent.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ agent_id: id, broker: { username: id } }), {
      mode: 0o600,
    });
    const deps = fakeDeps(fake, layout);
    deps.invokingUser = () => ({ uid: 1234, gid: 5678, home: userHome });
    const io = makeBufferIO({ now: () => new Date(NOW) });
    // HOME is root's under sudo, and env_reset strips VOLLEYD_HOME.
    const code = await auth(
      { argv: ["migrate"], env: { HOME: join(dir, "root"), VOLLEY_AUTH_DIR: authDir }, io },
      deps,
    );
    expect(code).toBe(0);
    expect(fake.clients().get(id)?.roles).toEqual(["volley-agent"]);
    const st = statSync(file);
    expect(deps.chowns).toContainEqual([file, st.uid, st.gid]);
  });

  it("refuses a broker older than 2.1 and changes nothing", async () => {
    const deps = fakeDeps(fake, layout);
    deps.binaryVersion = "mosquitto version 2.0.22";
    const conf = readFileSync(layout.config, "utf-8");
    const r = await run(["migrate"], deps);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("BROKER_TOO_OLD");
    expect(readFileSync(layout.config, "utf-8")).toBe(conf);
    expect(deps.ctrlCalls).toEqual([]);
    expect(json(agentJson(AGENTS[0] as string)).broker.password).toBe("old");
  });
});
