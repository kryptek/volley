import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOSQUITTO_INSTALL_HINT, connectAsClient } from "../src/connect";
import { makeBufferIO } from "../src/io";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

describe("connectAsClient", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects to a reachable broker and returns the live broker", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io);
    if (broker === null) throw new Error("expected a connected broker, got null");
    expect(broker.connected).toBe(true);
    await broker.disconnect();
    expect(io.readStderr()).toBe(""); // success path is silent
  });

  it("on an unreachable broker, prints a stderr hint and returns null (does NOT throw)", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient("mqtt://127.0.0.1:1", io);
    expect(broker).toBeNull();
    expect(io.readStderr()).toContain("cannot connect to broker");
    expect(io.readStderr()).toContain(MOSQUITTO_INSTALL_HINT);
  });
});

describe("connectAsClient against a broker that requires credentials", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker({ credentials: { username: "desk", password: "right" } });
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects with the given credentials", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io, { username: "desk", password: "right" });
    if (broker === null) throw new Error(`expected a connected broker: ${io.readStderr()}`);
    await broker.disconnect();
  });

  it("on refused credentials, prints AUTH_FAILED with the volley auth hint (not the install hint)", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io, { username: "desk", password: "wrong" });
    expect(broker).toBeNull();
    expect(io.readStderr()).toContain('refused the credentials for user "desk"');
    expect(io.readStderr()).toContain("volley auth init");
    expect(io.readStderr()).not.toContain(MOSQUITTO_INSTALL_HINT);
  });
});
