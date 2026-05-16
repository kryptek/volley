import mqtt from "mqtt";
import { describe, expect, it } from "vitest";
import { startTestBroker } from "./aedes-broker";

describe("startTestBroker", () => {
  it("starts a real MQTT broker a client can connect to, then closes cleanly", async () => {
    const broker = await startTestBroker();
    expect(broker.url).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/);
    expect(broker.port).toBeGreaterThan(0);

    const client = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    expect(client.connected).toBe(true);
    await client.endAsync();

    await broker.close();
  });

  it("assigns a distinct port on each start", async () => {
    const a = await startTestBroker();
    const b = await startTestBroker();
    expect(a.port).not.toBe(b.port);
    await a.close();
    await b.close();
  });
});
