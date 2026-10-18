import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { retireAgent } from "../src/retire";
import {
  type ScreenCapture,
  ScreenPublisher,
  type ScreenPublisherDeps,
  type ScreenTarget,
} from "../src/screen-publisher";
import type { JournalEvent } from "../src/types";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

const ID = "w1-t1-implementer-1";
const SCREEN = buildTopic(NS, ID, "screen");
const session = readFileSync(join(FIXTURES, "screens", "claude-session.txt"), "utf-8");

const until = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Every message seen on one topic (retained replays included), raw. */
async function collect(broker: VolleyBroker, topic: string): Promise<string[]> {
  const seen: string[] = [];
  await broker.subscribeStream(topic, ({ payload }) => seen.push(payload));
  return seen;
}

describe("ScreenPublisher", () => {
  let mq: TestBroker;
  let pubClient: VolleyBroker;
  let reader: VolleyBroker;
  let host: FakeHost;
  let clock: number;
  let publisher: ScreenPublisher;
  let staleChanges: [string, boolean][];
  let captures: ScreenCapture[];
  let interval: number;
  let makePublisher: (extra?: Partial<ScreenPublisherDeps>) => ScreenPublisher;
  /** A read that never settles (a hung cmux). */
  const hang = () => new Promise<string | null>(() => {});

  const target = (): ScreenTarget => ({
    agentId: ID,
    namespace: NS,
    workspace: "workspace:7",
    host,
    source: "cmux",
    intervalS: () => interval,
  });
  const retained = async () => {
    const raw = await reader.queryRetained(SCREEN, 300);
    return raw === null || raw === "" ? null : JSON.parse(raw);
  };

  beforeEach(async () => {
    mq = await startTestBroker();
    pubClient = new VolleyBroker();
    await pubClient.connect({ url: mq.url, agentId: "volleyd" });
    reader = new VolleyBroker();
    await reader.connect({ url: mq.url, agentId: "test-reader" });
    host = fakeHost();
    clock = 1_000_000;
    interval = 5;
    staleChanges = [];
    captures = [];
    makePublisher = (extra = {}) => {
      const p = new ScreenPublisher({
        publish: (topic, payload) => pubClient.publish(topic, payload, { qos: 0, retain: true }),
        now: () => clock,
        onStale: (id, stale) => staleChanges.push([id, stale]),
        ...extra,
      });
      p.onCapture((c) => captures.push(c));
      return p;
    };
    publisher = makePublisher();
  });

  afterEach(async () => {
    await pubClient.disconnect();
    await reader.disconnect();
    await mq.close();
  });

  it("publishes a retained screen_tail, then only when the hash changes", async () => {
    const seen = await collect(reader, SCREEN);
    host.screens = [session, session, `${session.split("❯")[0]}● Second step\n─────\n❯ \n─────\n`];
    publisher.track(target());

    await publisher.tick();
    await until(() => seen.length === 1);
    const first = JSON.parse(seen[0] as string);
    expect(first).toMatchObject({
      agent_id: "volleyd",
      channel: "screen",
      type: "screen_tail",
      payload: { workspace: "workspace:7", source: "cmux" },
    });
    expect(first.payload.lines.at(-1)).toBe("✳ Sautéing… (34s · ↓ 2.1k tokens · esc to interrupt)");
    expect(first.payload.captured_at).toBe(new Date(clock).toISOString());
    expect(schemaErrors("screen.schema.json", first)).toEqual([]);
    expect(host.screenReads).toEqual([{ workspace: "workspace:7", lines: 60 }]);

    // Not due yet: no read.
    clock += 4_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(1);

    // Same screen: read, but not published.
    clock += 1_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(2);
    expect(captures.map((c) => c.changed)).toEqual([true, false]);

    // Changed screen: a second publish with a new hash.
    clock += 5_000;
    await publisher.tick();
    await until(() => seen.length === 2);
    const second = JSON.parse(seen[1] as string);
    expect(second.payload.hash).not.toBe(first.payload.hash);
    expect(second.payload.lines.at(-1)).toBe("● Second step");
    expect(seen).toHaveLength(2);
    expect((await retained()).payload.hash).toBe(second.payload.hash);
  });

  it("a failed publish is reported as unchanged and retried on the next capture", async () => {
    let fail = true;
    const published: string[] = [];
    publisher = makePublisher({
      publish: async (topic) => {
        if (fail) throw new Error("broker down");
        published.push(topic);
      },
    });
    host.screens = [session];
    publisher.track(target());
    await publisher.tick();
    expect(captures[0]?.changed).toBe(false);
    fail = false;
    clock += 5_000;
    await publisher.tick();
    expect(captures[1]?.changed).toBe(true);
    expect(published).toEqual([SCREEN]);
  });

  it("reads the interval on every capture (a config change applies without restart)", async () => {
    host.screens = [session];
    publisher.track(target());
    await publisher.tick();
    interval = 20;
    clock += 5_000;
    await publisher.tick(); // due under the old interval; schedules the next with the new one
    clock += 10_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(2);
    clock += 10_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(3);
  });

  it("three failed reads back the agent off to 30 s and mark it stale; a good read recovers", async () => {
    host.screens = [null, null, null, session];
    publisher.track(target());
    for (let i = 0; i < 3; i++) {
      await publisher.tick();
      clock += 5_000;
    }
    expect(host.screenReads).toHaveLength(3);
    expect(publisher.isStale(ID)).toBe(true);
    expect(staleChanges).toEqual([[ID, true]]);
    expect(await retained()).toBeNull(); // nothing to publish yet

    // Backed off: nothing for 30 s after the third failure.
    clock += 20_000; // 25 s after it
    await publisher.tick();
    expect(host.screenReads).toHaveLength(3);
    clock += 5_000; // 30 s
    await publisher.tick();
    expect(host.screenReads).toHaveLength(4);
    expect(publisher.isStale(ID)).toBe(false);
    expect(staleChanges).toEqual([
      [ID, true],
      [ID, false],
    ]);
    await until(async () => (await retained()) !== null);
  });

  it("a read slower than 2 s backs the agent off at once", async () => {
    host.screens = [session];
    const read = host.readScreen.bind(host);
    host.readScreen = async (ws, n) => {
      clock += 2_500;
      return read(ws, n);
    };
    publisher.track(target());
    await publisher.tick();
    expect(publisher.isStale(ID)).toBe(true);
    clock += 29_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(1);
  });

  it("a fast failed read after a slow one keeps the agent stale and backed off", async () => {
    host.screens = [session, null, session];
    const read = host.readScreen.bind(host);
    let slowNext = true;
    host.readScreen = async (ws, n) => {
      if (slowNext) clock += 2_500;
      slowNext = false;
      return read(ws, n);
    };
    publisher.track(target());
    await publisher.tick(); // slow → stale
    clock += 30_000;
    await publisher.tick(); // fast, but failed: no good read yet
    expect(host.screenReads).toHaveLength(2);
    expect(publisher.isStale(ID)).toBe(true);
    expect(staleChanges).toEqual([[ID, true]]);
    clock += 29_000; // still backed off to 30 s
    await publisher.tick();
    expect(host.screenReads).toHaveLength(2);
    clock += 1_000;
    await publisher.tick(); // fast and good: recovers
    expect(host.screenReads).toHaveLength(3);
    expect(publisher.isStale(ID)).toBe(false);
  });

  it("a hung read is marked stale once screen_slow_ms passes, and times out as a failure", async () => {
    publisher = makePublisher({ slowMs: 40, readTimeoutMs: 150 });
    host.readScreen = hang;
    publisher.track(target());
    const ticking = publisher.tick();
    await until(() => publisher.isStale(ID), 1_000);
    expect(staleChanges).toEqual([[ID, true]]);
    await ticking; // the hard timeout settles the capture
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ screen: null, changed: false, stale: true });
    // The timed-out read counts: the agent is backed off to 30 s, then read again.
    host.readScreen = async () => session;
    clock += 29_000;
    await publisher.tick();
    expect(captures).toHaveLength(1);
    clock += 1_000;
    await publisher.tick();
    expect(captures).toHaveLength(2);
    expect(publisher.isStale(ID)).toBe(false);
  });

  it("untrack does not wait for a hung read", async () => {
    publisher = makePublisher({ slowMs: 40, readTimeoutMs: 150 });
    host.readScreen = hang;
    publisher.track(target());
    const ticking = publisher.tick();
    let untracked = false;
    void publisher.untrack(ID).then(() => {
      untracked = true;
    });
    await until(() => untracked, 100);
    await ticking;
    expect(captures).toHaveLength(0); // an untracked agent's capture reaches no listener
  });

  it("a read in flight at untrack publishes nothing, so retire's clear is the last word", async () => {
    const seen = await collect(reader, SCREEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    host.screens = [session];
    const read = host.readScreen.bind(host);
    host.readScreen = async (ws, n) => {
      await gate;
      return read(ws, n);
    };
    publisher.track(target());
    const ticking = publisher.tick();
    await publisher.untrack(ID); // returns without waiting for the read
    release();
    await ticking;
    expect(captures).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);

    // Retire clears every retained record, the screen included.
    await retireAgent(
      {
        wave: "w1",
        task: "T1",
        role: "implementer",
        agentId: ID,
        namespace: NS,
        status: "done",
        waveAgents: new Set([ID]),
        minted: false,
      },
      {
        exec: fakeExec().exec,
        clearRetained: (topic) => pubClient.publish(topic, "", { qos: 1, retain: true }),
        journal: () => {},
        releaseLock: () => {},
      },
    );
    await until(() => seen.at(-1) === "");
    expect(await retained()).toBeNull();
    clock += 60_000;
    await publisher.tick();
    expect(host.screenReads).toHaveLength(1);
  });
});

describe("daemon screen tails", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let daemon: Daemon;
  let clock: number;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: ID, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );
  const taskState = async () =>
    (
      (await env.retained("volley/_waves/w1/state")) as {
        payload: { tasks: { id: string; screen_stale?: boolean }[] };
      }
    ).payload.tasks[0];

  beforeEach(async () => {
    env = await makeDaemonEnv();
    const repo = join(realpathSync(env.home), "repo");
    mkdirSync(repo);
    const claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    agent = new VolleyBroker();
    await agent.connect({ url: env.broker.url, agentId: "agent-sim" });
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      });
    host = fakeHost(fake);
    host.onLaunch = () => {
      setTimeout(async () => {
        await pub(registryTopic(ID), "registered", "_system/registry", {
          capabilities: [],
          cwd: "/wt",
          started_at: new Date().toISOString(),
          model: "claude-opus-5-5",
          model_source: "harness-hook",
        });
        await pub(buildTopic(NS, ID, "status"), "working", "status", {});
        await pub(
          buildTopic(NS, ID, "progress"),
          "heartbeat",
          "progress",
          { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
          false,
        );
      }, 20);
    };
    clock = 5_000_000;
    daemon = await env.start({
      now: () => clock,
      screenTimeouts: { slowMs: 100, readTimeoutMs: 3_000 },
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        mintCredentials: false,
      },
    });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}, screen_tail_interval_s: 7 }\n`,
    );
    expect((await runCli(["run", wave], env.env)).exitCode).toBe(0);
    await until(() => journal().some((e) => e.type === "agent_registered")).catch((e) => {
      throw new Error(`${e}: ${JSON.stringify(journal().map((x) => [x.type, x.data]))}`);
    });
    // Supervision (and screen tracking) starts once the verification promise settles.
    host.screens = [""];
    await until(async () => {
      await daemon.tickScreens();
      return host.screenReads.length > 0;
    });
    clock += 60_000;
  });

  afterEach(async () => {
    await agent.disconnect();
    await env.cleanup();
  });

  it("captures the supervised agent's workspace and publishes its tail; retire clears it", async () => {
    host.screens = [session];
    await daemon.tickScreens();
    // Wait on the content: beforeEach's empty capture is already retained.
    await until(
      async () =>
        ((await env.retained(SCREEN)) as { payload: { lines: string[] } } | null)?.payload
          .lines[0] === "> fix the flaky retry test in packages/api",
    );
    const env1 = (await env.retained(SCREEN)) as { agent_id: string; payload: { lines: string[] } };
    expect(env1.agent_id).toBe("volleyd");
    expect(env1.payload.lines[0]).toBe("> fix the flaky retry test in packages/api");
    expect(host.screenReads.at(-1)).toEqual({ workspace: "workspace:1", lines: 60 });

    // The per-wave interval (7 s) applies.
    const reads = host.screenReads.length;
    clock += 6_000;
    await daemon.tickScreens();
    expect(host.screenReads).toHaveLength(reads);
    clock += 1_000;
    await daemon.tickScreens();
    expect(host.screenReads).toHaveLength(reads + 1);

    await pub(buildTopic(NS, ID, "status"), "done", "status", { summary: "ok" });
    await until(() => journal().some((e) => e.type === "agent_retired"));
    expect(await env.retained(SCREEN)).toBeNull();
    clock += 60_000;
    await daemon.tickScreens();
    expect(host.screenReads).toHaveLength(reads + 1);
  });

  it("failing reads put screen_stale on the task in the wave state", async () => {
    host.screens = [null];
    expect((await taskState())?.screen_stale).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      await daemon.tickScreens();
      clock += 7_000;
    }
    await until(async () => (await taskState())?.screen_stale === true);
    expect(daemon.snapshot("w1")?.tasks[0]?.screen_stale).toBe(true);
    expect(
      schemaErrors("wave-state.schema.json", await env.retained("volley/_waves/w1/state")),
    ).toEqual([]);

    host.screens = [session];
    clock += 30_000;
    await daemon.tickScreens();
    await until(async () => (await taskState())?.screen_stale === undefined);
  });

  it("a hung read marks the task screen_stale and never blocks retire", async () => {
    host.readScreen = () => new Promise<string | null>(() => {});
    const ticking = daemon.tickScreens();
    await until(async () => (await taskState())?.screen_stale === true, 2_000);

    // Retire completes while the read is still hung (well before its 3 s hard timeout).
    const t0 = Date.now();
    await pub(buildTopic(NS, ID, "status"), "done", "status", { summary: "ok" });
    await until(() => journal().some((e) => e.type === "agent_retired"), 1_500);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(await env.retained(SCREEN)).toBeNull();
    // Later control work still runs: the serial queue is not wedged.
    await daemon.tick();
    await ticking;
  }, 10_000);
});
