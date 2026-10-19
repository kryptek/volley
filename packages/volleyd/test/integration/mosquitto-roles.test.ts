import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { authOpsTopic, tokenRedeemTopic, tokenReplyTopic } from "../../src/accounts";

/**
 * The account roles (`volley auth add --role`) and a token login (`volley auth token`, username =
 * the token id) against real mosquitto 2.1 with Volley's shared Dynamic Security roles. Opt-in:
 * needs VOLLEY_INTEGRATION=1 and VOLLEY_AUTH_BROKER_URL pointing at a PRIVATE broker
 * bootstrapped by volley-cli's test/integration/dynsec-fixture.ts (each password is
 * "<username>-test-pw").
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

describe.skipIf(!RUN)("account roles on mosquitto 2.1 Dynamic Security", () => {
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
      // broker round-trip: delivery through the real mosquitto to the observer.
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }
  const probe = (label: string) => `${label}-${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    observer = await connectAs("volleyd");
    const stopTree = await observer.subscribeStream("volley/#", (m) => seen.push(m.payload));
    const stopAuth = await observer.subscribeStream("volley-auth/#", (m) => seen.push(m.payload));
    stop = async () => {
      await stopTree();
      await stopAuth();
    };
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

  it("peer publishes only its own machine record, never its readiness verdict", async () => {
    const own = probe("peer-own");
    const ownVerdict = probe("peer-own-readiness");
    const other = probe("peer-other");
    const mailbox = probe("peer-mailbox");
    await attempt("peer-test", "volley/_system/machines/peer-test", own);
    await attempt("peer-test", "volley/_system/machines/peer-test/readiness", ownVerdict);
    await attempt("peer-test", "volley/_system/machines/other-box", other);
    await attempt("peer-test", `volley/${NS}/some-agent/mailbox`, mailbox);
    expect(await delivered(own)).toBe(true);
    expect(seen).not.toContain(other);
    expect(seen).not.toContain(ownVerdict);
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

  it("a token login writes only its own redeem topic; nobody else writes it", async () => {
    const redeem = probe("token-redeem");
    const otherToken = probe("token-as-other-token");
    const tokenMailbox = probe("token-mailbox");
    const tokenStatus = probe("token-own-status");
    const tokenRegistry = probe("token-registry");
    const tokenLease = probe("token-lease");
    const steerRedeem = probe("steer-redeem");
    await attempt("0000abcd", tokenRedeemTopic("0000abcd"), redeem);
    await attempt("0000abcd", tokenRedeemTopic("0000beef"), otherToken);
    await attempt("0000abcd", `volley/${NS}/some-agent/mailbox`, tokenMailbox);
    // The shared %u patterns would grant these; the token block denies the whole tree.
    await attempt("0000abcd", `volley/${NS}/0000abcd/status`, tokenStatus);
    await attempt("0000abcd", "volley/_system/registry/0000abcd", tokenRegistry);
    await attempt("0000abcd", "volley/_system/leases/gpu/requests", tokenLease);
    await attempt("steer-test", tokenRedeemTopic("0000abcd"), steerRedeem);
    expect(await delivered(redeem)).toBe(true);
    for (const p of [
      otherToken,
      tokenMailbox,
      tokenStatus,
      tokenRegistry,
      tokenLease,
      steerRedeem,
    ]) {
      expect(seen, p).not.toContain(p);
    }
  });

  it("a token login reads only its own reply topic: not volley/#, not another token's", async () => {
    const c = await connectAs("0000abcd");
    clients.push(c);
    const got: string[] = [];
    // Dynamic Security refuses the subscription itself (acl_file used to accept it and filter).
    for (const filter of ["#", "volley/#", "volley-auth/redeem/+/reply"]) {
      await expect(c.subscribeStream(filter, () => {})).rejects.toThrow(/subscribe failed/);
    }
    await c.subscribeStream(tokenReplyTopic("0000abcd"), (m) => got.push(m.payload));
    const tree = probe("tree-status");
    const otherReply = probe("other-token-reply");
    const otherRequest = probe("other-token-request");
    const ownReply = probe("own-reply");
    await attempt("volleyd", `volley/${NS}/some-agent/status`, tree);
    await attempt("volleyd", tokenReplyTopic("0000beef"), otherReply);
    await attempt("volleyd", tokenRedeemTopic("0000beef"), otherRequest);
    await attempt("volleyd", tokenReplyTopic("0000abcd"), ownReply);
    for (let i = 0; i < 40 && !got.includes(ownReply); i++) {
      // broker round-trip: delivery through the real mosquitto to the reply subscriber.
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(got).toEqual([ownReply]);
  });

  it("nobody but volleyd writes a token's reply topic", async () => {
    const forged = probe("forged-token-reply");
    for (const who of ["admin-test", "steer-test", "supervisor-test", "0000abcd"]) {
      await attempt(who, tokenReplyTopic("0000abcd"), forged);
    }
    // broker round-trip: an ACL-denied publish is dropped silently; give a delivery time to show.
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).not.toContain(forged);
  });

  it("a supervisor account writes the tree but cannot impersonate an admin", async () => {
    const own = probe("supervisor-own");
    const asAdmin = probe("supervisor-as-admin");
    await attempt("supervisor-test", `volley/${NS}/some-agent/mailbox`, own);
    await attempt("supervisor-test", authOpsTopic("admin-test"), asAdmin);
    expect(await delivered(own)).toBe(true);
    expect(seen).not.toContain(asAdmin);
  });

  it("only the fixed volleyd identity writes an answer on the reply topic", async () => {
    const forged = probe("forged-reply");
    await attempt("admin-test", "volley/_system/auth/replies/0a4f3e7c-8b21", forged);
    await attempt("steer-test", "volley/_system/auth/replies/0a4f3e7c-8b21", forged);
    await attempt("supervisor-test", "volley/_system/auth/replies/0a4f3e7c-8b21", forged);
    // broker round-trip: an ACL-denied publish is dropped silently; give a delivery time to show.
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).not.toContain(forged);
  });
});
