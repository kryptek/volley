import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { type Envelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { buildTopic } from "volley-mcp/topics";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface ListArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

interface AgentRow {
  agent_id: string;
  namespace: string;
  parent_id: string | null;
  status: string;
  cwd: string;
  model: string;
  started_at: string;
  capabilities: string[];
  last_seen: string;
}

export async function list({ argv, env, io }: ListArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        namespace: { type: "string" },
        "all-namespaces": { type: "boolean", default: false },
        "include-reaped": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        timeout: { type: "string", default: "2" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley list: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(LIST_HELP);
    return EXIT.OK;
  }

  const allNamespaces = parsed.values["all-namespaces"] === true;
  const includeReaped = parsed.values["include-reaped"] === true;
  const asJson = parsed.values.json === true;

  let brokerUrl: string;

  let auth: BrokerAuth | null;
  let timeoutSec: number;
  let nsFilter: string | null;
  try {
    brokerUrl = resolveBrokerUrl(parsed.values["broker-url"] as string | undefined, env);
    auth = resolveAuth(
      {
        username: parsed.values.username as string | undefined,
        password: parsed.values.password as string | undefined,
      },
      env,
    );
    timeoutSec = parsePositiveInt(parsed.values.timeout as string, "--timeout");
    nsFilter = allNamespaces
      ? null
      : resolveNamespace(parsed.values.namespace as string | undefined, env);
  } catch (e) {
    io.stderr(`volley list: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  const broker = await connectAsClient(brokerUrl, io, auth);
  if (broker === null) return EXIT.ERROR; // connectAsClient already printed the diagnostic.
  try {
    // Subscribe to all retained registry entries. There is no max; collect for the
    // full timeout window — retained deliveries arrive within ~milliseconds of subscribe,
    // so a 2s default is plenty even on a busy broker.
    const entries = await broker.subscribeCollect(
      "volley/_system/registry/+",
      10_000,
      timeoutSec * 1000,
    );
    const rows: AgentRow[] = [];
    for (const { payload } of entries) {
      const envelope = parseEnvelope(payload);
      if (envelope === null) continue;
      const ns = envelope.namespace;
      if (typeof ns !== "string") continue;
      if (nsFilter !== null && ns !== nsFilter) continue;
      const row = await joinStatus(broker, envelope, ns);
      if (!includeReaped && row.status === "reaped") continue;
      rows.push(row);
    }
    rows.sort((a, b) => a.agent_id.localeCompare(b.agent_id));

    if (asJson) {
      io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      io.stdout(renderTable(rows));
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof VolleyError) {
      io.stderr(`volley list: ${e.code} — ${e.message}\n`);
    } else {
      io.stderr(`volley list: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return EXIT.ERROR;
  } finally {
    await broker.disconnect();
  }
}

async function joinStatus(
  broker: VolleyBroker,
  registry: Envelope,
  namespace: string,
): Promise<AgentRow> {
  const statusTopic = buildTopic(namespace, registry.agent_id, "status");
  const raw = await broker.queryRetained(statusTopic, 500);
  const statusEnvelope = raw !== null ? parseEnvelope(raw) : null;
  const status = statusEnvelope?.type ?? "unknown";
  const lastSeen = statusEnvelope?.wall_time ?? registry.wall_time;

  const payload = (registry.payload ?? {}) as Record<string, unknown>;
  return {
    agent_id: registry.agent_id,
    namespace,
    parent_id: registry.parent_id,
    status,
    cwd: typeof payload.cwd === "string" ? payload.cwd : "",
    model: typeof payload.model === "string" ? payload.model : "",
    started_at: typeof payload.started_at === "string" ? payload.started_at : registry.wall_time,
    capabilities: Array.isArray(payload.capabilities)
      ? (payload.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
      : [],
    last_seen: lastSeen,
  };
}

function renderTable(rows: AgentRow[]): string {
  if (rows.length === 0) {
    return "(no agents registered)\n";
  }
  const header = ["AGENT_ID", "NAMESPACE", "STATUS", "PARENT", "CWD", "LAST_SEEN"];
  const data = rows.map((r) => [
    r.agent_id,
    r.namespace,
    r.status,
    r.parent_id ?? "-",
    r.cwd || "-",
    r.last_seen,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  // widths is always the same length as the row (header.length); the non-null assertion
  // on widths[i] is safe here, but Biome banned it, so just trust the natural width.
  const fmt = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ");
  return [fmt(header), ...data.map(fmt), ""].join("\n");
}

const LIST_HELP = `Usage: volley list [options]

Optional:
  --namespace <ns>        Filter to one namespace (env: VOLLEY_NAMESPACE; default: default)
  --all-namespaces        Ignore namespace and list every registered agent
  --include-reaped        Include agents whose retained status is "reaped" (default: omit)
  --json                  Emit a JSON array instead of a human table
  --timeout <seconds>     Time to wait for retained entries to arrive (default: 2)
  --broker-url <url>      MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>       Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>         Broker password (env: VOLLEY_AUTH_PASSWORD)
  --help                  Show this help
`;
