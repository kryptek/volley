import { parseArgs } from "node:util";
import { channelConfigFor, isReservedChannelPath } from "volley-mcp/channels";
import type { BrokerAuth } from "volley-mcp/config";
import { buildEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { buildTopic, isReservedTopic, isValidAgentId } from "volley-mcp/topics";
import { parseJsonPayload, resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface PubArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export async function pub({ argv, env, io }: PubArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        namespace: { type: "string" },
        "agent-id": { type: "string" },
        "parent-id": { type: "string" },
        channel: { type: "string" },
        type: { type: "string" },
        payload: { type: "string" },
        "correlation-id": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley pub: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(PUB_HELP);
    return EXIT.OK;
  }

  const agentId = parsed.values["agent-id"];
  const channel = parsed.values.channel;
  const type = parsed.values.type;

  if (typeof agentId !== "string" || typeof channel !== "string" || typeof type !== "string") {
    io.stderr(`volley pub: --agent-id, --channel, and --type are required\n${PUB_HELP}`);
    return EXIT.USAGE;
  }
  if (!isValidAgentId(agentId)) {
    io.stderr(`volley pub: agent_id "${agentId}" does not match [a-z0-9][a-z0-9_-]{0,62}\n`);
    return EXIT.USAGE;
  }

  let namespace: string;
  let brokerUrl: string;
  let auth: BrokerAuth | null;
  let payload: Record<string, unknown>;
  try {
    namespace = resolveNamespace(parsed.values.namespace as string | undefined, env);
    brokerUrl = resolveBrokerUrl(parsed.values["broker-url"] as string | undefined, env);
    auth = resolveAuth(
      {
        username: parsed.values.username as string | undefined,
        password: parsed.values.password as string | undefined,
      },
      env,
      process.cwd(),
      brokerUrl,
    );
    payload = parseJsonPayload(parsed.values.payload as string | undefined);
  } catch (e) {
    io.stderr(`volley pub: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  const topic = buildTopic(namespace, agentId, channel);
  if (isReservedTopic(topic) || isReservedChannelPath(channel)) {
    io.stderr(`volley pub: RESERVED_TOPIC_WRITE — refusing to publish to ${topic}\n`);
    return EXIT.ERROR;
  }

  const cfg = channelConfigFor(channel);
  if (cfg === null) {
    io.stderr(
      `volley pub: unknown channel "${channel}" (use one of status|progress|mailbox|control|result|capability, or _user/<name>)\n`,
    );
    return EXIT.ERROR;
  }

  const parentId = (parsed.values["parent-id"] as string | undefined) ?? null;
  const correlationId = (parsed.values["correlation-id"] as string | undefined) ?? null;

  const envelope = buildEnvelope({
    agentId,
    parentId,
    channel,
    type,
    payload,
    correlationId,
    now: io.now,
  });

  const broker = await connectAsClient(brokerUrl, io, auth);
  if (broker === null) return EXIT.ERROR; // connectAsClient already printed the diagnostic.
  try {
    await broker.publish(topic, JSON.stringify(envelope), { qos: cfg.qos, retain: cfg.retain });
    return EXIT.OK;
  } catch (e) {
    if (e instanceof VolleyError) {
      io.stderr(`volley pub: ${e.code} — ${e.message}\n`);
    } else {
      io.stderr(`volley pub: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}

const PUB_HELP = `Usage: volley pub --agent-id <id> --channel <name> --type <type> [options]

Required:
  --agent-id <id>        Agent identifier (the topic-segment id, not the sender of this CLI run)
  --channel <name>       One of: status, progress, mailbox, control, result, capability, _user/<name>
  --type <type>          Channel-specific event type (e.g. "done" on status, "tests-green" on progress)

Optional:
  --payload <json>       JSON object literal (default: {})
  --parent-id <id>       Parent agent_id (for dispatch trees)
  --correlation-id <id>  UUID v4 to correlate request/response pairs
  --namespace <ns>       Volley namespace (env: VOLLEY_NAMESPACE; default: default)
  --broker-url <url>     MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>      Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>        Broker password (env: VOLLEY_AUTH_PASSWORD)
  --help                 Show this help
`;
