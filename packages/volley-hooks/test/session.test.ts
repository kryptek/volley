import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerConnectOptions, VolleyBroker } from "volley-mcp/broker";
import type { HookIdentity } from "../src/lib/identity";
import { connectDrain, hooksClientId, resolveSessionExpiry } from "../src/lib/session";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { connectClient, publishEnvelope } from "./helpers/hooks";

let broker: TestBroker;
let client: VolleyBroker;
let identity: HookIdentity;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  const dir = mkdtempSync(join(tmpdir(), "volley-hooks-session-"));
  mkdirSync(join(dir, ".volley"));
  identity = {
    mode: "agent",
    agentId: "w1-t1-implementer-1",
    namespace: "ns",
    parentId: null,
    brokerUrl: broker.url,
    projectDir: dir,
    stateDir: join(dir, ".volley"),
  };
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const setConfig = (sessionExpiry: number) =>
  publishEnvelope(
    client,
    "volley/_waves/_config",
    {
      agentId: "volleyd",
      parentId: null,
      channel: "_waves/_config",
      type: "config",
      payload: { version: 1, mailbox: { session_expiry_s: sessionExpiry } },
    },
    { qos: 1, retain: true },
  );

describe("session expiry", () => {
  it("reads mailbox.session_expiry_s from the retained _config topic and caches it for 60 s", async () => {
    await setConfig(120);
    expect(await resolveSessionExpiry(identity, {})).toBe(120);
    await setConfig(999);
    expect(await resolveSessionExpiry(identity, {})).toBe(120);
    expect(await resolveSessionExpiry(identity, {}, { now: () => Date.now() + 61_000 })).toBe(999);
  });

  it("falls back to VOLLEY_SESSION_EXPIRY_S, then 7 days", async () => {
    expect(await resolveSessionExpiry(identity, { VOLLEY_SESSION_EXPIRY_S: "300" })).toBe(300);
    expect(await resolveSessionExpiry(identity, { VOLLEY_SESSION_EXPIRY_S: "nope" })).toBe(604800);
    expect(await resolveSessionExpiry(identity, {})).toBe(604800);
  });

  it("the drain session connects persistent, with the hooks clientId and that expiry", async () => {
    await setConfig(120);
    const calls: BrokerConnectOptions[] = [];
    const fake = {
      connect: async (opts: BrokerConnectOptions) => {
        calls.push(opts);
      },
    } as unknown as VolleyBroker;
    await connectDrain(identity, { VOLLEY_HOOKS_MQTT_VERSION: "5" }, { createBroker: () => fake });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: broker.url,
      agentId: "w1-t1-implementer-1",
      clientId: hooksClientId("w1-t1-implementer-1"),
      cleanSession: false,
      sessionExpirySeconds: 120,
      protocolVersion: 5,
    });
    expect(hooksClientId("w1-t1-implementer-1")).toBe("volley-w1-t1-implementer-1-hooks");
  });

  it("defaults to MQTT 5 and honours VOLLEY_HOOKS_MQTT_VERSION=4", async () => {
    const calls: BrokerConnectOptions[] = [];
    const fake = {
      connect: async (opts: BrokerConnectOptions) => {
        calls.push(opts);
      },
    } as unknown as VolleyBroker;
    await connectDrain(identity, {}, { createBroker: () => fake });
    await connectDrain(identity, { VOLLEY_HOOKS_MQTT_VERSION: "4" }, { createBroker: () => fake });
    expect(calls.map((c) => c.protocolVersion)).toEqual([5, 4]);
  });
});
