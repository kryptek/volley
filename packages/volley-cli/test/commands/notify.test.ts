import { describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { notify } from "../../src/commands/notify";
import type {
  NotifyConnectFn,
  NotifySubscribeStreamFn,
  NotifySurfaceFactories,
} from "../../src/commands/notify";
import type { FireInput, Surface } from "../../src/commands/notify/surfaces/types";
import { makeBufferIO } from "../../src/io";

/** A connectFn that should never be called — usage errors must short-circuit before broker dial. */
const refusingConnectFn: NotifyConnectFn = async () => {
  throw new Error("connectFn was called despite a usage error short-circuit");
};

interface FakeBroker {
  subscribeStream: NotifySubscribeStreamFn;
  disconnect: () => Promise<void>;
}

interface FakeBrokerHandle {
  broker: FakeBroker;
  connectFn: NotifyConnectFn;
  /** Resolves to the `onMessage` callback once subscribeStream is invoked. */
  whenSubscribed: Promise<(msg: { topic: string; payload: string }) => void>;
  unsubscribeCalls: number;
  disconnectCalls: number;
}

function makeFakeBroker(): FakeBrokerHandle {
  let resolveSubscribed: ((cb: (msg: { topic: string; payload: string }) => void) => void) | null =
    null;
  const whenSubscribed = new Promise<(msg: { topic: string; payload: string }) => void>(
    (resolve) => {
      resolveSubscribed = resolve;
    },
  );
  const handle: FakeBrokerHandle = {
    broker: {
      subscribeStream: async (_pattern, onMessage) => {
        resolveSubscribed?.(onMessage);
        return async () => {
          handle.unsubscribeCalls += 1;
        };
      },
      disconnect: async () => {
        handle.disconnectCalls += 1;
      },
    },
    connectFn: async () => handle.broker as unknown as Awaited<ReturnType<NotifyConnectFn>>,
    whenSubscribed,
    unsubscribeCalls: 0,
    disconnectCalls: 0,
  };
  return handle;
}

function spySurface(name: "bell" | "desktop" | "webhook"): {
  surface: Surface;
  calls: FireInput[];
} {
  const calls: FireInput[] = [];
  return {
    surface: {
      name,
      async fire(input) {
        calls.push(input);
      },
    },
    calls,
  };
}

function envelopePayload(type: string): string {
  return JSON.stringify(
    buildEnvelope({ agentId: "alpha", parentId: null, channel: "status", type, payload: {} }),
  );
}

/** volleyd's morning digest push (SPEC §4.6.16): a `progress` envelope of type `digest`. */
const digestPayload = JSON.stringify(
  buildEnvelope({
    agentId: "volleyd",
    parentId: null,
    channel: "progress",
    type: "digest",
    payload: { msg: "w1 complete: 2 shipped", wave: "w1", trigger: "wave_complete" },
  }),
);

/** Run notify with a spy bell, deliver one digest push, return how often the bell fired. */
async function bellsForDigest(argv: string[]): Promise<number> {
  const handle = makeFakeBroker();
  const bell = spySurface("bell");
  let resolveShutdown: () => void = () => {};
  const shutdownSignal = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const running = notify({
    argv: ["--pattern", "volley/+/volleyd/progress", ...argv],
    env: {},
    io: makeBufferIO(),
    surfaceFactories: { bell: () => bell.surface },
    connectFn: handle.connectFn,
    shutdownSignal,
  });
  const onMessage = await handle.whenSubscribed;
  onMessage({ topic: "volley/default/volleyd/progress", payload: digestPayload });
  await new Promise((r) => setTimeout(r, 10));
  resolveShutdown();
  expect(await running).toBe(0);
  return bell.calls.length;
}

describe("volley notify — the digest push", () => {
  it("a digest envelope rings by default", async () => {
    expect(await bellsForDigest([])).toBe(1);
  });

  it("--on blocked leaves it out", async () => {
    expect(await bellsForDigest(["--on", "blocked"])).toBe(0);
  });
});

describe("volley notify — argv + validation", () => {
  it("exits 2 with a --pattern hint when --pattern is missing", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: [],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain("--pattern");
  });

  it("exits 2 when --pattern is not a valid MQTT topic filter", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: ["--pattern", "volley/test/#/status"],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain("invalid topic filter");
  });

  it("exits 2 when --surface lists an unknown surface, mentioning the valid set", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: ["--pattern", "volley/+/+/status", "--surface", "zzz"],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain("bell,desktop,webhook");
  });

  it("exits 2 when --on lists an unknown lifecycle type, mentioning the valid set", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: ["--pattern", "volley/+/+/status", "--on", "garbage"],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain(
      "spawning,working,done,blocked,failed,reaped,registered,digest",
    );
  });

  it("exits 2 when --surface webhook is selected but no --webhook-url is provided", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: ["--pattern", "volley/+/+/status", "--surface", "webhook"],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain("--webhook-url");
  });

  it("exits 2 when --webhook-url uses a non-http(s) scheme", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: [
        "--pattern",
        "volley/+/+/status",
        "--surface",
        "webhook",
        "--webhook-url",
        "file:///tmp/x",
      ],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(2);
    expect(io.readStderr()).toContain("http:// or https://");
  });

  it("--help prints USAGE and exits 0", async () => {
    const io = makeBufferIO();
    const code = await notify({
      argv: ["--help"],
      env: {},
      io,
      connectFn: refusingConnectFn,
    });
    expect(code).toBe(0);
    expect(io.readStdout()).toContain("Usage: volley notify");
  });

  it("reads VOLLEY_NOTIFY_ON from the environment when --on is absent", async () => {
    const io = makeBufferIO();
    const handle = makeFakeBroker();
    const bellSpy = spySurface("bell");
    const factories: NotifySurfaceFactories = {
      bell: () => bellSpy.surface,
    };
    let resolveShutdown: () => void = () => {};
    const shutdownSignal = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const notifyPromise = notify({
      argv: ["--pattern", "volley/+/+/status"],
      env: { VOLLEY_NOTIFY_ON: "working" },
      io,
      surfaceFactories: factories,
      connectFn: handle.connectFn,
      shutdownSignal,
    });

    const onMessage = await handle.whenSubscribed;

    // "working" is in the env-supplied --on set → spy fires.
    onMessage({ topic: "volley/default/alpha/status", payload: envelopePayload("working") });
    await new Promise((r) => setTimeout(r, 10));
    expect(bellSpy.calls).toHaveLength(1);
    expect(bellSpy.calls[0]?.envelope.type).toBe("working");

    // "blocked" is NOT in the env-supplied --on (env overrides the default blocked,failed,reaped),
    // so the spy must not fire for it.
    onMessage({ topic: "volley/default/alpha/status", payload: envelopePayload("blocked") });
    await new Promise((r) => setTimeout(r, 10));
    expect(bellSpy.calls).toHaveLength(1);

    resolveShutdown();
    const code = await notifyPromise;
    expect(code).toBe(0);
    expect(handle.unsubscribeCalls).toBe(1);
    expect(handle.disconnectCalls).toBe(1);
  });
});
