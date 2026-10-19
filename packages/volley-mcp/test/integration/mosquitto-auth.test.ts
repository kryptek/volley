import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "../../src/broker";
import { parseEnvelope } from "../../src/envelope";
import { shutdownLifecycle, startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volSendMailbox } from "../../src/tools/send-mailbox";

// Opt-in: needs a PRIVATE mosquitto 2.1 bootstrapped by volley-cli's
// test/integration/dynsec-fixture.ts (Volley's shared Dynamic Security roles; each password is
// "<username>-test-pw"). The plain integration job leaves VOLLEY_AUTH_BROKER_URL unset.
const URL = process.env.VOLLEY_AUTH_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && URL !== undefined;
const BROKER_URL = URL ?? "mqtt://localhost:1884";

const AGENT = "w1-t1-implementer-1";
const OTHER = "w1-t2-implementer-1";
/** A steering sender whose mailbox the shared agent role lets AGENT ack: a fixed identity. */
const PARENT = "desk";
/** A coordinator session's random-suffixed id: no static role rule can name its mailbox. */
const COORDINATOR = "coordinator-ab12";
/** Fresh namespace per run so retained leftovers from an earlier run never satisfy an assertion. */
const NS = `authit-${randomBytes(3).toString("hex")}`;
/** Run-unique wave id, so no probe can touch a real wave's retained state. */
const WAVE = `w-${NS}`;
const CONFIG = "volley/_waves/_config";

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

describe.skipIf(!RUN)(
  "broker auth + shared Dynamic Security roles against real mosquitto 2.1",
  () => {
    let observer: VolleyBroker;
    let stop: () => Promise<void>;
    const seen: { topic: string; payload: string }[] = [];
    const retained = new Set<string>();
    /** `_waves/_config` as it was before this run; restored (not cleared) afterwards. */
    let savedConfig: string | null = null;

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
      savedConfig = await observer.queryRetained(CONFIG, 500);
      stop = await observer.subscribeStream("volley/#", (m) => seen.push(m));
    });

    afterAll(async () => {
      if (!observer) return;
      await stop();
      // Clear every retained value this run may have left behind, and put _config back.
      retained.delete(CONFIG);
      for (const topic of retained) await observer.publish(topic, "", { qos: 1, retain: true });
      await observer.publish(CONFIG, savedConfig ?? "", { qos: 1, retain: true });
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

    it("maps the MQTT 5 refusal (reason 0x86/0x87) to AUTH_FAILED too", async () => {
      const b = new VolleyBroker();
      await expect(
        b.connect({
          url: BROKER_URL,
          agentId: "x5",
          protocolVersion: 5,
          username: "desk",
          password: "nope",
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await expect(
        new VolleyBroker().connect({ url: BROKER_URL, agentId: "anon5", protocolVersion: 5 }),
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
        await attempt(agent, `volley/_waves/${WAVE}/state`, "agent-writes-wave", true);
        // A wave whose id equals the agent id: the `+` in `volley/+/%u/...` reaches
        // `volley/_waves/<agent>/...`, but no topic SPEC §4.6 defines there is a channel name.
        await attempt(agent, `volley/_waves/${AGENT}/state`, "agent-writes-own-id-wave", true);
        await attempt(agent, `volley/_waves/${AGENT}/events`, "agent-writes-own-id-events");
        await attempt(agent, `volley/_waves/${AGENT}/decisions/d1`, "agent-opens-decision", true);
        await attempt(agent, "volley/_system/leases/build", "agent-writes-pool", true);
        await attempt(agent, CONFIG, "agent-writes-config", true);

        expect(await delivered("own-status")).toBe(true);
        expect(await delivered("own-progress")).toBe(true);
        expect(await delivered("lease-request")).toBe(true);
        expect(await delivered("agent-steers-other")).toBe(false);
        expect(await delivered("agent-forges-status")).toBe(false);
        expect(await delivered("agent-forges-registry")).toBe(false);
        expect(await delivered("agent-writes-wave")).toBe(false);
        expect(await delivered("agent-writes-own-id-wave")).toBe(false);
        expect(await delivered("agent-writes-own-id-events")).toBe(false);
        expect(await delivered("agent-opens-decision")).toBe(false);
        expect(await delivered("agent-writes-pool")).toBe(false);
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
        await attempt(desk, CONFIG, "desk-writes-config", true);
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
        await attempt(coord, `volley/_waves/${WAVE}/state`, "coordinator-writes-wave", true);
        await attempt(coord, CONFIG, "coordinator-writes-config", true);

        expect(await delivered("coordinator-steers-agent")).toBe(true);
        expect(await delivered("coordinator-status")).toBe(true);
        expect(await delivered("coordinator-registry")).toBe(true);
        expect(await delivered("coordinator-writes-wave")).toBe(false);
        expect(await delivered("coordinator-writes-config")).toBe(false);
      } finally {
        await coord.disconnect();
      }
    });

    it("an agent acks the desk's message end-to-end; a coordinator's ack is dropped (SPEC §4.4)", async () => {
      const start = (agentId: string, username: string, parentId: string | null) =>
        startLifecycle({
          brokerUrl: BROKER_URL,
          namespace: NS,
          agentId,
          parentId,
          auth: { username, password: `${username}-test-pw` },
        });
      const states: ServerState[] = [];
      try {
        const coord = await start(PARENT, "desk", null);
        states.push(coord);
        const stranger = await start(COORDINATOR, "coordinator", null);
        states.push(stranger);
        const agent = await start(AGENT, AGENT, PARENT);
        states.push(agent);
        for (const id of [PARENT, COORDINATOR, AGENT]) {
          retained.add(`volley/${NS}/${id}/status`);
          retained.add(`volley/_system/registry/${id}`);
        }

        // The agent acks every non-ack mailbox message, exactly as SPEC §4.4 prescribes:
        // to the sender's mailbox, with the message id as correlation_id.
        const stopAcking = await agent.broker.subscribeStream(
          `volley/${NS}/${AGENT}/mailbox`,
          (m) => {
            const env = parseEnvelope(m.payload);
            if (env === null || env.type === "ack" || typeof env.correlation_id !== "string")
              return;
            void volSendMailbox(agent, {
              to_agent_id: env.agent_id,
              type: "ack",
              payload: { text: "ACKED", acked_type: env.type },
              correlation_id: env.correlation_id,
            }).catch(() => {});
          },
        );
        try {
          const fromParent = await volSendMailbox(coord, {
            to_agent_id: AGENT,
            type: "steering",
            payload: { text: "ack-me" },
            wait_ack_ms: 3000,
          });
          expect(fromParent).toMatchObject({ delivered: true, acked: true, acked_by: AGENT });

          // A random-suffixed coordinator never sees the ack: the static agent role writes only
          // the fixed identities' mailboxes. Pinned so a widened role is a deliberate change.
          const fromStranger = await volSendMailbox(stranger, {
            to_agent_id: AGENT,
            type: "steering",
            payload: { text: "ack-me-too" },
            wait_ack_ms: 750,
          });
          expect(fromStranger).toMatchObject({ delivered: true, acked: false });
        } finally {
          await stopAcking();
        }

        // An agent still cannot write a coordinator's (or another agent's) mailbox.
        const other = await connectAs(OTHER);
        try {
          await attempt(other, `volley/${NS}/${COORDINATOR}/mailbox`, "other-writes-coordinator");
          await attempt(other, `volley/${NS}/${AGENT}/mailbox`, "other-steers-agent");
          expect(await delivered("other-writes-coordinator")).toBe(false);
          expect(await delivered("other-steers-agent")).toBe(false);
        } finally {
          await other.disconnect();
        }
      } finally {
        for (const st of states.reverse()) await shutdownLifecycle(st, "done");
      }
    });

    it("volleyd writes _waves/_config", async () => {
      await attempt(observer, CONFIG, "volleyd-writes-config", true);
      expect(await delivered("volleyd-writes-config")).toBe(true);
    });
  },
);
