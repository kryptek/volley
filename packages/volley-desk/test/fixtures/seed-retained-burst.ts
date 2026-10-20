/**
 * Publish `retainedBurst` (300 finished agents, 3 live ones) as retained messages to a
 * PRIVATE broker, for checking the Desk's first load in a browser (C11):
 *
 *   bun test/fixtures/seed-retained-burst.ts mqtt://127.0.0.1:<private-port>
 *
 * There is no default URL on purpose: never seed a broker that carries real agents.
 */
import mqtt from "mqtt";
import { retainedBurst } from "./retained-burst";

const url = process.argv[2];
if (!url) {
  console.error("usage: bun test/fixtures/seed-retained-burst.ts <private broker url>");
  process.exit(2);
}
const client = await mqtt.connectAsync(url, { reconnectPeriod: 0 });
const records = retainedBurst();
for (const r of records) {
  await client.publishAsync(r.topic, JSON.stringify(r.envelope), { qos: 1, retain: true });
}
await client.endAsync();
console.log(`seeded ${records.length} retained records to ${url}`);
