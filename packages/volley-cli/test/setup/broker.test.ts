import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateConfig } from "../../src/auth/config";
import {
  LAN_QUESTION,
  anonymousConnectPacket,
  connackOutcome,
  countLiveAgents,
  planDetect,
  planSecurity,
  probeAnonymous,
} from "../../src/setup/broker";
import { unifiedDiff } from "../../src/setup/step";
import { startTestBroker } from "../helpers/aedes-broker";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { ANONYMOUS_CONFIG, type FakeMachine, fakeMachine } from "../helpers/setup-machine";

describe("setup: broker", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "volley-setup-broker-"));
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir);
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const applyAll = async (plan: Awaited<ReturnType<typeof planSecurity>>) => {
    const out: string[] = [];
    for (const c of plan.changes) out.push(...(await c.apply()));
    return out;
  };

  describe("detect", () => {
    it("names the install, the version and what each listener does", async () => {
      const p = await planDetect(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.changes).toEqual([]);
      const text = p.found.join("\n");
      expect(text).toContain("brew-arm64");
      expect(text).toContain("mosquitto 2.1.2");
      expect(text).toContain("1883: accepts anonymous clients");
      expect(text).toContain("9001: not listening");
    });

    it("blocks with the install hint when there is no mosquitto", async () => {
      m.auth.binaryVersion = null;
      const p = await planDetect(m.ctx);
      expect(p.blocked).toContain("brew install mosquitto");
    });

    it("blocks a broker older than 2.1 with the upgrade hint", async () => {
      m.auth.binaryVersion = "mosquitto version 2.0.22";
      const p = await planDetect(m.ctx);
      expect(p.blocked).toContain("BROKER_TOO_OLD");
      expect(p.blocked).toContain("sudo snap install mosquitto");
    });

    it("counts running agents once the coordinator's credentials exist", async () => {
      // Before setup there is no coordinator.json: nothing to log in with.
      expect((await planDetect(m.ctx)).found.join("\n")).not.toContain("running on the broker");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(m.layout.authDir, { recursive: true });
      writeFileSync(
        join(m.layout.authDir, "coordinator.json"),
        JSON.stringify({ username: "coordinator", password: "x" }),
      );
      expect((await planDetect(m.ctx)).found.join("\n")).toContain(
        "2 agents running on the broker",
      );
    });

    it("counts only agents whose retained status has not ended", () => {
      const st = (type: string) => ({ payload: JSON.stringify({ type }) });
      expect(
        countLiveAgents([
          st("working"),
          st("registered"),
          st("blocked"),
          st("done"),
          st("failed"),
          st("reaped"),
          { payload: "" },
          { payload: "not json" },
        ]),
      ).toBe(3);
    });
  });

  describe("security", () => {
    it("plans the config diff, the state file and the restart, writing nothing", async () => {
      const p = await planSecurity(m.ctx);
      expect(p.blocked).toBeUndefined();
      expect(p.changes.map((c) => c.summary)).toEqual([
        `Write ${m.layout.config} (Dynamic Security, both listeners authenticated; the old one backed up)`,
        `Create ${m.layout.stateFile} with the admin login dynsec-admin`,
        `Restart the broker (${m.layout.restart})`,
      ]);
      const diff = p.changes[0]?.detail ?? "";
      expect(diff).toContain("-allow_anonymous true");
      expect(diff).toContain("+allow_anonymous false");
      expect(diff).toContain("+listener 9001 127.0.0.1");
      expect(diff).toContain("+autosave_interval 30");
      // Planning changed nothing.
      expect(readFileSync(m.layout.config, "utf-8")).toBe(ANONYMOUS_CONFIG);
      expect(existsSync(m.layout.stateFile)).toBe(false);
      expect(m.auth.ctrlCalls).toEqual([]);
      expect(m.execCalls).toEqual([]);
    });

    it("applies: backup, config, state file + admin (0600), restart, then both listeners refuse", async () => {
      const p = await planSecurity(m.ctx);
      const out = await applyAll(p);
      expect(readFileSync(m.layout.config, "utf-8")).toBe(
        generateConfig({ ...m.layout, stateFile: m.layout.stateFile, by: "volley setup" }),
      );
      const backups = readdirSync(dir).filter((f) => f.startsWith("mosquitto.conf.volley-backup-"));
      expect(backups).toEqual(["mosquitto.conf.volley-backup-20261018T120000Z"]);
      expect(readFileSync(join(dir, backups[0] as string), "utf-8")).toBe(ANONYMOUS_CONFIG);
      const admin = join(m.layout.authDir, "admin.json");
      expect(statSync(admin).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(admin, "utf-8")).username).toBe("dynsec-admin");
      expect(m.execCalls).toEqual([["brew", "services", "restart", "mosquitto"]]);
      expect(out.join("\n")).toContain("Backed the previous config up");
      expect(await p.verify?.()).toEqual([]);
      // Planned again: nothing left to do.
      const again = await planSecurity(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain("1883: refuses anonymous clients");
    });

    it("a config `volley auth init` wrote is in place: only its header differs, nothing is rewritten", async () => {
      await applyAll(await planSecurity(m.ctx));
      const byInit = generateConfig({ ...m.layout, stateFile: m.layout.stateFile });
      writeFileSync(m.layout.config, byInit);
      const again = await planSecurity(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.found.join("\n")).toContain("is Volley's Dynamic Security config");
      expect(readFileSync(m.layout.config, "utf-8")).toBe(byInit);
    });

    it("asks about LAN access (yes by default) when no flag decides, and keeps 1883 on loopback", async () => {
      m.answers = [true];
      const p = await planSecurity(m.ctx);
      expect(m.questions).toEqual([LAN_QUESTION]);
      expect(LAN_QUESTION).toContain("not encrypted until TLS");
      expect(p.found.join("\n")).toContain("LAN access: on");
      const diff = p.changes[0]?.detail ?? "";
      expect(diff).toContain("+listener 1883 127.0.0.1");
      expect(diff).toMatch(/^\+listener 9001$/m);
      expect(diff).not.toContain("+listener 9001 127.0.0.1");
      expect(p.changes[0]?.summary).toContain("WebSocket open to the LAN");
    });

    it("asks nothing under --yes and keeps the listener local; --lan opens it without asking", async () => {
      m.ctx.yes = true;
      let p = await planSecurity(m.ctx);
      expect(m.questions).toEqual([]);
      expect(p.found.join("\n")).toContain("LAN access: off");
      expect(p.changes[0]?.detail).toContain("+listener 9001 127.0.0.1");
      m.ctx.lan = true;
      p = await planSecurity(m.ctx);
      expect(m.questions).toEqual([]);
      expect(p.changes[0]?.detail).toMatch(/^\+listener 9001$/m);
    });

    it("with LAN on: writes the open listener, restarts, and checks the LAN listener refuses anonymous", async () => {
      m.ctx.lan = true;
      const probed: string[] = [];
      const probe = m.deps.probeAnonymous;
      m.deps.probeAnonymous = async (url) => {
        probed.push(url);
        return probe(url);
      };
      const p = await planSecurity(m.ctx);
      await applyAll(p);
      expect(readFileSync(m.layout.config, "utf-8")).toBe(
        generateConfig({
          ...m.layout,
          stateFile: m.layout.stateFile,
          wsBind: "",
          by: "volley setup",
        }),
      );
      expect(readFileSync(m.layout.config, "utf-8")).toContain("not encrypted (no TLS)");
      expect(m.lanWs).toBe(true);
      expect(await p.verify?.()).toEqual([]);
      expect(probed).toContain("ws://desk.example:9001");
      // A LAN listener the phone cannot reach (a firewall) fails the step.
      m.lanWs = false;
      expect(await p.verify?.()).toEqual([
        "ws://desk.example:9001 is not reachable from the LAN (a firewall? the wrong address? pass --desk-host)",
      ]);
      // A rerun without a flag keeps LAN access on, asking nothing.
      m.lanWs = true;
      Reflect.deleteProperty(m.ctx, "lan");
      const again = await planSecurity(m.ctx);
      expect(again.changes).toEqual([]);
      expect(m.questions).toEqual([]);
      expect(again.found.join("\n")).toContain("LAN access: on");
      // --no-lan closes it again.
      m.ctx.lan = false;
      const close = await planSecurity(m.ctx);
      expect(close.changes[0]?.detail).toContain("+listener 9001 127.0.0.1");
    });

    it("plans only a restart when the config is right but a listener still takes anonymous clients", async () => {
      await applyAll(await planSecurity(m.ctx));
      m.anonymous.ws = "accepted";
      const p = await planSecurity(m.ctx);
      expect(p.changes.map((c) => c.summary)).toEqual([`Restart the broker (${m.layout.restart})`]);
    });

    it("verify names a listener that still accepts anonymous clients", async () => {
      const p = await planSecurity(m.ctx);
      await applyAll(p);
      m.anonymous.tcp = "accepted";
      expect(await p.verify?.()).toEqual(["mqtt://127.0.0.1:1883 still accepts anonymous clients"]);
    });

    it("waits for the restarted broker to take the admin login", async () => {
      let polls = 0;
      const restart = m.deps.exec;
      m.deps.exec = async (argv, o) => {
        const r = await restart(argv, o);
        if (argv.join(" ") === m.layout.restart) m.auth.adminUp = false;
        return r;
      };
      m.deps.sleep = async () => {
        if (++polls === 3) m.auth.adminUp = true;
      };
      await applyAll(await planSecurity(m.ctx));
      expect(polls).toBe(3);
    });

    it("fails the restart change when the broker never takes the admin login", async () => {
      const restart = m.deps.exec;
      m.deps.exec = async (argv, o) => {
        const r = await restart(argv, o);
        m.auth.adminUp = false;
        return r;
      };
      const p = await planSecurity(m.ctx);
      await expect(applyAll(p)).rejects.toThrow(/did not accept the admin login/);
    });

    it("blocks on a config trap, naming it", async () => {
      writeFileSync(m.layout.config, "per_listener_settings true\nlistener 1883\n");
      const p = await planSecurity(m.ctx);
      expect(p.blocked).toContain("per_listener_settings true");
      expect(p.changes).toEqual([]);
    });

    it("blocks a state file whose admin login is not in the auth dir", async () => {
      writeFileSync(m.layout.stateFile, "{}\n");
      const p = await planSecurity(m.ctx);
      expect(p.blocked).toContain("admin.json does not");
    });

    it("reports a failed restart command with its stderr", async () => {
      m.deps.exec = async () => ({ code: 1, stdout: "", stderr: "Error: permission denied" });
      const p = await planSecurity(m.ctx);
      await expect(applyAll(p)).rejects.toThrow(
        /brew services restart mosquitto.*permission denied/,
      );
    });
  });
});

describe("unifiedDiff", () => {
  it("is empty for equal text and marks a new file", () => {
    expect(unifiedDiff("f", "a\n", "a\n")).toBe("");
    expect(unifiedDiff("f", "", "a\nb\n")).toBe("--- f (new file)\n+++ f\n@@ -0,0 +1,2 @@\n+a\n+b");
  });

  it("keeps three lines of context and splits distant changes into hunks", () => {
    const before = `${Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")}\n`;
    const after = before.replace("l2\n", "L2\n").replace("l17\n", "L17\n");
    expect(unifiedDiff("f", before, after)).toBe(
      [
        "--- f",
        "+++ f",
        "@@ -1,6 +1,6 @@",
        " l0",
        " l1",
        "-l2",
        "+L2",
        " l3",
        " l4",
        " l5",
        "@@ -15,6 +15,6 @@",
        " l14",
        " l15",
        " l16",
        "-l17",
        "+L17",
        " l18",
        " l19",
      ].join("\n"),
    );
  });
});

/** A WebSocket endpoint that answers the first binary frame with a CONNACK carrying `rc`. */
async function wsConnackServer(rc: number, opts: { subprotocol?: boolean } = {}) {
  const frames: Buffer[] = [];
  const offered: (string | undefined)[] = [];
  const sockets = new Set<import("node:stream").Duplex>();
  const server = createHttpServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    // Like mosquitto: no `mqtt` subprotocol offered, no upgrade.
    const protocols = req.headers["sec-websocket-protocol"] as string | undefined;
    offered.push(protocols);
    if (!(protocols ?? "").split(/\s*,\s*/).includes("mqtt")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"] as string;
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(opts.subprotocol !== false ? ["Sec-WebSocket-Protocol: mqtt"] : []),
        "",
        "",
      ].join("\r\n"),
    );
    socket.on("data", (d: Buffer) => {
      // One small masked client frame: 2 header bytes, 4 mask bytes, payload.
      if ((d[0] as number) & 0x08) {
        socket.end(); // a close frame
        return;
      }
      const len = (d[1] as number) & 0x7f;
      const mask = d.subarray(2, 6);
      frames.push(Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ (mask[i % 4] as number))));
      socket.write(Buffer.from([0x82, 4, 0x20, 0x02, 0x00, rc]));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    offered,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A TCP server that accepts connections and never replies. */
async function silentServer() {
  const sockets = new Set<import("node:net").Socket>();
  const server = createNetServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe("probeAnonymous", () => {
  it("builds a credential-less MQTT 3.1.1 CONNECT and reads CONNACKs", () => {
    expect([...anonymousConnectPacket("p")]).toEqual([
      0x10, 13, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30, 0, 1, 0x70,
    ]);
    expect(connackOutcome(Uint8Array.from([0x20, 2, 0, 0]))).toBe("accepted");
    expect(connackOutcome(Uint8Array.from([0x20, 2, 0, 5]))).toBe("refused");
    expect(connackOutcome(Uint8Array.from([0x20, 2, 0]))).toBeNull();
  });

  it("over TCP: refused by an authenticating broker, accepted by an open one", async () => {
    const authed = await startFakeDynsec();
    const open = await startTestBroker();
    try {
      expect(await probeAnonymous(authed.url)).toBe("refused");
      expect(await probeAnonymous(open.url)).toBe("accepted");
    } finally {
      await authed.close();
      await open.close();
    }
  });

  it("over a WebSocket with the mqtt subprotocol", async () => {
    const refusing = await wsConnackServer(5);
    const accepting = await wsConnackServer(0);
    try {
      expect(await probeAnonymous(refusing.url)).toBe("refused");
      expect(await probeAnonymous(accepting.url)).toBe("accepted");
      expect(refusing.frames[0]?.[0]).toBe(0x10);
      expect(refusing.offered).toEqual(["mqtt"]);
    } finally {
      await refusing.close();
      await accepting.close();
    }
  });

  it("unreachable: a listener that never answers (over TCP and a WebSocket)", async () => {
    // A server that stays bound for the whole test, so no other test can take its port.
    const quiet = await silentServer();
    try {
      expect(await probeAnonymous(`ws://127.0.0.1:${quiet.port}`, 500)).toBe("unreachable");
      expect(await probeAnonymous(`mqtt://127.0.0.1:${quiet.port}`, 500)).toBe("unreachable");
    } finally {
      await quiet.close();
    }
  });
});
