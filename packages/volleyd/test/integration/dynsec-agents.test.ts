import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DynsecSession, brokerTransport, roleDrift } from "volley-cli/auth/dynsec";
import { VOLLEY_ROLES } from "volley-cli/auth/roles";
import { VolleyBroker } from "volley-mcp/broker";
import { DynsecControl, DynsecCredentials, brokerControl } from "../../src/dynsec";
import { reapAndRevoke } from "../../src/retire";

/**
 * volleyd's agent logins on REAL mosquitto 2.1 (opt-in): VOLLEY_INTEGRATION=1,
 * VOLLEY_DYNSEC_BROKER_URL and VOLLEY_DYNSEC_ADMIN_PASSWORD for a PRIVATE broker bootstrapped by
 * volley-cli's test/integration/dynsec-fixture.ts (CI: the eclipse-mosquitto:2.1-alpine container).
 */
const URL = process.env.VOLLEY_DYNSEC_BROKER_URL;
const PW = process.env.VOLLEY_DYNSEC_ADMIN_PASSWORD;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && URL !== undefined && PW !== undefined;
const NS = `dynsecagents-${randomBytes(3).toString("hex")}`;
const ADMIN = { username: "dynsec-admin", password: PW as string };

describe.skipIf(!RUN)("volleyd agent logins on mosquitto 2.1", () => {
  let control: DynsecControl;
  let creds: DynsecCredentials;
  let observer: VolleyBroker;
  const seen: { topic: string; payload: string }[] = [];

  beforeAll(async () => {
    control = new DynsecControl({
      connect: brokerControl(URL as string, ADMIN),
      batchMs: () => 50,
    });
    creds = new DynsecCredentials(control);
    observer = new VolleyBroker();
    await observer.connect({
      url: URL as string,
      agentId: "obs",
      username: "volleyd",
      password: "volleyd-test-pw",
    });
    await observer.subscribeStream(`volley/${NS}/+/status`, (m) => seen.push(m));
  });
  afterAll(async () => {
    await observer?.disconnect();
    await control?.close();
  });

  it("50 parallel mints over one connection: 50 logins that work, no role edited", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `${NS}-t${i}-implementer-1`);
    const minted = await Promise.all(ids.map((id) => creds.mint(id)));
    expect(control.opened).toBe(1);
    const logins = await creds.agentLogins();
    expect(ids.every((id) => logins.includes(id))).toBe(true);
    const b = new VolleyBroker();
    const m = minted[17] as { username: string; password: string };
    await b.connect({ url: URL as string, agentId: "probe", ...m });
    await b.disconnect();
    const admin = new VolleyBroker();
    await admin.connect({ url: URL as string, agentId: "adm", ...ADMIN });
    const s = await DynsecSession.open(brokerTransport(admin));
    expect(await roleDrift(s, VOLLEY_ROLES)).toEqual([]);
    await s.close();
    await admin.disconnect();
    expect(await Promise.all(ids.map((id) => creds.revoke(id)))).toEqual(ids.map(() => true));
    const after = await creds.agentLogins();
    expect(ids.some((id) => after.includes(id))).toBe(false);
  });

  it("the delete path: reaped first, the records cleared, the connected agent dropped, no LWT", async () => {
    const id = `${NS}-tx-implementer-1`;
    const c = await creds.mint(id);
    const agent = new VolleyBroker();
    const statusTopic = `volley/${NS}/${id}/status`;
    await agent.connect({
      url: URL as string,
      agentId: id,
      username: c.username,
      password: c.password,
      willTopic: statusTopic,
      willPayload: JSON.stringify({ type: "reaped", payload: { reason: "disconnect" } }),
    });
    await agent.publish(statusTopic, JSON.stringify({ type: "working" }), { qos: 1, retain: true });
    await new Promise((r) => setTimeout(r, 100));
    seen.length = 0;
    const ok = await reapAndRevoke(id, NS, {
      credentials: creds,
      publishRetained: (t, p) => observer.publish(t, p, { qos: 1, retain: true }),
      clearRetained: (t) => observer.publish(t, "", { qos: 1, retain: true }),
      journal: () => {},
    });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(agent.connected).toBe(false);
    const mine = seen.filter((m) => m.topic === statusTopic);
    // volleyd's `reaped`, then the clear; the broker sent no will (it would say "disconnect").
    expect(mine.map((m) => (m.payload === "" ? "" : JSON.parse(m.payload).payload.reason))).toEqual(
      ["credentials_deleted", ""],
    );
    expect(await observer.queryRetained(statusTopic, 300)).toBeNull();
  });
});
