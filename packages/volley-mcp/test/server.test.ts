import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../src/lifecycle";
import { createServer } from "../src/server";
import type { ServerState } from "../src/state";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { firstText } from "./helpers/mcp-result";

describe("createServer (MCP wiring)", () => {
  let tb: TestBroker;
  let state: ServerState;
  let client: Client;

  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "srv-aaaa",
      parentId: null,
    });
    const server = createServer(state);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await state.broker.disconnect();
    await tb.close();
  });

  it("exposes exactly the seven v0.1 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "vol_list_agents",
      "vol_publish",
      "vol_query",
      "vol_register",
      "vol_send_mailbox",
      "vol_subscribe",
      "vol_tap",
    ]);
  });

  it("vol_register through the MCP interface registers the agent", async () => {
    const res = await client.callTool({
      name: "vol_register",
      arguments: { capabilities: ["demo"] },
    });
    const text = firstText(res);
    expect(JSON.parse(text)).toEqual({ agent_id: "srv-aaaa", namespace: "test" });
    expect(state.registered).toBe(true);
  });

  it("returns a thrown VolleyError as isError with a structured code", async () => {
    state.registered = false;
    const res = await client.callTool({
      name: "vol_publish",
      arguments: { channel: "progress", type: "tick" },
    });
    expect(res.isError).toBe(true);
    const text = firstText(res);
    expect(JSON.parse(text)).toEqual({
      error: "call vol_register before publishing",
      code: "NOT_REGISTERED",
    });
  });
});
