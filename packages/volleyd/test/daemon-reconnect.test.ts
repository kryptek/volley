import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { waveStateTopic } from "../src/control";
import { type Daemon, daemonClientId } from "../src/daemon";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";

/**
 * The supervisor survives a broker drop (#635): it reconnects with backoff, its mailbox answers
 * again and its retained records come back, all in the same process. Real clock: the reconnect
 * runs on mqtt.js's own timers (the first retry after `broker_reconnect_base_ms`).
 */

const EXAMPLE = fileURLToPath(new URL("./fixtures/example.yaml", import.meta.url));
const WAVE = "2026-10-20-example";
const STATUS = `volley/${NS}/volleyd/status`;
/** A reconnect takes the first retry (1 s) plus the republish. */
const BACK = { deadlineMs: 10_000 };

let t: DaemonEnv;
let logs: string[];
beforeEach(async () => {
  t = await makeDaemonEnv();
  logs = [];
});
afterEach(async () => {
  await t.cleanup();
});

/** Whether `d.closed` has resolved (the daemon ended itself). */
function endedFlag(d: Daemon): () => boolean {
  let ended = false;
  void d.closed.then(() => {
    ended = true;
  });
  return () => ended;
}

const statusType = async (): Promise<string | undefined> =>
  ((await t.retained(STATUS)) as { type: string } | null)?.type;

/** The daemon is back: retained status `working`, the mailbox drained, `status` answered. */
async function expectRecovered(): Promise<void> {
  await eventually(async () => (await statusType()) === "working", {
    ...BACK,
    what: "the daemon's retained status back to working",
  });
  expect(t.broker.subscriptions(daemonClientId(NS))).toContain("volley/+/volleyd/mailbox");
  const status = await runCli(["status", "--json"], t.env);
  expect(status.exitCode).toBe(0);
}

describe("volleyd reconnects after losing the broker (#635)", () => {
  it("reconnects after the broker drops its connection: mailbox resubscribed, status answered, retained status back to working, no restart", async () => {
    const d = await t.start({ log: (l) => logs.push(l) });
    const ended = endedFlag(d);
    expect(t.broker.dropClient(daemonClientId(NS))).toBe(true);
    // The LWT fired: the broker marks the supervisor dead until it is back.
    await eventually(async () => (await statusType()) === "reaped", {
      what: "the LWT's reaped status",
    });
    await expectRecovered();
    expect(ended()).toBe(false);
    expect(logs.filter((l) => l.startsWith("broker connection lost"))).toHaveLength(1);
    await eventually(() => logs.some((l) => l.startsWith("broker connection restored")));
  });

  it("a broker that goes silent without closing is detected and reconnected", async () => {
    const d = await t.start({ log: (l) => logs.push(l), keepaliveSeconds: 1 });
    const ended = endedFlag(d);
    expect(t.broker.stallClient(daemonClientId(NS))).toBe(true);
    await eventually(() => logs.some((l) => l.startsWith("broker connection lost")), {
      what: "the stall to be noticed",
    });
    // mqtt.js's keepalive (1.5 keepalives) closes it first; checkBroker's own backstop (2
    // keepalives, then kill()) is defensive and not what this test covers.
    expect(logs.find((l) => l.startsWith("broker connection lost"))).toMatch(/Keepalive timeout/);
    await eventually(() => logs.some((l) => l.startsWith("broker connection restored")), BACK);
    await expectRecovered();
    expect(ended()).toBe(false);
  });

  it("a wave's retained state is republished after a reconnect", async () => {
    await t.start({ log: (l) => logs.push(l) });
    expect((await runCli(["run", EXAMPLE], t.env)).exitCode).toBe(0);
    await eventually(async () => (await t.retained(waveStateTopic(WAVE))) !== null);
    // Lost with the broker (one restarted without persistence): only a republish brings it back.
    const clearer = new VolleyBroker();
    await clearer.connect({ url: t.broker.url, agentId: "test-clearer" });
    await clearer.publish(waveStateTopic(WAVE), "", { qos: 1, retain: true });
    await clearer.disconnect();
    expect(await t.retained(waveStateTopic(WAVE))).toBeNull();
    t.broker.dropClient(daemonClientId(NS));
    await eventually(async () => (await t.retained(waveStateTopic(WAVE))) !== null, {
      ...BACK,
      what: "the wave's state republished",
    });
    await expectRecovered();
  });

  it("a session another client took over (DISCONNECT 142) ends the daemon instead of reconnecting", async () => {
    const d = await t.start({ log: (l) => logs.push(l) });
    // Aedes speaks MQTT 3.1.1 (no reason codes): stand in for an MQTT 5 broker's DISCONNECT 142.
    const internals = d as unknown as {
      broker: { client: { emit(e: string, p: unknown): void } };
    };
    internals.broker.client.emit("disconnect", { cmd: "disconnect", reasonCode: 142 });
    t.broker.dropClient(daemonClientId(NS));
    expect((await d.closed).message).toMatch(/broker connection lost: .*DISCONNECT 142/);
    expect(logs.some((l) => l.endsWith("; reconnecting"))).toBe(false);
    // Past the first retry (1 s): nothing came back to fight the new holder for the session.
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.broker.dropClient(daemonClientId(NS))).toBe(false);
  });

  it("a second drop after a recovery is recovered too", async () => {
    const d = await t.start({ log: (l) => logs.push(l) });
    const ended = endedFlag(d);
    for (let i = 1; i <= 2; i++) {
      t.broker.dropClient(daemonClientId(NS));
      await eventually(
        () => logs.filter((l) => l.startsWith("broker connection restored")).length === i,
        { ...BACK, what: `reconnect ${i}` },
      );
    }
    await expectRecovered();
    expect(ended()).toBe(false);
  });
});
