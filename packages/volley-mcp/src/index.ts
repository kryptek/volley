#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { shutdownLifecycle, startLifecycle } from "./lifecycle";
import { createServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const state = await startLifecycle(config);
  const server = createServer(state);

  let shuttingDown = false;
  const shutdown = async (type: "done" | "failed"): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdownLifecycle(state, type);
    } finally {
      process.exit(type === "done" ? 0 : 1);
    }
  };
  process.on("SIGINT", () => void shutdown("done"));
  process.on("SIGTERM", () => void shutdown("done"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: a transport drop after connect() (e.g. stdin closes) is not re-raised here —
  // the SDK has already settled the connect() promise. If stdin closes, the host process
  // exits and the broker's LWT fires `reaped`. Acceptable for v0.1's single-client model.
}

main().catch((e) => {
  process.stderr.write(
    `volley-mcp failed to start: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
