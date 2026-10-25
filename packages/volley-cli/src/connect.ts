import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { VolleyError } from "volley-mcp/errors";
import { randomSuffix } from "volley-mcp/util";
import { EXIT, type ExitCode } from "./exit-codes";
import type { IO } from "./io";
import {
  type DiagnoseInput,
  MOSQUITTO_INSTALL_HINT,
  printUnreachable,
  silentInput,
} from "./supervisor/diagnose";
import { type Probes, climb, connectFailed, realProbes, whereHere } from "./supervisor/probes";

export { MOSQUITTO_INSTALL_HINT } from "./supervisor/diagnose";

/**
 * Connect a non-agent (CLI-tool) broker session: no LWT, no will payload, no registry
 * presence — just a transient MQTT client. The `clientId` carries a `cli-` prefix so
 * brokers + observers can tell tool clients apart from agents.
 *
 * On failure, prints a human-readable diagnostic (plus the mosquitto install hint on
 * BROKER_DOWN) to stderr and returns `null` — the caller treats null as "give up, the
 * user has already been told." AUTH_FAILED messages carry their own `volley auth` hint.
 * This keeps every subcommand from duplicating the
 * BROKER_DOWN translation AND avoids a re-throw that the top-level handler would
 * double-print.
 */
export async function connectAsClient(
  brokerUrl: string,
  io: IO,
  auth: BrokerAuth | null = null,
  will?: { topic: string; payload: string },
): Promise<VolleyBroker | null> {
  try {
    return await openClient(brokerUrl, auth, will);
  } catch (e) {
    reportConnectError(io, e);
    return null;
  }
}

/** `connectAsClient` without the diagnostics: throws the connect error for the caller to judge. */
export async function openClient(
  brokerUrl: string,
  auth: BrokerAuth | null = null,
  will?: { topic: string; payload: string },
): Promise<VolleyBroker> {
  const broker = new VolleyBroker();
  const clientId = `cli-${randomSuffix(8)}`;
  // No status LWT: the CLI is not a conforming Volley agent (SPEC §7 says agents MUST set
  // an LWT; the CLI does not — it's a transient tool, not a tracked participant). A caller
  // may still arm a non-retained will (`volley lease` releases its lease that way).
  await broker.connect({
    url: brokerUrl,
    agentId: clientId, // VolleyBroker uses this in the underlying MQTT clientId.
    ...(will !== undefined
      ? { willTopic: will.topic, willPayload: will.payload, willRetain: false }
      : {}),
    ...(auth ?? {}),
  });
  return broker;
}

/**
 * How a command reports a supervisor it cannot reach: its name for the message (`volley list`),
 * whether it prints JSON, and the environment the ladder reads (`$HOME`, `VOLLEY_*`).
 */
export interface Reach {
  command: string;
  json?: boolean;
  env: Record<string, string | undefined>;
  /** The ladder's probes (supervisor/probes.ts); unset: the real ones. */
  probes?: Probes;
}

/**
 * `connectAsClient` for a command that needs the supervisor: on BROKER_DOWN it climbs the ladder
 * (supervisor/probes.ts) and prints the diagnosis (`reportUnreachable`), returning its exit code
 * (69 `SUPERVISOR_UNREACHABLE`); any other failure prints as `reportConnectError` does and
 * returns 1. Nothing is published either way.
 */
export async function connectToSupervisor(
  brokerUrl: string,
  io: IO,
  auth: BrokerAuth | null,
  reach: Reach,
  will?: { topic: string; payload: string },
): Promise<VolleyBroker | ExitCode> {
  try {
    return await openClient(brokerUrl, auth, will);
  } catch (e) {
    return reportUnreachable(io, e, brokerUrl, reach);
  }
}

/**
 * The failure path for a connect that threw `e`: a BROKER_DOWN is diagnosed (internet → private
 * network → tunnel → broker), printed as `<command>: supervisor unreachable (<reason>): <cause>`
 * with its fix line on stderr (with `json`, the `SUPERVISOR_UNREACHABLE` object on stdout) and
 * answered with 69. Anything else (a refused login, a bad URL) prints as before and is 1.
 */
export async function reportUnreachable(
  io: IO,
  e: unknown,
  brokerUrl: string,
  reach: Reach,
): Promise<ExitCode> {
  if (!(e instanceof VolleyError && e.code === "BROKER_DOWN")) {
    reportConnectError(io, e);
    return EXIT.ERROR;
  }
  const where = whereHere(reach.env, brokerUrl);
  const input = await climb(where, reach.probes ?? realProbes(reach.env));
  return printDiagnosis(io, reach, connectFailed(input), e);
}

/**
 * A command that reached the broker but found no live volleyd in `namespace`: `daemon_silent`,
 * 69. (The broker answered, so the earlier rungs passed.)
 */
export function reportDaemonSilent(
  io: IO,
  brokerUrl: string,
  namespace: string,
  reach: Reach,
): ExitCode {
  const where = { ...whereHere(reach.env, brokerUrl), namespace };
  return printDiagnosis(io, reach, silentInput(where));
}

function printDiagnosis(io: IO, reach: Reach, input: DiagnoseInput, e?: unknown): ExitCode {
  if (!printUnreachable(io, reach.command, reach.json === true, input)) {
    reportConnectError(io, e);
    return EXIT.ERROR;
  }
  return EXIT.SUPERVISOR_UNREACHABLE;
}

/** The stderr diagnostic for a failed connect (plus the mosquitto install hint on BROKER_DOWN). */
export function reportConnectError(io: IO, e: unknown): void {
  if (e instanceof VolleyError && e.code === "BROKER_DOWN") {
    io.stderr(`volley: ${e.message}\n${MOSQUITTO_INSTALL_HINT}\n`);
  } else {
    io.stderr(`volley: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
