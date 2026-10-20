import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { isValidTopicFilter } from "volley-mcp/topics";
import {
  parseLifecycleEventCsv,
  parseSurfaceCsv,
  resolveAuth,
  resolveBrokerUrl,
  resolveNamespace,
  resolveWebhookUrl,
} from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { createBellSurface } from "./notify/surfaces/bell";
import { createDesktopSurface } from "./notify/surfaces/desktop";
import type { Surface, SurfaceName } from "./notify/surfaces/types";
import { createWebhookSurface } from "./notify/surfaces/webhook";

export type NotifyConnectFn = typeof connectAsClient;

/** Minimal broker shape `notify` consumes — lets tests pass a fake without re-implementing every VolleyBroker method. */
export interface NotifyBrokerLike {
  subscribeStream: VolleyBroker["subscribeStream"];
  disconnect: VolleyBroker["disconnect"];
}

export type NotifySubscribeStreamFn = NotifyBrokerLike["subscribeStream"];

/**
 * Test-only factory map. Each entry receives the IO seam, the resolved webhook URL
 * (null when not configured), and the process env so individual factories can pick
 * out whatever they need. Production code resolves missing keys to the real
 * `create*Surface` factories from Phase 1.
 */
export type NotifySurfaceFactories = Partial<
  Record<
    SurfaceName,
    (io: IO, webhookUrl: string | null, env: Record<string, string | undefined>) => Surface
  >
>;

export interface NotifyArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
  surfaceFactories?: NotifySurfaceFactories;
  connectFn?: NotifyConnectFn;
  shutdownSignal?: Promise<void>;
}

const DEFAULT_ON = "blocked,failed,reaped";
const DEFAULT_SURFACES = "bell";

const PRODUCTION_FACTORIES: Required<NotifySurfaceFactories> = {
  bell: (io) => createBellSurface(io),
  desktop: (io, _url, env) => {
    const sound = env.VOLLEY_NOTIFY_SOUND;
    return createDesktopSurface(sound === undefined ? { io } : { io, sound });
  },
  webhook: (io, url) => {
    // Unreachable in practice — the argv validation in `notify` exits 2 when
    // `webhook ∈ surfaces && webhookUrl === null` before this factory is ever
    // invoked. A named throw here converts an internal-invariant violation into
    // a loud, traceable error instead of a silent `fetch("")` at the first
    // matching notification.
    if (url === null) throw new Error("internal: webhook factory invoked without URL");
    return createWebhookSurface({ io, url });
  },
};

export async function notify({
  argv,
  env,
  io,
  surfaceFactories,
  connectFn,
  shutdownSignal,
}: NotifyArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        namespace: { type: "string" },
        pattern: { type: "string" },
        on: { type: "string" },
        surface: { type: "string" },
        "webhook-url": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    io.stderr(`volley notify: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (parsed.values.help === true) {
    io.stdout(NOTIFY_HELP);
    return EXIT.OK;
  }

  const pattern = parsed.values.pattern as string | undefined;
  if (typeof pattern !== "string") {
    io.stderr(`volley notify: --pattern is required\n${NOTIFY_HELP}`);
    return EXIT.USAGE;
  }
  if (!isValidTopicFilter(pattern)) {
    io.stderr(`volley notify: invalid topic filter "${pattern}" (see SPEC.md §2 for grammar)\n`);
    return EXIT.USAGE;
  }

  let surfaces: string[];
  let onTypes: string[];
  let webhookUrl: string | null;
  let brokerUrl: string;
  let auth: BrokerAuth | null;
  try {
    // Order matches the spec: surface → on → webhook URL. Each helper throws with a
    // human-readable message; we prefix `volley notify:` and exit 2.
    const surfaceArg =
      (parsed.values.surface as string | undefined) ??
      env.VOLLEY_NOTIFY_SURFACES ??
      DEFAULT_SURFACES;
    surfaces = parseSurfaceCsv(surfaceArg);

    const onArg = (parsed.values.on as string | undefined) ?? env.VOLLEY_NOTIFY_ON ?? DEFAULT_ON;
    onTypes = parseLifecycleEventCsv(onArg);

    webhookUrl = resolveWebhookUrl(parsed.values["webhook-url"] as string | undefined, env);

    // --namespace is parsed/validated only for symmetry with other subcommands; the
    // pattern already encodes the namespace, so we don't otherwise consume the result.
    resolveNamespace(parsed.values.namespace as string | undefined, env);
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
    io.stderr(`volley notify: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }

  if (surfaces.includes("webhook") && webhookUrl === null) {
    io.stderr(
      "volley notify: --webhook-url (or VOLLEY_NOTIFY_WEBHOOK_URL) is required when 'webhook' is selected via --surface\n",
    );
    return EXIT.USAGE;
  }

  const factories: NotifySurfaceFactories = surfaceFactories ?? {};
  const surfaceInstances: Surface[] = surfaces.map((name) => {
    const surfaceName = name as SurfaceName;
    const override = factories[surfaceName];
    const factory = override ?? PRODUCTION_FACTORIES[surfaceName];
    return factory(io, webhookUrl, env);
  });

  const onSet = new Set(onTypes);

  const connect = connectFn ?? connectAsClient;
  const broker = (await connect(brokerUrl, io, auth)) as NotifyBrokerLike | null;
  if (broker === null) return EXIT.ERROR;

  let unsubscribe: (() => Promise<void>) | null = null;
  try {
    unsubscribe = await broker.subscribeStream(pattern, (msg) => {
      void handleMessage(msg);
    });

    await (shutdownSignal ?? sigintPromise());
    return EXIT.OK;
  } catch (e) {
    if (e instanceof VolleyError) {
      io.stderr(`volley notify: ${e.code} — ${e.message}\n`);
    } else {
      io.stderr(`volley notify: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return EXIT.ERROR;
  } finally {
    if (unsubscribe !== null) {
      await unsubscribe().catch(() => {});
    }
    await broker.disconnect().catch(() => {});
    io.stderr("[notify] shutting down\n");
  }

  async function handleMessage(msg: { topic: string; payload: string }): Promise<void> {
    const envelope = parseEnvelope(msg.payload);
    if (envelope === null) return;
    if (!onSet.has(envelope.type)) return;
    const results = await Promise.allSettled(
      surfaceInstances.map((s) => s.fire({ topic: msg.topic, envelope })),
    );
    const fired: string[] = [];
    for (let i = 0; i < surfaceInstances.length; i++) {
      const s = surfaceInstances[i];
      const r = results[i];
      if (s !== undefined && r !== undefined && r.status === "fulfilled") {
        fired.push(s.name);
      }
    }
    io.stdout(
      `${JSON.stringify({
        topic: msg.topic,
        type: envelope.type,
        agent_id: envelope.agent_id,
        surfaces: fired,
      })}\n`,
    );
  }
}

/** Default shutdown trigger: resolves on first SIGINT or SIGTERM. `process.once` keeps test runs from leaking listeners. */
function sigintPromise(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

const NOTIFY_HELP = `Usage: volley notify --pattern <filter> [options]

Required:
  --pattern <filter>       MQTT topic filter, e.g. "volley/+/+/status"

Optional:
  --on <csv>               Comma-separated lifecycle types (default: ${DEFAULT_ON})
                           Valid: spawning, working, done, blocked, failed, reaped, registered
                           (env: VOLLEY_NOTIFY_ON)
  --surface <csv>          Comma-separated surfaces (default: ${DEFAULT_SURFACES})
                           Valid: bell, desktop, webhook
                           (env: VOLLEY_NOTIFY_SURFACES)
  --webhook-url <url>      Target URL for the 'webhook' surface (http:// or https://)
                           Required only if webhook ∈ surfaces
                           (env: VOLLEY_NOTIFY_WEBHOOK_URL)
  --namespace <ns>         Informational; volley namespace (env: VOLLEY_NAMESPACE; default: default)
  --broker-url <url>       MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>        Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>          Broker password (env: VOLLEY_AUTH_PASSWORD)
  --help                   Show this help

Behavior:
  Subscribes to --pattern and fires the configured surfaces for every envelope
  whose type is in --on. Runs until SIGINT/SIGTERM. Surfaces fire concurrently
  via Promise.allSettled; a single surface error never aborts the loop.

Output:
  stdout: one JSON line per fired notification {topic, type, agent_id, surfaces}
  stderr: human warnings (surface unavailable, webhook non-2xx, etc.)

Exit:
  0    clean SIGINT/SIGTERM shutdown
  1    broker error
  2    invalid usage
`;
