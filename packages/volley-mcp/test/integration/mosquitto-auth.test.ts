import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "../../src/broker";
import { shutdownLifecycle, startLifecycle } from "../../src/lifecycle";

// Opt-in: needs a mosquitto started with mosquitto-auth.conf (see its header for
// the local recipe). The plain integration job leaves VOLLEY_AUTH_BROKER_URL unset.
const URL = process.env.VOLLEY_AUTH_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && URL !== undefined;
const BROKER_URL = URL ?? "mqtt://localhost:1884";

const AGENT = "w1-t1-implementer-1";
const OTHER = "w1-t2-implementer-1";
/** Fresh namespace per run so retained leftovers from an earlier run never satisfy an assertion. */
const NS = `authit-${randomBytes(3).toString("hex")}`;

async function connectAs(username: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: BROKER_URL,
    agentId: `authit-${username}`,
    username,
    password: `${username}-test-pw`,
  });
  return b;
}

describe.skipIf(!RUN)("broker auth + ACLs against real mosquitto", () => {
  let observer: VolleyBroker;
  let stop: () => Promise<void>;
  const seen: { topic: string; payload: string }[] = [];
  const retained = new Set<string>();

  /** Publish as `who`; a denied QoS 1 publish may be rejected (v5) or silently dropped (3.1.1). */
  async function attempt(who: VolleyBroker, topic: string, payload: string, retain = false) {
    if (retain) retained.add(topic);
    await who.publish(topic, payload, { qos: 1, retain }).catch(() => {});
  }

  /** Did the observer (volleyd: reads everything) receive `payload`? Waits briefly for delivery. */
  async function delivered(payload: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      if (seen.some((m) => m.payload === payload)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  beforeAll(async () => {
    observer = await connectAs("volleyd");
    stop = await observer.subscribeStream("volley/#", (m) => seen.push(m));
  });

  afterAll(async () => {
    if (!observer) return;
    await stop();
    // Clear every retained value this run may have left behind.
    for (const topic of retained) await observer.publish(topic, "", { qos: 1, retain: true });
    await observer.disconnect();
  });

  it("refuses an anonymous connect with AUTH_FAILED", async () => {
    await expect(
      new VolleyBroker().connect({ url: BROKER_URL, agentId: "anon" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses a wrong password with AUTH_FAILED", async () => {
    const b = new VolleyBroker();
    await expect(
      b.connect({ url: BROKER_URL, agentId: "x", username: "desk", password: "nope" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("an agent writes its own channels but not another agent's mailbox", async () => {
    const agent = await connectAs(AGENT);
    try {
      await attempt(agent, `volley/${NS}/${AGENT}/status`, "own-status", true);
      await attempt(agent, `volley/${NS}/${AGENT}/progress`, "own-progress");
      await attempt(agent, "volley/_system/leases/build/requests", "lease-request");
      await attempt(agent, `volley/${NS}/${OTHER}/mailbox`, "agent-steers-other");
      await attempt(agent, `volley/${NS}/${OTHER}/status`, "agent-forges-status", true);
      await attempt(agent, `volley/_system/registry/${OTHER}`, "agent-forges-registry", true);
      await attempt(agent, "volley/_waves/w1/state", "agent-writes-wave", true);
      await attempt(agent, "volley/_waves/_config", "agent-writes-config", true);

      expect(await delivered("own-status")).toBe(true);
      expect(await delivered("own-progress")).toBe(true);
      expect(await delivered("lease-request")).toBe(true);
      expect(await delivered("agent-steers-other")).toBe(false);
      expect(await delivered("agent-forges-status")).toBe(false);
      expect(await delivered("agent-forges-registry")).toBe(false);
      expect(await delivered("agent-writes-wave")).toBe(false);
      expect(await delivered("agent-writes-config")).toBe(false);
    } finally {
      await agent.disconnect();
    }
  });

  it("an agent can run the full MCP lifecycle (LWT + spawning + registry) as itself", async () => {
    const state = await startLifecycle({
      brokerUrl: BROKER_URL,
      namespace: NS,
      agentId: AGENT,
      parentId: null,
      auth: { username: AGENT, password: `${AGENT}-test-pw` },
    });
    retained.add(`volley/${NS}/${AGENT}/status`);
    retained.add(`volley/_system/registry/${AGENT}`);
    try {
      const reg = await observer.queryRetained(`volley/_system/registry/${AGENT}`, 1000);
      expect(reg).not.toBeNull();
      expect(JSON.parse(reg ?? "{}").agent_id).toBe(AGENT);
    } finally {
      await shutdownLifecycle(state, "done");
    }
  });

  it("the desk steers any agent and the daemon, but cannot write _waves/_config", async () => {
    const desk = await connectAs("desk");
    try {
      await attempt(desk, `volley/${NS}/${AGENT}/mailbox`, "desk-steers-agent");
      await attempt(desk, `volley/${NS}/volleyd/mailbox`, "desk-config-set-request");
      await attempt(desk, "volley/_waves/_config", "desk-writes-config", true);
      await attempt(desk, `volley/${NS}/${AGENT}/status`, "desk-forges-status", true);

      expect(await delivered("desk-steers-agent")).toBe(true);
      expect(await delivered("desk-config-set-request")).toBe(true);
      expect(await delivered("desk-writes-config")).toBe(false);
      expect(await delivered("desk-forges-status")).toBe(false);
    } finally {
      await desk.disconnect();
    }
  });

  it("a coordinator steers and runs its own random-suffixed agent, but cannot write _waves/*", async () => {
    const coord = await connectAs("coordinator");
    try {
      await attempt(coord, `volley/${NS}/${AGENT}/mailbox`, "coordinator-steers-agent");
      await attempt(coord, `volley/${NS}/coordinator-ab12/status`, "coordinator-status", true);
      await attempt(
        coord,
        "volley/_system/registry/coordinator-ab12",
        "coordinator-registry",
        true,
      );
      await attempt(coord, "volley/_waves/w1/state", "coordinator-writes-wave", true);
      await attempt(coord, "volley/_waves/_config", "coordinator-writes-config", true);

      expect(await delivered("coordinator-steers-agent")).toBe(true);
      expect(await delivered("coordinator-status")).toBe(true);
      expect(await delivered("coordinator-registry")).toBe(true);
      expect(await delivered("coordinator-writes-wave")).toBe(false);
      expect(await delivered("coordinator-writes-config")).toBe(false);
    } finally {
      await coord.disconnect();
    }
  });

  it("volleyd writes _waves/_config", async () => {
    await attempt(observer, "volley/_waves/_config", "volleyd-writes-config", true);
    expect(await delivered("volleyd-writes-config")).toBe(true);
  });
});
