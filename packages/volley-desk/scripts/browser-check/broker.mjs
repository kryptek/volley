// A private in-process MQTT broker for the browser checks: MQTT over TCP and over WebSocket,
// on 127.0.0.1 only. Run it with bun (its WebSocket listener is Bun.serve):
//   bun broker.mjs <mqtt port> <ws port> [pace ms]
// `pace` delays each frame sent to a WebSocket client by that many ms, as a remote Desk's
// network does: a localhost broker delivers a whole retained replay inside one 16 ms flush,
// which hides first-load bugs. Never point the checks at a shared broker.
import { createServer } from "node:net";
import { Duplex } from "node:stream";
import Aedes from "aedes";

const [mqttPort, wsPort, pace = 0] = process.argv.slice(2).map(Number);
if (!mqttPort || !wsPort) {
  console.error("usage: bun broker.mjs <mqtt port> <ws port> [pace ms]");
  process.exit(2);
}
const aedes = (await Aedes.createBroker?.()) ?? new Aedes();
createServer(aedes.handle).listen(mqttPort, "127.0.0.1");

Bun.serve({
  hostname: "127.0.0.1",
  port: wsPort,
  fetch(req, server) {
    const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim() ?? "mqtt";
    if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": protocol } })) return;
    return new Response("MQTT over WebSocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      let chain = Promise.resolve();
      const send = (chunk) => {
        if (ws.readyState === 1) ws.sendBinary(chunk);
      };
      const stream = new Duplex({
        read() {},
        write(chunk, _enc, cb) {
          if (pace > 0) chain = chain.then(() => new Promise((r) => setTimeout(r, pace)));
          chain = chain.then(() => send(chunk));
          cb();
        },
        final(cb) {
          chain.then(() => ws.close());
          cb();
        },
      });
      ws.data = stream;
      aedes.handle(stream);
    },
    message(ws, data) {
      ws.data.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
    },
    close(ws) {
      ws.data.push(null);
      ws.data.destroy();
    },
  },
});
console.log(`broker mqtt://127.0.0.1:${mqttPort} ws://127.0.0.1:${wsPort} pace ${pace} ms`);
