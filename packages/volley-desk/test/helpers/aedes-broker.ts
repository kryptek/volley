import { createServer } from "node:net";
import Aedes from "aedes";

export interface TestBrokerOptions {
  /** When set, CONNECTs must carry exactly these credentials; anything else gets CONNACK 4. */
  credentials?: { username: string; password: string };
}

export interface TestBroker {
  url: string;
  port: number;
  /** Destroy a connected client's socket without a DISCONNECT, as a network drop would. */
  dropClient: (clientId: string) => void;
  close: () => Promise<void>;
}

/**
 * Start an in-process Aedes MQTT broker over TCP on an OS-assigned port.
 *
 * The Desk's production code uses `ws://` (mosquitto's WebSocket listener);
 * the test uses `mqtt://` because the contract we verify here — that
 * mqtt-client subscribes to its topic filters on connect and surfaces incoming
 * messages via `onMessage` — is transport-agnostic at the mqtt.js layer.
 * Matches the volley-mcp test broker exactly.
 */
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
    dropClient: (clientId) => {
      const { clients } = aedes as unknown as {
        clients: Record<string, { conn?: { destroy(): void } }>;
      };
      const c = clients[clientId];
      if (!c?.conn) throw new Error(`no connected client ${clientId}`);
      c.conn.destroy();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}
