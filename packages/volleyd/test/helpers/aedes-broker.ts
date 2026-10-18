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
 * code 4, like `allow_anonymous false` in mosquitto).
 */
export async function startTestBroker(
  opts: { users?: Record<string, string> } = {},
): Promise<TestBroker> {
  const users = opts.users;
  const aedes = new Aedes(
    users === undefined
      ? {}
      : {
          authenticate: (_client, username, password, done) => {
            const ok =
              username !== undefined &&
              Object.hasOwn(users, username) &&
              password?.toString() === users[username];
            if (ok) return done(null, true);
            const err = Object.assign(new Error("bad username or password"), {
              returnCode: 4 as const,
            });
            done(err, null);
          },
        },
  );
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
