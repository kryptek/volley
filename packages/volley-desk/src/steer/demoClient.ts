/**
 * Demo-mode steering client: no broker. A publish lands in the store as the
 * envelope it is, then the recipient "answers" through the same reducer the
 * live path uses: the hook's ack to the Desk's mailbox, then the model's
 * `steering_acked` (a coordinator: `resumed`). A daemon control request gets
 * an `ok` ack. Timings follow the prototype (1.1 s delivered, 2.6 s acked).
 */
import type { DeskMessage, Envelope } from "../store/types";
import { DAEMON_AGENT_ID, type SteerClient } from "./transport";

export const DEMO_IDENTITY = "desk";
const DELIVER_MS = 1100;
const ACT_MS = 2600;
const CONTROL_MS = 600;

export function createDemoSteerClient(
  apply: (msgs: DeskMessage[]) => void,
  isCoordinator: (agentId: string) => boolean,
  now: () => number = Date.now,
): SteerClient {
  const handlers = new Set<(m: DeskMessage) => void>();
  const emit = (topic: string, envelope: Envelope) => {
    const m: DeskMessage = { topic, envelope, receivedAt: now() };
    apply([m]);
    for (const h of handlers) h(m);
  };
  const reply = (
    from: string,
    ns: string,
    channel: string,
    type: string,
    payload: unknown,
    id: string | null = null,
  ): Envelope => ({
    schema_version: "0.1",
    agent_id: from,
    parent_id: null,
    namespace: ns,
    channel,
    type,
    wall_time: new Date(now()).toISOString(),
    correlation_id: id,
    payload,
  });
  return {
    async publish(topic, payload) {
      const env = JSON.parse(payload) as Envelope;
      const [, ns = "default", to = ""] = topic.split("/");
      const id = env.correlation_id ?? null;
      const self = `volley/${ns}/${env.agent_id}/mailbox`;
      if (to === DAEMON_AGENT_ID) {
        setTimeout(() => {
          emit(self, reply(DAEMON_AGENT_ID, ns, "mailbox", "ack", { text: "ACKED", ok: true }, id));
        }, CONTROL_MS);
        return;
      }
      emit(topic, env);
      setTimeout(() => {
        emit(self, reply(to, ns, "mailbox", "ack", { text: "ACKED", acked_type: env.type }, id));
      }, DELIVER_MS);
      setTimeout(() => {
        const text = String((env.payload as { text?: unknown } | undefined)?.text ?? "");
        emit(
          `volley/${ns}/${to}/progress`,
          isCoordinator(to)
            ? reply(to, ns, "progress", "resumed", { source: "harness-hook" })
            : reply(
                to,
                ns,
                "progress",
                "steering_acked",
                { msg: `Acknowledged: ${text.toLowerCase()}` },
                id,
              ),
        );
      }, ACT_MS);
    },
    onMessage(h) {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
  };
}
