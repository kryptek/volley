#!/usr/bin/env bun
/**
 * Bootstrap a PRIVATE mosquitto 2.1 (Dynamic Security) for the opt-in auth integration suites:
 * Volley's eight shared roles (what `volley auth init` creates) and the identities those suites
 * log in as, each with the password "<username>-test-pw" (test-only). Idempotent.
 *
 *   VOLLEY_DYNSEC_BROKER_URL=mqtt://127.0.0.1:<port>  VOLLEY_DYNSEC_ADMIN_PASSWORD=<pw> \
 *     bun packages/volley-cli/test/integration/dynsec-fixture.ts
 *
 * Start the broker from examples/mosquitto-auth/mosquitto-dynsec.conf (the eclipse-mosquitto:2.1
 * container layout), its state file created first with
 * `mosquitto_ctrl dynsec init /mosquitto/data/dynamic-security.json dynsec-admin <pw>`; map the
 * container's 1883/9001 to private host ports (never the ports a real Volley broker uses).
 */
import { VolleyBroker } from "volley-mcp/broker";
import {
  DynsecSession,
  brokerTransport,
  ensureClients,
  ensureRoles,
  sysVersion,
} from "../../src/auth/dynsec";
import {
  ACCOUNT_ROLE_MAP,
  DYNSEC_ADMIN_USER,
  FIXED_CLIENTS,
  type VolleyRole,
} from "../../src/auth/roles";
import { requireBrokerVersion } from "../../src/auth/version";

export const FIXTURE_IDENTITIES: { username: string; roles: readonly VolleyRole[] }[] = [
  ...Object.entries(FIXED_CLIENTS).map(([username, roles]) => ({ username, roles })),
  { username: "w1-t1-implementer-1", roles: ["agent"] },
  { username: "w1-t2-implementer-1", roles: ["agent"] },
  ...Object.entries(ACCOUNT_ROLE_MAP).map(([role, roles]) => ({ username: `${role}-test`, roles })),
  // A one-time token's login: its username is the token id.
  { username: "0000abcd", roles: ["token"] },
];

const url = process.env.VOLLEY_DYNSEC_BROKER_URL;
const password = process.env.VOLLEY_DYNSEC_ADMIN_PASSWORD;
if (url === undefined || password === undefined) {
  process.stderr.write(
    "dynsec-fixture: set VOLLEY_DYNSEC_BROKER_URL and VOLLEY_DYNSEC_ADMIN_PASSWORD\n",
  );
  process.exit(2);
}
const b = new VolleyBroker();
await b.connect({ url, agentId: "dynsec-fixture", username: DYNSEC_ADMIN_USER, password });
const version = await requireBrokerVersion({ sys: () => sysVersion(b) });
const s = await DynsecSession.open(brokerTransport(b));
const roles = await ensureRoles(s);
const made = await ensureClients(
  s,
  FIXTURE_IDENTITIES.map((i) => ({ ...i, password: `${i.username}-test-pw` })),
);
await s.close();
await b.disconnect();
process.stdout.write(
  `dynsec-fixture: mosquitto ${version}; roles created ${roles.created.length}, kept ${roles.existing.length}; identities created ${made.filter((m) => m === "created").length}\n`,
);
