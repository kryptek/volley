import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { AUTH_REDEEM_TOPIC, authOpsTopic } from "../../src/accounts";

/**
 * The account role templates (`volley auth add --role`) and a token login (`volley auth token`)
 * against real mosquitto with the shipped examples/mosquitto-auth/acl.conf. Opt-in: needs
 * VOLLEY_INTEGRATION=1 and VOLLEY_AUTH_BROKER_URL pointing at a PRIVATE mosquitto started as
 * volley-mcp's test/integration/mosquitto-auth.conf describes. auth-fixture.sh appends the
 * role blocks volley-cli's auth.test.ts proves the generator writes; each password is
 * "<username>-test-pw".
 */
const AUTH_URL = process.env.VOLLEY_AUTH_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && AUTH_URL !== undefined;
const BROKER_URL = AUTH_URL as string;
/** Fresh namespace per run so no earlier message can satisfy an assertion. */
const NS = `rolesit-${randomBytes(3).toString("hex")}`;

async function connectAs(username: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: BROKER_URL,
    agentId: `rolesit-${username}`,
    username,
    password: `${username}-test-pw`,
  });
  return b;
}

describe.skipIf(!RUN)("account roles against real mosquitto + the shipped ACL", () => {
  let observer: VolleyBroker;
  let stop: () => Promise<void>;
  const clients: VolleyBroker[] = [];
  const seen: string[] = [];

  /** Publish `payload` as `who` (QoS 1, not retained); a denied publish is dropped silently. */
  async function attempt(who: string, topic: string, payload: string): Promise<void> {
    const c = await connectAs(who);
    clients.push(c);
    await c.publish(topic, payload, { qos: 1, retain: false }).catch(() => {});
  }

  /** Did the observer (volleyd: reads everything) receive `payload`? Waits briefly. */
  async function delivered(payload: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      if (seen.includes(payload)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }
  const probe = (label: string) => `${label}-${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    observer = await connectAs("volleyd");
    stop = await observer.subscribeStream("volley/#", (m) => seen.push(m.payload));
  });

  afterAll(async () => {
    for (const c of clients) await c.disconnect().catch(() => {});
    if (!observer) return;
    await stop();
    await observer.disconnect();
  });

  it("watch cannot publish a mailbox; steer can", async () => {
    const denied = probe("watch-mailbox");
    await attempt("watch-test", `volley/${NS}/some-agent/mailbox`, denied);
    const allowed = probe("steer-mailbox");
    await attempt("steer-test", `volley/${NS}/some-agent/mailbox`, allowed);
    expect(await delivered(allowed)).toBe(true);
    expect(seen).not.toContain(denied);
  });

  it("peer publishes only under its own machine topic", async () => {
    const own = probe("peer-own");
    const ownSub = probe("peer-own-sub");
    const other = probe("peer-other");
    const mailbox = probe("peer-mailbox");
    await attempt("peer-test", "volley/_system/machines/peer-test", own);
    await attempt("peer-test", "volley/_system/machines/peer-test/health", ownSub);
    await attempt("peer-test", "volley/_system/machines/other-box", other);
    await attempt("peer-test", `volley/${NS}/some-agent/mailbox`, mailbox);
    expect(await delivered(own)).toBe(true);
    expect(await delivered(ownSub)).toBe(true);
    expect(seen).not.toContain(other);
    expect(seen).not.toContain(mailbox);
  });

  it("only an admin writes account ops, and only on its own username's topic", async () => {
    const admin = probe("admin-ops");
    const impersonated = probe("steer-as-admin");
    const steerOwn = probe("steer-ops");
    await attempt("admin-test", authOpsTopic("admin-test"), admin);
    await attempt("steer-test", authOpsTopic("admin-test"), impersonated);
    await attempt("steer-test", authOpsTopic("steer-test"), steerOwn);
    expect(await delivered(admin)).toBe(true);
    expect(seen).not.toContain(impersonated);
    expect(seen).not.toContain(steerOwn);
  });

  it("a token login may only ask to be redeemed; nobody else writes the redeem topic", async () => {
    const redeem = probe("token-redeem");
    const tokenMailbox = probe("token-mailbox");
    const steerRedeem = probe("steer-redeem");
    await attempt("redeem-0000abcd", AUTH_REDEEM_TOPIC, redeem);
    await attempt("redeem-0000abcd", `volley/${NS}/some-agent/mailbox`, tokenMailbox);
    await attempt("steer-test", AUTH_REDEEM_TOPIC, steerRedeem);
    expect(await delivered(redeem)).toBe(true);
    expect(seen).not.toContain(tokenMailbox);
    expect(seen).not.toContain(steerRedeem);
  });

  it("nobody but the supervisor writes an answer on the reply topic", async () => {
    const forged = probe("forged-reply");
    await attempt("admin-test", "volley/_system/auth/replies/0a4f3e7c-8b21", forged);
    await attempt("steer-test", "volley/_system/auth/replies/0a4f3e7c-8b21", forged);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).not.toContain(forged);
  });
});
