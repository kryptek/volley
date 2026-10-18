import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { ControlClient, waveEventsTopic, waveStateTopic } from "../src/control";
import { Daemon } from "../src/daemon";
import { startTestBroker } from "./helpers/aedes-broker";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

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
    expect(human.stdout).toContain(`${WAVE}  running  v1`);
    expect(human.stdout).toMatch(/T0\s+#101\s+queued\s+admitted: awaiting spawn/);
    expect(human.stdout).toMatch(/T3\s+#104\s+queued\s+after: T1, T2/);
  });

  it("mirrors every journal event to the events topic as schema-valid envelopes", async () => {
    await t.start();
    const sub = new VolleyBroker();
    await sub.connect({ url: t.broker.url, agentId: "test-events" });
    const collected = sub.subscribeCollect(waveEventsTopic(WAVE), 6, 3000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    const msgs = (await collected).map((m) => JSON.parse(m.payload));
    await sub.disconnect();
    expect(msgs.map((m) => m.type)).toEqual([
      "wave_submitted",
      "task_queued",
      "task_queued",
      "task_queued",
      "task_queued",
      "task_admitted",
    ]);
    expect(msgs.map((m) => m.payload.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const m of msgs) expect(schemaErrors("wave-event.schema.json", m)).toEqual([]);
  });

  it("exits 1 with 'not running' within 2 s when no daemon is registered", async () => {
    const started = Date.now();
    const r = await runCli(["status", "--json"], t.env);
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

  it("refuses to start a second daemon while one is live", async () => {
    await t.start();
    await expect(
      Daemon.start({ brokerUrl: t.broker.url, namespace: NS, home: t.home, tickMs: 0 }),
    ).rejects.toThrow(/already running/);
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
      const unknown = await client.request("pause" as never, {});
      expect(unknown).toMatchObject({
        ok: false,
        error: "unknown op 'pause'",
        acked_type: "query",
      });
      const missing = await client.request("status", { wave: "nope" });
      expect(missing).toMatchObject({ ok: false, error: "unknown wave 'nope'" });
    } finally {
      await client.close();
    }
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
