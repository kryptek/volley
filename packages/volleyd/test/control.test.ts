import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { noOwnerWarning } from "../src/commands/run";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { CONFIG_TOPIC, ControlClient, waveEventsTopic, waveStateTopic } from "../src/control";
import { Daemon, daemonClientId } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { type DoctorReport, machineTopic } from "../src/machines";
import type { ReadinessPayload } from "../src/readiness";
import { SYSTEM_WAVE } from "../src/types";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NO_PRESSURE, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { fakeExec } from "./helpers/fake-exec";
import {
  type FakeRemoteAnswers,
  type FakeRemoteHost,
  GREEN_DOCTOR,
  adoptSpec,
  fakeHost,
  fakeRemoteHost,
} from "./helpers/fake-host";
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
    // On a broker volleyd has never used: the startup probe finds no status at all.
    await t.cleanup();
    t = await makeDaemonEnv({ neverStarted: true });
    expect(await t.retained(`volley/${NS}/volleyd/status`)).toBeNull();
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
    // No owner (no --owner, VOLLEY_AGENT_ID or registered session): the one warning.
    expect(run.stderr).toBe(`warning: ${noOwnerWarning(WAVE)}\n`);
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
    expect(JSON.parse(all.stdout)).toEqual({
      waves: [retained.payload],
      // its admitted task, queued for its first agent (no spawner here), holds a ceiling slot
      ceiling: { live: 1, max: 12 },
    });

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

  it("exits 69 (daemon_silent) within 2 s when no daemon is registered", async () => {
    const started = Date.now();
    const r = await runCli(["status"], t.env);
    // real process: the CLI's own control timeout, in a child process on the real clock.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.exitCode).toBe(69);
    expect(r.stderr).toContain(
      "volleyd status: supervisor unreachable (daemon_silent): The broker answers but volleyd is silent in namespace '",
    );
    expect(r.stderr).toContain("\n  fix: on the supervisor's machine: ");
  });

  it("status --json with no daemon: the SUPERVISOR_UNREACHABLE object on stdout", async () => {
    const r = await runCli(["status", "--json"], t.env);
    expect(r.exitCode).toBe(69);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: "SUPERVISOR_UNREACHABLE",
      reason: "daemon_silent",
      where: { kind: "other", brokerUrl: t.broker.url, namespace: expect.any(String) },
      probes: { broker: "up", daemon: "silent" },
    });
  });

  it("status with a live daemon works as before", async () => {
    await t.start();
    const r = await runCli(["status"], t.env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("supervisor unreachable");
  });

  it("says 'not running' after a clean stop, and restores waves from the journal on restart", async () => {
    const d = await t.start();
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    const before = await runCli(["status", "--json", WAVE], t.env);
    await d.stop();
    expect((await runCli(["status"], t.env)).stderr).toContain("(daemon_silent)");

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
    expect(r.stderr).not.toContain("supervisor unreachable");
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
        // seq 1 is the first start's `roles_changed` (SPEC §4.6.24).
        seq: 2,
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

  it("reports a broker that is down as exit 69 with the diagnosis", async () => {
    const dead = await startTestBroker();
    const url = dead.url;
    await dead.close();
    const r = await runCli(["status"], { ...t.env, VOLLEY_BROKER_URL: url });
    expect(r.exitCode).toBe(69);
    // No setup here and a broker on loopback: the install hint (no_broker_here).
    expect(r.stderr).toMatch(/^volleyd status: supervisor unreachable \(no_broker_here\): /);
    expect(r.stderr).toContain("install mosquitto");
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

describe("peer_doctor (the doctor on a paired machine, for an admin)", () => {
  const USERS = ["volleyd", "admin-1", "steer-1"];
  const pw = (u: string) => `${u}-pw`;
  /** The shipped roles' ACL, reduced to the auth topics (peers.test.ts). */
  const canPublish = (user: string | undefined, topic: string) =>
    user === "volleyd" ||
    (topic.startsWith("volley/_system/auth/ops/")
      ? topic === authOpsTopic(user ?? "")
      : !topic.startsWith("volley/_system/auth/"));
  const REPORT: DoctorReport = {
    ...GREEN_DOCTOR,
    checks: [
      { id: "repo.clone", ok: true, severity: "block", detail: "clone at /srv/repo" },
      {
        id: "volley.version",
        ok: false,
        severity: "block",
        detail: "volley 0.1.3 in /opt/volley; the supervisor runs 0.2.0",
        fix: "git -C /opt/volley fetch origin --tags && git -C /opt/volley checkout --detach v0.2.0",
      },
      { id: "gh.auth", ok: false, severity: "warn", detail: "gh signed out", fix: "gh auth login" },
    ],
  };
  let broker: TestBroker;
  let home: string;
  let box: FakeRemoteHost | undefined;
  let answers: FakeRemoteAnswers;
  let daemon: Daemon;
  const clients: VolleyBroker[] = [];

  beforeEach(async () => {
    broker = await startTestBroker({
      users: Object.fromEntries(USERS.map((u) => [u, pw(u)])),
      canPublish,
    });
    home = tempDir("volleyd-peer-doctor-");
    writeFileSync(
      join(home, "config.yaml"),
      "hosts:\n  box-a:\n    target: dev@box-a\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n",
    );
    answers = { doctor: REPORT };
    box = undefined;
    const auth = fakeExec().on(["volley", "auth", "list"], {
      stdout: JSON.stringify({
        accounts: [
          { name: "admin-1", role: "admin", kind: "human", created: "2026-10-19T09:00:00.000Z" },
          { name: "steer-1", role: "steer", kind: "human", created: "2026-10-19T09:00:00.000Z" },
        ],
      }),
    });
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      auth: { username: "volleyd", password: pw("volleyd") },
      authExec: auth.exec,
      spawner: {
        remoteHost: (s) => {
          box ??= fakeRemoteHost(s, fakeHost(), answers);
          return adoptSpec(box, s);
        },
      },
    });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      // broker round-trip: a client the ACL refused may never complete its DISCONNECT.
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      c.simulateCrash();
    }
    await daemon.stop();
    await broker.close();
  });

  /** One account op as `user`, answered on the account-op reply topic. */
  async function op(user: string, payload: Record<string, unknown>) {
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: `cli-${randomUUID().slice(0, 6)}`,
      username: user,
      password: pw(user),
    });
    clients.push(c);
    const cid = randomUUID();
    let resolve!: (p: Record<string, unknown>) => void;
    const reply = new Promise<Record<string, unknown>>((r) => {
      resolve = r;
    });
    await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const env = parseEnvelope(raw);
      if (env?.type === "ack" && env.correlation_id === cid) {
        resolve(env.payload as Record<string, unknown>);
      }
    });
    const env = buildEnvelope({
      agentId: user,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload,
    });
    await c.publish(authOpsTopic(user), JSON.stringify(env), { qos: 1, retain: false });
    return reply;
  }

  it("from an admin: runs the doctor on the box and answers its checks and the plan", async () => {
    const r = await op("admin-1", { op: "peer_doctor", name: "box-a", fix: false });
    expect(r).toMatchObject({ ok: true, op: "peer_doctor" });
    const result = r.result as { name: string; checks: unknown[]; plan: unknown[] };
    expect(result.name).toBe("box-a");
    expect(result.checks).toEqual(REPORT.checks);
    // The plan: each failing check with its fix, so the sheet shows what Repair would do.
    expect(result.plan).toEqual([
      {
        id: "volley.version",
        severity: "block",
        detail: "volley 0.1.3 in /opt/volley; the supervisor runs 0.2.0",
        fix: "git -C /opt/volley fetch origin --tags && git -C /opt/volley checkout --detach v0.2.0",
      },
      { id: "gh.auth", severity: "warn", detail: "gh signed out", fix: "gh auth login" },
    ]);
    expect(box?.doctorRuns).toEqual([{ fix: false }]);

    const fixed = await op("admin-1", { op: "peer_doctor", name: "box-a", fix: true });
    expect(fixed).toMatchObject({ ok: true, result: { name: "box-a", fix: true } });
    expect(box?.doctorRuns.at(-1)).toEqual({ fix: true });
  });

  it("clone with no wave running: refused before ssh (the doctor clones only from the wave repo's origin)", async () => {
    const r = await op("admin-1", { op: "peer_doctor", name: "box-a", fix: true, clone: true });
    expect(r).toMatchObject({ ok: false, op: "peer_doctor" });
    expect(r.error).toMatch(/origin.*not known/);
    expect(box?.doctorRuns ?? []).toEqual([]);
  });

  it("from a non-admin, or on the mailbox: refused, and nothing runs on the box", async () => {
    const r = await op("steer-1", { op: "peer_doctor", name: "box-a", fix: false });
    expect(r).toMatchObject({ ok: false, op: "peer_doctor" });
    expect(r.error).toMatch(/steer-1.*steer.*admin/);
    const client = await ControlClient.connect(broker.url, NS, {
      username: "steer-1",
      password: pw("steer-1"),
    });
    try {
      const m = await client.request("peer_doctor", { name: "box-a" });
      expect(m).toMatchObject({ ok: false, error: expect.stringContaining("auth/ops") });
    } finally {
      await client.close();
    }
    expect(box?.doctorRuns ?? []).toEqual([]);
  });

  it("an ssh failure answers ok: false with the transport reason", async () => {
    answers.doctor = new Error("ssh to dev@box-a failed (volley peer doctor): Connection refused");
    const r = await op("admin-1", { op: "peer_doctor", name: "box-a" });
    expect(r).toMatchObject({ ok: false, op: "peer_doctor" });
    expect(r.error).toContain("Connection refused");
  });

  it("a run holds no queue: config_set and ticks go on meanwhile; a second run on the box is refused until it ends; each run is journaled", async () => {
    let release!: (r: DoctorReport) => void;
    answers.doctor = () =>
      new Promise<DoctorReport>((r) => {
        release = r;
      });
    const pending = op("admin-1", { op: "peer_doctor", name: "box-a", fix: true });
    await eventually(async () => (box?.doctorRuns.length ?? 0) === 1);

    // The doctor is still running on the box: the daemon's queue is not.
    const client = await ControlClient.connect(broker.url, NS, {
      username: "admin-1",
      password: pw("admin-1"),
    });
    try {
      const r = await client.request("config_set", {
        patch: { hosts: { "box-a": { max_agents: 2 } } },
        by: "tester",
      });
      expect(r).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
    await daemon.tick();
    expect(await op("admin-1", { op: "peer_doctor", name: "box-a", fix: true })).toMatchObject({
      ok: false,
      error: 'a doctor run on "box-a" is already in progress',
    });
    expect(box?.doctorRuns).toHaveLength(1);

    release(REPORT);
    expect(await pending).toMatchObject({ ok: true, result: { name: "box-a", fix: true } });
    const runs = () =>
      readJournalFile(join(home, "waves", SYSTEM_WAVE, "journal.jsonl")).filter(
        (e) => e.type === "peer_doctor_run",
      );
    expect(runs().map((e) => e.data)).toEqual([
      { by: "admin-1", name: "box-a", fix: true, clone: false, ok: true },
    ]);

    // Ended: the box takes the next run.
    answers.doctor = REPORT;
    expect(await op("admin-1", { op: "peer_doctor", name: "box-a" })).toMatchObject({ ok: true });
    expect(runs().map((e) => e.data.ok)).toEqual([true, true]);
  });

  it("folds the run's report into the box's retained record at once, as the peer would publish it", async () => {
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: "box-a",
      username: "volleyd",
      password: pw("volleyd"),
    });
    clients.push(c);
    /** box-a's retained machine record, as the Desk and readiness read it. */
    const record = async () => {
      const raw = await c.queryRetained(machineTopic("box-a"), 500);
      return raw === null ? null : parseEnvelope(raw);
    };
    // The peer's last heartbeat: a stale doctor run from an hour ago.
    const beat = {
      name: "box-a",
      os: "linux",
      arch: "x64",
      cores: 8,
      tunnel: "up",
      load: [0.5, 0.25, 0.125],
      agents: 0,
      remote_port: 21883,
      kind: "peer",
      checks: [{ id: "volley.installed", ok: false, severity: "block", detail: "stale install" }],
      doctor_at: "2026-10-19T08:00:00.000Z",
      last_seen: "2026-10-19T09:00:00.000Z",
    };
    await c.publish(
      machineTopic("box-a"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box-a",
          parentId: null,
          channel: "_system/machines",
          type: "machine",
          payload: beat,
        }),
      ),
      { qos: 1, retain: true },
    );
    await eventually(async () => (await record())?.agent_id === "box-a");
    /** box-a's retained readiness verdict. */
    const verdict = async () => {
      const raw = await c.queryRetained(`${machineTopic("box-a")}/readiness`, 200);
      return raw === null ? null : (parseEnvelope(raw)?.payload as ReadinessPayload | undefined);
    };
    await eventually(async () => {
      await daemon.tick();
      return (await verdict()) !== null;
    });
    const before = await verdict();
    expect(before?.ready).toBe(false);
    expect(before?.reasons).toContain("volley.installed: stale install");

    answers.doctor = { ...REPORT, doctor_at: "2026-10-19T09:00:05.000Z" };
    expect(await op("admin-1", { op: "peer_doctor", name: "box-a", fix: true })).toMatchObject({
      ok: true,
    });
    const after = await record();
    expect(after?.agent_id).toBe("volleyd");
    expect(after?.payload).toMatchObject({
      ...beat,
      // The report's checks, without their fix text (a record never carries it).
      checks: REPORT.checks.map(({ id, ok, severity, detail }) => ({ id, ok, severity, detail })),
      versions: REPORT.versions,
      auth: REPORT.auth,
      doctor_at: "2026-10-19T09:00:05.000Z",
    });
    expect(JSON.stringify(after?.payload)).not.toContain("gh auth login");
    // The verdict is re-computed from the folded checks, not left for the next heartbeat.
    const reasons = (await verdict())?.reasons ?? [];
    expect(reasons.some((r) => r.startsWith("volley.installed"))).toBe(false);
    expect(reasons).not.toEqual(before?.reasons);

    // The box's next beat still carries its service's older run: the supervisor re-asserts the
    // newer one over it, so the Desk never shows the stale checks again.
    await c.publish(
      machineTopic("box-a"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box-a",
          parentId: null,
          channel: "_system/machines",
          type: "machine",
          payload: { ...beat, last_seen: "2026-10-19T09:00:30.000Z" },
        }),
      ),
      { qos: 1, retain: true },
    );
    await eventually(async () => {
      const r = await record();
      return (
        r?.agent_id === "volleyd" &&
        (r.payload as { last_seen?: string }).last_seen === "2026-10-19T09:00:30.000Z"
      );
    });
    expect((await record())?.payload).toMatchObject({
      last_seen: "2026-10-19T09:00:30.000Z",
      doctor_at: "2026-10-19T09:00:05.000Z",
      versions: REPORT.versions,
    });
  });

  it("a run on a box that never published a record publishes none", async () => {
    expect(await op("admin-1", { op: "peer_doctor", name: "box-a" })).toMatchObject({ ok: true });
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: "reader",
      username: "volleyd",
      password: pw("volleyd"),
    });
    clients.push(c);
    expect(await c.queryRetained(machineTopic("box-a"), 300)).toBeNull();
  });

  it("a run on a box whose tunnel is down folds nothing: its record stays the box's own", async () => {
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: "box-a",
      username: "volleyd",
      password: pw("volleyd"),
    });
    clients.push(c);
    const record = async () => {
      const raw = await c.queryRetained(machineTopic("box-a"), 500);
      return raw === null ? null : parseEnvelope(raw);
    };
    // The box's LWT: ssh still reaches it, its tunnel does not.
    const lwt = {
      name: "box-a",
      os: "linux",
      cores: 8,
      tunnel: "down",
      reason: "disconnect",
      load: [0.5, 0.25, 0.125],
      agents: 0,
      checks: [{ id: "volley.installed", ok: false, severity: "block", detail: "stale install" }],
      doctor_at: "2026-10-19T08:00:00.000Z",
      last_seen: "2026-10-19T09:00:00.000Z",
    };
    await c.publish(
      machineTopic("box-a"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box-a",
          parentId: null,
          channel: "_system/machines",
          type: "machine",
          payload: lwt,
        }),
      ),
      { qos: 1, retain: true },
    );
    await eventually(async () => (await record())?.agent_id === "box-a");
    await daemon.tick();

    answers.doctor = { ...REPORT, doctor_at: "2026-10-19T09:00:05.000Z" };
    expect(await op("admin-1", { op: "peer_doctor", name: "box-a", fix: true })).toMatchObject({
      ok: true,
    });
    const after = await record();
    expect(after?.agent_id).toBe("box-a");
    expect(after?.payload).toMatchObject({ tunnel: "down", doctor_at: lwt.doctor_at });
  });

  it("refuses an unknown host and --clone without --fix before ssh", async () => {
    expect(await op("admin-1", { op: "peer_doctor", name: "nobody" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("nobody"),
    });
    expect(
      await op("admin-1", { op: "peer_doctor", name: "box-a", fix: false, clone: true }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("clone") });
    expect(box?.doctorRuns ?? []).toEqual([]);
  });
});
