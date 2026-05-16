import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { firstText } from "./helpers/mcp-result";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("volley-mcp binary (stdio smoke test)", () => {
  let tb: TestBroker;
  let client: Client;

  beforeEach(async () => {
    tb = await startTestBroker();

    // StdioClientTransport requires Record<string, string> — no undefined values.
    // Filter process.env to satisfy that constraint, then overlay the Volley vars.
    const filteredEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) filteredEnv[k] = v;
    }

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts"],
      cwd: PACKAGE_ROOT,
      env: {
        ...filteredEnv,
        VOLLEY_BROKER_URL: tb.url,
        VOLLEY_NAMESPACE: "test",
        VOLLEY_AGENT_ID: "smoke-aaaa",
      },
    });
    client = new Client({ name: "smoke-client", version: "0.0.0" });
    await client.connect(transport);
  });
  afterEach(async () => {
    await client.close();
    await tb.close();
  });

  it("starts, lists 7 tools, and round-trips vol_register over real stdio", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);

    const res = await client.callTool({
      name: "vol_register",
      arguments: { capabilities: ["smoke"] },
    });
    const text = firstText(res);
    const parsed = JSON.parse(text);
    expect(parsed.namespace).toBe("test");
    expect(parsed.agent_id).toMatch(/^smoke-aaaa-[a-z0-9]{4}$/);
  });
});
