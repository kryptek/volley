import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

async function publisherFor(tb: TestBroker, agentId: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: tb.url,
    agentId,
    willTopic: `volley/_meta/cli/${agentId}/will`,
    willPayload: "",
  });
  return b;
}

async function publishStatus(
  broker: VolleyBroker,
  ns: string,
  agentId: string,
  type: string,
): Promise<void> {
  const env = buildEnvelope({ agentId, parentId: null, channel: "status", type, payload: {} });
  await broker.publish(`volley/${ns}/${agentId}/status`, JSON.stringify(env), {
    qos: 1,
    retain: true,
  });
}

describe("volley wait", () => {
  let tb: TestBroker;
  let agent: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    agent = await publisherFor(tb, "agent-1");
  });
  afterEach(async () => {
    await agent.disconnect();
    await tb.close();
  });

  it("returns 0 immediately when the retained status is already terminal", async () => {
    await publishStatus(agent, "test", "a-aaaa", "done");

    const r = await runCli({
      argv: [
        "wait",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--timeout",
        "5",
      ],
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ agent_id: "a-aaaa", terminal_type: "done" });
  });

  it("blocks, then returns 0 when a terminal status is published mid-wait", async () => {
    // Start in "working" state.
    await publishStatus(agent, "test", "a-aaaa", "working");

    const run = runCli({
      argv: [
        "wait",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--timeout",
        "10",
      ],
    });

    // After a beat, transition to a terminal state.
    setTimeout(() => {
      void publishStatus(agent, "test", "a-aaaa", "blocked");
    }, 300);

    const r = await run;
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).terminal_type).toBe("blocked");
  });

  it("on timeout with no terminal state, exits 124", async () => {
    await publishStatus(agent, "test", "a-aaaa", "working");
    const r = await runCli({
      argv: [
        "wait",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--timeout",
        "1",
      ],
    });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("timeout");
  });

  it("honors a custom --terminal-states list", async () => {
    // With terminal-states = "done" only, a "blocked" status should NOT trigger exit.
    await publishStatus(agent, "test", "a-aaaa", "blocked");
    const r = await runCli({
      argv: [
        "wait",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--terminal-states",
        "done",
        "--timeout",
        "1",
      ],
    });
    expect(r.exitCode).toBe(124);
  });
});
