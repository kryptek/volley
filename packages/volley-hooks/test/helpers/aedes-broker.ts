import { createServer } from "node:net";
import Aedes from "aedes";

export interface TestBroker {
  url: string;
  port: number;
  /** Client connections the broker has accepted so far. */
  connections: () => number;
  close: () => Promise<void>;
}

/** Start an in-process Aedes MQTT broker on an OS-assigned free port. */
export async function startTestBroker(): Promise<TestBroker> {
  const aedes = new Aedes();
  let connections = 0;
  aedes.on("client", () => {
    connections++;
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
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}
