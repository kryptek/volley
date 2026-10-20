import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json";
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

  it("reports the package version to MCP clients", () => {
    expect(client.getServerVersion()).toEqual({ name: "volley-mcp", version: pkg.version });
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

  it("vol_register takes a title of up to 120 characters and links", async () => {
    const ok = await client.callTool({
      name: "vol_register",
      arguments: {
        capabilities: [],
        title: "x".repeat(120),
        links: { repo: "example-org/example-repo", issue: 42 },
      },
    });
    expect(ok.isError).toBeFalsy();
    const got = await state.broker.queryRetained("volley/_system/registry/srv-aaaa", 1000);
    const payload = JSON.parse(got ?? "{}").payload;
    expect(payload.title).toBe("x".repeat(120));
    expect(payload.links).toEqual({ repo: "example-org/example-repo", issue: 42 });
  });

  it("vol_register refuses a 121-character title, a multi-line one and malformed links", async () => {
    for (const args of [
      { title: "x".repeat(121) },
      { title: "first line\nsecond line" },
      { links: { issue: true } },
      { links: { repo: "not a repo" } },
      { links: { pr: "javascript:alert(1)" } },
      { links: { extra: 1 } },
    ]) {
      const res = await client.callTool({
        name: "vol_register",
        arguments: { capabilities: [], ...args },
      });
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("vol_register accepts a padded title whose trimmed length fits", async () => {
    const res = await client.callTool({
      name: "vol_register",
      arguments: { capabilities: [], title: `  ${"x".repeat(119)}  ` },
    });
    expect(res.isError).toBeFalsy();
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

  it("vol_send_mailbox rejects a non-UUID correlation_id or supersedes before publishing", async () => {
    state.registered = true;
    for (const args of [
      { correlation_id: "" },
      { correlation_id: "not-a-uuid" },
      { payload: { text: "x", supersedes: "not-a-uuid" } },
    ]) {
      const res = await client.callTool({
        name: "vol_send_mailbox",
        arguments: {
          to_agent_id: "worker-bbbb",
          type: "steering",
          payload: { text: "x" },
          ...args,
        },
      });
      expect(res.isError).toBe(true);
    }
  });
});
