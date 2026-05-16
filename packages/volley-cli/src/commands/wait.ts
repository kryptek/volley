import { parseArgs } from "node:util";
import { parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { buildTopic, isValidAgentId } from "volley-mcp/topics";
import { parseCsv, parsePositiveInt, resolveBrokerUrl, resolveNamespace } from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface WaitArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

const DEFAULT_TERMINAL_STATES = ["done", "blocked", "failed", "reaped"];

export async function wait({ argv, env, io }: WaitArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        "agent-id": { type: "string" },
        "terminal-states": { type: "string" },
        timeout: { type: "string", default: "3600" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley wait: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(WAIT_HELP);
    return EXIT.OK;
  }

  const agentId = parsed.values["agent-id"];
  if (typeof agentId !== "string") {
    io.stderr(`volley wait: --agent-id is required\n${WAIT_HELP}`);
    return EXIT.USAGE;
  }
  if (!isValidAgentId(agentId)) {
    io.stderr(`volley wait: agent_id "${agentId}" does not match [a-z0-9][a-z0-9_-]{0,62}\n`);
    return EXIT.USAGE;
  }

  let namespace: string;
  let brokerUrl: string;
  let timeoutSec: number;
  const terminalStatesArg = parsed.values["terminal-states"] as string | undefined;
  const terminalStates =
    terminalStatesArg === undefined ? DEFAULT_TERMINAL_STATES : parseCsv(terminalStatesArg);
  try {
    namespace = resolveNamespace(parsed.values.namespace as string | undefined, env);
    brokerUrl = resolveBrokerUrl(parsed.values["broker-url"] as string | undefined, env);
    timeoutSec = parsePositiveInt(parsed.values.timeout as string, "--timeout");
  } catch (e) {
    io.stderr(`volley wait: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  if (terminalStates.length === 0) {
    io.stderr("volley wait: --terminal-states must list at least one state\n");
    return EXIT.USAGE;
  }

  const topic = buildTopic(namespace, agentId, "status");

  const broker = await connectAsClient(brokerUrl, io);
  if (broker === null) return EXIT.ERROR;
  try {
    // One subscription, kept open for the whole wait. The broker delivers the current
    // retained `status` payload immediately on subscribe; if it's already terminal, the
    // predicate matches and we resolve straight away. If it's non-terminal, we ignore it
    // and wait for the next live publish. Critically, we do NOT re-subscribe — that
    // would cause the broker to re-deliver the same non-terminal retained payload in a
    // hot loop (~4000 iter/s observed against an in-process broker), defeating the
    // sub-5s-latency promise the dogfood needs.
    const matched = await broker.subscribeUntil(
      topic,
      (payload) => {
        const envelope = parseEnvelope(payload);
        return envelope !== null && terminalStates.includes(envelope.type);
      },
      timeoutSec * 1000,
    );
    if (matched !== null) {
      const envelope = parseEnvelope(matched.payload);
      if (envelope !== null) {
        io.stdout(
          `${JSON.stringify({ agent_id: agentId, terminal_type: envelope.type, wall_time: envelope.wall_time })}\n`,
        );
        return EXIT.OK;
      }
    }
    io.stderr(
      `volley wait: timeout after ${timeoutSec}s waiting for ${topic} to reach one of [${terminalStates.join(",")}]\n`,
    );
    return EXIT.TIMEOUT;
  } catch (e) {
    if (e instanceof VolleyError) {
      io.stderr(`volley wait: ${e.code} — ${e.message}\n`);
    } else {
      io.stderr(`volley wait: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}

const WAIT_HELP = `Usage: volley wait --agent-id <id> [options]

Required:
  --agent-id <id>         The agent whose status channel to watch

Optional:
  --terminal-states <csv>  Comma-separated states that end the wait (default: done,blocked,failed,reaped)
  --timeout <seconds>      Give up after N seconds (default: 3600)
  --namespace <ns>         Volley namespace (env: VOLLEY_NAMESPACE; default: default)
  --broker-url <url>       MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --help                   Show this help

Output:
  On terminal: one JSON line {"agent_id":"...","terminal_type":"...","wall_time":"..."}

Exit:
  0    a terminal state was observed
  124  --timeout elapsed first
  1    broker error
  2    invalid usage
`;
