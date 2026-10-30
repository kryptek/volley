import { createServer } from "node:net";
import Aedes from "aedes";

export interface TestBroker {
  url: string;
  port: number;
  /** The broker itself, for a test that needs its hooks or its clients. */
  aedes: Aedes;
  /** Close a connected client from the broker side (a broker restart or network drop). */
  dropClient: (clientId: string) => boolean;
  /**
   * Stop serving a connected client without closing its socket (a broker that stopped reading):
   * nothing it sends is read or answered, and the broker's own keepalive never closes it.
   */
  stallClient: (clientId: string) => boolean;
  /** The number of clients connected right now. */
  connectedClients: () => number;
  close: () => Promise<void>;
}

export interface TestBrokerOptions {
  /** When set, CONNECTs must carry exactly these credentials; anything else gets CONNACK 4. */
  credentials?: { username: string; password: string };
}

/** Aedes's live client map; its typings omit it and the per-client internals used here. */
interface LiveClient {
  close(): void;
  conn: { removeAllListeners(event: string): void };
  _keepaliveTimer: { clear(): void } | null;
}
const liveClients = (aedes: Aedes): Record<string, LiveClient> =>
  (aedes as unknown as { clients: Record<string, LiveClient> }).clients;

/** Start an in-process Aedes MQTT broker on an OS-assigned free port. */
export async function startTestBroker(opts: TestBrokerOptions = {}): Promise<TestBroker> {
  const aedes = new Aedes();
  const creds = opts.credentials;
  if (creds !== undefined) {
    aedes.authenticate = (_client, username, password, done) => {
      if (username === creds.username && password?.toString() === creds.password) {
        done(null, true);
        return;
      }
      // returnCode 4 = "bad user name or password" (MQTT 3.1.1 CONNACK).
      done(Object.assign(new Error("bad credentials"), { returnCode: 4 }) as never, false);
    };
  }
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
    aedes,
    dropClient: (clientId) => {
      const client = liveClients(aedes)[clientId];
      client?.close();
      return client !== undefined;
    },
    stallClient: (clientId) => {
      const client = liveClients(aedes)[clientId];
      if (client === undefined) return false;
      client._keepaliveTimer?.clear();
      client._keepaliveTimer = null;
      client.conn.removeAllListeners("readable");
      return true;
    },
    connectedClients: () => aedes.connectedClients,
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}
