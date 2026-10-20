import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { ControlClient } from "../src/control";
import type { AgentIdentityFile } from "../src/identity";
import { NS } from "./helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * A steer sent while a task has no live agent (its implementer retired, the next one not up yet)
 * is queued, never published to the retired agent, and delivered to the task's next agent (of the
 * role it names) once that agent registers; a task that ends drops it.
 */

let s: SupervisedEnv;
let client: ControlClient;
afterEach(async () => {
  await client?.close();
  await s?.cleanup();
});

/** Every later launch registers like a real session: status, registry entry, heartbeat. */
function registerEveryLaunch(env: SupervisedEnv): void {
  const pub = (id: string, topic: string, type: string, channel: string, payload: unknown) =>
    env.agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: id, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain: channel !== "progress" },
    );
  env.host.onLaunch = async (spec) => {
    const file = join(spec.cwd, ".volley", "agent.json");
    const id = (JSON.parse(readFileSync(file, "utf-8")) as AgentIdentityFile).agent_id;
    await pub(id, buildTopic(NS, id, "status"), "spawning", "status", {});
    await pub(id, registryTopic(id), "registered", "_system/registry", {
      capabilities: [],
      cwd: "/wt",
      started_at: new Date().toISOString(),
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
    await pub(id, buildTopic(NS, id, "status"), "working", "status", { source: "harness-hook" });
    await pub(id, buildTopic(NS, id, "progress"), "heartbeat", "progress", {
      source: "harness-hook",
      seq: 1,
      hook_event: "SessionStart",
    });
  };
}

/** w1's implementer failed and is retired: T1 waits on the respawn decision, no agent is live. */
async function retiredImplementer(): Promise<string> {
  s = await makeSupervisedEnv();
  client = await ControlClient.connect(s.env.broker.url, NS);
  registerEveryLaunch(s);
  await s.status("failed", { reason: "tests red" });
  await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
  const opened = await s.event("decision_opened");
  await s.settled();
  return opened.data.decision_id as string;
}

/** The steering messages published to `agentId`'s mailbox, as they arrive. */
async function mailbox(agentId: string) {
  const seen: { id: string | null; payload: Record<string, unknown> }[] = [];
  await s.agent.subscribeStream(buildTopic(NS, agentId, "mailbox"), ({ payload }) => {
    const env = parseEnvelope(payload);
    if (env?.type === "steering")
      seen.push({ id: env.correlation_id, payload: env.payload as Record<string, unknown> });
  });
  return seen;
}

const steer = async (fields: Record<string, unknown>) => {
  const res = await client.request("steer", { wave: "w1", task: "T1", by: "coord-a", ...fields });
  expect(res.error).toBeUndefined();
  return res.result as { message_id: string; seq: number; delivery: string };
};

const queuedOf = () => s.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.queued_steers;

const resolve = async (id: string, answer: string) => {
  const res = await client.request("resolve", { wave: "w1", decision_id: id, answer, by: "x" });
  expect(res.error).toBeUndefined();
};

describe("steer with no live agent", () => {
  it("is queued, then delivered in order to the next agent of the task when it registers", async () => {
    const decision = await retiredImplementer();
    const retired = await mailbox(AGENT);
    const next = "w1-t1-implementer-2";
    const got = await mailbox(next);

    const first = await steer({ text: "use the shared table" });
    const second = await steer({ text: "and keep v1" });
    expect(first).toMatchObject({ delivery: "queued", seq: 1 });
    expect(second).toMatchObject({ delivery: "queued", seq: 2, supersedes: first.message_id });
    expect(queuedOf()).toBe(2);

    await resolve(decision, "respawn");
    await s.event((e) => e.type === "agent_registered" && e.data.agent_id === next);
    await s.event((e) => e.type === "steering_sent" && e.data.message_id === second.message_id);
    await s.until(() => got.length === 2);
    await s.consumed();

    expect(got.map((m) => m.id)).toEqual([first.message_id, second.message_id]);
    expect(got[0]?.payload).toMatchObject({
      text: "use the shared table",
      seq: 1,
      wave: "w1",
      task: "T1",
      by: "coord-a",
    });
    expect(got[0]?.payload).not.toHaveProperty("supersedes");
    expect(got[1]?.payload).toMatchObject({ seq: 2, supersedes: first.message_id });
    const sent = s.journal().filter((e) => e.type === "steering_sent");
    expect(sent.map((e) => [e.data.message_id, e.data.agent_id, e.data.queued])).toEqual([
      [first.message_id, next, true],
      [second.message_id, next, true],
    ]);
    expect(queuedOf()).toBeUndefined();
    expect(retired).toEqual([]);

    // A live agent again: the next steer goes straight to it, numbered after the queued ones.
    const third = await steer({ text: "ship it", wait_ack_ms: 0 });
    expect(third).toMatchObject({ delivery: "delivered", seq: 3, supersedes: second.message_id });
  });

  it("--role waits for an agent of that role: another role registering does not take it", async () => {
    await retiredImplementer();
    const rebase = await mailbox("w1-t1-rebase-1");
    const fixup = await mailbox("w1-t1-fixup-1");
    const queued = await steer({ text: "fix the lint", role: "fixup" });
    expect(queued).toMatchObject({ delivery: "queued", queued_for: "fixup" });

    expect((await client.request("spawn", { wave: "w1", task: "T1", role: "rebase" })).ok).toBe(
      true,
    );
    await s.event((e) => e.type === "agent_registered" && e.data.role === "rebase");
    await s.consumed();
    expect(rebase).toEqual([]);
    expect(queuedOf()).toBe(1);

    expect((await client.request("spawn", { wave: "w1", task: "T1", role: "fixup" })).ok).toBe(
      true,
    );
    await s.event((e) => e.type === "steering_sent" && e.data.message_id === queued.message_id);
    await s.until(() => fixup.length === 1);
    expect(fixup[0]?.payload).toMatchObject({ text: "fix the lint", seq: 1 });
    expect(rebase).toEqual([]);
    expect(queuedOf()).toBeUndefined();
  });

  it("a cancelled task drops its queue (journaled) and delivers it to nobody", async () => {
    const decision = await retiredImplementer();
    const queued = await steer({ text: "never mind" });
    await resolve(decision, "cancel");
    const dropped = await s.event("steering_dropped");
    expect(dropped.task).toBe("T1");
    expect(dropped.data).toEqual({ message_ids: [queued.message_id], reason: "task cancelled" });
    expect(queuedOf()).toBeUndefined();
    expect(s.journal().some((e) => e.type === "steering_sent")).toBe(false);
  });

  it("a task that reaches done drops its queue (journaled)", async () => {
    await retiredImplementer();
    const queued = await steer({ text: "too late" });
    await s.daemon.recordEvent("w1", {
      type: "stage_entered",
      task: "T1",
      data: { stage: "done" },
    });
    const dropped = await s.event("steering_dropped");
    expect(dropped.task).toBe("T1");
    expect(dropped.data).toEqual({ message_ids: [queued.message_id], reason: "task done" });
    expect(queuedOf()).toBeUndefined();
  });

  it("survives a daemon restart (the journal holds the queue)", async () => {
    await retiredImplementer();
    await steer({ text: "after the restart" });
    await s.daemon.stop();
    const again = await s.restart();
    expect(again.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.queued_steers).toBe(1);
    expect(again.record("w1")?.queued_steers.T1?.[0]).toMatchObject({
      text: "after the restart",
      seq: 1,
    });
  });
});
