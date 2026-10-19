import { createHash } from "node:crypto";
import {
  existsSync,
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
import { LAYOUTS, type Layout } from "../../src/auth/config";
import { realAuthDeps } from "../../src/auth/context";
import { ACCOUNT_ROLE_MAP, DYNSEC_ADMIN_USER, VOLLEY_ROLES, roleName } from "../../src/auth/roles";
import { auth } from "../../src/commands/auth";
import { makeBufferIO } from "../../src/io";
import { type TestDeps, fakeDeps } from "../helpers/auth-deps";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

describe("volley auth", () => {
  let dir: string;
  let fake: FakeDynsec;
  let layout: Layout;
  let authDir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-auth-cli-"));
    fake = await startFakeDynsec();
    authDir = join(dir, "auth");
    layout = {
      ...LAYOUTS["brew-arm64"],
      config: join(dir, "mosquitto.conf"),
      authDir,
      stateFile: join(dir, "dynamic-security.json"),
    };
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (
    argv: string[],
    deps: TestDeps = fakeDeps(fake, layout),
    env: Record<string, string | undefined> = {
      VOLLEYD_HOME: join(dir, "volleyd-home"),
      VOLLEY_AUTH_DIR: authDir,
    },
  ) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const code = await auth({ argv, env, io }, deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr(), deps };
  };
  /** A finished `init`: admin.json in authDir, the roles, the fixed identities (pw-2..pw-4). */
  const initDeps = async () => {
    const deps = fakeDeps(fake, layout);
    const r = await run(["init"], deps);
    expect(r.code).toBe(0);
    return deps;
  };
  const adminCreds = () =>
    JSON.parse(readFileSync(join(authDir, "admin.json"), "utf-8")) as {
      username: string;
      password: string;
    };
  const volleyRoles = () => [...fake.roles().keys()].filter((r) => r.startsWith("volley-")).sort();

  describe("init", () => {
    it("writes the config, the state file + admin, the eight roles and the fixed identities", async () => {
      const r = await run(["init"]);
      expect(r.code).toBe(0);
      const conf = readFileSync(layout.config, "utf-8");
      expect(conf).toContain(`plugin_opt_config_file ${layout.stateFile}`);
      expect(conf).toContain("per_listener_settings false");
      expect(r.deps.ctrlCalls).toEqual([
        ["mosquitto_ctrl", layout.stateFile, DYNSEC_ADMIN_USER, "pw-1"],
      ]);
      const admin = join(authDir, "admin.json");
      expect(JSON.parse(readFileSync(admin, "utf-8"))).toEqual({
        username: DYNSEC_ADMIN_USER,
        password: "pw-1",
      });
      expect(statSync(admin).mode & 0o777).toBe(0o600);
      expect(volleyRoles()).toEqual(VOLLEY_ROLES.map(roleName).sort());
      const clients = fake.clients();
      expect(clients.get("volleyd")).toEqual({ password: "pw-2", roles: ["volley-volleyd"] });
      expect(clients.get("desk")?.roles).toEqual(["volley-account", "volley-desk"]);
      expect(clients.get("coordinator")?.roles).toEqual(["volley-account", "volley-coordinator"]);
      // Plaintext passwords are shown exactly once, here.
      expect(r.stdout).toContain("volleyd        pw-2");
      expect(r.stdout).toContain("desk           pw-3");
      expect(r.stdout).toContain("coordinator    pw-4");
      expect(r.stdout).toContain("brew services restart mosquitto");
    });

    it("refuses a broker older than 2.1 before anything is written", async () => {
      const deps = fakeDeps(fake, layout);
      deps.binaryVersion = "mosquitto version 2.0.22";
      const r = await run(["init"], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("BROKER_TOO_OLD");
      expect(r.stderr).toContain("sudo snap install mosquitto");
      expect(existsSync(layout.config)).toBe(false);
      expect(deps.ctrlCalls).toEqual([]);
    });

    it("an existing admin login reads the version from the broker's $SYS", async () => {
      await initDeps();
      await fake.setVersion("mosquitto version 2.0.22");
      const r = await run(["init"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("BROKER_TOO_OLD");
      expect(r.deps.versionCalls).toEqual([]);
    });

    it("refuses a config with per_listener_settings true or the plugin twice, naming the trap", async () => {
      writeFileSync(layout.config, "per_listener_settings true\nlistener 1883\n");
      const r = await run(["init"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("per_listener_settings true");
      expect(readFileSync(layout.config, "utf-8")).toBe(
        "per_listener_settings true\nlistener 1883\n",
      );
      expect(r.deps.ctrlCalls).toEqual([]);

      const inc = join(dir, "conf.d");
      mkdirSync(inc);
      writeFileSync(join(inc, "a.conf"), "plugin /x/mosquitto_dynamic_security.so\n");
      writeFileSync(layout.config, `include_dir ${inc}\nplugin /x/mosquitto_dynamic_security.so\n`);
      const twice = await run(["init"]);
      expect(twice.code).toBe(1);
      expect(twice.stderr).toContain("loaded twice");
    });

    it("backs an existing config up and replaces it atomically", async () => {
      writeFileSync(layout.config, "listener 1883\npassword_file /old/passwd\n");
      const r = await run(["init"]);
      expect(r.code).toBe(0);
      const backups = readdirSync(dir).filter((f) => f.includes(".volley-backup-"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0] as string), "utf-8")).toContain("password_file");
      expect(r.stdout).toContain("rollback");
    });

    it("--no-config leaves the broker config alone", async () => {
      writeFileSync(layout.config, "mine\n");
      expect((await run(["init", "--no-config"])).code).toBe(0);
      expect(readFileSync(layout.config, "utf-8")).toBe("mine\n");
    });

    it("before the broker runs the plugin: asks for a restart; the rerun completes", async () => {
      const deps = fakeDeps(fake, layout);
      deps.adminUp = false;
      const first = await run(["init"], deps);
      expect(first.code).toBe(1);
      expect(first.stdout).toContain("Next: restart the broker");
      expect(first.stdout).toContain("brew services restart mosquitto");
      expect(volleyRoles()).toEqual([]);
      deps.adminUp = true;
      const again = await run(["init"], deps);
      expect(again.code).toBe(0);
      expect(volleyRoles()).toHaveLength(8);
      expect(deps.ctrlCalls).toHaveLength(1);
    });

    it("--restart runs the layout's restart command and continues", async () => {
      const deps = fakeDeps(fake, layout);
      deps.adminUp = false;
      const r = await run(["init", "--restart"], deps);
      expect(r.code).toBe(0);
      expect(deps.restarts).toEqual(["brew services restart mosquitto"]);
      expect(volleyRoles()).toHaveLength(8);
    });

    it("a rerun is idempotent: no role edit, the fixed passwords kept, nothing printed twice", async () => {
      const deps = await initDeps();
      const edits = fake.roleEdits();
      const r = await run(["init"], deps);
      expect(r.code).toBe(0);
      expect(fake.roleEdits()).toBe(edits);
      expect(fake.clients().get("desk")?.password).toBe("pw-3");
      expect(r.stdout).toContain("Nothing to do");
      expect(r.stdout).not.toMatch(/pw-\d/);
    });

    it("--force rotates the fixed identities (and says it disconnects them)", async () => {
      const deps = await initDeps();
      const r = await run(["init", "--force"], deps);
      expect(r.code).toBe(0);
      expect(fake.clients().get("volleyd")?.password).toBe("pw-5");
      expect(r.stdout).toContain("disconnected");
      expect(r.stdout).toContain("volleyd        pw-5");
    });

    it("a state file without its admin.json is refused (never a second admin)", async () => {
      writeFileSync(layout.stateFile, "{}\n");
      const r = await run(["init"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("admin.json");
      expect(r.deps.ctrlCalls).toEqual([]);
    });

    it("as root, hands the new state file to the broker's user", async () => {
      const deps = fakeDeps(fake, layout);
      deps.brokerOwner = () => ({ uid: 111, gid: 222 });
      await run(["init"], deps);
      expect(deps.chowns).toContainEqual([layout.stateFile, 111, 222]);
    });

    it("--coordinator-file writes coordinator.json (0600); --force rotates an existing one", async () => {
      const deps = fakeDeps(fake, layout);
      await run(["init", "--coordinator-file"], deps);
      const path = join(authDir, "coordinator.json");
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        username: "coordinator",
        password: "pw-4",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      await run(["init", "--force"], deps);
      expect(JSON.parse(readFileSync(path, "utf-8")).password).toBe("pw-7");
    });

    it("--volleyd-file writes broker.json and the admin login volleyd mints with (0600)", async () => {
      await run(["init", "--volleyd-file"]);
      const vh = join(dir, "volleyd-home");
      expect(JSON.parse(readFileSync(join(vh, "broker.json"), "utf-8"))).toEqual({
        username: "volleyd",
        password: "pw-2",
      });
      expect(JSON.parse(readFileSync(join(vh, "dynsec-admin.json"), "utf-8"))).toEqual({
        username: DYNSEC_ADMIN_USER,
        password: "pw-1",
      });
      expect(statSync(join(vh, "broker.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(vh, "dynsec-admin.json")).mode & 0o777).toBe(0o600);
      expect(statSync(vh).mode & 0o777).toBe(0o700);
    });

    describe("--volleyd-file under sudo", () => {
      const sudoEnv = (extra = {}) => ({
        HOME: join(dir, "roothome"),
        SUDO_UID: "501",
        SUDO_GID: "20",
        ...extra,
      });
      const sudoDeps = () => {
        const deps = fakeDeps(fake, layout);
        deps.invokingUser = () => ({ uid: 501, gid: 20, home: join(dir, "userhome") });
        return deps;
      };

      it("writes the files in the invoking user's home, owned by them", async () => {
        const deps = sudoDeps();
        const r = await run(["init", "--volleyd-file"], deps, {
          ...sudoEnv(),
          VOLLEY_AUTH_DIR: authDir,
        });
        expect(r.code).toBe(0);
        const vh = join(dir, "userhome", ".volley", "volleyd");
        expect(existsSync(join(dir, "roothome"))).toBe(false);
        expect(deps.chowns).toEqual([
          [join(dir, "userhome"), 501, 20],
          [join(dir, "userhome", ".volley"), 501, 20],
          [vh, 501, 20],
          [join(vh, "broker.json"), 501, 20],
          [join(vh, "dynsec-admin.json"), 501, 20],
        ]);
      });

      it("as root with no sudo user, refuses --volleyd-file without VOLLEYD_HOME (nothing done)", async () => {
        const deps = fakeDeps(fake, layout);
        deps.invokingUser = () => "root";
        const r = await run(["init", "--volleyd-file"], deps, {
          HOME: join(dir, "roothome"),
          VOLLEY_AUTH_DIR: authDir,
        });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("VOLLEYD_HOME");
        expect(deps.ctrlCalls).toEqual([]);
        expect(existsSync(layout.config)).toBe(false);
      });
    });

    it("the per-verb flags are refused elsewhere", async () => {
      expect((await run(["add-agent", "w1-t1-x-1", "--volleyd-file"])).code).toBe(2);
      expect((await run(["add-agent", "w1-t1-x-1", "--force"])).code).toBe(2);
      expect((await run(["init", "--roles"])).code).toBe(2);
      expect((await run(["list-agents", "--role", "steer"])).code).toBe(2);
    });
  });

  describe("migrate --roles", () => {
    it("without --yes prints the reconnect warning and changes nothing", async () => {
      const deps = await initDeps();
      // An older Volley's role: one ACL fewer.
      const agentAcls = fake.roles().get("volley-agent") ?? [];
      const admin = await realAuthDeps.connectAdmin(fake.url, adminCreds());
      await admin.session.run([
        {
          command: "removeRoleACL",
          rolename: "volley-agent",
          acltype: agentAcls[0]?.acltype,
          topic: agentAcls[0]?.topic,
        },
      ]);
      await admin.close();
      const edits = fake.roleEdits();
      const r = await run(["migrate", "--roles"], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("will be disconnected");
      expect(r.stderr).toContain("volley-agent: 1 ACL(s) to add");
      expect(fake.roleEdits()).toBe(edits);

      const yes = await run(["migrate", "--roles", "--yes"], deps);
      expect(yes.code).toBe(0);
      expect(fake.roles().get("volley-agent")).toHaveLength(agentAcls.length);
    });
  });

  describe("migrate --roles with a missing role", () => {
    it("without --yes lists it and creates nothing; --yes creates it", async () => {
      const deps = await initDeps();
      const admin = await realAuthDeps.connectAdmin(fake.url, adminCreds());
      await admin.session.run([{ command: "deleteRole", rolename: "volley-token" }]);
      await admin.close();
      const edits = fake.roleEdits();
      const r = await run(["migrate", "--roles"], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("volley-token: missing, to create");
      expect(r.stderr).toContain("Nothing was changed");
      expect(fake.roleEdits()).toBe(edits);
      expect(fake.roles().has("volley-token")).toBe(false);

      expect((await run(["migrate", "--roles", "--yes"], deps)).code).toBe(0);
      expect(fake.roles().has("volley-token")).toBe(true);
    });
  });

  describe("agent logins", () => {
    it("add-agent creates a volley-agent login and prints only its password", async () => {
      const deps = await initDeps();
      const r = await run(["add-agent", "w1-t1-implementer-1"], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-5\n");
      expect(fake.clients().get("w1-t1-implementer-1")).toEqual({
        password: "pw-5",
        roles: ["volley-agent"],
      });
      const json = await run(["add-agent", "w1-t2-implementer-1", "--json"], deps);
      expect(JSON.parse(json.stdout)).toEqual({
        username: "w1-t2-implementer-1",
        password: "pw-6",
      });
    });

    it("add-agent of an existing login fails without changing its password", async () => {
      const deps = await initDeps();
      await run(["add-agent", "w1-t1-implementer-1"], deps);
      const r = await run(["add-agent", "w1-t1-implementer-1"], deps);
      expect(r.code).toBe(1);
      expect(fake.clients().get("w1-t1-implementer-1")?.password).toBe("pw-5");
    });

    it("rejects an out-of-grammar id, the fixed identities, reserved and token-shaped ids", async () => {
      const deps = await initDeps();
      for (const id of [
        "Bad_Id",
        "desk",
        "volleyd",
        DYNSEC_ADMIN_USER,
        "registry",
        "mailbox",
        "0000abcd",
      ]) {
        const r = await run(["add-agent", id], deps);
        expect(r.code, id).toBe(2);
      }
    });

    it("--ack-to and grant are gone: acks to the fixed identities need no per-agent grant", async () => {
      const deps = await initDeps();
      expect(
        (await run(["add-agent", "w1-t1-x-1", "--ack-to", "coordinator-ab12"], deps)).code,
      ).toBe(2);
      expect((await run(["grant", "w1-t1-x-1"], deps)).code).toBe(2);
    });

    it("rm-agent deletes an agent login; a missing one succeeds; never a non-agent login", async () => {
      const deps = await initDeps();
      await run(["add-agent", "w1-t1-implementer-1"], deps);
      expect((await run(["rm-agent", "w1-t1-implementer-1"], deps)).code).toBe(0);
      expect(fake.clients().has("w1-t1-implementer-1")).toBe(false);
      const again = await run(["rm-agent", "w1-t1-implementer-1"], deps);
      expect(again.code).toBe(0);
      expect(again.stderr).toContain("nothing to revoke");
      await run(["add", "w1-t9-implementer-1", "--role", "watch"], deps).catch(() => {});
    });

    it("rm-agent refuses an account's login", async () => {
      const deps = await initDeps();
      await run(["add", "phone", "--role", "steer"], deps);
      const r = await run(["rm-agent", "phone"], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not an agent login");
      expect(fake.clients().has("phone")).toBe(true);
    });

    it("list-agents lists only agent logins", async () => {
      const deps = await initDeps();
      await run(["add-agent", "w1-t1-implementer-1"], deps);
      await run(["add", "phone", "--role", "steer"], deps);
      const r = await run(["list-agents", "--json"], deps);
      expect(JSON.parse(r.stdout)).toEqual({ agents: ["w1-t1-implementer-1"] });
      expect((await run(["list-agents"], deps)).stdout).toBe("w1-t1-implementer-1\n");
    });

    it("before init fails with a pointer to init", async () => {
      const r = await run(["add-agent", "w1-t1-implementer-1"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("volley auth init");
    });

    it("every verb refuses a broker older than 2.1", async () => {
      const deps = await initDeps();
      await fake.setVersion("mosquitto version 2.0.22");
      const r = await run(["add-agent", "w1-t1-implementer-1"], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("2.0.22");
      expect(fake.clients().has("w1-t1-implementer-1")).toBe(false);
    });
  });

  describe("accounts", () => {
    const accounts = () =>
      JSON.parse(readFileSync(join(authDir, "accounts.json"), "utf-8")) as {
        accounts: Record<string, unknown>[];
      };

    it("add --role watch: an accounts.json entry and a login holding volley-account", async () => {
      const deps = await initDeps();
      const r = await run(["add", "tablet", "--role", "watch"], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-5\n");
      expect(accounts().accounts).toEqual([
        { name: "tablet", role: "watch", kind: "device", created: "2026-10-18T12:00:00.000Z" },
      ]);
      expect(fake.clients().get("tablet")).toEqual({ password: "pw-5", roles: ["volley-account"] });
    });

    it("each role's login holds that role's shared roles", async () => {
      const deps = await initDeps();
      for (const role of Object.keys(ACCOUNT_ROLE_MAP) as (keyof typeof ACCOUNT_ROLE_MAP)[]) {
        expect((await run(["add", `${role}-acct`, "--role", role], deps)).code).toBe(0);
        expect(fake.clients().get(`${role}-acct`)?.roles).toEqual(
          ACCOUNT_ROLE_MAP[role].map(roleName),
        );
      }
    });

    it("add --json prints the credentials and role; --kind overrides the default", async () => {
      const deps = await initDeps();
      const r = await run(
        ["add", "ci", "--role", "supervisor", "--kind", "machine", "--json"],
        deps,
      );
      expect(JSON.parse(r.stdout)).toEqual({
        username: "ci",
        password: "pw-5",
        role: "supervisor",
      });
      expect(accounts().accounts[0]?.kind).toBe("machine");
    });

    it("add refuses a missing/unknown role or kind, a taken name and reserved names", async () => {
      const deps = await initDeps();
      expect((await run(["add", "x"], deps)).code).toBe(2);
      expect((await run(["add", "x", "--role", "root"], deps)).code).toBe(2);
      expect((await run(["add", "x", "--role", "watch", "--kind", "robot"], deps)).code).toBe(2);
      for (const name of ["desk", DYNSEC_ADMIN_USER, "registry", "0000abcd", "admin-0000abcd"]) {
        expect((await run(["add", name, "--role", "watch"], deps)).code, name).toBe(2);
      }
      await run(["add", "tablet", "--role", "watch"], deps);
      expect((await run(["add", "tablet", "--role", "steer"], deps)).code).toBe(1);
      // A login of that name that is not an account (an agent) is taken too.
      await run(["add-agent", "w1-t1-implementer-1"], deps);
      expect((await run(["add", "w1-t1-implementer-1", "--role", "watch"], deps)).code).toBe(1);
    });

    it("rotate sets a new password (printed once); revoke deletes the login and the entry", async () => {
      const deps = await initDeps();
      await run(["add", "tablet", "--role", "watch"], deps);
      const r = await run(["rotate", "tablet"], deps);
      expect(r.stdout).toBe("pw-6\n");
      expect(fake.clients().get("tablet")?.password).toBe("pw-6");
      expect((await run(["revoke", "tablet"], deps)).code).toBe(0);
      expect(fake.clients().has("tablet")).toBe(false);
      expect(accounts().accounts).toEqual([]);
      expect((await run(["revoke", "tablet"], deps)).code).toBe(1);
    });

    it("list --json prints the registry without passwords, and needs no broker", async () => {
      const deps = await initDeps();
      await run(["add", "tablet", "--role", "watch"], deps);
      deps.adminUp = false;
      const r = await run(["list", "--json"], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("pw-");
      expect(JSON.parse(r.stdout).accounts[0].name).toBe("tablet");
      expect((await run(["list"], deps)).stdout).toContain("tablet");
    });

    describe("one-time tokens", () => {
      const tokens = () =>
        JSON.parse(readFileSync(join(authDir, "tokens.json"), "utf-8")) as {
          tokens: Record<string, unknown>[];
        };
      const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
      // randomHex: the id is the 1st draw (4 bytes), the secret the 2nd (16 bytes).
      const TOKEN = `vly_admin_00000001_${"2".padStart(32, "0")}`;

      it("token prints a one-time admin token, stores only its hash, and is a volley-token login", async () => {
        const deps = await initDeps();
        const r = await run(["token"], deps);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(TOKEN);
        expect(r.stdout).toContain("10 minutes");
        // The sign-in form has no token field: the link is what works.
        expect(r.stdout).toContain(`http://localhost:5199/#signin=${TOKEN}`);
        expect(r.stdout).not.toContain("paste it");
        expect(JSON.stringify(tokens())).not.toContain(TOKEN);
        expect(tokens().tokens).toEqual([
          {
            id: "00000001",
            kind: "admin",
            role: "admin",
            hash: sha256(TOKEN),
            created: "2026-10-18T12:00:00.000Z",
            expires_at: "2026-10-18T12:10:00.000Z",
          },
        ]);
        // Its login is named by the token id, so the role's %u names exactly its two topics.
        expect(fake.clients().get("00000001")).toEqual({
          password: TOKEN,
          roles: ["volley-token"],
        });
        expect(fake.canPublish("00000001", "volley-auth/redeem/00000001")).toBe(true);
        expect(fake.canPublish("00000001", "volley-auth/redeem/00000002")).toBe(false);
      });

      it("token --json prints the token, its broker login and expiry", async () => {
        const deps = await initDeps();
        const r = await run(["token", "--json", "--ttl", "60"], deps);
        expect(JSON.parse(r.stdout)).toEqual({
          token: TOKEN,
          username: "00000001",
          expires_at: "2026-10-18T12:01:00.000Z",
        });
      });

      it("redeem mints an admin account bound to the label, burns the token, keeps its login", async () => {
        const deps = await initDeps();
        await run(["token"], deps);
        deps.stdin = `${TOKEN}\n`;
        const r = await run(["redeem", "--label", "Desk on mac", "--json"], deps);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({
          username: "admin-00000001",
          password: "pw-5",
          role: "admin",
          label: "Desk on mac",
          token_id: "00000001",
        });
        expect(fake.clients().get("admin-00000001")?.roles).toEqual([
          "volley-account",
          "volley-admin",
        ]);
        expect(tokens().tokens[0]?.used_at).toBe("2026-10-18T12:00:00.000Z");
        // The redeeming client is still connected as the token login: it is not deleted yet.
        expect(fake.clients().has("00000001")).toBe(true);
        const twice = await run(["redeem", "--label", "Desk on mac"], deps);
        expect(twice.code).toBe(1);
        expect(twice.stderr).toContain("already used");
      });

      it("a redeemed token's login is deleted once its short grace has passed", async () => {
        const deps = await initDeps();
        await run(["token"], deps);
        deps.stdin = `${TOKEN}\n`;
        await run(["redeem", "--label", "Desk"], deps);
        const io = makeBufferIO({ now: () => new Date(NOW + 61_000) });
        await auth({ argv: ["list"], env: { VOLLEY_AUTH_DIR: authDir }, io }, deps);
        expect(fake.clients().has("00000001")).toBe(false);
      });

      it("an expired token's login is pruned by any later account command", async () => {
        const deps = await initDeps();
        await run(["token", "--ttl", "1"], deps);
        const io = makeBufferIO({ now: () => new Date(NOW + 5_000) });
        await auth({ argv: ["list", "--json"], env: { VOLLEY_AUTH_DIR: authDir }, io }, deps);
        expect(fake.clients().has("00000001")).toBe(false);
        deps.stdin = `${TOKEN}\n`;
        const late = makeBufferIO({ now: () => new Date(NOW + 5_000) });
        expect(
          await auth(
            { argv: ["redeem", "--label", "Desk"], env: { VOLLEY_AUTH_DIR: authDir }, io: late },
            deps,
          ),
        ).toBe(1);
        expect(late.readStderr()).toContain("expired");
      });

      it("redeem refuses, without burning the token, when the account name is taken", async () => {
        const deps = await initDeps();
        await run(["token"], deps);
        const admin = await realAuthDeps.connectAdmin(fake.url, adminCreds());
        await admin.session.run([
          { command: "createClient", username: "admin-00000001", password: "x", roles: [] },
        ]);
        await admin.close();
        deps.stdin = `${TOKEN}\n`;
        const r = await run(["redeem", "--label", "Desk"], deps);
        expect(r.code).toBe(1);
        expect(tokens().tokens[0]?.used_at).toBeUndefined();
      });

      it("refuses an unknown or forged token", async () => {
        const deps = await initDeps();
        await run(["token"], deps);
        deps.stdin = `vly_admin_00000001_${"9".padStart(32, "0")}\n`;
        expect((await run(["redeem", "--label", "Desk"], deps)).code).toBe(1);
        deps.stdin = "garbage\n";
        expect((await run(["redeem", "--label", "Desk"], deps)).code).toBe(1);
      });

      it("signin-link issues only steer or watch, needs a label; its redemption has that role", async () => {
        const deps = await initDeps();
        expect((await run(["signin-link", "--role", "admin", "--label", "x"], deps)).code).toBe(2);
        expect((await run(["signin-link", "--role", "steer"], deps)).code).toBe(2);
        const r = await run(["signin-link", "--role", "steer", "--label", "phone", "--json"], deps);
        const { token } = JSON.parse(r.stdout) as { token: string };
        deps.stdin = `${token}\n`;
        const red = await run(["redeem", "--label", "phone", "--json"], deps);
        expect(JSON.parse(red.stdout).role).toBe("steer");
        expect(fake.clients().get("steer-00000001")?.roles).toEqual([
          "volley-account",
          "volley-desk",
        ]);
      });

      it("rewrites tokens.json and accounts.json by rename, never in place", async () => {
        const deps = await initDeps();
        await run(["token"], deps);
        const before = statSync(join(authDir, "tokens.json")).ino;
        await run(["token"], deps);
        expect(statSync(join(authDir, "tokens.json")).ino).not.toBe(before);
        expect(readdirSync(authDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      });
    });
  });

  it("no verb, an unknown verb or `reload`: usage, exit 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["reload"])).code).toBe(2);
  });
});

describe("no broker signalling and no file editing (both packages)", () => {
  const roots = ["../../src", "../../../volleyd/src"].map((p) => new URL(p, import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  for (const r of roots) walk(r.pathname);

  it("no pkill / SIGHUP / reload verb / --no-reload / mosquitto_passwd / grant verb anywhere", () => {
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, "utf-8");
      return [
        // String literals only: a comment may still name the old mechanism it replaced.
        /["']pkill["']/,
        /["']-HUP["']/,
        /["']--no-reload["']/,
        /["']reload["']/,
        /["']mosquitto_passwd["']/,
        /["']auth["'],\s*["']grant["']/,
        /["']add-agent["']/,
      ]
        .filter((re) => re.test(text))
        .map((re) => `${f}: ${re}`);
    });
    // `add-agent` survives only as the CLI verb itself (commands/auth.ts); volleyd never runs it.
    const cliVerb = (o: string) =>
      o.includes("volley-cli/src/commands/auth.ts:") && o.includes("add-agent");
    expect(offenders.filter((o) => !cliVerb(o))).toEqual([]);
  });
});
