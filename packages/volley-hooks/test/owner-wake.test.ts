import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { coordinatorStateDir } from "../src/lib/identity";
import { summaryLineOf, wakeLine } from "../src/lib/owner-waves";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  type HookRun,
  connectClient,
  eventually,
  fixture,
  makeWorkdir,
  publishEnvelope,
  publishRegistry,
  runScript,
  tick,
} from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const COORD = "coordinator-ab12";
const OTHER = "coordinator-zz99";
const SESSION = "3f1c2a90-5b7e-4d21-9a0c-6e8f1b2d4c77";

let broker: TestBroker;
let client: VolleyBroker;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const runWaiter = (stdin: string, opts: { cwd: string; env?: Record<string, string> }) =>
  runScript(join("src", "hooks", "owner-wake.ts"), stdin, opts);

async function publishState(wave: string, status: string, owner: string): Promise<void> {
  await publishEnvelope(
    client,
    `volley/_waves/${wave}/state`,
    {
      agentId: "volleyd",
      parentId: null,
      channel: "_waves/state",
      type: "wave_state",
      payload: {
        wave,
        owner,
        release_branch: `release/${wave}`,
        status,
        tasks: [],
        open_decisions: [],
        gates: [],
        updated_at: new Date().toISOString(),
        coordinator: {
          agent_id: owner,
          presence: "online",
          state: "working",
          last_seen: new Date().toISOString(),
        },
      },
    },
    { qos: 1, retain: true },
  );
}

function digest(wave: string, generatedAt: string, trigger = "wave_complete") {
  return {
    wave,
    release_branch: `release/${wave}`,
    generated_at: generatedAt,
    trigger,
    shipped: [
      {
        task: "T1",
        issue: 7,
        pr: { number: 12, url: "https://example.invalid/pr/12" },
        merge_sha: null,
        merged_by: "supervisor",
      },
    ],
    closes: [7],
    auto: {
      decisions_resolved: 0,
      flakes_fixed: [],
      conflicts_resolved: 0,
      retries: 0,
      rebases: 0,
    },
    waiting: [],
    failures: [],
    held: [],
  };
}

async function publishDigest(wave: string, generatedAt: string, trigger?: string): Promise<void> {
  await publishEnvelope(
    client,
    `volley/_waves/${wave}/digest`,
    {
      agentId: "volleyd",
      parentId: null,
      channel: "_waves/digest",
      type: "digest",
      payload: digest(wave, generatedAt, trigger),
    },
    { qos: 1, retain: true },
  );
}

describe("owner-wake (agent mode)", () => {
  it("exits 0 at once without opening a socket", async () => {
    const dir = makeWorkdir({
      agent_id: "w1-t1-implementer-1",
      namespace: "ns",
      broker_url: broker.url,
    });
    const before = broker.connections();
    const run = await runWaiter(fixture("stop-owner-wake.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(broker.connections()).toBe(before);
  });
});

describe("owner-wake (coordinator mode)", () => {
  let dir: string;
  let env: Record<string, string>;
  let stateDir: string;
  const lockPath = () => join(stateDir, "owner-wake.lock");

  beforeEach(async () => {
    dir = makeWorkdir();
    env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
      VOLLEY_OWNER_WAKE_SETTLE_MS: "300",
    };
    stateDir = coordinatorStateDir(dir, env, `session:${SESSION}`);
    await publishRegistry(client, COORD, "default", {
      capabilities: [],
      cwd: dir,
      started_at: "2026-11-08T10:00:00.000Z",
    });
  });

  const start = (extra: Record<string, string> = {}): Promise<HookRun> =>
    runWaiter(fixture("stop-owner-wake.json", dir), { cwd: dir, env: { ...env, ...extra } });

  it("owning nothing: exits 0 after one read, nothing armed", async () => {
    await publishState("w2", "running", OTHER);
    const run = await start();
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("owning a running wave: ignores a digest published before the arm, wakes on the next one", async () => {
    await publishState("w1", "running", COORD);
    await publishDigest("w1", "2026-11-08T09:00:00.000Z", "escalation");
    const waiting = start();
    await eventually(() => existsSync(lockPath()), 5000);
    const lock = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(lock).toMatchObject({ pid: expect.any(Number), armed_at: expect.any(String) });
    // The retained digest from before the arm has been delivered (MQTT 3.1.1) and dropped.
    await tick(400);
    expect(existsSync(lockPath())).toBe(true);
    await publishDigest("w1", new Date().toISOString());
    const run = await waiting;
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(
      /^\[volley owner-wake\] wave w1: wave_complete — w1 complete: 1 shipped\. Run `volleyd digest w1`/,
    );
    expect(run.stderr).toContain("the next Stop re-arms this wake");
    expect(existsSync(lockPath())).toBe(false);
    const record = JSON.parse(readFileSync(join(stateDir, "owner-wake.json"), "utf-8"));
    expect(record).toMatchObject({
      wave: "w1",
      trigger: "wave_complete",
      generated_at: expect.any(String),
      woke_at: expect.any(String),
    });
  });

  it("a digest for a wave another coordinator owns does not wake", async () => {
    await publishState("w1", "running", COORD);
    await publishState("w2", "running", OTHER);
    let done = false;
    const waiting = start().then((r) => {
      done = true;
      return r;
    });
    await eventually(() => existsSync(lockPath()), 5000);
    await publishDigest("w2", new Date().toISOString());
    await tick(600);
    expect(done).toBe(false);
    await publishDigest("w1", new Date().toISOString(), "stopped");
    const run = await waiting;
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/^\[volley owner-wake\] wave w1: stopped — /);
  });

  it("a second waiter while the first holds the lock exits 0 at once", async () => {
    await publishState("w1", "running", COORD);
    const first = start();
    await eventually(() => existsSync(lockPath()), 5000);
    const second = await start();
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(existsSync(lockPath())).toBe(true);
    await publishDigest("w1", new Date().toISOString());
    expect((await first).exitCode).toBe(2);
  });

  it("a stale lock (its pid is dead) is taken over", async () => {
    await publishState("w1", "running", COORD);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 2 ** 22 + 12345, armed_at: "2026-11-08T08:00:00.000Z" }),
    );
    const waiting = start();
    await eventually(() => {
      try {
        return JSON.parse(readFileSync(lockPath(), "utf-8")).pid !== 2 ** 22 + 12345;
      } catch {
        return false;
      }
    }, 5000);
    await publishDigest("w1", new Date().toISOString());
    expect((await waiting).exitCode).toBe(2);
  });

  it("the wave leaving running with no digest: exits 0 and releases the lock", async () => {
    await publishState("w1", "running", COORD);
    const waiting = start();
    await eventually(() => existsSync(lockPath()), 5000);
    await publishState("w1", "archived", COORD);
    const run = await waiting;
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("VOLLEY_OWNER_WAKE_MAX_S: wakes with the still-in-flight line when the wave still runs", async () => {
    await publishState("w1", "releasing", COORD);
    const run = await start({ VOLLEY_OWNER_WAKE_MAX_S: "1" });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(
      /^\[volley owner-wake\] wave w1 still in flight after 1 s; re-armed\./,
    );
    expect(run.ms).toBeGreaterThanOrEqual(1000);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("wakeLine / summaryLineOf", () => {
  it("names the wave, the trigger and the digest's summary line", () => {
    const d = digest("w1", "2026-11-08T12:00:00.000Z", "release_go");
    expect(summaryLineOf({ ...d, waiting: [{ kind: "release_go" }, { kind: "release_go" }] })).toBe(
      "w1 ready to release: 1 shipped, 2 waiting for you (release_go)",
    );
    expect(wakeLine("w1", "release_go", summaryLineOf(d))).toBe(
      "[volley owner-wake] wave w1: release_go — w1 ready to release: 1 shipped. Run `volleyd digest w1` (and `volleyd inbox` when it says waiting for you) and carry the wave on; the next Stop re-arms this wake.",
    );
  });

  it("tolerates a digest missing its counters", () => {
    expect(summaryLineOf({ wave: "w9", trigger: "escalation" })).toBe("w9 needs you: 0 shipped");
  });
});
