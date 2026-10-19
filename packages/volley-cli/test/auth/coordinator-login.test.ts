import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuth } from "../../src/args";
import {
  type SavedLoginDeps,
  agentContext,
  fileSavedLoginDeps,
  isLocalBroker,
  keychainReadArgv,
  readSavedCoordinatorFile,
  savedCoordinatorLogin,
  savedLoginSource,
} from "../../src/auth/coordinator-login";

const LOCAL = "mqtt://localhost:1883";

describe("the coordinator login on the supervisor machine", () => {
  let dir: string;
  let keychainCalls: number;
  let fileCalls: number;
  /** Fake sources: a keychain answer, and the auth dir's file read only from the test's temp dir. */
  const deps = (platform: NodeJS.Platform, keychain: string | null): SavedLoginDeps => ({
    platform,
    keychain: () => {
      keychainCalls++;
      return keychain;
    },
    coordinatorFile: (env) => {
      fileCalls++;
      expect(env.VOLLEY_AUTH_DIR ?? env.VOLLEYD_HOME ?? "").toContain(dir);
      return readSavedCoordinatorFile(env);
    },
  });
  const writeLogin = (authDir: string, password: string, mode = 0o600) => {
    mkdirSync(authDir, { recursive: true });
    const f = join(authDir, "coordinator.json");
    writeFileSync(f, JSON.stringify({ username: "coordinator", password }));
    chmodSync(f, mode);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volley-coord-login-"));
    keychainCalls = 0;
    fileCalls = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the keychain item setup stores, by service and account, never a password on argv", () => {
    expect(keychainReadArgv).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "volley-broker",
      "-a",
      "coordinator",
      "-w",
    ]);
  });

  it("macOS: the keychain first, then the auth dir's coordinator.json", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth") };
    writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
    expect(savedCoordinatorLogin(env, LOCAL, dir, deps("darwin", "from-keychain"))).toEqual({
      username: "coordinator",
      password: "from-keychain",
    });
    expect(savedCoordinatorLogin(env, LOCAL, dir, deps("darwin", null))).toEqual({
      username: "coordinator",
      password: "from-file",
    });
  });

  it("Linux: no keychain, the auth dir's coordinator.json", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth") };
    writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
    expect(savedCoordinatorLogin(env, LOCAL, dir, deps("linux", "unused"))).toEqual({
      username: "coordinator",
      password: "from-file",
    });
    expect(keychainCalls).toBe(0);
  });

  it("finds the auth dir setup recorded in $VOLLEYD_HOME/setup.json when VOLLEY_AUTH_DIR is unset", () => {
    const home = join(dir, "volleyd");
    mkdirSync(home, { recursive: true });
    const authDir = join(dir, "custom-auth");
    writeLogin(authDir, "recorded");
    writeFileSync(
      join(home, "setup.json"),
      JSON.stringify({
        layout: "brew-arm64",
        config: "/x/mosquitto.conf",
        state_file: "/x/dynamic-security.json",
        auth_dir: authDir,
      }),
    );
    expect(savedCoordinatorLogin({ VOLLEYD_HOME: home }, LOCAL, dir, deps("linux", null))).toEqual({
      username: "coordinator",
      password: "recorded",
    });
  });

  it("never sends the login to a broker on another machine", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth") };
    writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
    expect(
      savedCoordinatorLogin(env, "mqtt://broker.example:1883", dir, deps("darwin", "k")),
    ).toBeNull();
    expect(keychainCalls + fileCalls).toBe(0);
  });

  it("is null when there is nothing saved, and skips a file it may not read", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth"), VOLLEYD_HOME: join(dir, "none") };
    expect(savedCoordinatorLogin(env, LOCAL, dir, deps("darwin", null))).toBeNull();
    if (process.getuid?.() !== 0) {
      writeLogin(env.VOLLEY_AUTH_DIR, "root-only", 0o000);
      expect(savedCoordinatorLogin(env, LOCAL, dir, deps("linux", null))).toBeNull();
    }
  });

  it("knows a broker on this machine", () => {
    for (const u of [
      "mqtt://localhost:1883",
      "mqtt://127.0.0.1:18830",
      "mqtt://[::1]:1883",
      "ws://localhost:9001",
    ]) {
      expect(isLocalBroker(u)).toBe(true);
    }
    for (const u of ["mqtt://10.0.0.5:1883", "mqtt://broker.example", "not a url"]) {
      expect(isLocalBroker(u)).toBe(false);
    }
  });

  describe("an agent never becomes the coordinator", () => {
    /** An agent's worktree as volleyd sets it up: its identity file with its own minted login. */
    const worktree = () => {
      const wt = join(dir, "wt");
      mkdirSync(join(wt, ".volley"), { recursive: true });
      mkdirSync(join(wt, "packages", "deep", "src"), { recursive: true });
      writeFileSync(
        join(wt, ".volley", "agent.json"),
        JSON.stringify({ agent_id: "w1-t1-impl", namespace: "default" }),
      );
      return wt;
    };

    it("not from a subdirectory of its worktree (the identity file has no broker block there)", () => {
      const authDir = join(dir, "auth");
      writeLogin(authDir, "coordinator-pw");
      const wt = worktree();
      const sub = join(wt, "packages", "deep", "src");
      const env = { VOLLEY_AUTH_DIR: authDir };
      for (const cwd of [wt, sub]) {
        expect(savedCoordinatorLogin(env, LOCAL, cwd, deps("darwin", "keychain-pw"))).toBeNull();
        expect(resolveAuth({}, env, cwd, LOCAL, deps("darwin", "keychain-pw"))).toBeNull();
      }
      expect(keychainCalls + fileCalls).toBe(0);
      expect(agentContext(env, sub)).toContain(join(wt, ".volley", "agent.json"));
    });

    it("not when volleyd launched it (VOLLEY_HOOKS_DIR) or it names an agent id, from any directory", () => {
      const authDir = join(dir, "auth");
      writeLogin(authDir, "coordinator-pw");
      for (const marker of [
        { VOLLEY_HOOKS_DIR: "/opt/volley/packages/volley-hooks" },
        { VOLLEY_AGENT_ID: "w1-t1-impl" },
      ]) {
        const env = { VOLLEY_AUTH_DIR: authDir, ...marker };
        expect(savedCoordinatorLogin(env, LOCAL, dir, deps("darwin", "keychain-pw"))).toBeNull();
        expect(resolveAuth({}, env, dir, LOCAL, deps("linux", null))).toBeNull();
      }
      expect(keychainCalls + fileCalls).toBe(0);
    });

    it("an operator in a plain directory still gets it", () => {
      expect(agentContext({}, dir)).toBeNull();
    });
  });

  describe("never reads this machine's real login under a test", () => {
    it("is off in a process no CLI entry point turned it on in", () => {
      expect(savedLoginSource()).toBeNull();
      // Default sources: nothing is asked, whatever this machine has saved.
      expect(savedCoordinatorLogin({}, LOCAL, dir)).toBeNull();
      expect(resolveAuth({}, {}, dir, LOCAL)).toBeNull();
    });

    it("is off in every CLI a test starts (vitest sets VOLLEY_NO_SAVED_LOGIN for children)", () => {
      expect(process.env.VOLLEY_NO_SAVED_LOGIN).toBe("1");
      const env = { VOLLEY_AUTH_DIR: join(dir, "auth"), VOLLEY_NO_SAVED_LOGIN: "1" };
      writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
      expect(savedCoordinatorLogin(env, LOCAL, dir, deps("darwin", "k"))).toBeNull();
      expect(keychainCalls + fileCalls).toBe(0);
    });

    it("only the two entry points turn it on, and volleyd's never asks the keychain", () => {
      const root = join(import.meta.dirname, "..", "..", "..");
      const cli = readFileSync(join(root, "volley-cli", "src", "cli.ts"), "utf-8");
      const volleyd = readFileSync(join(root, "volleyd", "src", "cli.ts"), "utf-8");
      const entry = (text: string) => text.slice(text.indexOf("if (import.meta.main) {"));
      expect(entry(cli)).toContain("useSavedLogin(realSavedLoginDeps)");
      expect(entry(volleyd)).toContain("useSavedLogin(fileSavedLoginDeps)");
      expect(volleyd).not.toContain("realSavedLoginDeps");
      expect(fileSavedLoginDeps.keychain()).toBeNull();
    });
  });

  describe("resolveAuth (every volley CLI command)", () => {
    it("flags, then the identity file, then VOLLEY_AUTH_*, then the saved login", () => {
      const authDir = join(dir, "auth");
      writeLogin(authDir, "saved");
      const env = { VOLLEY_AUTH_DIR: authDir };
      const d = deps("darwin", null);
      expect(resolveAuth({}, env, dir, LOCAL, d)).toEqual({
        username: "coordinator",
        password: "saved",
      });
      expect(
        resolveAuth(
          {},
          { ...env, VOLLEY_AUTH_USERNAME: "alice", VOLLEY_AUTH_PASSWORD: "pw" },
          dir,
          LOCAL,
          d,
        ),
      ).toEqual({ username: "alice", password: "pw" });
      expect(resolveAuth({ username: "bob", password: "x" }, env, dir, LOCAL, d)).toEqual({
        username: "bob",
        password: "x",
      });
      // Without the broker URL (an older caller) or for a remote broker: anonymous, as before.
      expect(resolveAuth({}, env, dir, undefined, d)).toBeNull();
      expect(resolveAuth({}, env, dir, "mqtt://broker.example:1883", d)).toBeNull();
    });
  });
});
