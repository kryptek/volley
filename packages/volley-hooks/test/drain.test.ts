import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  connectClient,
  contextOf,
  fixture,
  makeWorkdir,
  publishEnvelope,
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

  it("skips the drain while another hook holds the drain lock", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, ".volley", "drain.lock"), String(process.pid));
    await send("coord-a", "held back", { seq: 1 });
    await tick(50);
    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    expect(contextOf(run.stdout)).toBeNull();
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
