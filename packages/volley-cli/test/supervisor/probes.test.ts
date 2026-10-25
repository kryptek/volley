import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import {
  type Probes,
  type TcpProbe,
  brokerUp,
  climb,
  daemonLive,
  internetUp,
  networkUp,
  tcpProbe,
  tunnelUp,
  whereAmI,
} from "../../src/supervisor/probes";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { tempDir } from "../helpers/tmp";

/** A loopback port nothing listens on (bound once, then closed). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let servers: Server[] = [];
let brokers: TestBroker[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const b of brokers) await b.close();
  servers = [];
  brokers = [];
});

async function openPort(): Promise<number> {
  const s = createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return (s.address() as { port: number }).port;
}

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "box.example.ts.net." },
});
const NEEDS_LOGIN = JSON.stringify({ BackendState: "NeedsLogin", Self: {} });

describe("internetUp", () => {
  it("connects to github.com:443 with a two-second bound", async () => {
    const calls: [string, number, number][] = [];
    const tcp: TcpProbe = async (host, port, ms) => {
      calls.push([host, port, ms]);
      return "open";
    };
    expect(await internetUp({ tcp })).toBe(true);
    expect(calls).toEqual([["github.com", 443, 2000]]);
  });

  it("a refusal or no answer is offline", async () => {
    expect(await internetUp({ tcp: async () => "refused" })).toBe(false);
    expect(await internetUp({ tcp: async () => "none" })).toBe(false);
  });

  it("VOLLEY_INTERNET_PROBE names another host:port", async () => {
    const port = await openPort();
    expect(await internetUp({ env: { VOLLEY_INTERNET_PROBE: `127.0.0.1:${port}` } })).toBe(true);
    const shut = await closedPort();
    expect(await internetUp({ env: { VOLLEY_INTERNET_PROBE: `127.0.0.1:${shut}` } })).toBe(false);
  });
});

describe("networkUp", () => {
  it("tailscale: Running is up, NeedsLogin or not installed is down (5 s bound)", async () => {
    const seen: [string[], number][] = [];
    const exec =
      (stdout: string, code = 0) =>
      async (argv: string[], ms: number) => {
        seen.push([argv, ms]);
        return { code, stdout };
      };
    const ts = { kind: "tailscale" as const, name: "box.example.ts.net" };
    expect(await networkUp(ts, { port: 1883, exec: exec(RUNNING) })).toBe("up");
    expect(await networkUp(ts, { port: 1883, exec: exec(NEEDS_LOGIN) })).toBe("down");
    expect(await networkUp(ts, { port: 1883, exec: exec("", 127) })).toBe("down");
    expect(seen[0]).toEqual([["tailscale", "status", "--json"], 5000]);
  });

  it("manual: an address that answers (even with a refusal) is up; one that does not is down", async () => {
    const shut = await closedPort();
    const manual = { kind: "manual" as const, address: "127.0.0.1" };
    expect(await networkUp(manual, { port: shut })).toBe("up");
    expect(await networkUp(manual, { port: await openPort() })).toBe("up");
    expect(await networkUp(manual, { port: 1883, tcp: async () => "none" })).toBe("down");
  });

  it("none, or no record: unknown", async () => {
    expect(await networkUp({ kind: "none" }, { port: 1883 })).toBe("unknown");
    expect(await networkUp(null, { port: 1883 })).toBe("unknown");
  });
});

describe("tunnelUp", () => {
  it("a closed port is down within two seconds", async () => {
    const started = Date.now();
    expect(await tunnelUp(await closedPort())).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an open port is up", async () => {
    expect(await tunnelUp(await openPort())).toBe(true);
  });
});

describe("tcpProbe", () => {
  it("tells open from refused", async () => {
    expect(await tcpProbe("127.0.0.1", await openPort(), 1000)).toBe("open");
    expect(await tcpProbe("127.0.0.1", await closedPort(), 1000)).toBe("refused");
  });
});

describe("brokerUp and daemonLive against an Aedes broker", () => {
  it("brokerUp: the broker's port answers; a closed one does not", async () => {
    const tb = await startTestBroker();
    brokers.push(tb);
    expect(await brokerUp(tb.url)).toBe(true);
    expect(await brokerUp(`mqtt://127.0.0.1:${await closedPort()}`)).toBe(false);
  });

  it("daemonLive: false without a retained status, true with a live one, false for a stopped one", async () => {
    const tb = await startTestBroker();
    brokers.push(tb);
    expect(await daemonLive(tb.url, null, { timeoutMs: 300 })).toBe(false);
    const pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "volleyd" });
    const status = (type: string) =>
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "status",
          type,
          payload: {},
        }),
      );
    await pub.publish("volley/default/volleyd/status", status("working"), {
      qos: 1,
      retain: true,
    });
    expect(await daemonLive(tb.url, null, { timeoutMs: 2000 })).toBe(true);
    await pub.publish("volley/default/volleyd/status", status("done"), { qos: 1, retain: true });
    expect(await daemonLive(tb.url, null, { timeoutMs: 2000 })).toBe(false);
    await pub.disconnect();
  });

  it("daemonLive: false when the broker does not answer", async () => {
    expect(
      await daemonLive(`mqtt://127.0.0.1:${await closedPort()}`, null, { timeoutMs: 500 }),
    ).toBe(false);
  });
});

describe("whereAmI", () => {
  it("a peer home: peer.json's name and tunnel port, setup.json's network", () => {
    const home = tempDir("volley-where-peer-");
    mkdirSync(join(home, ".volley", "volleyd"), { recursive: true });
    writeFileSync(
      join(home, ".volley", "peer.json"),
      JSON.stringify({ name: "box", remote_port: 21883 }),
    );
    writeFileSync(
      join(home, ".volley", "volleyd", "setup.json"),
      JSON.stringify({ network: { kind: "tailscale", name: "box.example.ts.net" } }),
    );
    expect(whereAmI(home, {}, "mqtt://127.0.0.1:21883")).toEqual({
      kind: "peer",
      machine: "box",
      brokerUrl: "mqtt://127.0.0.1:21883",
      tunnelPort: 21883,
      network: { kind: "tailscale", name: "box.example.ts.net" },
    });
  });

  it("a peer with tunnel: none has no tunnel port", () => {
    const home = tempDir("volley-where-peer-none-");
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(
      join(home, ".volley", "peer.json"),
      JSON.stringify({ name: "box", remote_port: 1883, tunnel: "none" }),
    );
    expect(whereAmI(home, {}, "mqtt://127.0.0.1:1883").tunnelPort).toBeUndefined();
  });

  it("a supervisor home: setup.json with a layout", () => {
    const home = tempDir("volley-where-sup-");
    mkdirSync(join(home, ".volley", "volleyd"), { recursive: true });
    writeFileSync(
      join(home, ".volley", "volleyd", "setup.json"),
      JSON.stringify({
        layout: "etc",
        config: "/path/to/mosquitto.conf",
        state_file: "/path/to/dynamic-security.json",
        auth_dir: "/path/to/auth",
      }),
    );
    expect(whereAmI(home, {}, "mqtt://localhost:1883").kind).toBe("supervisor");
  });

  it("a coordinator env", () => {
    const home = tempDir("volley-where-coord-");
    const env = { VOLLEY_AGENT_ID: "coordinator", VOLLEY_BROKER_URL: "mqtt://192.0.2.10:1883" };
    expect(whereAmI(home, env, "mqtt://192.0.2.10:1883")).toEqual({
      kind: "coordinator",
      brokerUrl: "mqtt://192.0.2.10:1883",
    });
  });

  it("nothing: other", () => {
    expect(whereAmI(tempDir("volley-where-none-"), {}, "mqtt://localhost:1883").kind).toBe("other");
  });
});

describe("climb", () => {
  /** Every rung up unless `down` names it; `asked` is the order the ladder asked in. */
  const probes = (down: string[] = []): Probes & { asked: string[] } => {
    const asked: string[] = [];
    const rung = (name: string) => {
      asked.push(name);
      return !down.includes(name);
    };
    return {
      asked,
      internetUp: async () => rung("internet"),
      networkUp: async () => (rung("network") ? "up" : "down"),
      tunnelUp: async () => rung("tunnel"),
      brokerUp: async () => rung("broker"),
      daemonLive: async () => rung("daemon"),
    };
  };
  const peer = { kind: "peer" as const, brokerUrl: "mqtt://127.0.0.1:21883", tunnelPort: 21883 };

  it("stops at the first failing rung", async () => {
    const p = probes(["internet"]);
    const r = await climb(peer, p, { askDaemon: true });
    expect(r.internet).toBe(false);
    expect(p.asked).toEqual(["internet"]);
  });

  it("a peer's tunnel: down after internet and network", async () => {
    const p = probes(["tunnel"]);
    const r = await climb(peer, p, { askDaemon: true });
    expect(r).toMatchObject({ internet: true, network: "up", tunnel: "down" });
    expect(p.asked).toEqual(["internet", "network", "tunnel"]);
  });

  it("a broker on this machine's loopback with no tunnel skips the internet and the network", async () => {
    const p = probes(["broker"]);
    const r = await climb({ kind: "supervisor", brokerUrl: "mqtt://localhost:1883" }, p);
    expect(r).toMatchObject({ internet: true, network: "unknown", tunnel: "none", broker: "down" });
    expect(p.asked).toEqual(["broker"]);
  });

  it("asks the daemon only when asked to", async () => {
    const p = probes();
    expect((await climb(peer, p)).daemon).toBe("unknown");
    const q = probes(["daemon"]);
    expect((await climb(peer, q, { askDaemon: true })).daemon).toBe("silent");
  });
});
