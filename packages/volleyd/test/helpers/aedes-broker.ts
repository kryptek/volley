import { createServer } from "node:net";
import Aedes from "aedes";

export interface TestBroker {
  url: string;
  port: number;
  /** Close a connected client from the broker side (a broker restart or network drop). */
  dropClient: (clientId: string) => boolean;
  /** The filters a client is subscribed to right now (SUBSCRIBE minus UNSUBSCRIBE), sorted. */
  subscriptions: (clientId: string) => string[];
  close: () => Promise<void>;
}

/**
 * Start an in-process Aedes MQTT broker on an OS-assigned free port. With `users`, every client
 * must CONNECT with one of those username/password pairs (anything else is refused with return
 * code 4, like `allow_anonymous false` in mosquitto). With `canPublish`, a PUBLISH the predicate
 * refuses for the client's username never reaches a subscriber, like a mosquitto ACL denial
 * (Aedes also closes the publisher's connection; mosquitto drops the message silently).
 *
 * With `overlapSafe`, Aedes's in-memory persistence tolerates a QoS 1 packet a persistent
 * (`clean: false`) client receives once per overlapping subscription (the daemon's
 * `volley/+/+/status` beside an agent's own status topic): Aedes tracks both copies under one
 * queue entry, and when they interleave with the client's acks it cannot find the entry to update
 * ("no such packet") and closes the client. Mosquitto delivers such copies fine; the soak (many
 * agents launched at once) needs this.
 */
export async function startTestBroker(
  opts: {
    users?: Record<string, string>;
    canPublish?: (username: string | undefined, topic: string) => boolean;
    overlapSafe?: boolean;
  } = {},
): Promise<TestBroker> {
  const { users, canPublish } = opts;
  const usernames = new Map<string, string>();
  const aedes = new Aedes({
    ...(canPublish === undefined
      ? {}
      : {
          authorizePublish: (client, packet, done) => {
            if (client === null || canPublish(usernames.get(client.id), packet.topic)) {
              return done(null);
            }
            done(new Error(`ACL: ${packet.topic}`));
          },
        }),
    ...(users === undefined
      ? {}
      : {
          authenticate: (client, username, password, done) => {
            const ok =
              username !== undefined &&
              Object.hasOwn(users, username) &&
              password?.toString() === users[username];
            if (ok) {
              usernames.set(client.id, username);
              return done(null, true);
            }
            const err = Object.assign(new Error("bad username or password"), {
              returnCode: 4 as const,
            });
            done(err, null);
          },
        }),
  });
  if (opts.overlapSafe === true) {
    // Aedes's typings omit its persistence; the callback is (err, client, packet).
    type Cb = (err: Error | null, client: unknown, packet: unknown) => void;
    const p = (aedes as unknown as { persistence: Record<string, unknown> }).persistence;
    const update = (p.outgoingUpdate as (c: unknown, pk: unknown, cb: Cb) => void).bind(p);
    p.outgoingUpdate = (client: unknown, packet: unknown, cb: Cb) =>
      update(client, packet, (err, c, pk) =>
        cb(err?.message === "no such packet" ? null : err, c, pk),
      );
  }
  const subs = new Map<string, Set<string>>();
  aedes.on("subscribe", (subscriptions, client) => {
    const set = subs.get(client.id) ?? new Set<string>();
    for (const sub of subscriptions) set.add(sub.topic);
    subs.set(client.id, set);
  });
  aedes.on("unsubscribe", (unsubscriptions, client) => {
    for (const topic of unsubscriptions) subs.get(client.id)?.delete(topic);
  });
  const server = createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind test broker to a TCP port");
  }
  const port = address.port;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    port,
    dropClient: (clientId) => {
      // Aedes's typings omit its live client map.
      const clients = (aedes as unknown as { clients: Record<string, { close(): void }> }).clients;
      const client = clients[clientId];
      client?.close();
      return client !== undefined;
    },
    subscriptions: (clientId) => [...(subs.get(clientId) ?? [])].sort(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}
