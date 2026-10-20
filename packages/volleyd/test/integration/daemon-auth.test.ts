import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { BROKER_FILE } from "../../src/broker-auth";
import { ControlClient } from "../../src/control";
import { tempDir } from "../helpers/tmp";

/**
 * `volleyd daemon` against real mosquitto 2.1 with `allow_anonymous false` and Volley's shared
 * Dynamic Security roles. Opt-in: needs VOLLEY_INTEGRATION=1 and VOLLEY_AUTH_BROKER_URL pointing
 * at a PRIVATE broker bootstrapped by volley-cli's test/integration/dynsec-fixture.ts (each
 * password is "<username>-test-pw").
 */
const AUTH_URL = process.env.VOLLEY_AUTH_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && AUTH_URL !== undefined;
// Only read inside the suite, which RUN gates on AUTH_URL being set: there is no default broker.
const BROKER_URL = AUTH_URL as string;
const NS = `volleydauth-${randomBytes(3).toString("hex")}`;
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const pw = (user: string) => `${user}-test-pw`;

interface Run {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

/** `bun src/cli.ts daemon --no-spawn` with its own $VOLLEYD_HOME. */
function startDaemon(home: string, extraEnv: Record<string, string> = {}): Run {
  // vitest runs under node; the CLI is TypeScript run by bun (no build step).
  const bun = process.versions.bun !== undefined ? process.execPath : "bun";
  const child = spawn(bun, [CLI, "daemon", "--no-spawn"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      VOLLEYD_HOME: home,
      VOLLEY_BROKER_URL: BROKER_URL,
      VOLLEY_NAMESPACE: NS,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  return { child, out: () => out, exited };
}

describe.skipIf(!RUN)("volleyd daemon against mosquitto 2.1 Dynamic Security", () => {
  let observer: VolleyBroker;
  const newHome = () => tempDir("volleyd-auth-it-");

  const status = async (): Promise<string | null> => {
    const raw = await observer.queryRetained(`volley/${NS}/volleyd/status`, 500);
    return raw === null || raw === "" ? null : (JSON.parse(raw) as { type: string }).type;
  };

  beforeAll(async () => {
    observer = new VolleyBroker();
    await observer.connect({
      url: BROKER_URL,
      agentId: `${NS}-observer`,
      username: "coordinator",
      password: pw("coordinator"),
    });
  });

  afterAll(async () => {
    if (observer) {
      // The daemon's own retained records in this run's namespace.
      for (const ch of ["status", "mailbox"]) {
        await observer.publish(`volley/${NS}/volleyd/${ch}`, "", { qos: 1, retain: true });
      }
      await observer.disconnect();
    }
  });

  it("without credentials it exits 1 with AUTH_FAILED", async () => {
    const run = startDaemon(newHome());
    expect(await run.exited).toBe(1);
    expect(run.out()).toMatch(/AUTH_FAILED|refused/);
  });

  it("with $VOLLEYD_HOME/broker.json it runs, answers a coordinator's control request, and stops cleanly", async () => {
    const home = newHome();
    writeFileSync(
      join(home, BROKER_FILE),
      JSON.stringify({ username: "volleyd", password: pw("volleyd") }),
      { mode: 0o600 },
    );
    const run = startDaemon(home);
    try {
      for (let i = 0; i < 200 && (await status()) !== "working"; i++) {
        // broker round-trip: the daemon child process's retained status on the real mosquitto.
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await status(), run.out()).toBe("working");

      // The ACL lets a coordinator write volleyd's mailbox; volleyd writes the reply mailbox.
      const client = await ControlClient.connect(BROKER_URL, NS, {
        username: "coordinator",
        password: pw("coordinator"),
      });
      try {
        const res = await client.request("status", {});
        expect(res.ok).toBe(true);
        expect(res.result).toEqual({ waves: [] });
      } finally {
        await client.close();
      }
    } finally {
      run.child.kill("SIGTERM");
    }
    expect(await run.exited, run.out()).toBe(0);
    expect(await status()).toBe("done");
  }, 60_000);
});
