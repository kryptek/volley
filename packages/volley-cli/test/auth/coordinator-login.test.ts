import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuth } from "../../src/args";
import {
  type SavedLoginDeps,
  isLocalBroker,
  keychainReadArgv,
  savedCoordinatorLogin,
} from "../../src/auth/coordinator-login";

const LOCAL = "mqtt://localhost:1883";

describe("the coordinator login on the supervisor machine", () => {
  let dir: string;
  let calls: number;
  const deps = (platform: NodeJS.Platform, keychain: string | null): SavedLoginDeps => ({
    platform,
    keychain: () => {
      calls++;
      return keychain;
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
    calls = 0;
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
    expect(savedCoordinatorLogin(env, LOCAL, deps("darwin", "from-keychain"))).toEqual({
      username: "coordinator",
      password: "from-keychain",
    });
    expect(savedCoordinatorLogin(env, LOCAL, deps("darwin", null))).toEqual({
      username: "coordinator",
      password: "from-file",
    });
  });

  it("Linux: no keychain, the auth dir's coordinator.json", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth") };
    writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
    expect(savedCoordinatorLogin(env, LOCAL, deps("linux", "unused"))).toEqual({
      username: "coordinator",
      password: "from-file",
    });
    expect(calls).toBe(0);
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
    expect(savedCoordinatorLogin({ VOLLEYD_HOME: home }, LOCAL, deps("linux", null))).toEqual({
      username: "coordinator",
      password: "recorded",
    });
  });

  it("never sends the login to a broker on another machine", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth") };
    writeLogin(env.VOLLEY_AUTH_DIR, "from-file");
    expect(
      savedCoordinatorLogin(env, "mqtt://broker.example:1883", deps("darwin", "k")),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("is null when there is nothing saved, and skips a file it may not read", () => {
    const env = { VOLLEY_AUTH_DIR: join(dir, "auth"), VOLLEYD_HOME: join(dir, "none") };
    expect(savedCoordinatorLogin(env, LOCAL, deps("darwin", null))).toBeNull();
    if (process.getuid?.() !== 0) {
      writeLogin(env.VOLLEY_AUTH_DIR, "root-only", 0o000);
      expect(savedCoordinatorLogin(env, LOCAL, deps("linux", null))).toBeNull();
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
