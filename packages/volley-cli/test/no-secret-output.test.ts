import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";
import { tempDir } from "./helpers/tmp";

/**
 * A damaged coordinator.json never reaches a stream (#613): the parser's message quotes the text
 * it failed on, so a password fragment would. Every command names the path and exits 1.
 */

const MARKER = "hunter2-marker-0a7e";

/** The four ways the file arrives broken. */
const DAMAGED: [string, string, number][] = [
  ["only the marker", MARKER, 0o600],
  ["the marker as an unquoted value", `{"username":"coordinator","password":${MARKER}}`, 0o600],
  ["truncated inside the password", `{"username":"coordinator","password":"${MARKER}`, 0o600],
  ["0644 holding the marker", MARKER, 0o644],
];

const COMMANDS: [string, string[]][] = [
  ["volley list", ["list"]],
  ["volley wait", ["wait", "--agent-id", "w1-t1-impl", "--timeout", "1"]],
  ["volley repo add", ["repo", "add", "a/a", "--timeout", "1"]],
  ["volley auth status", ["auth", "status"]],
];

let authDir: string;
const cwd = process.cwd();
beforeEach(() => {
  authDir = tempDir("volley-no-secret-");
  // A plain directory: no agent identity file above it (this repo may run inside a worktree).
  process.chdir(authDir);
});
afterEach(() => {
  process.chdir(cwd);
});

describe.each(DAMAGED)("a coordinator.json with %s", (_what, text, mode) => {
  it.each(COMMANDS)("%s: exit 1, the path on stderr, the marker nowhere", async (_name, argv) => {
    const path = join(authDir, "coordinator.json");
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
    const r = await runCli({
      argv,
      env: {
        VOLLEY_AUTH_DIR: authDir,
        // A port nothing answers on: the command must fail before it connects.
        VOLLEY_BROKER_URL: "mqtt://127.0.0.1:9",
        HOME: authDir,
        VOLLEYD_HOME: join(authDir, "volleyd"),
      },
    });
    expect(r.stderr).toContain(path);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).not.toContain(MARKER);
    expect(r.exitCode).toBe(1);
  });
});
