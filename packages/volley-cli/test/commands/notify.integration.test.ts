import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { notify } from "../../src/commands/notify";
import type { NotifySurfaceFactories } from "../../src/commands/notify";
import type { FireInput, Surface } from "../../src/commands/notify/surfaces/types";
import { makeBufferIO } from "../../src/io";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

function envelopeJson(agentId: string, channel: string, type: string): string {
  return JSON.stringify(buildEnvelope({ agentId, parentId: null, channel, type, payload: {} }));
}

describe("volley notify — Aedes integration", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("fires the configured surfaces only for envelopes whose type is in --on, in publish order", async () => {
    const calls: FireInput[] = [];
    const spy: Surface = {
      name: "bell",
      async fire(input) {
        calls.push(input);
      },
    };
    // Default --surface is `bell`, so we override only that. Spy receives one
    // call per matching event.
    const factories: NotifySurfaceFactories = {
      bell: () => spy,
    };

    let resolveShutdown: () => void = () => {};
    const shutdownSignal = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const io = makeBufferIO();
    const notifyPromise = notify({
      argv: [
        "--broker-url",
        tb.url,
        "--pattern",
        "volley/default/+/status",
        // Defaults to blocked,failed,reaped — leave --on absent on purpose.
      ],
      env: {},
      io,
      surfaceFactories: factories,
      shutdownSignal,
    });

    // Wait for the subscribe to register before publishing — without this, retained-only
    // delivery + race timing can flake.
    await new Promise((r) => setTimeout(r, 100));

    const pub = new VolleyBroker();
    await pub.connect({
      url: tb.url,
      agentId: "alpha-pub",
      willTopic: "volley/_meta/cli/alpha-pub/will",
      willPayload: "",
    });
    try {
      // QoS 1 to guarantee publish-order delivery to the single subscriber.
      await pub.publish("volley/default/alpha/status", envelopeJson("alpha", "status", "working"), {
        qos: 1,
        retain: false,
      });
      await pub.publish("volley/default/alpha/status", envelopeJson("alpha", "status", "blocked"), {
        qos: 1,
        retain: false,
      });
      await pub.publish("volley/default/alpha/status", envelopeJson("alpha", "status", "done"), {
        qos: 1,
        retain: false,
      });
      await pub.publish("volley/default/alpha/status", envelopeJson("alpha", "status", "failed"), {
        qos: 1,
        retain: false,
      });
      await pub.publish("volley/default/alpha/status", envelopeJson("alpha", "status", "reaped"), {
        qos: 1,
        retain: false,
      });
    } finally {
      await pub.disconnect();
    }

    // Wait for delivery — one bell surface × three matching events = three fire() calls.
    for (let i = 0; i < 100 && calls.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    resolveShutdown();
    const code = await notifyPromise;

    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.envelope.type)).toEqual(["blocked", "failed", "reaped"]);

    expect(io.readStderr()).toContain("[notify] shutting down");

    // One stdout JSON line per matching event (NOT per surface call).
    const stdoutLines = io.readStdout().trim().split("\n").filter(Boolean);
    expect(stdoutLines).toHaveLength(3);
    const parsedTypes = stdoutLines.map((l) => JSON.parse(l).type);
    expect(parsedTypes).toEqual(["blocked", "failed", "reaped"]);
  }, 10000);
});
