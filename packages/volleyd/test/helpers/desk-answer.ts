import { randomUUID } from "node:crypto";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../../src/accounts";
import { fakeExec } from "./fake-exec";

/** `volley auth list` knows admin-1 (admin), steer-1 (steer) and watch-1 (watch). */
export const deskAccounts = () =>
  fakeExec().on(["volley", "auth", "list"], {
    stdout: JSON.stringify({
      accounts: [
        { name: "admin-1", role: "admin", kind: "human", created: "2026-10-19T09:00:00.000Z" },
        { name: "steer-1", role: "steer", kind: "device", created: "2026-10-19T09:00:00.000Z" },
        { name: "watch-1", role: "watch", kind: "device", created: "2026-10-19T09:00:00.000Z" },
      ],
    }),
  });

/**
 * `op` (inbox_answer, resolve) from Desk login `user` on its own account-op topic, where the
 * broker names the sender: volleyd's ack payload from the reply topic.
 */
export async function deskAnswer(
  url: string,
  user: string,
  fields: Record<string, unknown>,
  op = "inbox_answer",
): Promise<Record<string, unknown>> {
  const desk = new VolleyBroker();
  await desk.connect({ url, agentId: `desk-test-${randomUUID().slice(0, 6)}` });
  try {
    const cid = randomUUID();
    let resolve!: (p: Record<string, unknown>) => void;
    const reply = new Promise<Record<string, unknown>>((r) => {
      resolve = r;
    });
    await desk.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const e = parseEnvelope(raw);
      if (e?.type === "ack" && e.correlation_id === cid)
        resolve(e.payload as Record<string, unknown>);
    });
    const env = buildEnvelope({
      agentId: user,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload: { op, ...fields },
    });
    await desk.publish(authOpsTopic(user), JSON.stringify(env), { qos: 1, retain: false });
    return await reply;
  } finally {
    await desk.disconnect();
  }
}
