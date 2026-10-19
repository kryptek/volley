import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynsecSession, brokerTransport, ensureClients, ensureRoles } from "volley-cli/auth/dynsec";
import { BrokerVersionError } from "volley-cli/auth/version";
import { VolleyBroker } from "volley-mcp/broker";
import { Daemon } from "../src/daemon";
import { DynsecControl, brokerControl } from "../src/dynsec";
import { NO_PRESSURE } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { type FakeDynsec, startFakeDynsec } from "./helpers/fake-dynsec";

describe("volleyd refuses a broker older than 2.1 (control-connection open)", () => {
  let fake: FakeDynsec;
  afterEach(async () => {
    await fake.close();
  });

  it("$SYS/broker/version 2.0.22 → BROKER_TOO_OLD with the install instructions; nothing sent", async () => {
    fake = await startFakeDynsec({ version: "mosquitto version 2.0.22" });
    const c = new DynsecControl({
      connect: brokerControl(fake.url, fake.admin),
      batchMs: () => 0,
      clock: fakeClock(),
    });
    const err = await c.open().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerVersionError);
    expect((err as BrokerVersionError).code).toBe("BROKER_TOO_OLD");
    expect((err as Error).message).toContain("brew install mosquitto");
    expect((err as Error).message).toContain("sudo snap install mosquitto");
    expect((err as Error).message).toContain("eclipse-mosquitto:2.1-alpine");
    expect(fake.controlMessages).toEqual([]);
    await c.close();
  });

  it("2.1.2 → proceeds", async () => {
    fake = await startFakeDynsec({ version: "mosquitto version 2.1.2" });
    const c = new DynsecControl({
      connect: brokerControl(fake.url, fake.admin),
      batchMs: () => 0,
      clock: fakeClock(),
    });
    await c.open();
    expect(c.version).toBe("2.1.2");
    await c.close();
  });

  it("no retained version → `mosquitto -h` (the fenced exec) decides", async () => {
    fake = await startFakeDynsec({ version: null });
    const old = new DynsecControl({
      connect: brokerControl(fake.url, fake.admin),
      batchMs: () => 0,
      clock: fakeClock(),
      binaryVersion: async () => "mosquitto version 2.0.22\n\nmosquitto is an MQTT broker.",
    });
    await expect(old.open()).rejects.toMatchObject({ code: "BROKER_TOO_OLD" });
    await old.close();
    const ok = new DynsecControl({
      connect: brokerControl(fake.url, fake.admin),
      batchMs: () => 0,
      clock: fakeClock(),
      binaryVersion: async () => "mosquitto version 2.1.2",
    });
    await ok.open();
    expect(ok.version).toBe("2.1.2");
    await ok.close();
  });
});

describe("Daemon.start with a dynsec admin login", () => {
  let fake: FakeDynsec;
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "volleyd-version-"));
  });
  afterEach(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function bootstrap(): Promise<void> {
    const b = new VolleyBroker();
    await b.connect({ url: fake.url, agentId: "bootstrap", ...fake.admin });
    const s = await DynsecSession.open(brokerTransport(b));
    await ensureRoles(s);
    await ensureClients(s, [{ username: "volleyd", password: "vd", roles: ["volleyd"] }]);
    await s.close();
    await b.disconnect();
  }
  const opts = () => ({
    brokerUrl: fake.url,
    namespace: "vt",
    home,
    tickMs: 0,
    protocolVersion: 4 as const,
    pressure: NO_PRESSURE,
    auth: { username: "volleyd", password: "vd" },
    dynsecAdmin: fake.admin,
  });

  it("refuses to start against 2.0.22 (BROKER_TOO_OLD)", async () => {
    fake = await startFakeDynsec({ version: "mosquitto version 2.0.22" });
    await bootstrap();
    await expect(Daemon.start(opts())).rejects.toMatchObject({ code: "BROKER_TOO_OLD" });
  });

  it("starts against 2.1.2", async () => {
    fake = await startFakeDynsec();
    await bootstrap();
    const d = await Daemon.start(opts());
    await d.stop();
  });
});
