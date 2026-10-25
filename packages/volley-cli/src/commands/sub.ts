import { parseArgs } from "node:util";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { isValidTopicFilter } from "volley-mcp/topics";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectToSupervisor } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface SubArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export async function sub({ argv, env, io }: SubArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        pattern: { type: "string" },
        "max-messages": { type: "string", default: "100" },
        timeout: { type: "string", default: "30" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley sub: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(SUB_HELP);
    return EXIT.OK;
  }

  const pattern = parsed.values.pattern;
  if (typeof pattern !== "string") {
    io.stderr(`volley sub: --pattern is required\n${SUB_HELP}`);
    return EXIT.USAGE;
  }
  if (!isValidTopicFilter(pattern)) {
    io.stderr(`volley sub: invalid topic filter "${pattern}" (see SPEC.md §2 for grammar)\n`);
    return EXIT.USAGE;
  }

  let max: number;
  let timeoutSec: number;
  let brokerUrl: string;
  let auth: BrokerAuth | null;
  try {
    max = parsePositiveInt(parsed.values["max-messages"] as string, "--max-messages");
    timeoutSec = parsePositiveInt(parsed.values.timeout as string, "--timeout");
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
  } catch (e) {
    io.stderr(`volley sub: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  const broker = await connectToSupervisor(brokerUrl, io, auth, { command: "volley sub", env });
  if (typeof broker === "number") return broker;
  try {
    const collected = await broker.subscribeCollect(pattern, max, timeoutSec * 1000);
    for (const { topic, payload } of collected) {
      const envelope = parseEnvelope(payload);
      io.stdout(
        `${JSON.stringify({ topic, envelope, raw: envelope === null ? payload : undefined })}\n`,
      );
    }
    return collected.length < max ? EXIT.TIMEOUT : EXIT.OK;
  } catch (e) {
    if (e instanceof VolleyError) {
      io.stderr(`volley sub: ${e.code} — ${e.message}\n`);
    } else {
      io.stderr(`volley sub: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}

const SUB_HELP = `Usage: volley sub --pattern <mqtt-filter> [options]

Required:
  --pattern <filter>     MQTT topic filter, e.g. "volley/+/+/status" or "volley/example-dispatch/#"

Optional:
  --max-messages <n>     Stop after N messages (default: 100)
  --timeout <seconds>    Stop after N seconds even if --max-messages not reached (default: 30)
  --broker-url <url>     MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>      Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>        Broker password (env: VOLLEY_AUTH_PASSWORD)
  --help                 Show this help

Output:
  One JSON line per message: {"topic": "...", "envelope": <parsed> | null, "raw": "<str>"?}

Exit:
  0    --max-messages reached
  124  --timeout elapsed before --max-messages
  1    broker error
  2    invalid usage
`;
