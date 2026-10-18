import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { appendBlock, markSuperseded } from "../src/lib/steering-file";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  connectClient,
  contextOf,
  fixture,
  makeWorkdir,
  publishEnvelope,
  publishRegistry,
  retainedEnvelope,
  runHook,
  tick,
} from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const NS = "ns";

let broker: TestBroker;
let client: VolleyBroker;
let dir: string;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  dir = makeWorkdir({
    agent_id: AGENT,
    namespace: NS,
    parent_id: "coordinator-ab12",
    broker_url: broker.url,
  });
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const sessionStart = (name: string) => runHook("session-start", fixture(name, dir), { cwd: dir });

describe("session-start", () => {
  it("publishes the harness-reported model on the retained registry entry", async () => {
    const run = await sessionStart("session-start-startup.json");
    expect(run.exitCode).toBe(0);
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.type).toBe("registered");
    expect(reg.channel).toBe("_system/registry");
    expect(reg.namespace).toBe(NS);
    expect(reg.parent_id).toBe("coordinator-ab12");
    expect(reg.payload).toMatchObject({
      model: "claude-opus-5-5",
      model_source: "harness-hook",
      capabilities: [],
      cwd: dir,
    });
  });

  it("keeps the last known model and marks it unknown when the input has none", async () => {
    await publishRegistry(client, AGENT, NS, {
      capabilities: ["implements-issue"],
      cwd: dir,
      model: "claude-sonnet-5-5",
      started_at: "2026-10-18T10:00:00.000Z",
    });
    await sessionStart("session-start-no-model.json");
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toEqual({
      capabilities: ["implements-issue"],
      cwd: dir,
      model: "claude-sonnet-5-5",
      model_source: "unknown",
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("flips a spawning/registered status to working, and leaves other states alone", async () => {
    const statusTopic = buildTopic(NS, AGENT, "status");
    const setStatus = (type: string) =>
      publishEnvelope(
        client,
        statusTopic,
        { agentId: AGENT, parentId: null, channel: "status", type },
        { qos: 1, retain: true },
      );
    await setStatus("registered");
    await sessionStart("session-start-startup.json");
    expect((await retainedEnvelope(client, statusTopic)).type).toBe("working");

    await setStatus("done");
    await sessionStart("session-start-startup.json");
    expect((await retainedEnvelope(client, statusTopic)).type).toBe("done");
  });

  it("publishes a heartbeat", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await sessionStart("session-start-startup.json");
    await tick(150);
    const hb = progress.envelopes.find((e) => e.type === "heartbeat");
    expect(hb?.payload).toMatchObject({ source: "harness-hook", hook_event: "SessionStart" });
    expect(typeof (hb?.payload as { seq: unknown }).seq).toBe("number");
    await progress.stop();
  });

  it("emits no context on a plain startup", async () => {
    const run = await sessionStart("session-start-startup.json");
    expect(run.stdout).toBe("");
  });

  it.each(["session-start-compact.json", "session-start-resume.json"])(
    "%s re-injects every live STEERING.md directive",
    async (name) => {
      const path = join(dir, ".volley", "STEERING.md");
      const base = { type: "steering", from: "coordinator-ab12", at: "2026-10-18T10:00:00.000Z" };
      appendBlock(path, { ...base, seq: 1, id: "id-1", text: "use approach A" });
      appendBlock(path, { ...base, seq: 2, id: "id-2", text: "use approach B" });
      appendBlock(path, { ...base, seq: 3, id: "id-3", text: "keep the PR small" });
      markSuperseded(path, "id-1", "id-2", "coordinator-ab12");
      const run = await sessionStart(name);
      const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const ctx = contextOf(run.stdout);
      expect(ctx).toContain("use approach B");
      expect(ctx).toContain("keep the PR small");
      expect(ctx).not.toContain("use approach A");
    },
  );

  it("a done directive is not re-injected", async () => {
    const path = join(dir, ".volley", "STEERING.md");
    appendBlock(path, {
      seq: 1,
      type: "steering",
      id: "id-1",
      from: "coordinator-ab12",
      at: "2026-10-18T10:00:00.000Z",
      text: "already handled",
    });
    const { readFileSync } = await import("node:fs");
    writeFileSync(path, readFileSync(path, "utf-8").replace("state=live", "state=done"));
    const run = await sessionStart("session-start-compact.json");
    expect(run.stdout).toBe("");
  });

  it("bootstraps the persistent drain session so later mail is queued", async () => {
    await sessionStart("session-start-startup.json");
    await publishEnvelope(client, `volley/${NS}/${AGENT}/mailbox`, {
      agentId: "coordinator-ab12",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "queued while idle", seq: 1 },
      correlationId: "5f8b8a52-3f7e-4b8e-9d0c-1a2b3c4d5e6f",
    });
    await tick(50);
    const run = await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
    expect(contextOf(run.stdout)).toContain("queued while idle");
  });
});

describe("post-model-switch", () => {
  it("re-publishes the registry entry with to_model", async () => {
    await publishRegistry(client, AGENT, NS, {
      capabilities: [],
      cwd: dir,
      model: "claude-haiku-5-5",
      started_at: "2026-10-18T10:00:00.000Z",
    });
    const run = await runHook("post-model-switch", fixture("post-model-switch.json", dir), {
      cwd: dir,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toMatchObject({
      model: "claude-sonnet-5-5",
      model_source: "harness-hook",
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });
});
