import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient } from "../../src/connect";
import { deskHealthy, volleydHealthy } from "../../src/deploy/health";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

const FAST = { timeoutMs: 400, pollMs: 25 };

describe("deskHealthy", () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((ok) => (server === null ? ok() : server.close(() => ok())));
    server = null;
  });
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    server = createServer(handler);
    await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const desk = (version: string, status = 200) =>
    serve((req, res) => {
      if (req.url === "/version.json") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ version }));
      } else res.writeHead(status).end("<!doctype html>");
    });

  it("is healthy when / answers 200 and version.json carries the version", async () => {
    expect(await deskHealthy(await desk("0.5.0"), "0.5.0", FAST)).toBeNull();
  });

  it("says why on a 500, a version mismatch, or no answer within the timeout", async () => {
    expect(await deskHealthy(await desk("0.5.0", 500), "0.5.0", FAST)).toMatch(/HTTP 500/);
    await new Promise<void>((ok) => server?.close(() => ok()));
    expect(await deskHealthy(await desk("0.4.0"), "0.5.0", FAST)).toMatch(
      /serves 0\.4\.0, not 0\.5\.0/,
    );
    await new Promise<void>((ok) => server?.close(() => ok()));
    // Accepts the connection, never answers.
    const hung = await serve(() => {});
    const t0 = Date.now();
    expect(await deskHealthy(hung, "0.5.0", FAST)).toMatch(/no answer/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("takes any version.json (or none) when no version is required (a rollback)", async () => {
    const index = await serve((_req, res) => res.writeHead(200).end("<!doctype html>"));
    expect(await deskHealthy(index, null, FAST)).toBeNull();
  });

  it("waits for a Desk that comes up during the wait", async () => {
    let up = false;
    const url = await serve((req, res) => {
      if (!up) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200).end(req.url === "/version.json" ? '{"version":"0.5.0"}' : "ok");
    });
    setTimeout(() => {
      up = true;
    }, 100);
    expect(await deskHealthy(url, "0.5.0", FAST)).toBeNull();
  });
});

describe("volleydHealthy", () => {
  let broker: TestBroker;
  beforeEach(async () => {
    broker = await startTestBroker();
  });
  afterEach(async () => {
    await broker.close();
  });
  const retain = async (type: string, wallTime: Date) => {
    const c = await openClient(broker.url);
    await c.publish(
      "volley/default/volleyd/status",
      JSON.stringify({
        schema_version: "0.1",
        agent_id: "volleyd",
        wall_time: wallTime.toISOString(),
        channel: "status",
        type,
        payload: {},
      }),
      { qos: 1, retain: true },
    );
    await c.disconnect();
  };
  const check = (since: Date) =>
    volleydHealthy({ brokerUrl: broker.url, auth: null, namespace: "default", since, ...FAST });

  it("is not healthy with no retained status", async () => {
    expect(await check(new Date())).toMatch(/no live status/);
  });

  it("is not healthy while the retained status is the old process's", async () => {
    const since = new Date();
    await retain("registered", new Date(since.getTime() - 60_000));
    expect(await check(since)).toMatch(/not re-registered since the restart/);
  });

  it("is not healthy while the status is terminal", async () => {
    const since = new Date(Date.now() - 1_000);
    await retain("reaped", new Date());
    expect(await check(since)).toMatch(/reaped/);
  });

  it("is healthy once the new process registers within the wait", async () => {
    const since = new Date();
    await retain("registered", new Date(since.getTime() - 60_000));
    setTimeout(() => void retain("registered", new Date()), 100);
    expect(await check(since)).toBeNull();
  });

  it("says the broker is unreachable", async () => {
    const r = await volleydHealthy({
      brokerUrl: "mqtt://127.0.0.1:1",
      auth: null,
      namespace: "default",
      since: new Date(),
      ...FAST,
    });
    expect(r).toMatch(/broker/);
  });
});
