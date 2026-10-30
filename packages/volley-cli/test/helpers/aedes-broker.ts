import { createServer } from "node:net";
import Aedes from "aedes";

export interface TestBroker {
  url: string;
  port: number;
  /** The broker itself, for a test that needs its hooks or its clients. */
  aedes: Aedes;
  close: () => Promise<void>;
}

export interface TestBrokerOptions {
  /** When set, CONNECTs must carry exactly these credentials; anything else gets CONNACK 4. */
  credentials?: { username: string; password: string };
}

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
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}
