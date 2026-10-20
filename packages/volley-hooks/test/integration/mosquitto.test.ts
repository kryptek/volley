import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import {
  collect,
  connectClient,
  contextOf,
  fixture,
  makeWorkdir,
  publishEnvelope,
  runHook,
  tick,
} from "../helpers/hooks";
import { tempDirForAll } from "../helpers/tmp";

/**
 * The default production path — an MQTT 5 persistent session with `sessionExpiryInterval`,
 * mail queued while no hook runs — which Aedes (v3.1.1 only) cannot exercise. Opt-in: needs
 * VOLLEY_INTEGRATION=1 and an explicit VOLLEY_BROKER_URL pointing at a disposable mosquitto.
 */
const BROKER_URL = process.env.VOLLEY_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && BROKER_URL !== undefined;

describe.skipIf(!RUN)("mosquitto (MQTT 5): mailbox drain", () => {
  const url = BROKER_URL as string;
  const agent = `it-hooks-${randomUUID().slice(0, 8)}`;
  const ns = "it-hooks";
  const env = { VOLLEY_HOOKS_MQTT_VERSION: "5" };
  let client: VolleyBroker;
  let dir: string;
  const workdir = tempDirForAll("volley-hooks-it-");

  beforeAll(async () => {
    client = await connectClient(url, `${agent}-observer`);
    dir = makeWorkdir({ agent_id: agent, namespace: ns, broker_url: url }, workdir());
  });

  afterAll(async () => {
    // A throwing afterAll skips the later ones (the workdir's removal among them).
    if (client) await client.disconnect();
  });

  const postToolUse = () =>
    runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir, env });

  it("delivers mail queued while no hook ran, acks it, and drains it once", async () => {
    // One-time bootstrap creates the persistent session (clientId volley-<id>-hooks).
    expect((await postToolUse()).exitCode).toBe(0);

    const acks = await collect(client, `volley/${ns}/it-coord/mailbox`);
    const ids: string[] = [];
    for (const [seq, text] of [
      [1, "first run the integration suite"],
      [2, "then rebase on the release branch"],
    ] as const) {
      const id = randomUUID();
      ids.push(id);
      await publishEnvelope(client, `volley/${ns}/${agent}/mailbox`, {
        agentId: "it-coord",
        parentId: null,
        channel: "mailbox",
        type: "steering",
        payload: { text, seq },
        correlationId: id,
      });
    }
    await tick(200);

    const ctx = contextOf((await postToolUse()).stdout);
    expect(ctx).toContain("[volley steering] 2 message(s)");
    expect(ctx?.indexOf("first run the integration suite")).toBeLessThan(
      ctx?.indexOf("then rebase on the release branch") ?? -1,
    );
    await tick(300);
    expect(acks.envelopes.map((e) => e.correlation_id)).toEqual(ids);

    expect(contextOf((await postToolUse()).stdout)).toBeNull();
    await acks.stop();
  });
});
