import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { ControlClient } from "../src/control";
import { Daemon, daemonClientId } from "../src/daemon";
import { watchAgent } from "../src/verify";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";

/**
 * A wave's own `namespace:` (its agents live in `volley/<wave-ns>/…`) is honoured for cancel,
 * progress (steering_acked, heartbeats) and mailbox acks; the daemon watches every namespace's
 * progress through ONE subscription, so a broker that delivers one copy per matching filter
 * (mosquitto) never multiplies a signal.
 */
const WAVE = "w-ns";
const WNS = "wave-ns";
const AGENT = "agent-ns1";
const yaml = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
namespace: ${WNS}
pipeline: [implement, merge_ready]
config: { hard_ceiling: 1 }
tasks:
  A: { issue: 1 }
`;

let broker: TestBroker;
let home: string;
let daemon: Daemon;
let client: ControlClient;
let agent: VolleyBroker;

const start = () =>
  Daemon.start({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    tickMs: 0,
    protocolVersion: 4,
    pressure: NO_PRESSURE,
    interrupt: async () => {},
  });

beforeEach(async () => {
  broker = await startTestBroker();
  home = mkdtempSync(join(tmpdir(), "volleyd-ns-"));
});
afterEach(async () => {
  await agent?.disconnect();
  await client?.close();
  await daemon?.stop();
  await broker.close();
  rmSync(home, { recursive: true, force: true });
});

async function withRunningAgent(): Promise<void> {
  daemon = await start();
  client = await ControlClient.connect(broker.url, NS);
  agent = new VolleyBroker();
  await agent.connect({ url: broker.url, agentId: AGENT });
  expect(
    (await client.request("run", { wave_yaml: yaml, owner: "coord-a" })).error,
  ).toBeUndefined();
  await daemon.recordEvent(WAVE, {
    type: "agent_spawned",
    task: "A",
    data: { role: "implementer", agent_id: AGENT },
  });
  await daemon.recordEvent(WAVE, {
    type: "stage_entered",
    task: "A",
    data: { stage: "implement" },
  });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a wave's namespace", () => {
  it("stop sends the cancel to the agent's mailbox in the wave's namespace", async () => {
    await withRunningAgent();
    const got: string[] = [];
    const unsub = await agent.subscribeStream(`volley/${WNS}/${AGENT}/mailbox`, (m) =>
      got.push(m.payload),
    );
    const res = await client.request("stop", { wave: WAVE, by: "coord-a" });
    expect(res.error).toBeUndefined();
    await waitFor(() => got.length === 1);
    await unsub();
    expect(parseEnvelope(got[0] ?? "")?.type).toBe("cancel");
  });

  it("a steer to a namespaced agent settles: mailbox ack (received) and steering_acked (acked)", async () => {
    await withRunningAgent();
    const unsub = await agent.subscribeStream(`volley/${WNS}/${AGENT}/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      if (env?.type !== "steering" || env.correlation_id === null) return;
      const as = (channel: string, type: string) =>
        JSON.stringify(
          buildEnvelope({
            agentId: AGENT,
            parentId: null,
            channel,
            type,
            correlationId: env.correlation_id,
            payload: { text: "ACKED", acked_type: "steering" },
          }),
        );
      // The hooks ack to the sender's mailbox in the agent's own namespace.
      void agent.publish(`volley/${WNS}/volleyd/mailbox`, as("mailbox", "ack"), {
        qos: 1,
        retain: false,
      });
      void agent.publish(`volley/${WNS}/${AGENT}/progress`, as("progress", "steering_acked"), {
        qos: 0,
        retain: false,
      });
    });
    const res = await client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "rebase first",
      by: "coord-a",
      wait_ack_ms: 3000,
    });
    await unsub();
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ delivery: "acked", received: true, acked: true });
  });
});

describe("one progress subscription", () => {
  it("the daemon subscribes volley/+/+/progress once and drains volley/+/volleyd/mailbox", async () => {
    // A session left by an earlier volleyd that drained only its own namespace's mailbox.
    const legacy = new VolleyBroker();
    await legacy.connect({
      url: broker.url,
      agentId: "volleyd",
      clientId: daemonClientId(NS),
      cleanSession: false,
      protocolVersion: 4,
    });
    await legacy.drainQueued(`volley/${NS}/volleyd/mailbox`, { idleMs: 10, maxMessages: 1 });
    await legacy.disconnect();

    await withRunningAgent();
    await waitFor(() =>
      broker.subscriptions(daemonClientId(NS)).includes("volley/+/volleyd/mailbox"),
    );
    await waitFor(
      () => !broker.subscriptions(daemonClientId(NS)).includes(`volley/${NS}/volleyd/mailbox`),
    );
    const progress = broker
      .subscriptions(daemonClientId(NS))
      .filter((f) => f.endsWith("/progress") || f === "volley/#");
    expect(progress).toEqual(["volley/+/+/progress"]);
  });

  it("an agent watch takes its progress from a supplied feed (no subscription of its own)", async () => {
    const b = new VolleyBroker();
    await b.connect({ url: broker.url, agentId: "watcher", clientId: "watcher-client" });
    const fed: string[] = [];
    let deliver: ((m: { topic: string; payload: string }) => void) | undefined;
    const w = await watchAgent(b, WNS, AGENT, Date.now, async (topic, d) => {
      fed.push(topic);
      deliver = d;
      return async () => {};
    });
    const seen: string[] = [];
    w.onProgress((raw) => seen.push(raw));
    expect(fed).toEqual([`volley/${WNS}/${AGENT}/progress`]);
    expect(broker.subscriptions("watcher-client").some((f) => f.endsWith("/progress"))).toBe(false);
    const hb = JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: null,
        channel: "progress",
        type: "heartbeat",
        payload: { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
      }),
    );
    deliver?.({ topic: `volley/${WNS}/${AGENT}/progress`, payload: hb });
    expect(seen).toEqual([hb]);
    expect(w.state.sessionStart).toBe(true);
    await w.close();
    await b.disconnect();
  });

  it("an API overload signal is counted once, from any namespace, even when delivered twice", async () => {
    await withRunningAgent();
    const signal = JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: null,
        channel: "progress",
        type: "idle",
        payload: { source: "harness-hook", seq: 7, hook_event: "Stop", text: "API overloaded" },
      }),
    );
    // mosquitto delivers one copy per matching subscription: the same bytes twice.
    for (let i = 0; i < 2; i++) {
      await agent.publish(`volley/${WNS}/${AGENT}/progress`, signal, { qos: 1, retain: false });
    }
    const count = async () => {
      await daemon.tick();
      const res = await client.request("admission", {});
      return (res.result as { signals: { api_overload?: { value?: number } } }).signals.api_overload
        ?.value;
    };
    let n = await count();
    for (let i = 0; i < 50 && n === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      n = await count();
    }
    expect(n).toBe(1);
  });
});
