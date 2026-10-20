import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SavedLoginDeps,
  readSavedCoordinatorFile,
  savedLoginSource,
  useSavedLogin,
} from "volley-cli/auth/coordinator-login";
import { VolleyBroker } from "volley-mcp/broker";
import {
  ADMIN_FILE,
  BROKER_FILE,
  controlAuth,
  daemonAdminAuth,
  daemonAuth,
} from "../src/broker-auth";
import { daemonStartOptions } from "../src/commands/daemon";
import { resolveControlTarget } from "../src/control";
import { Daemon } from "../src/daemon";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { tempDir } from "./helpers/tmp";

const NS = "volleyd-auth";
const USERS = { volleyd: "volleyd-pw", coordinator: "coordinator-pw" };

let home: string;
beforeEach(() => {
  home = tempDir("volleyd-auth-");
});

function writeBrokerFile(contents: string, mode = 0o600): string {
  const path = join(home, BROKER_FILE);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

describe("daemonAdminAuth: the dynsec admin login volleyd mints with", () => {
  const admin = (dir: string, name: string, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ username: "dynsec-admin", password: "a" }), { mode });
    chmodSync(path, mode);
    return path;
  };

  it("reads $VOLLEYD_HOME/dynsec-admin.json, else $VOLLEY_AUTH_DIR/admin.json, else none", () => {
    expect(daemonAdminAuth(home, {})).toBeNull();
    const authDir = tempDir("volleyd-authdir-");
    admin(authDir, "admin.json");
    expect(daemonAdminAuth(home, { VOLLEY_AUTH_DIR: authDir })).toEqual({
      username: "dynsec-admin",
      password: "a",
    });
    writeFileSync(
      join(home, ADMIN_FILE),
      JSON.stringify({ username: "dynsec-admin", password: "h" }),
      {
        mode: 0o600,
      },
    );
    expect(daemonAdminAuth(home, { VOLLEY_AUTH_DIR: authDir })?.password).toBe("h");
  });

  it("refuses a file other users can read", () => {
    admin(home, ADMIN_FILE, 0o644);
    expect(() => daemonAdminAuth(home, {})).toThrow(/chmod 600/);
  });

  it("volleyd daemon passes it on, unless --no-mint", () => {
    admin(home, ADMIN_FILE);
    const env = { VOLLEYD_HOME: home };
    expect(
      daemonStartOptions({ brokerUrl: "mqtt://x", namespace: NS }, env, {}).dynsecAdmin,
    ).toEqual({
      username: "dynsec-admin",
      password: "a",
    });
    expect(
      daemonStartOptions({ brokerUrl: "mqtt://x", namespace: NS }, env, { mintCredentials: false })
        .dynsecAdmin,
    ).toBeUndefined();
  });
});

describe("daemonAuth: volleyd's broker credentials", () => {
  it("reads a 0600 $VOLLEYD_HOME/broker.json", () => {
    writeBrokerFile(JSON.stringify({ username: "volleyd", password: "s3cret" }));
    expect(daemonAuth(home, {})).toEqual({ username: "volleyd", password: "s3cret" });
  });

  it("the file wins over VOLLEY_AUTH_*", () => {
    writeBrokerFile(JSON.stringify({ username: "volleyd", password: "s3cret" }));
    const env = { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "x" };
    expect(daemonAuth(home, env)).toEqual({ username: "volleyd", password: "s3cret" });
  });

  it("refuses a file other users can read (it holds a password)", () => {
    const path = writeBrokerFile(
      JSON.stringify({ username: "volleyd", password: "s3cret" }),
      0o644,
    );
    expect(() => daemonAuth(home, {})).toThrow(`${path} is mode 0644`);
    expect(() => daemonAuth(home, {})).toThrow("chmod 600");
  });

  it("refuses a malformed file instead of connecting anonymously", () => {
    writeBrokerFile("{not json");
    expect(() => daemonAuth(home, {})).toThrow(/broker\.json: malformed/);
    writeBrokerFile(JSON.stringify({ username: "", password: "x" }));
    expect(() => daemonAuth(home, {})).toThrow(/non-empty string username/);
  });

  it("falls back to VOLLEY_AUTH_*, else anonymous (null)", () => {
    expect(
      daemonAuth(home, { VOLLEY_AUTH_USERNAME: "volleyd", VOLLEY_AUTH_PASSWORD: "pw" }),
    ).toEqual({ username: "volleyd", password: "pw" });
    expect(daemonAuth(home, {})).toBeNull();
  });
});

describe("volleyd against a broker that requires credentials", () => {
  let broker: TestBroker;
  let reader: VolleyBroker;
  const daemons: Daemon[] = [];
  beforeEach(async () => {
    broker = await startTestBroker({ users: USERS });
    reader = new VolleyBroker();
    await reader.connect({
      url: broker.url,
      agentId: "test-reader",
      username: "coordinator",
      password: USERS.coordinator,
    });
  });
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop().catch(() => {});
    await reader.disconnect();
    await broker.close();
  });

  const options = (extra: Partial<Parameters<typeof Daemon.start>[0]> = {}) => ({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    tickMs: 0,
    protocolVersion: 4 as const,
    pressure: NO_PRESSURE,
    ...extra,
  });

  const liveStatus = async () => {
    const raw = await reader.queryRetained(`volley/${NS}/volleyd/status`, 500);
    return raw === null || raw === "" ? null : (JSON.parse(raw) as { type: string }).type;
  };

  it("without credentials the daemon is refused (AUTH_FAILED)", async () => {
    await expect(Daemon.start(options())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("with credentials the probe and the daemon connect both authenticate", async () => {
    daemons.push(
      await Daemon.start(options({ auth: { username: "volleyd", password: "volleyd-pw" } })),
    );
    expect(await liveStatus()).toBe("working");
  });

  it("`volleyd daemon` starts with $VOLLEYD_HOME/broker.json; control commands use VOLLEY_AUTH_* (coordinator)", async () => {
    writeBrokerFile(JSON.stringify({ username: "volleyd", password: USERS.volleyd }));
    const env = { VOLLEY_BROKER_URL: broker.url, VOLLEY_NAMESPACE: NS, VOLLEYD_HOME: home };
    const opts = daemonStartOptions({ brokerUrl: broker.url, namespace: NS }, env);
    expect(opts.home).toBe(home);
    expect(opts.auth).toEqual({ username: "volleyd", password: USERS.volleyd });
    // The command's options with the test-only overrides (no timers, no real pressure samplers).
    const { issueBody: _gh, ...rest } = opts;
    daemons.push(
      await Daemon.start({ ...rest, tickMs: 0, protocolVersion: 4, pressure: NO_PRESSURE }),
    );
    expect(await liveStatus()).toBe("working");

    const anon = await runCli(["status"], env);
    expect(anon.exitCode).toBe(1);
    expect(anon.stderr).toMatch(/refused|auth/i);

    const status = await runCli(["status", "--json"], {
      ...env,
      VOLLEY_AUTH_USERNAME: "coordinator",
      VOLLEY_AUTH_PASSWORD: USERS.coordinator,
    });
    expect(status.stderr).toBe("");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ waves: [] });
  });

  it("`volleyd daemon` refuses a group-readable broker.json before connecting", async () => {
    writeBrokerFile(JSON.stringify({ username: "volleyd", password: USERS.volleyd }), 0o640);
    const env = { VOLLEY_BROKER_URL: broker.url, VOLLEY_NAMESPACE: NS, VOLLEYD_HOME: home };
    const r = await runCli(["daemon", "--no-spawn"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("chmod 600");
  });
});

describe("control clients on the supervisor machine (volleyd config get, status, …)", () => {
  const linux: SavedLoginDeps = {
    platform: "linux",
    keychain: () => null,
    coordinatorFile: readSavedCoordinatorFile,
  };
  let dirs = 0;
  /** An auth dir holding the coordinator.json `volley setup` writes. */
  const saved = () => {
    const authDir = join(home, `auth-${dirs++}`);
    mkdirSync(authDir);
    writeFileSync(
      join(authDir, "coordinator.json"),
      JSON.stringify({ username: "coordinator", password: "saved-pw" }),
      { mode: 0o600 },
    );
    return { VOLLEY_AUTH_DIR: authDir };
  };

  it("use the coordinator login setup saved when nothing else names one", () => {
    expect(controlAuth(saved(), home, "mqtt://localhost:1883", linux)).toEqual({
      username: "coordinator",
      password: "saved-pw",
    });
    // The macOS keychain item comes first.
    expect(
      controlAuth(saved(), home, "mqtt://127.0.0.1:1883", {
        ...linux,
        platform: "darwin",
        keychain: () => "keychain-pw",
      }),
    ).toEqual({ username: "coordinator", password: "keychain-pw" });
  });

  it("keep VOLLEY_AUTH_* first, and never send the saved login to another machine's broker", () => {
    const env = { ...saved(), VOLLEY_AUTH_USERNAME: "alice", VOLLEY_AUTH_PASSWORD: "a" };
    expect(controlAuth(env, home, "mqtt://localhost:1883", linux)).toEqual({
      username: "alice",
      password: "a",
    });
    expect(controlAuth(saved(), home, "mqtt://broker.example:1883", linux)).toBeNull();
  });

  it("resolveControlTarget passes the broker URL, so the fallback applies once cli.ts turns it on", () => {
    const env = { ...saved(), VOLLEY_BROKER_URL: "mqtt://localhost:1883" };
    // Off by default: a test never reads this machine's keychain or auth dir.
    expect(savedLoginSource()).toBeNull();
    expect(resolveControlTarget({}, env, home).auth).toBeNull();
    useSavedLogin(linux);
    try {
      expect(resolveControlTarget({}, env, home).auth).toEqual({
        username: "coordinator",
        password: "saved-pw",
      });
      // Never for an agent: volleyd launches every agent with VOLLEY_HOOKS_DIR set.
      expect(resolveControlTarget({}, { ...env, VOLLEY_HOOKS_DIR: "/x" }, home).auth).toBeNull();
    } finally {
      useSavedLogin(null);
    }
  });
});
