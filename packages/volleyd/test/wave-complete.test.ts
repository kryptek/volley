import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { ControlClient, waveStateTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import { decisionTopic, waveDecisionId } from "../src/decisions";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";

const WAVE = "w-done";
const WAVE_YAML = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
  B: { issue: 2, after: [A] }
`;

let t: DaemonEnv;
let daemon: Daemon;
let client: ControlClient;
let pub: VolleyBroker;

beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start();
  client = await ControlClient.connect(t.broker.url, NS);
  pub = new VolleyBroker();
  await pub.connect({ url: t.broker.url, agentId: "test-pub" });
  const res = await client.request("run", { wave_yaml: WAVE_YAML, owner: "coord-a" });
  expect(res.error).toBeUndefined();
});
afterEach(async () => {
  await pub.disconnect();
  await client.close();
  await t.cleanup();
});

const stage = (task: string, s: string) =>
  daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: s } });
const completions = () => daemon.journalEvents(WAVE).filter((e) => e.type === "wave_complete");

async function retainedState(): Promise<Record<string, unknown>> {
  const env = (await t.retained(waveStateTopic(WAVE))) as { payload: Record<string, unknown> };
  expect(schemaErrors("wave-state.schema.json", env)).toEqual([]);
  return env.payload;
}

/** The owner's status/progress reach the daemon, and its retained state the reader, over MQTT. */
const waitFor = eventually;

describe("a wave completes", () => {
  it("every task done → wave_complete journaled once, status complete, wave_complete decision open", async () => {
    await stage("A", "done");
    await daemon.tick();
    expect(completions()).toHaveLength(0);
    await stage("B", "done");
    await daemon.tick();
    await daemon.tick();
    expect(completions()).toHaveLength(1);
    expect(completions()[0]?.data).toMatchObject({ done: ["A", "B"], cancelled: [] });
    const state = await retainedState();
    expect(state.status).toBe("complete");
    const open = state.open_decisions as string[];
    expect(open).toHaveLength(1);
    const d = (await t.retained(decisionTopic(WAVE, open[0] as string))) as {
      payload: { kind: string; task: string | null; question: string };
    };
    expect(schemaErrors("decision.schema.json", d)).toEqual([]);
    expect(d.payload).toMatchObject({ kind: "wave_complete", task: null });
    expect(d.payload.question).toContain(`release/${WAVE}`);
  });

  it("two waves' wave_complete decisions have their own ids: resolve without --wave answers each", async () => {
    const W2 = "w-done-2";
    const res = await client.request("run", {
      wave_yaml: WAVE_YAML.replaceAll(WAVE, W2),
      owner: "coord-a",
    });
    expect(res.error).toBeUndefined();
    for (const w of [WAVE, W2])
      for (const task of ["A", "B"])
        await daemon.recordEvent(w, { type: "stage_entered", task, data: { stage: "done" } });
    await daemon.tick();
    await daemon.tick();
    const ids = [WAVE, W2].map((w) => daemon.record(w)?.state?.open_decisions ?? []);
    expect(ids).toEqual([
      [waveDecisionId("wave_complete", WAVE)],
      [waveDecisionId("wave_complete", W2)],
    ]);
    for (const [i, w] of [WAVE, W2].entries()) {
      const r = await client.request("resolve", {
        decision_id: ids[i]?.[0],
        answer: "acknowledged",
        by: "coord-a",
      });
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({ wave: w });
      expect(daemon.record(w)?.state?.open_decisions).toEqual([]);
    }
  });

  it("done + cancelled tasks complete the wave too", async () => {
    await stage("A", "done");
    await daemon.recordEvent(WAVE, { type: "task_cancelled", task: "B", data: { by: "coord-a" } });
    await daemon.tick();
    expect(completions()[0]?.data).toMatchObject({ done: ["A"], cancelled: ["B"] });
    expect(daemon.snapshot(WAVE)?.status).toBe("complete");
  });

  it("a failed wave_complete decision open is retried on the next tick", async () => {
    const d = daemon as unknown as { openDecisionNow: (...a: unknown[]) => Promise<unknown> };
    const real = d.openDecisionNow.bind(daemon);
    d.openDecisionNow = async () => {
      throw new Error("broker publish failed");
    };
    await stage("A", "done");
    await stage("B", "done");
    await daemon.tick().catch(() => {});
    d.openDecisionNow = real;
    await daemon.tick();
    expect(completions()).toHaveLength(1);
    expect((await retainedState()).open_decisions).toHaveLength(1);
  });

  it("a paused or stopped wave does not complete", async () => {
    expect((await client.request("pause", { wave: WAVE, by: "coord-a" })).ok).toBe(true);
    await stage("A", "done");
    await stage("B", "done");
    await daemon.tick();
    expect(completions()).toHaveLength(0);
  });
});

describe("awaiting_decision", () => {
  it("a running wave whose every unsettled task waits on a decision publishes awaiting_decision", async () => {
    await stage("A", "implement");
    const d = await daemon.openDecision(WAVE, {
      kind: "agent_blocked",
      task: "A",
      question: "v1 or v2?",
    });
    // A parked; B is queued behind A.
    expect((await retainedState()).status).toBe("awaiting_decision");
    // Internally the wave keeps running (admission, pipeline ticks).
    expect(daemon.record(WAVE)?.state?.status).toBe("running");
    await daemon.resolveDecision(WAVE, d.decision_id, { answer: "v2", by: "coord-a" });
    expect((await retainedState()).status).toBe("running");
  });

  it("a wave whose only open decisions are held waits on the blocker, not on the owner", async () => {
    await stage("A", "implement");
    const d = await daemon.openDecision(WAVE, {
      kind: "agent_blocked",
      task: "A",
      question: "v1 or v2?",
    });
    expect((await retainedState()).status).toBe("awaiting_decision");
    const h = await client.request("hold", {
      decision_id: d.decision_id,
      on: { issue: 7 },
      by: "coord-a",
    });
    expect(h.error).toBeUndefined();
    expect((await retainedState()).status).toBe("running");
  });
});

describe("coordinator attention", () => {
  const as = async (channel: string, type: string, payload: Record<string, unknown> = {}) => {
    const env = buildEnvelope({ agentId: "coord-a", parentId: null, channel, type, payload });
    await pub.publish(`volley/${NS}/coord-a/${channel}`, JSON.stringify(env), {
      qos: 1,
      retain: channel === "status",
    });
  };
  const coordinator = async () =>
    (await retainedState()).coordinator as Record<string, unknown> | undefined;

  it("follows the owner's status and progress: working → awaiting_input (question) → gone", async () => {
    await as("status", "working");
    await waitFor(async () => (await coordinator())?.state === "working");
    expect(await coordinator()).toMatchObject({ agent_id: "coord-a", state: "working" });

    await as("progress", "awaiting_input", {
      source: "harness-hook",
      seq: 3,
      hook_event: "Notification",
      question: "Merge T1 now?\nIt is green.\nThird line is dropped.",
      session_url: "https://example.test/session/1",
      workspace: "workspace:7",
    });
    await waitFor(async () => (await coordinator())?.state === "awaiting_input");
    expect(await coordinator()).toMatchObject({
      question: "Merge T1 now?\nIt is green.",
      session_url: "https://example.test/session/1",
      workspace: "workspace:7",
    });

    await as("progress", "resumed", {
      source: "harness-hook",
      seq: 4,
      hook_event: "UserPromptSubmit",
    });
    await waitFor(async () => (await coordinator())?.state === "working");
    expect(await coordinator()).not.toHaveProperty("question");

    await as("status", "reaped");
    await waitFor(async () => (await coordinator())?.state === "gone");
  });

  it("keeps no attention or finished status for agents that own no wave (bounded memory)", async () => {
    const maps = daemon as unknown as {
      statusOf: Map<string, unknown>;
      attentionOf: Map<string, unknown>;
    };
    const from = async (agent: string, channel: string, type: string) => {
      const env = buildEnvelope({ agentId: agent, parentId: null, channel, type, payload: {} });
      await pub.publish(`volley/${NS}/${agent}/${channel}`, JSON.stringify(env), {
        qos: 1,
        retain: channel === "status",
      });
    };
    await from("agent-x", "progress", "awaiting_input");
    await from("agent-y", "status", "working");
    await waitFor(() => maps.statusOf.has("agent-y"));
    await from("agent-y", "status", "done");
    await waitFor(() => !maps.statusOf.has("agent-y"));
    // The owner's entries stay: its `coordinator` turns `gone`.
    await as("status", "done");
    await waitFor(async () => (await coordinator())?.state === "gone");
    expect(maps.attentionOf.has("agent-x")).toBe(false);
  });

  it("is absent until anything of the owner was seen", async () => {
    expect(await coordinator()).toBeUndefined();
  });
});
