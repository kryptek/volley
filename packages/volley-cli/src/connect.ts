import { VolleyBroker } from "volley-mcp/broker";
import { VolleyError } from "volley-mcp/errors";
import { randomSuffix } from "volley-mcp/util";
import type { IO } from "./io";

/** Printed alongside any BROKER_DOWN error — bridges from "the CLI failed" to "here is the fix". */
export const MOSQUITTO_INSTALL_HINT =
  "Hint: install mosquitto with `brew install mosquitto && brew services start mosquitto` " +
  "(or run any MQTT broker on the URL given by --broker-url / $VOLLEY_BROKER_URL).";

/**
 * Connect a non-agent (CLI-tool) broker session: no LWT, no will payload, no registry
 * presence — just a transient MQTT client. The `clientId` carries a `cli-` prefix so
 * brokers + observers can tell tool clients apart from agents.
 *
 * On failure, prints a human-readable diagnostic (plus the mosquitto install hint on
 * BROKER_DOWN) to stderr and returns `null` — the caller treats null as "give up, the
 * user has already been told." This keeps every subcommand from duplicating the
 * BROKER_DOWN translation AND avoids a re-throw that the top-level handler would
 * double-print.
 */
export async function connectAsClient(brokerUrl: string, io: IO): Promise<VolleyBroker | null> {
  const broker = new VolleyBroker();
  const clientId = `cli-${randomSuffix(8)}`;
  try {
    // No will: the CLI is not a conforming Volley agent (SPEC §7 says agents MUST set
    // an LWT; the CLI does not — it's a transient tool, not a tracked participant).
    // VolleyBroker.connect accepts willTopic/willPayload being absent for this case.
    await broker.connect({
      url: brokerUrl,
      agentId: clientId, // VolleyBroker uses this in the underlying MQTT clientId.
    });
    return broker;
  } catch (e) {
    if (e instanceof VolleyError && e.code === "BROKER_DOWN") {
      io.stderr(`volley: ${e.message}\n${MOSQUITTO_INSTALL_HINT}\n`);
    } else {
      io.stderr(`volley: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return null;
  }
}
