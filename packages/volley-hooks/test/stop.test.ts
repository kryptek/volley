import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import type { Envelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  connectClient,
  fixture,
  makeWorkdir,
  publishRegistry,
  runHook,
  tick,
} from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const NS = "ns";

let broker: TestBroker;
let client: VolleyBroker;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const types = (envs: Envelope[]) => envs.map((e) => e.type);

describe("stop (agent mode)", () => {
  it("publishes idle with the last assistant message, then a heartbeat", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    await tick(150);
    expect(types(progress.envelopes)).toEqual(["idle", "heartbeat"]);
    const [idle, hb] = progress.envelopes as [Envelope, Envelope];
    expect(idle.payload).toMatchObject({
      source: "harness-hook",
      hook_event: "Stop",
      text: "Tests are green and the PR is open.",
    });
    const seqIdle = (idle.payload as { seq: number }).seq;
    expect((hb.payload as { seq: number }).seq).toBe(seqIdle + 1);
    await progress.stop();
  });

  it("truncates text to 500 characters", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook("stop", fixture("stop.json", dir, { last_assistant_message: "x".repeat(900) }), {
      cwd: dir,
    });
    await tick(150);
    expect((progress.envelopes[0]?.payload as { text: string }).text).toHaveLength(500);
    await progress.stop();
  });

  it("an agent-mode question is idle only (no awaiting_input)", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook("stop", fixture("stop-question.json", dir), { cwd: dir });
    await tick(150);
    expect(types(progress.envelopes)).toEqual(["idle", "heartbeat"]);
    await progress.stop();
  });
});

describe("coordinator mode (no agent.json; registry entry found by cwd)", () => {
  const COORD = "coordinator-ab12";
  let dir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    dir = makeWorkdir();
    env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: mkdtempSync(join(tmpdir(), "volley-hooks-state-")),
      VOLLEY_SESSION_URL: "https://claude.ai/code/session_0123",
      VOLLEY_WORKSPACE: "workspace:7",
    };
    // An older session in the same cwd, and an unrelated agent elsewhere.
    await publishRegistry(client, "coordinator-old1", "default", {
      capabilities: [],
      cwd: dir,
      started_at: "2026-10-17T10:00:00.000Z",
    });
    await publishRegistry(client, "elsewhere-zz99", "default", {
      capabilities: [],
      cwd: "/somewhere/else",
      started_at: "2026-10-18T11:00:00.000Z",
    });
    await publishRegistry(client, COORD, "default", {
      capabilities: [],
      cwd: dir,
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("a Stop ending in a question publishes awaiting_input with question, session_url, workspace; the next PostToolUse publishes resumed", async () => {
    const progress = await collect(client, buildTopic("default", COORD, "progress"));
    const run = await runHook("stop", fixture("stop-question.json", dir), { cwd: dir, env });
    expect(run.exitCode).toBe(0);
    await tick(150);
    expect(types(progress.envelopes)).toEqual(["idle", "awaiting_input", "heartbeat"]);
    expect(progress.envelopes[1]?.payload).toMatchObject({
      source: "harness-hook",
      hook_event: "Stop",
      question: "Should I merge PR 12 now?\nIt has two approvals.",
      session_url: "https://claude.ai/code/session_0123",
      workspace: "workspace:7",
    });

    await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir, env });
    await tick(150);
    expect(types(progress.envelopes).slice(3)).toEqual(["resumed", "heartbeat"]);
    expect(progress.envelopes[3]?.payload).toMatchObject({ hook_event: "PostToolUse" });

    // Already resumed: no second resumed.
    await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir, env });
    await tick(150);
    expect(types(progress.envelopes).slice(5)).toEqual(["heartbeat"]);
    await progress.stop();
  });

  it("a Stop without a question is idle only", async () => {
    const progress = await collect(client, buildTopic("default", COORD, "progress"));
    await runHook("stop", fixture("stop.json", dir), { cwd: dir, env });
    await tick(150);
    expect(types(progress.envelopes)).toEqual(["idle", "heartbeat"]);
    await progress.stop();
  });

  it("is a no-op when no registry entry matches the cwd", async () => {
    const other = makeWorkdir();
    const run = await runHook("stop", fixture("stop-question.json", other), { cwd: other, env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  });
});
