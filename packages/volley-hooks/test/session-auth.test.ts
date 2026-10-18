import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { openDrainSession } from "../src/lib/drain";
import type { HookIdentity } from "../src/lib/identity";
import {
  connectDrain,
  lookupRegistry,
  openSession,
  resolveSessionExpiry,
} from "../src/lib/session";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  contextOf,
  eventually,
  fixture,
  makeWorkdir,
  publishEnvelope,
  retainedEnvelope,
  runHook,
  tick,
} from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const NS = "ns";
const PASSWORD = "minted-pw";

let broker: TestBroker;
let client: VolleyBroker;

beforeEach(async () => {
  broker = await startTestBroker({ credentials: { username: AGENT, password: PASSWORD } });
  client = new VolleyBroker();
  await client.connect({
    url: broker.url,
    agentId: "test-observer",
    username: AGENT,
    password: PASSWORD,
  });
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

/** A minted agent's worktree: `.volley/agent.json` with a `broker` block. */
const mintedDir = (password = PASSWORD) =>
  makeWorkdir({
    agent_id: AGENT,
    namespace: NS,
    parent_id: "coord-a",
    broker_url: broker.url,
    broker: { username: AGENT, password },
  });

function agentIdentity(dir: string): HookIdentity {
  return {
    mode: "agent",
    agentId: AGENT,
    namespace: NS,
    parentId: "coord-a",
    brokerUrl: broker.url,
    projectDir: dir,
    stateDir: join(dir, ".volley"),
  };
}

describe("hooks against an authenticating broker — right credentials", () => {
  it("SessionStart registers with model_source harness-hook and heartbeats; PostToolUse drains + acks a steer", async () => {
    const dir = mintedDir();
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const start = await runHook("session-start", fixture("session-start-startup.json", dir), {
      cwd: dir,
    });
    expect(start.exitCode).toBe(0);
    expect(start.stderr).toBe("");
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toMatchObject({
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
    await eventually(() =>
      progress.envelopes.some(
        (e) =>
          e.type === "heartbeat" &&
          (e.payload as { hook_event?: string }).hook_event === "SessionStart",
      ),
    );
    await progress.stop();

    const acks = await collect(client, buildTopic(NS, "coord-a", "mailbox"));
    const id = randomUUID();
    await publishEnvelope(client, buildTopic(NS, AGENT, "mailbox"), {
      agentId: "coord-a",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "run the auth suite next", seq: 1 },
      correlationId: id,
    });
    await tick(100);
    const post = await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
    expect(post.exitCode).toBe(0);
    expect(contextOf(post.stdout)).toContain("run the auth suite next");
    await eventually(() => acks.envelopes.some((e) => e.type === "ack" && e.correlation_id === id));
    await acks.stop();
  });
});

describe("hooks against an authenticating broker — refused", () => {
  const rejectsAuth = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ code: "AUTH_FAILED" });

  it("wrong credentials: every connect rejects with AUTH_FAILED", async () => {
    const identity = agentIdentity(mintedDir("wrong"));
    // Aedes speaks MQTT 3.1.1 only.
    const env = { VOLLEY_HOOKS_MQTT_VERSION: "4" };
    await rejectsAuth(resolveSessionExpiry(identity, env));
    // A fresh config cache, so connectDrain reaches its own connect.
    writeFileSync(
      join(identity.stateDir, "config.json"),
      JSON.stringify({ session_expiry_s: 60, fetched_at: Date.now() }),
    );
    await rejectsAuth(connectDrain(identity, env));
    await rejectsAuth(openSession(identity, "Stop", env));
    await rejectsAuth(openDrainSession(identity, { env, event: "PostToolUse" }, true));
    await rejectsAuth(
      lookupRegistry(broker.url, makeWorkdir(), { VOLLEY_AUTH_USERNAME: "coordinator" }),
    );
  });

  it("anonymous (no broker block, no env) rejects with AUTH_FAILED", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
    await rejectsAuth(openSession(agentIdentity(dir), "Stop", {}));
    const authDir = mkdtempSync(join(tmpdir(), "volley-hooks-noauth-"));
    mkdirSync(authDir, { recursive: true });
    await rejectsAuth(lookupRegistry(broker.url, makeWorkdir(), { VOLLEY_AUTH_DIR: authDir }));
  });

  it("coordinator lookup uses $VOLLEY_AUTH_DIR/coordinator.json", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "volley-hooks-authdir-"));
    writeFileSync(
      join(authDir, "coordinator.json"),
      JSON.stringify({ username: AGENT, password: PASSWORD }),
    );
    await expect(
      lookupRegistry(broker.url, makeWorkdir(), { VOLLEY_AUTH_DIR: authDir }),
    ).resolves.toEqual([]);
  });
});
