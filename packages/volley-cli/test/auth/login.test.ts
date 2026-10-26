import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SavedLoginDeps } from "../../src/auth/coordinator-login";
import { type LoginSource, resolveLogin } from "../../src/auth/login";
import { tempDir } from "../helpers/tmp";

/** Every fake password carries it: it may appear in `auth.password` and nowhere else. */
const MARKER = "hunter2-marker-91c4";
const LOCAL = "mqtt://127.0.0.1:1883";

let dir: string;
let calls: { keychain: number; file: number };

/** Fake saved-login sources: a keychain answer and a coordinator.json answer, both counted. */
const saved = (o: { keychain?: boolean; file?: boolean; platform?: NodeJS.Platform } = {}) =>
  ({
    platform: o.platform ?? "darwin",
    keychain: () => {
      calls.keychain++;
      return o.keychain === true ? `${MARKER}-keychain` : null;
    },
    coordinatorFile: () => {
      calls.file++;
      return o.file === true ? { username: "coordinator", password: `${MARKER}-file` } : null;
    },
    coordinatorPath: () => "/path/to/auth/coordinator.json",
  }) satisfies SavedLoginDeps;

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
};

/** A worktree with an identity file carrying its own minted login. */
const identityDir = (password = `${MARKER}-identity`) => {
  const wt = join(dir, "wt");
  writeJson(join(wt, ".volley", "agent.json"), {
    agent_id: "w1-t1-impl",
    broker: { username: "w1-t1-impl", password },
  });
  return wt;
};

/** An auth dir holding coordinator.json. */
const authDir = (password = `${MARKER}-authdir`) => {
  const d = join(dir, "auth");
  writeJson(join(d, "coordinator.json"), { username: "coordinator", password });
  return d;
};

beforeEach(() => {
  dir = tempDir("volley-login-");
  calls = { keychain: 0, file: 0 };
});

/** Every source alone: its input. */
const ALONE: Record<LoginSource, () => Parameters<typeof resolveLogin>[0]> = {
  flags: () => ({ flags: { username: "alice", password: `${MARKER}-flags` }, env: {}, cwd: dir }),
  identity_file: () => ({ env: {}, cwd: identityDir() }),
  env: () => ({
    env: { VOLLEY_AUTH_USERNAME: "bob", VOLLEY_AUTH_PASSWORD: `${MARKER}-env` },
    cwd: dir,
  }),
  auth_dir: () => ({ env: { VOLLEY_AUTH_DIR: authDir() }, cwd: dir, saved: null }),
  keychain: () => ({ env: {}, cwd: dir, brokerUrl: LOCAL, saved: saved({ keychain: true }) }),
  coordinator_file: () => ({
    env: {},
    cwd: dir,
    brokerUrl: LOCAL,
    saved: saved({ file: true, platform: "linux" }),
  }),
};

describe("resolveLogin: one ladder for every CLI", () => {
  it.each(Object.keys(ALONE) as LoginSource[])("%s alone resolves with its source", (source) => {
    const r = resolveLogin(ALONE[source]());
    expect(r.source).toBe(source);
    expect(r.auth?.password).toContain(MARKER);
  });

  it("names the file a file step read", () => {
    expect(resolveLogin(ALONE.identity_file()).path).toBe(join(dir, "wt", ".volley", "agent.json"));
    expect(resolveLogin(ALONE.auth_dir()).path).toBe(join(dir, "auth", "coordinator.json"));
    expect(resolveLogin(ALONE.coordinator_file()).path).toBe("/path/to/auth/coordinator.json");
  });

  it("two at once: the earlier wins and the later is in skipped", () => {
    const both = resolveLogin({
      env: {
        VOLLEY_AUTH_USERNAME: "bob",
        VOLLEY_AUTH_PASSWORD: `${MARKER}-env`,
        VOLLEY_AUTH_DIR: authDir(),
      },
      cwd: identityDir(),
      brokerUrl: LOCAL,
      saved: saved({ keychain: true, file: true }),
    });
    expect(both.source).toBe("identity_file");
    expect(both.skipped).toContain("env (identity file answered first)");
    expect(both.skipped).toContain("auth dir (identity file answered first)");
    const keychainFirst = resolveLogin(ALONE.keychain());
    expect(keychainFirst.skipped).toContain("coordinator.json (keychain answered first)");
    expect(keychainFirst.skipped).toContain("env (VOLLEY_AUTH_USERNAME unset)");
  });

  it("env beats every store step, and the stores are never asked", () => {
    const r = resolveLogin({
      env: {
        VOLLEY_AUTH_USERNAME: "bob",
        VOLLEY_AUTH_PASSWORD: `${MARKER}-env`,
        VOLLEY_AUTH_DIR: authDir(),
      },
      cwd: dir,
      brokerUrl: LOCAL,
      saved: saved({ keychain: true, file: true }),
    });
    expect(r).toMatchObject({ source: "env", auth: { username: "bob" } });
    expect(calls).toEqual({ keychain: 0, file: 0 });
  });

  it("--password without --username throws; --username takes VOLLEY_AUTH_PASSWORD", () => {
    expect(() => resolveLogin({ flags: { password: "x" }, env: {}, cwd: dir })).toThrow(
      "--password requires --username",
    );
    expect(
      resolveLogin({
        flags: { username: "alice" },
        env: { VOLLEY_AUTH_PASSWORD: "pw" },
        cwd: dir,
      }).auth,
    ).toEqual({ username: "alice", password: "pw" });
  });

  it("no login at all: null, and every step says why", () => {
    const r = resolveLogin({ env: {}, cwd: dir, brokerUrl: LOCAL, saved: saved() });
    expect(r).toMatchObject({ auth: null, source: null });
    expect(r.skipped).toEqual([
      "flags (no --username)",
      `identity file (no ${join(dir, ".volley", "agent.json")})`,
      "env (VOLLEY_AUTH_USERNAME unset)",
      "auth dir (VOLLEY_AUTH_DIR unset)",
      "keychain (no keychain item volley-broker/coordinator)",
      "coordinator.json (none readable at /path/to/auth/coordinator.json)",
    ]);
  });

  it("the store guards say themselves: opted out, another machine's broker", () => {
    const off = resolveLogin({
      env: { VOLLEY_NO_SAVED_LOGIN: "1", VOLLEY_AUTH_DIR: authDir() },
      cwd: dir,
      brokerUrl: LOCAL,
      saved: saved({ keychain: true }),
    });
    expect(off.auth).toBeNull();
    expect(off.skipped).toContain("auth dir (VOLLEY_NO_SAVED_LOGIN is set)");
    expect(off.skipped).toContain("keychain (VOLLEY_NO_SAVED_LOGIN is set)");
    const remote = resolveLogin({
      env: {},
      cwd: dir,
      brokerUrl: "mqtt://broker.example:1883",
      saved: saved({ keychain: true }),
    });
    expect(remote.skipped).toContain(
      "keychain (broker mqtt://broker.example:1883 is not on this machine)",
    );
    expect(calls).toEqual({ keychain: 0, file: 0 });
  });

  it("the auth dir's file serves a broker on another machine (the coordinator role on a peer)", () => {
    const r = resolveLogin({
      env: { VOLLEY_AUTH_DIR: authDir() },
      cwd: dir,
      brokerUrl: "mqtt://hub.example:1883",
      saved: null,
    });
    expect(r.source).toBe("auth_dir");
  });
});

describe("resolveLogin: the coordinator role and dispatched agents", () => {
  /** coordinatorEnv (volleyd/src/coordinator/role.ts), with the auth dir's file. */
  const coordinatorEnv = () => ({
    VOLLEY_AGENT_ID: "coordinator",
    VOLLEY_COORDINATOR: "coord-main",
    VOLLEY_BROKER_URL: LOCAL,
    VOLLEY_AUTH_DIR: authDir(),
    VOLLEY_HOOKS_COORDINATOR: "1",
    VOLLEY_HOOKS_DIR: "/path/to/volley-hooks",
  });

  it("the volleyd-run coordinator logs in through VOLLEY_AUTH_DIR from any cwd without an identity file above", () => {
    const deep = join(dir, "a", "b");
    mkdirSync(deep, { recursive: true });
    for (const cwd of [dir, deep]) {
      const r = resolveLogin({ env: coordinatorEnv(), cwd, brokerUrl: LOCAL, saved: saved() });
      expect(r.source).toBe("auth_dir");
      expect(r.auth?.username).toBe("coordinator");
    }
    expect(calls).toEqual({ keychain: 0, file: 0 });
  });

  it("the same env inside a worktree resolves the identity file", () => {
    const r = resolveLogin({ env: coordinatorEnv(), cwd: identityDir(), brokerUrl: LOCAL });
    expect(r.source).toBe("identity_file");
  });

  it("…and from a worktree's subdirectory (identity file above, no broker block here) nothing", () => {
    const wt = identityDir();
    const sub = join(wt, "src");
    mkdirSync(sub, { recursive: true });
    const r = resolveLogin({ env: coordinatorEnv(), cwd: sub, brokerUrl: LOCAL, saved: saved() });
    expect(r.auth).toBeNull();
    expect(r.skipped.some((s) => s.startsWith("auth dir (agent context:"))).toBe(true);
  });

  it("a dispatched agent's env with VOLLEY_AUTH_DIR resolves nothing, and no store is asked", () => {
    for (const marker of [
      { VOLLEY_HOOKS_DIR: "/path/to/volley-hooks" },
      { VOLLEY_AGENT_ID: "w1-t1-impl" },
      // Only the literal "1" is the coordinator switch.
      { VOLLEY_AGENT_ID: "w1-t1-impl", VOLLEY_HOOKS_COORDINATOR: "0" },
    ]) {
      const r = resolveLogin({
        env: { VOLLEY_AUTH_DIR: authDir(), ...marker },
        cwd: dir,
        brokerUrl: LOCAL,
        saved: saved({ keychain: true, file: true }),
      });
      expect(r.auth).toBeNull();
      const key = Object.keys(marker)[0];
      expect(r.skipped).toContain(`auth dir (agent context: ${key} is set)`);
      expect(r.skipped).toContain(`keychain (agent context: ${key} is set)`);
    }
    expect(calls).toEqual({ keychain: 0, file: 0 });
  });
});

describe("resolveLogin never carries a password outside auth.password", () => {
  it("for every source, and for none", () => {
    const inputs = [
      ...Object.values(ALONE).map((f) => f()),
      { env: {}, cwd: dir, brokerUrl: LOCAL, saved: saved() },
    ];
    for (const input of inputs) {
      const r = resolveLogin(input);
      const { auth, ...rest } = r;
      expect(JSON.stringify(rest)).not.toContain(MARKER);
      expect(auth?.username ?? "").not.toContain(MARKER);
    }
  });
});
