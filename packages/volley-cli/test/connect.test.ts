import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { list } from "../src/commands/list";
import { MOSQUITTO_INSTALL_HINT, connectAsClient, connectToSupervisor } from "../src/connect";
import { makeBufferIO } from "../src/io";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { tempDir } from "./helpers/tmp";

describe("connectAsClient", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects to a reachable broker and returns the live broker", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io);
    if (broker === null) throw new Error("expected a connected broker, got null");
    expect(broker.connected).toBe(true);
    await broker.disconnect();
    expect(io.readStderr()).toBe(""); // success path is silent
  });

  it("on an unreachable broker, prints a stderr hint and returns null (does NOT throw; reconnects use it)", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient("mqtt://127.0.0.1:1", io);
    expect(broker).toBeNull();
    expect(io.readStderr()).toContain("cannot connect to broker");
    expect(io.readStderr()).toContain(MOSQUITTO_INSTALL_HINT);
  });
});

describe("connectAsClient against a broker that requires credentials", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker({ credentials: { username: "desk", password: "right" } });
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects with the given credentials", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io, { username: "desk", password: "right" });
    if (broker === null) throw new Error(`expected a connected broker: ${io.readStderr()}`);
    await broker.disconnect();
  });

  it("on refused credentials, prints AUTH_FAILED with the volley auth hint (not the install hint)", async () => {
    const io = makeBufferIO();
    const broker = await connectAsClient(tb.url, io, { username: "desk", password: "wrong" });
    expect(broker).toBeNull();
    expect(io.readStderr()).toContain('refused the credentials for user "desk"');
    expect(io.readStderr()).toContain("volley auth init");
    expect(io.readStderr()).not.toContain(MOSQUITTO_INSTALL_HINT);
  });
});

/** A loopback port nothing listens on (bound once, then closed). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("connectToSupervisor: the unreachable-supervisor diagnosis", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers = [];
  });
  /** A loopback port that accepts connections (the stand-in for github.com:443). */
  async function openPort(): Promise<number> {
    const s = createServer((c) => c.destroy());
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    return (s.address() as { port: number }).port;
  }
  /** A paired machine's home: peer.json's tunnel port, nothing listening on it. */
  async function peerHome() {
    const root = tempDir("volley-reach-peer-");
    const port = await closedPort();
    const home = join(root, "home");
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(
      join(home, ".volley", "peer.json"),
      JSON.stringify({ name: "box", remote_port: port }),
    );
    return {
      port,
      env: {
        HOME: home,
        VOLLEYD_HOME: join(root, "volleyd"),
        VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${port}`,
        VOLLEY_INTERNET_PROBE: `127.0.0.1:${await openPort()}`,
      },
    };
  }

  it("a machine with no setup and no broker on loopback: 69, no_broker_here, the install hint", async () => {
    const root = tempDir("volley-reach-other-");
    const io = makeBufferIO();
    const r = await connectToSupervisor("mqtt://127.0.0.1:1", io, null, {
      command: "volley pub",
      env: { HOME: join(root, "home"), VOLLEYD_HOME: join(root, "volleyd") },
    });
    expect(r).toBe(69);
    expect(io.readStderr()).toMatch(/^volley pub: supervisor unreachable \(no_broker_here\): /);
    expect(io.readStderr()).toContain(`  fix: ${MOSQUITTO_INSTALL_HINT}`);
  });

  it("refused credentials stay exit 1 with the volley auth hint (no diagnosis)", async () => {
    const tb = await startTestBroker({ credentials: { username: "desk", password: "right" } });
    try {
      const io = makeBufferIO();
      const r = await connectToSupervisor(
        tb.url,
        io,
        { username: "desk", password: "wrong" },
        { command: "volley pub", env: {} },
      );
      expect(r).toBe(1);
      expect(io.readStderr()).toContain("volley auth init");
      expect(io.readStderr()).not.toContain("supervisor unreachable");
    } finally {
      await tb.close();
    }
  });

  it("volley list on a peer whose tunnel is down: 69 and the tunnel_down text with the port", async () => {
    const { port, env } = await peerHome();
    const io = makeBufferIO();
    const exit = await list({ argv: [], env, io });
    expect(exit).toBe(69);
    expect(io.readStderr()).toContain(
      `volley list: supervisor unreachable (tunnel_down): This machine's tunnel to the broker is down (\`127.0.0.1:${port}\` refuses). \`volley peer doctor\` shows why;`,
    );
    expect(io.readStderr()).toContain("\n  fix: `volley peer doctor`");
    expect(io.readStdout()).toBe("");
  });

  it("volley list --json on that peer: the SUPERVISOR_UNREACHABLE object on stdout", async () => {
    const { port, env } = await peerHome();
    const io = makeBufferIO();
    expect(await list({ argv: ["--json"], env, io })).toBe(69);
    expect(JSON.parse(io.readStdout())).toEqual({
      error: "SUPERVISOR_UNREACHABLE",
      reason: "tunnel_down",
      cause: expect.stringContaining(`127.0.0.1:${port}`),
      fix: expect.stringContaining("volley peer doctor"),
      where: {
        kind: "peer",
        machine: "box",
        brokerUrl: `mqtt://127.0.0.1:${port}`,
        tunnelPort: port,
      },
      probes: {
        internet: true,
        network: "unknown",
        tunnel: "down",
        broker: "up",
        daemon: "unknown",
      },
    });
  });
});
