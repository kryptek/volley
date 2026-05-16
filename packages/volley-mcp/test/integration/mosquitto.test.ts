import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shutdownLifecycle, startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volListAgents } from "../../src/tools/list-agents";
import { volPublish } from "../../src/tools/publish";
import { volQuery } from "../../src/tools/query";
import { volRegister } from "../../src/tools/register";

const RUN = process.env.VOLLEY_INTEGRATION === "1";
const BROKER_URL = process.env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";

describe.skipIf(!RUN)("volley-mcp against real mosquitto", () => {
  let state: ServerState | undefined;

  beforeAll(async () => {
    state = await startLifecycle({
      brokerUrl: BROKER_URL,
      namespace: "integration",
      agentId: "mosq-aaaa",
      parentId: null,
    });
  });
  afterAll(async () => {
    if (state) await shutdownLifecycle(state, "done");
  });

  it("registers, publishes, queries, and lists end-to-end against mosquitto", async () => {
    if (!state) throw new Error("beforeAll did not initialise state");

    const reg = await volRegister(state, { capabilities: ["integration"], model: "test" });
    expect(reg).toEqual({ agent_id: "mosq-aaaa", namespace: "integration" });

    const pub = await volPublish(state, {
      channel: "result",
      type: "build-artifact",
      payload: { url: "https://volley.systems/ci/1" },
    });
    expect(pub.retained).toBe(true);

    const q = await volQuery(state, { topic: pub.topic });
    expect((q.payload as { type: string }).type).toBe("build-artifact");

    const list = await volListAgents(state, { namespace: "integration" });
    expect(list.agents.map((a) => a.agent_id)).toContain("mosq-aaaa");
  });
});
