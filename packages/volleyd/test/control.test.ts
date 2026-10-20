import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { CONFIG_TOPIC, ControlClient, waveEventsTopic, waveStateTopic } from "../src/control";
import { Daemon, daemonClientId } from "../src/daemon";
import { SYSTEM_WAVE } from "../src/types";
import { startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const EXAMPLE = fileURLToPath(new URL("./fixtures/example.yaml", import.meta.url));
const WAVE = "2026-10-20-example";

let t: DaemonEnv;
beforeEach(async () => {
  t = await makeDaemonEnv();
});
afterEach(async () => {
  await t.cleanup();
});

describe("volleyd daemon + control channel", () => {
  it("registers as volleyd with a live retained status and registry entry", async () => {
    await t.start();
    const status = (await t.retained(`volley/${NS}/volleyd/status`)) as { type: string };
    expect(status.type).toBe("working");
    expect(schemaErrors("status.schema.json", status)).toEqual([]);
    const reg = (await t.retained("volley/_system/registry/volleyd")) as { namespace: string };
    expect(reg.namespace).toBe(NS);
    expect(schemaErrors("registry.schema.json", reg)).toEqual([]);
  });

  it("run submits a wave (no spawning; tasks stay queued) and status --json returns the retained state", async () => {
    await t.start();
    const run = await runCli(["run", EXAMPLE], t.env);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`submitted wave ${WAVE} (4 tasks)`);

    const retained = (await t.retained(waveStateTopic(WAVE))) as {
      payload: { tasks: { stage: string }[] };
    };
    expect(schemaErrors("wave-state.schema.json", retained)).toEqual([]);
    expect(retained.payload.tasks.map((x) => x.stage)).toEqual([
      "queued",
      "queued",
      "queued",
      "queued",
    ]);

    const status = await runCli(["status", "--json", WAVE], t.env);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(retained.payload);

    const all = await runCli(["status", "--json"], t.env);
    expect(JSON.parse(all.stdout)).toEqual({ waves: [retained.payload] });

    const human = await runCli(["status"], t.env);
    expect(human.stdout).toContain(`${WAVE}  running  plan v1`);
    expect(human.stdout).toMatch(/T0\s+#101\s+queued\s+admitted: awaiting spawn/);
    expect(human.stdout).toMatch(/T3\s+#104\s+queued\s+after: T1, T2/);
  });

  it("mirrors every journal event to the events topic as schema-valid envelopes", async () => {
    await t.start();
    const sub = new VolleyBroker();
    await sub.connect({ url: t.broker.url, agentId: "test-events" });
    const got: { payload: string }[] = [];
    // subscribeStream resolves after SUBACK, so nothing published after it can be missed.
    const unsubscribe = await sub.subscribeStream(waveEventsTopic(WAVE), (m) => got.push(m));
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    await waitFor(() => got.length >= 7);
    await unsubscribe();
    await sub.disconnect();
    const msgs = got.map((m) => JSON.parse(m.payload));
    expect(msgs.map((m) => m.type)).toEqual([
      "wave_submitted",
      "alarm_raised", // brief_preface_missing: the example repo has no preface
      "task_queued",
      "task_queued",
      "task_queued",
      "task_queued",
      "task_admitted",
    ]);
    expect(msgs.map((m) => m.payload.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const m of msgs) expect(schemaErrors("wave-event.schema.json", m)).toEqual([]);
  });

  it("exits 1 with 'not running' within 2 s when no daemon is registered", async () => {
    const started = Date.now();
    const r = await runCli(["status", "--json"], t.env);
    // real process: the CLI's own control timeout, in a child process on the real clock.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("volleyd not running");
  });

  it("says 'not running' after a clean stop, and restores waves from the journal on restart", async () => {
    const d = await t.start();
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    const before = await runCli(["status", "--json", WAVE], t.env);
    await d.stop();
    expect((await runCli(["status"], t.env)).stderr).toContain("volleyd not running");

    await t.start();
    const after = await runCli(["status", "--json", WAVE], t.env);
    expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
    const dup = await runCli(["run", EXAMPLE], t.env);
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toContain(`wave '${WAVE}' already submitted`);
  });

  it("refuses a second daemon on the same home before opening any journal", async () => {
    await t.start();
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    // The live daemon is mid-write: a partial line with no newline yet.
    const journal = join(t.home, "waves", WAVE, "journal.jsonl");
    appendFileSync(journal, '{"seq":99,"at":"2026-');
    const before = readFileSync(journal, "utf-8");
    await expect(Daemon.start(t.options())).rejects.toThrow(/already running/);
    expect(readFileSync(journal, "utf-8")).toBe(before); // not truncated
  });

  it("refuses a second daemon on another home while one is live on the broker", async () => {
    await t.start();
    const other = tempDir("volleyd-home2-");
    await expect(Daemon.start(t.options({ home: other }))).rejects.toThrow(
      /already running \(retained/,
    );
    // The refused daemon did not take over the live one's session.
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
  });

  it("replaces a stale home lock left by a dead process", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(t.home, "volleyd.lock"), "999999999\n");
    await t.start();
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
  });

  it("exits (closed resolves) when the broker drops its connection, freeing the home", async () => {
    // The watchdog interval runs on the fake clock: each step is one virtual watchdog period.
    const clock = fakeClock();
    const d = await t.start({ clock });
    let reason: Error | undefined;
    void d.closed.then((r) => {
      reason = r;
    });
    expect(t.broker.dropClient(daemonClientId(NS))).toBe(true);
    // The daemon's client sees the socket close on its own I/O: step the watchdog until it has.
    await eventually(async () => {
      await clock.advance(DAEMON_DEFAULTS.watchdog_ms);
      return reason !== undefined;
    });
    expect(reason?.message).toMatch(/broker connection lost/);
    // The LWT marked it dead and the lock is free: a restart comes straight back.
    expect(((await t.retained(`volley/${NS}/volleyd/status`)) as { type: string }).type).toBe(
      "reaped",
    );
    await t.start();
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
  });

  it("delivers a config_set sent while the daemon is down on its next start (persistent session)", async () => {
    const d = await t.start();
    d._crashForTest();
    await waitFor(async () => {
      const s = (await t.retained(`volley/${NS}/volleyd/status`)) as { type: string } | null;
      return s?.type === "reaped";
    });

    const sender = new VolleyBroker();
    await sender.connect({ url: t.broker.url, agentId: "test-sender" });
    const acks: { payload: string }[] = [];
    const unsubscribe = await sender.subscribeStream(`volley/${NS}/test-sender/mailbox`, (m) =>
      acks.push(m),
    );
    const correlationId = randomUUID();
    const req = buildEnvelope({
      agentId: "test-sender",
      parentId: null,
      channel: "mailbox",
      type: "query",
      correlationId,
      payload: { op: "config_set", text: "while down", patch: { hard_ceiling: 4 }, by: "tester" },
    });
    await sender.publish(`volley/${NS}/volleyd/mailbox`, JSON.stringify(req), {
      qos: 1,
      retain: false,
    });

    await t.start();
    await waitFor(() => acks.length >= 1);
    await unsubscribe();
    await sender.disconnect();
    const ack = JSON.parse(acks[0]?.payload as string);
    expect(ack).toMatchObject({
      type: "ack",
      correlation_id: correlationId,
      payload: { text: "ACKED", acked_type: "query", ok: true, applied: true },
    });
    expect(schemaErrors("mailbox.schema.json", ack)).toEqual([]);
    const cfg = (await t.retained(CONFIG_TOPIC)) as { payload: { hard_ceiling: number } };
    expect(cfg.payload.hard_ceiling).toBe(4);
  });

  it("validates locally before contacting the daemon", async () => {
    const bad = fileURLToPath(new URL("./fixtures/bad-cycle.yaml", import.meta.url));
    const r = await runCli(["run", bad], t.env); // no daemon running: still a validation error
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("dependency cycle");
    expect(r.stderr).not.toContain("not running");
  });

  it("answers unknown ops and unknown waves with ok:false", async () => {
    await t.start();
    const client = await ControlClient.connect(t.broker.url, NS);
    try {
      const unknown = await client.request("frobnicate" as never, {});
      expect(unknown).toMatchObject({
        ok: false,
        error: "unknown op 'frobnicate'",
        acked_type: "query",
      });
      const missing = await client.request("status", { wave: "nope" });
      expect(missing).toMatchObject({ ok: false, error: "unknown wave 'nope'" });
    } finally {
      await client.close();
    }
  });

  it("acks every answer as ACKED with the request's correlation_id, schema-valid", async () => {
    await t.start();
    const r = await rawRequest({ op: "pause", text: "x" }, randomUUID());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ payload: { text: "ACKED", ok: false } });
    expect(schemaErrors("mailbox.schema.json", r[0])).toEqual([]);
  });

  it("drops a query without a correlation_id instead of sending an invalid ack", async () => {
    await t.start();
    expect(await rawRequest({ op: "status", text: "x" }, undefined)).toEqual([]);
  });

  it("answers a redelivered request (same correlation_id) without running it twice", async () => {
    await t.start();
    const id = randomUUID();
    const body = { op: "config_set", text: "x", patch: { hard_ceiling: 5 }, by: "tester" };
    const first = await rawRequest(body, id);
    const second = await rawRequest(body, id);
    expect(first[0]).toMatchObject({ payload: { applied: true, result: { version: 2 } } });
    expect(second[0]).toMatchObject({ payload: { applied: true, result: { version: 2 } } });
    const cfg = (await t.retained(CONFIG_TOPIC)) as { payload: { version: number } };
    expect(cfg.payload.version).toBe(2);
  });

  it("never executes a stray retained message on its mailbox", async () => {
    const raw = new VolleyBroker();
    await raw.connect({ url: t.broker.url, agentId: "test-raw" });
    const req = buildEnvelope({
      agentId: "test-raw",
      parentId: null,
      channel: "mailbox",
      type: "query",
      correlationId: randomUUID(),
      payload: { op: "config_set", text: "x", patch: { hard_ceiling: 7 }, by: "tester" },
    });
    await raw.publish(`volley/${NS}/volleyd/mailbox`, JSON.stringify(req), {
      qos: 1,
      retain: true,
    });
    await raw.disconnect();
    const d = await t.start();
    await d.stop();
    await t.start();
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
    const cfg = (await t.retained(CONFIG_TOPIC)) as { payload: { version: number } };
    expect(cfg.payload.version).toBe(1);
  });

  it("mirrors config_changed from the _system journal to volley/_waves/_system/events", async () => {
    await t.start();
    const sub = new VolleyBroker();
    await sub.connect({ url: t.broker.url, agentId: "test-sys-events" });
    const got: { payload: string }[] = [];
    const unsubscribe = await sub.subscribeStream(waveEventsTopic(SYSTEM_WAVE), (m) => got.push(m));
    const r = await runCli(["config", "set", "hard_ceiling", "3", "--by", "tester"], t.env);
    expect(r.exitCode).toBe(0);
    await waitFor(() => got.length >= 1);
    await unsubscribe();
    await sub.disconnect();
    const ev = JSON.parse(got[0]?.payload as string);
    expect(ev).toMatchObject({
      type: "config_changed",
      payload: {
        wave: SYSTEM_WAVE,
        seq: 1,
        data: {
          by: "tester",
          patch: { hard_ceiling: 3 },
          previous: { hard_ceiling: 12 },
          version: 2,
        },
      },
    });
    expect(schemaErrors("wave-event.schema.json", ev)).toEqual([]);
  });

  it("ignores malformed mailbox messages and keeps serving", async () => {
    await t.start();
    const raw = new VolleyBroker();
    await raw.connect({ url: t.broker.url, agentId: "test-raw" });
    const topic = `volley/${NS}/volleyd/mailbox`;
    await raw.publish(topic, "not json", { qos: 1, retain: false });
    const steering = buildEnvelope({
      agentId: "someone",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "hi" },
    });
    await raw.publish(topic, JSON.stringify(steering), { qos: 1, retain: false });
    await raw.disconnect();
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
  });

  it("reports a broker that is down as exit 1", async () => {
    const dead = await startTestBroker();
    const url = dead.url;
    await dead.close();
    const r = await runCli(["status"], { ...t.env, VOLLEY_BROKER_URL: url });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/volleyd status: .*connect/);
  });
});

/** Event mirrors, acks and retained statuses reach the test's clients over MQTT. */
const waitFor = eventually;

/**
 * Send one raw control query to the daemon and collect what comes back on the sender's mailbox:
 * the acks (all of them, so a second ack would show) within a short window after the first.
 */
async function rawRequest(
  payload: Record<string, unknown>,
  correlationId: string | undefined,
): Promise<Record<string, unknown>[]> {
  const sender = new VolleyBroker();
  const agentId = "test-raw-sender";
  await sender.connect({ url: t.broker.url, agentId });
  const got: { payload: string }[] = [];
  const unsubscribe = await sender.subscribeStream(`volley/${NS}/${agentId}/mailbox`, (m) =>
    got.push(m),
  );
  try {
    const req = buildEnvelope({
      agentId,
      parentId: null,
      channel: "mailbox",
      type: "query",
      ...(correlationId !== undefined ? { correlationId } : {}),
      payload,
    });
    await sender.publish(`volley/${NS}/volleyd/mailbox`, JSON.stringify(req), {
      qos: 1,
      retain: false,
    });
    // A later status round trip through the same serial queue proves the request was handled.
    expect((await runCli(["status", "--json"], t.env)).exitCode).toBe(0);
    // Its acks were published before that answer; a sentinel the sender sends itself now arrives
    // after every one of them (one connection delivers in order), so a second ack would show.
    const sentinel = `volley/${NS}/${agentId}/progress`;
    const token = randomUUID();
    const back = sender.subscribeUntil(sentinel, (p) => p === token, 5000);
    await sender.publish(sentinel, token, { qos: 1, retain: false });
    expect(await back).not.toBeNull();
    return got.map((m) => JSON.parse(m.payload));
  } finally {
    await unsubscribe();
    await sender.disconnect();
  }
}
