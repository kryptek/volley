import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SavedLoginDeps, useSavedLogin } from "../../src/auth/coordinator-login";
import { authStatus } from "../../src/commands/auth-status";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";
import { tempDir } from "../helpers/tmp";

/** `volley auth status` (#613): which login a shell uses, from where, and whether it works. */

/** The coordinator's password: in no stream, ever. */
const MARKER = "hunter2-marker-5be1";
const LOGIN = { username: "coordinator", password: MARKER };

let tb: TestBroker;
let dir: string;
beforeEach(async () => {
  tb = await startTestBroker({ credentials: LOGIN });
  dir = tempDir("volley-auth-status-");
});
afterEach(async () => {
  useSavedLogin(null);
  await tb.close();
});

const linuxFile = (login: { username: string; password: string } | null): SavedLoginDeps => ({
  platform: "linux",
  keychain: () => null,
  coordinatorFile: () => login,
  coordinatorPath: () => "/path/to/auth/coordinator.json",
});
const macKeychain = (password: string | null): SavedLoginDeps => ({
  platform: "darwin",
  keychain: () => password,
  coordinatorFile: () => LOGIN,
  coordinatorPath: () => "/path/to/auth/coordinator.json",
});

const status = async (
  argv: string[],
  env: Record<string, string | undefined> = {},
  url: string = tb.url,
) => {
  const io = makeBufferIO();
  const exitCode = await authStatus(argv, { VOLLEY_BROKER_URL: url, HOME: dir, ...env }, io, {
    cwd: dir,
  });
  const r = { exitCode, stdout: io.readStdout(), stderr: io.readStderr() };
  expect(r.stdout).not.toContain(MARKER);
  expect(r.stderr).not.toContain(MARKER);
  return r;
};

describe("volley auth status: the four lines", () => {
  it("keychain: the coordinator, a fixed identity, accepted", async () => {
    useSavedLogin(macKeychain(MARKER));
    const r = await status([]);
    expect(r.exitCode).toBe(EXIT.OK);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("login:   coordinator (fixed identity)");
    expect(lines[1]).toBe("source:  keychain (volley-broker)");
    expect(lines[2]).toBe(`broker:  ${tb.url} · accepted`);
    expect(lines[3]).toMatch(/^not used: /);
    expect(lines[3]).toContain("env (VOLLEY_AUTH_USERNAME unset)");
    expect(lines[3]).toContain("coordinator.json (keychain answered first)");
  });

  it("coordinator.json: its path", async () => {
    useSavedLogin(linuxFile(LOGIN));
    const r = await status([]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("source:  coordinator.json (/path/to/auth/coordinator.json)");
    expect(r.stdout).toContain("keychain (not macOS)");
  });

  it("env and flags: an account whose role this machine knows, or does not", async () => {
    const auth = join(dir, "auth");
    mkdirSync(auth);
    writeFileSync(
      join(auth, "accounts.json"),
      JSON.stringify({
        accounts: [
          { name: "boss", role: "admin", kind: "human", created: "2026-10-19T00:00:00.000Z" },
        ],
      }),
    );
    const env = { VOLLEY_AUTH_USERNAME: "boss", VOLLEY_AUTH_PASSWORD: MARKER };
    // The broker takes only the coordinator: this login is refused (exit 1), and still described.
    const r = await status([], { ...env, VOLLEY_AUTH_DIR: auth });
    expect(r.stdout).toContain("login:   boss (admin account)");
    expect(r.stdout).toContain("source:  env\n");
    expect(r.stdout).toContain(`broker:  ${tb.url} · refused`);
    expect(r.exitCode).toBe(EXIT.ERROR);
    const flags = await status(["--username", "someone"], { VOLLEY_AUTH_PASSWORD: MARKER });
    expect(flags.stdout).toContain("login:   someone (account; role not known here)");
    expect(flags.stdout).toContain("source:  flags\n");
  });

  it("the auth dir VOLLEY_AUTH_DIR names (the volleyd-run coordinator's session)", async () => {
    const auth = join(dir, "role-auth");
    mkdirSync(auth);
    writeFileSync(join(auth, "coordinator.json"), JSON.stringify(LOGIN), { mode: 0o600 });
    const r = await status([], {
      VOLLEY_AGENT_ID: "coordinator",
      VOLLEY_AUTH_DIR: auth,
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_HOOKS_DIR: "/path/to/volley-hooks",
    });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain(`source:  auth dir (${join(auth, "coordinator.json")})`);
    expect(r.stdout).toContain("· accepted");
  });
});

describe("volley auth status: the broker's answer", () => {
  it("--password without --username is a usage mistake, exit 2", async () => {
    const r = await status(["--password", "x"]);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--password requires --username");
  });

  it("no login at all: every step says why, exit 1", async () => {
    useSavedLogin(linuxFile(null));
    const r = await status([]);
    expect(r.exitCode).toBe(EXIT.ERROR);
    expect(r.stdout).toContain("login:   none (anonymous)");
    for (const step of [
      "flags",
      "identity file",
      "env",
      "auth dir",
      "keychain",
      "coordinator.json",
    ])
      expect(r.stdout).toContain(`${step} (`);
  });

  it("no broker: unreachable, exit 69 with the usual diagnosis", async () => {
    // A port nothing listens on.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    useSavedLogin(linuxFile(LOGIN));
    const r = await status([], {}, `mqtt://127.0.0.1:${port}`);
    expect(r.stdout).toContain("· unreachable");
    expect(r.exitCode).toBe(EXIT.SUPERVISOR_UNREACHABLE);
  });

  it("--json: the shape, never the password", async () => {
    useSavedLogin(macKeychain(MARKER));
    const r = await status(["--json"]);
    expect(r.exitCode).toBe(EXIT.OK);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(j).toMatchObject({
      username: "coordinator",
      kind: "fixed",
      source: "keychain",
      broker: { url: tb.url, result: "accepted" },
    });
    expect(Array.isArray(j.skipped)).toBe(true);
    expect(Object.keys(j).sort()).toEqual(
      ["broker", "kind", "skipped", "source", "username"].sort(),
    );
    useSavedLogin(linuxFile(LOGIN));
    const file = JSON.parse((await status(["--json"])).stdout) as Record<string, unknown>;
    expect(file).toMatchObject({
      source: "coordinator_file",
      path: "/path/to/auth/coordinator.json",
    });
  });

  it("is a `volley auth` verb that needs no admin login, and has its own help", async () => {
    const r = await runCli({ argv: ["auth", "status", "--help"] });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toContain("Usage: volley auth status [--json]");
    const help = await runCli({ argv: ["auth", "--help"] });
    expect(help.stdout).toContain("volley auth status [--json]");
  });
});
