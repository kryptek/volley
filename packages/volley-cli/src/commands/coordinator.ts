import { parseArgs } from "node:util";
import type { BrokerAuth } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import {
  COORDINATOR_TOPIC,
  type CoordinatorRolePayload,
  formatCoordinator,
} from "volleyd/coordinator/role";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectToSupervisor } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { openUrl } from "../open-url";
import { type Answer, askVolleyd } from "./peer";

/**
 * `volley coordinator` (SPEC §4.6.25): the coordinator role volleyd keeps alive, a `claude
 * remote-control` server on the machine `coordinator.machine` names. `status` and `open` read
 * its retained state (`volley/_system/federation/coordinator`); `restart` and `stop` are admin
 * ops (sent on the admin's account-op topic, like `volley repo add`).
 */

const HELP = `Usage:
  volley coordinator status [--json]   Where the coordinator runs, its state, since when, its link
  volley coordinator open [--browser]  Print its link (--browser: open it); exit 1 without one
  volley coordinator restart           Start it again (clears its backoff, a stop or a failure)
  volley coordinator stop              Stop it until the next restart

Options:
  --json               status: the retained state as JSON
  --browser            open: open the link in this machine's browser
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME); restart and stop need an admin
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD)
  --timeout <seconds>  restart and stop: how long to wait for volleyd's answer (default 30)

Choose its machine with \`volleyd config set coordinator.machine <name>\` (\`local\`: this one;
null: off). A laptop is refused unless coordinator.allow_laptop is true.
`;

const OPTIONS = {
  json: { type: "boolean" },
  browser: { type: "boolean" },
  timeout: { type: "string" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

/** How long a retained read waits for the broker's answer. */
const READ_MS = 2000;

/** What the role's state says when it is off (no retained state). */
const OFF =
  "the coordinator role is off: set coordinator.machine (volleyd config set coordinator.machine <name>)";

export interface CoordinatorArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export interface CoordinatorDeps {
  /** One op to volleyd: its answer, or the exit code once it printed why not. */
  ask: (
    cmd: string,
    op: string,
    fields: Record<string, unknown>,
    v: Values,
    env: Record<string, string | undefined>,
    io: IO,
    admin: boolean,
  ) => Promise<Answer | ExitCode>;
  /** The retained state (null: the role is off), or the exit code once it printed why not. */
  read: (
    v: Values,
    env: Record<string, string | undefined>,
    io: IO,
  ) => Promise<CoordinatorRolePayload | null | ExitCode>;
  /** Open `url` with the platform's opener; false when it could not be started. */
  open: (url: string) => Promise<boolean>;
}

export function realCoordinatorDeps(): CoordinatorDeps {
  return { ask: askVolleyd, read: readRetained, open: openUrl };
}

export function coordinator(args: CoordinatorArgs): Promise<ExitCode> {
  return runCoordinator(args, realCoordinatorDeps());
}

export async function runCoordinator(
  { argv, env, io }: CoordinatorArgs,
  deps: CoordinatorDeps,
): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.stdout(HELP);
    return verb === undefined ? EXIT.USAGE : EXIT.OK;
  }
  let v: Values;
  try {
    const parsed = parseArgs({
      args: rest,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 0)
      throw new Error(`unexpected argument: ${parsed.positionals[0]}`);
    v = parsed.values;
  } catch (e) {
    io.stderr(`volley coordinator: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const usage = (msg: string) => {
    io.stderr(`volley coordinator ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  if (v.json === true && verb !== "status") return usage("--json is an option of status only");
  if (v.browser === true && verb !== "open") return usage("--browser is an option of open only");
  switch (verb) {
    case "status": {
      const p = await deps.read(v, env, io);
      if (typeof p === "number") return p;
      if (v.json === true) {
        io.stdout(`${JSON.stringify(p, null, 2)}\n`);
        return EXIT.OK;
      }
      io.stdout(`${p === null ? OFF : formatCoordinator(p)}\n`);
      return EXIT.OK;
    }
    case "open": {
      const p = await deps.read(v, env, io);
      if (typeof p === "number") return p;
      if (p === null) {
        io.stderr(`${OFF}\n`);
        return EXIT.ERROR;
      }
      if (p.session_url === undefined) {
        io.stderr(`no link yet: open the Claude app and pick "${p.name}"\n`);
        return EXIT.ERROR;
      }
      io.stdout(`${p.session_url}\n`);
      if (v.browser === true && !(await deps.open(p.session_url))) {
        io.stderr("volley coordinator open: could not start this machine's browser\n");
        return EXIT.ERROR;
      }
      return EXIT.OK;
    }
    case "restart":
    case "stop": {
      const a = await deps.ask(
        `volley coordinator ${verb}`,
        `coordinator_${verb}`,
        {},
        v,
        env,
        io,
        true,
      );
      if (typeof a === "number") return a;
      const p = a.result as CoordinatorRolePayload | null;
      io.stdout(`${p === null || p === undefined ? OFF : formatCoordinator(p)}\n`);
      return EXIT.OK;
    }
    default:
      io.stderr(`volley coordinator: unknown verb '${verb}'\n\n${HELP}`);
      return EXIT.USAGE;
  }
}

/** The role's retained state as volleyd published it (any other publisher's is ignored). */
async function readRetained(
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
): Promise<CoordinatorRolePayload | null | ExitCode> {
  let url: string;
  let auth: BrokerAuth | null;
  try {
    url = resolveBrokerUrl(v["broker-url"], env);
    auth = resolveAuth({ username: v.username, password: v.password }, env, process.cwd(), url);
    if (v.timeout !== undefined) parsePositiveInt(v.timeout, "--timeout");
  } catch (e) {
    io.stderr(`volley coordinator: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const broker = await connectToSupervisor(url, io, auth, {
    command: "volley coordinator",
    json: v.json === true,
    env,
  });
  if (typeof broker === "number") return broker; // already diagnosed and printed.
  try {
    const raw = await broker.queryRetained(COORDINATOR_TOPIC, READ_MS);
    const e = raw === null || raw === "" ? null : parseEnvelope(raw);
    // Only the supervisor's record counts: any login may publish on a topic it can write.
    if (e === null || e.agent_id !== "volleyd" || e.type !== "coordinator") return null;
    return e.payload as CoordinatorRolePayload;
  } finally {
    await broker.disconnect();
  }
}
