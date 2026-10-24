import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { registryTopic } from "volley-mcp/topics";
import { appendBlock, readBlocks } from "../src/lib/steering-file";
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
const MAILBOX = `volley/${NS}/${AGENT}/mailbox`;

let broker: TestBroker;
let client: VolleyBroker;
let dir: string;

async function send(
  from: string,
  text: string,
  extra: { seq?: number; supersedes?: string; type?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const { type = "steering", ...payload } = extra;
  await publishEnvelope(client, MAILBOX, {
    agentId: from,
    parentId: null,
    channel: "mailbox",
    type,
    payload: { text, ...payload },
    correlationId: id,
  });
  return id;
}

const postToolUse = () =>
  runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
  // One-time bootstrap: the first hook run creates the persistent drain session.
  const boot = await postToolUse();
  expect(boot.exitCode).toBe(0);
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

describe("mailbox drain (post-tool-use)", () => {
  it("injects messages queued while no hook ran, in seq order, acks each sender once", async () => {
    const acksA = await collect(client, `volley/${NS}/coord-a/mailbox`);
    const acksB = await collect(client, `volley/${NS}/coord-b/mailbox`);
    const id2 = await send("coord-a", "then rebase on the release branch", { seq: 2 });
    const id1 = await send("coord-b", "first run the integration suite", { seq: 1 });
    await tick(100);

    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("[volley steering] 2 message(s)");
    expect(ctx.indexOf("first run the integration suite")).toBeGreaterThan(-1);
    expect(ctx.indexOf("first run the integration suite")).toBeLessThan(
      ctx.indexOf("then rebase on the release branch"),
    );
    expect(ctx).toContain("steering_acked");
    expect(ctx).toContain(id1);
    expect(ctx).toContain(id2);

    await tick(200);
    expect(acksA.envelopes.map((e) => [e.type, e.correlation_id, e.agent_id])).toEqual([
      ["ack", id2, AGENT],
    ]);
    expect(acksB.envelopes.map((e) => [e.type, e.correlation_id, e.agent_id])).toEqual([
      ["ack", id1, AGENT],
    ]);
    expect(acksB.envelopes[0]?.payload).toEqual({ text: "ACKED", acked_type: "steering", seq: 1 });

    const steering = readFileSync(join(dir, ".volley", "STEERING.md"), "utf-8");
    expect(steering.match(/^## /gm)).toHaveLength(2);
    expect(steering).toContain(`## 1 steering ${id1}`);
    expect(steering).toContain(`## 2 steering ${id2}`);

    // Idempotent: nothing new queued → no context, no further acks.
    const again = await postToolUse();
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe("");
    await tick(200);
    expect(acksA.envelopes).toHaveLength(1);
    expect(acksB.envelopes).toHaveLength(1);
    expect(readFileSync(join(dir, ".volley", "STEERING.md"), "utf-8")).toBe(steering);

    await acksA.stop();
    await acksB.stop();
  });

  it("acks only what mailbox.schema.json allows: a known type and a UUID message id", async () => {
    const acks = await collect(client, `volley/${NS}/coord-a/mailbox`);
    const ok = await send("coord-a", "a normal steer");
    await send("coord-a", "an unknown type", { type: "shout" });
    await publishEnvelope(client, MAILBOX, {
      agentId: "coord-a",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "a non-UUID id" },
      correlationId: "not-a-uuid",
    });
    await tick(100);
    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    // Every message is still injected; only the schema-valid one is acked.
    const ctx = (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toContain("a normal steer");
    expect(ctx).toContain("an unknown type");
    expect(ctx).toContain("a non-UUID id");
    await tick(200);
    expect(
      acks.envelopes.map((e) => [
        e.correlation_id,
        (e.payload as { acked_type: string }).acked_type,
      ]),
    ).toEqual([[ok, "steering"]]);
    await acks.stop();
  });

  it("supersedes marks the older block and only the live one is injected", async () => {
    const id1 = await send("coord-a", "use approach A", { seq: 1 });
    await tick(50);
    expect(contextOf((await postToolUse()).stdout)).toContain("use approach A");

    const id2 = await send("coord-a", "use approach B instead", { seq: 2, supersedes: id1 });
    await tick(50);
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx).toContain("use approach B instead");
    expect(ctx).not.toContain("use approach A");

    const steering = readFileSync(join(dir, ".volley", "STEERING.md"), "utf-8");
    const block1 = steering.slice(steering.indexOf(`## 1 steering ${id1}`));
    expect(block1.split("\n")[1]).toContain(`state=superseded by=${id2}`);
    expect(steering).toContain(`## 2 steering ${id2}`);
  });

  it("drops a superseded message that arrives in the same drain as its replacement", async () => {
    const id3 = await send("coord-a", "deploy to staging", { seq: 3 });
    await send("coord-a", "do not deploy at all", { seq: 4, supersedes: id3 });
    await tick(50);
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx).toContain("[volley steering] 1 message(s)");
    expect(ctx).toContain("do not deploy at all");
    expect(ctx).not.toContain("deploy to staging");
  });

  it("ignores supersedes from a different sender", async () => {
    const id1 = await send("coord-a", "keep the old API", { seq: 1 });
    await tick(50);
    await postToolUse();
    await send("coord-b", "drop the old API", { seq: 1, supersedes: id1 });
    await tick(50);
    await postToolUse();
    const steering = readFileSync(join(dir, ".volley", "STEERING.md"), "utf-8");
    expect(steering).not.toContain("state=superseded");
  });

  it("surfaces acks for messages this agent sent without storing or re-acking them", async () => {
    const acks = await collect(client, `volley/${NS}/coord-a/mailbox`);
    const sentId = randomUUID();
    await publishEnvelope(client, MAILBOX, {
      agentId: "coord-a",
      parentId: null,
      channel: "mailbox",
      type: "ack",
      payload: { text: "ACKED", acked_type: "steering" },
      correlationId: sentId,
    });
    await tick(50);
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx).toContain(`coord-a acknowledged your message ${sentId}`);
    await tick(150);
    expect(acks.envelopes).toHaveLength(0);
    await acks.stop();
  });

  it("skips the drain while another hook holds the drain lock; the mail stays queued", async () => {
    const lock = join(dir, ".volley", "drain.lock");
    writeFileSync(lock, "another-hook");
    await send("coord-a", "held back", { seq: 1 });
    await tick(50);
    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    expect(contextOf(run.stdout)).toBeNull();
    // The other hook's lock is untouched.
    expect(readFileSync(lock, "utf-8")).toBe("another-hook");

    unlinkSync(lock);
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx?.split("held back")).toHaveLength(2);
    expect(contextOf((await postToolUse()).stdout)).toBeNull();
  });

  it("injects a directive stored but never delivered (crash after the ack), exactly once", async () => {
    const acks = await collect(client, `volley/${NS}/coord-a/mailbox`);
    // A previous hook appended this block and acked it, then died before its stdout reached
    // the model: the sender saw the ack and will never re-send.
    appendBlock(join(dir, ".volley", "STEERING.md"), {
      seq: 7,
      type: "steering",
      id: "lost-1",
      from: "coord-a",
      at: "2026-10-18T10:00:00.000Z",
      text: "rebase before you push",
    });
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx).toContain("rebase before you push");
    expect(ctx).toContain("steering_acked");
    expect(readBlocks(join(dir, ".volley", "STEERING.md"))[0]?.delivered).toBe(true);
    expect(contextOf((await postToolUse()).stdout)).toBeNull();
    await tick(100);
    expect(acks.envelopes).toHaveLength(0);
    await acks.stop();
  });

  it("a redelivered message stored but never injected is re-acked and injected once", async () => {
    const acks = await collect(client, `volley/${NS}/coord-a/mailbox`);
    const id = randomUUID();
    appendBlock(join(dir, ".volley", "STEERING.md"), {
      seq: 1,
      type: "steering",
      id,
      from: "coord-a",
      at: "2026-10-18T10:00:00.000Z",
      text: "ship it after the checks",
    });
    // The sender never saw an ack and retries with the same id.
    await publishEnvelope(client, MAILBOX, {
      agentId: "coord-a",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "ship it after the checks", seq: 1 },
      correlationId: id,
    });
    await tick(50);
    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx?.split("ship it after the checks")).toHaveLength(2);
    await tick(150);
    expect(acks.envelopes.map((e) => e.correlation_id)).toEqual([id]);
    expect(readFileSync(join(dir, ".volley", "STEERING.md"), "utf-8").match(/^## /gm)).toHaveLength(
      1,
    );
    expect(contextOf((await postToolUse()).stdout)).toBeNull();
    await acks.stop();
  });

  it("restores the harness model when the MCP server's own register overwrote it", async () => {
    await runHook("session-start", fixture("session-start-startup.json", dir), { cwd: dir });
    // The MCP server's startup auto-register (or the agent's vol_register) replaces the entry.
    await publishRegistry(client, AGENT, NS, {
      capabilities: ["implements-issue"],
      cwd: dir,
      model: "self-reported-model",
      model_source: "self-reported",
      started_at: "2026-10-18T10:00:00.000Z",
    });
    await postToolUse();
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toMatchObject({
      capabilities: ["implements-issue"],
      model: "claude-opus-5-5",
      model_source: "harness-hook",
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("honours VOLLEY_HOOKS_DRAIN_MATCHER for PostToolUse", async () => {
    await send("coord-a", "after the next edit", { seq: 1 });
    await tick(50);
    const env = { VOLLEY_HOOKS_DRAIN_MATCHER: "^(Edit|Write)$" };
    const bash = await runHook("post-tool-use", fixture("post-tool-use.json", dir), {
      cwd: dir,
      env,
    });
    expect(contextOf(bash.stdout)).toBeNull();
    const edit = await runHook(
      "post-tool-use",
      fixture("post-tool-use.json", dir, { tool_name: "Edit" }),
      { cwd: dir, env },
    );
    expect(contextOf(edit.stdout)).toContain("after the next edit");
  });

  it("user-prompt-submit: a stuck work-log lock never loses drained steering", async () => {
    // A held lock, its mtime a minute ahead so it never turns stale: withLock times out on it.
    const lock = join(dir, ".volley", "work-log.lock");
    writeFileSync(lock, "4242.held-by-a-live-hook");
    const ahead = new Date(Date.now() + 60_000);
    utimesSync(lock, ahead, ahead);
    const id = await send("coord-a", "stop and rebase first", { seq: 1 });
    await tick(50);
    const run = await runHook("user-prompt-submit", fixture("user-prompt-submit.json", dir), {
      cwd: dir,
    });
    expect(run.exitCode).toBe(0);
    expect(contextOf(run.stdout)).toContain("stop and rebase first");
    const block = readBlocks(join(dir, ".volley", "STEERING.md")).find((b) => b.id === id);
    expect(block?.delivered).toBe(true);
  });

  it("user-prompt-submit drains too", async () => {
    await send("coord-a", "pause after this step", { seq: 1 });
    await tick(50);
    const run = await runHook("user-prompt-submit", fixture("user-prompt-submit.json", dir), {
      cwd: dir,
    });
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(contextOf(run.stdout)).toContain("pause after this step");
  });
});
