import { parseArgs } from "node:util";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

/**
 * `volley role`: the machine roles (SPEC §4.6.24), which machine runs the broker, the supervisor
 * and the Desk. `status` reads the supervisor's retained record; it needs the broker, not an
 * answer from volleyd.
 */

const ROLES_TOPIC = "volley/_system/roles";
const NO_RECORD = "no roles record: is volleyd running?";

const HELP = `Usage:
  volley role status [--json]        Which machine runs the broker, the supervisor and the Desk

Options:
  --json               The record as JSON
  --timeout <seconds>  How long to wait for the retained record (default 2)
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD)
`;

export interface RoleArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/** The fields `status` prints; the rest of the record is printed by `--json` as it is. */
interface RolesPayload {
  broker: { machine: string };
  supervisor: { machine: string };
  desk: { machine: string; url: string };
}

export async function role({ argv, env, io }: RoleArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        timeout: { type: "string", default: "2" },
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const [verb, ...extra] = parsed.positionals;
  if (parsed.values.help === true || verb === "help") {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (verb !== "status") {
    io.stderr(verb === undefined ? HELP : `volley role: unknown verb: ${verb}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (extra.length > 0) {
    io.stderr(`volley role status: unexpected argument: ${extra[0]}\n`);
    return EXIT.USAGE;
  }

  let brokerUrl: string;
  let auth: BrokerAuth | null;
  let timeoutSec: number;
  try {
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
    timeoutSec = parsePositiveInt(parsed.values.timeout as string, "--timeout");
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  const broker = await connectAsClient(brokerUrl, io, auth);
  if (broker === null) return EXIT.ERROR; // connectAsClient already printed the diagnostic.
  try {
    const raw = await broker.queryRetained(ROLES_TOPIC, timeoutSec * 1000);
    const envelope = raw === null || raw === "" ? null : parseEnvelope(raw);
    // Only the supervisor's record counts: any login may publish on a topic it can write.
    if (envelope === null || envelope.agent_id !== "volleyd" || envelope.type !== "roles") {
      io.stderr(`volley role: ${NO_RECORD}\n`);
      return EXIT.ERROR;
    }
    const record = envelope.payload as RolesPayload;
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(record, null, 2)}\n`);
      return EXIT.OK;
    }
    io.stdout(
      [
        `broker      on ${record.broker.machine}`,
        `supervisor  on ${record.supervisor.machine}`,
        `desk        on ${record.desk.machine} (${record.desk.url})`,
        "",
      ].join("\n"),
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volley role: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}
