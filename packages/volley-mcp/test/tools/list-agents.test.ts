import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shutdownLifecycle, startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volListAgents } from "../../src/tools/list-agents";
import { volRegister } from "../../src/tools/register";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_list_agents", () => {
  let tb: TestBroker;
  let viewer: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    viewer = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "viewer-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await viewer.broker.disconnect();
    await tb.close();
  });

  it("enumerates registered agents with their status and registry payload", async () => {
    const a = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "agent-one",
      parentId: "viewer-aaaa",
    });
    await volRegister(a, {
      capabilities: ["x"],
      model: "m1",
      cwd: "/tmp/one",
      title: "#42 fix the login redirect",
    });
    const b = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "agent-two",
      parentId: null,
    });
    await volRegister(b, { capabilities: ["y"] });

    const res = await volListAgents(viewer, {});
    const ids = res.agents.map((x) => x.agent_id).sort();
    expect(ids).toEqual(["agent-one", "agent-two", "viewer-aaaa"]);
    const one = res.agents.find((x) => x.agent_id === "agent-one");
    expect(one?.status).toBe("registered");
    expect(one?.parent_id).toBe("viewer-aaaa");
    expect(one?.capabilities).toEqual(["x"]);
    expect(one?.model).toBe("m1");
    expect(one?.cwd).toBe("/tmp/one");
    expect(one?.title).toBe("#42 fix the login redirect");
    expect(res.agents.find((x) => x.agent_id === "agent-two")?.title).toBeNull();

    await a.broker.disconnect();
    await b.broker.disconnect();
  });

  it("excludes reaped agents by default and includes them when asked", async () => {
    const a = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "agent-gone",
      parentId: null,
    });
    await volRegister(a, { capabilities: [] });
    await shutdownLifecycle(a, "done");
    const crasher = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "agent-crash",
      parentId: null,
    });
    await volRegister(crasher, { capabilities: [] });
    crasher.broker.simulateCrash();
    await new Promise((r) => setTimeout(r, 300));

    const without = await volListAgents(viewer, {});
    expect(without.agents.map((x) => x.agent_id)).not.toContain("agent-crash");

    const withReaped = await volListAgents(viewer, { include_reaped: true });
    expect(withReaped.agents.map((x) => x.agent_id)).toContain("agent-crash");
  });

  it("filters by namespace when given", async () => {
    const other = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "other-ns",
      agentId: "agent-other",
      parentId: null,
    });
    await volRegister(other, { capabilities: [] });
    const res = await volListAgents(viewer, { namespace: "other-ns" });
    expect(res.agents.map((x) => x.agent_id)).toEqual(["agent-other"]);
    await other.broker.disconnect();
  });
});
