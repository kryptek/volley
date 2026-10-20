import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json";
import { toToolError } from "./errors";
import type { ServerState } from "./state";
import { volListAgents } from "./tools/list-agents";
import { volPublish } from "./tools/publish";
import { volQuery } from "./tools/query";
import { volRegister } from "./tools/register";
import { volSendMailbox } from "./tools/send-mailbox";
import { volSubscribe } from "./tools/subscribe";
import { volTap } from "./tools/tap";

/**
 * CallToolResult-compatible response shape. The index signature satisfies the SDK's
 * `{ [x: string]: unknown; content: ...; isError?: boolean }` requirement.
 */
interface McpToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Build the MCP server with all seven Volley tools bound to the given ServerState. */
export function createServer(state: ServerState): McpServer {
  const server = new McpServer({ name: "volley-mcp", version: pkg.version });

  /**
   * Wraps a typed tool function for MCP registration. The input is typed as `unknown`
   * at the MCP boundary because the SDK's `ShapeOutput` with `exactOptionalPropertyTypes`
   * adds `| undefined` to every optional field, which conflicts with tool interfaces that
   * declare optional fields without `| undefined`. The cast is safe: the SDK validates
   * the input against the Zod `inputSchema` before calling the handler.
   */
  const wrap =
    <I>(fn: (s: ServerState, input: I) => Promise<unknown>) =>
    // biome-ignore lint/suspicious/noExplicitAny: SDK ShapeOutput adds |undefined to optional fields; input is validated by Zod before this handler runs
    async (input: any): Promise<McpToolResponse> => {
      try {
        const result = await fn(state, input as I);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: JSON.stringify(toToolError(e), null, 2) }],
          isError: true,
        };
      }
    };

  server.registerTool(
    "vol_register",
    {
      description: "Register this agent in the Volley registry and flip status to `registered`.",
      inputSchema: {
        capabilities: z.array(z.string()),
        parent_id: z.string().nullable().optional(),
        model: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    wrap(volRegister),
  );

  server.registerTool(
    "vol_publish",
    {
      description:
        "Publish a message to one of this agent's channels. Requires prior vol_register.",
      inputSchema: {
        channel: z.string(),
        type: z.string(),
        payload: z.unknown().optional(),
        correlation_id: z.string().nullable().optional(),
      },
    },
    wrap(volPublish),
  );

  server.registerTool(
    "vol_query",
    {
      description: "Fetch the current retained value at an exact topic.",
      inputSchema: { topic: z.string() },
    },
    wrap(volQuery),
  );

  server.registerTool(
    "vol_subscribe",
    {
      description: "Block until max_messages arrive on a topic pattern or timeout_ms elapses.",
      inputSchema: {
        topic_pattern: z.string(),
        max_messages: z.number().int().positive().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    wrap(volSubscribe),
  );

  server.registerTool(
    "vol_list_agents",
    {
      description: "Enumerate registered agents from the retained registry topics.",
      inputSchema: {
        namespace: z.string().optional(),
        include_reaped: z.boolean().optional(),
      },
    },
    wrap(volListAgents),
  );

  server.registerTool(
    "vol_tap",
    {
      description: "Debugging wildcard subscription with debug-tuned defaults.",
      inputSchema: {
        topic_pattern: z.string(),
        max_messages: z.number().int().positive().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    wrap(volTap),
  );

  server.registerTool(
    "vol_send_mailbox",
    {
      description:
        "Deliver a mailbox message to another agent. Returns message_id (the envelope correlation_id); with wait_ack_ms, also waits for the recipient's ack. Requires prior vol_register.",
      inputSchema: {
        to_agent_id: z.string(),
        type: z.enum(["steering", "cancel", "nudge", "query", "ack"]),
        payload: z
          .object({
            text: z.string(),
            seq: z.number().int().nonnegative().optional(),
            supersedes: z.string().uuid().optional(),
          })
          .passthrough(),
        correlation_id: z.string().uuid().nullable().optional(),
        wait_ack_ms: z.number().int().positive().optional(),
      },
    },
    wrap(volSendMailbox),
  );

  return server;
}
