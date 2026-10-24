import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAYOUTS, type Layout, type LayoutName, generateConfig } from "../../src/auth/config";
import {
  type BrokerReceiveDeps,
  receivedMarker,
  runBroker,
} from "../../src/commands/broker-receive";
import { EXIT, type ExitCode } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { ANONYMOUS_CONFIG, type FakeMachine, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

const MOVE = "broker-20261024-101500-ab12";
/** A Dynamic Security state file as the plugin writes it: three logins. */
const STATE = {
  defaultACLAccess: { publishClientSend: false, subscribe: false },
  clients: [
    { username: "dynsec-admin", roles: [{ rolename: "admin" }] },
    { username: "volleyd", roles: [{ rolename: "supervisor" }] },
    { username: "coordinator", roles: [{ rolename: "admin" }] },
  ],
  groups: [],
  roles: [{ rolename: "admin", acls: [] }],
};

let dir: string;
let fake: FakeDynsec;
let m: FakeMachine;
let home: string;
let layouts: Record<LayoutName, Layout>;
let peerCalls: string[][];
let svcCalls: string[][];

beforeEach(async () => {
  dir = tempDir("volley-broker-receive-");
  fake = await startFakeDynsec();
  m = fakeMachine(fake, dir);
  home = join(dir, "home");
  peerCalls = [];
  svcCalls = [];
  const under = (name: LayoutName): Layout => ({
    ...LAYOUTS[name],
    config: join(dir, name, "mosquitto.conf"),
    authDir: join(dir, name, "auth"),
    stateFile: join(dir, name, "dynamic-security.json"),
  });
  layouts = {
    "brew-arm64": m.layout,
    "brew-intel": under("brew-intel"),
    snap: under("snap"),
    etc: under("etc"),
    container: under("container"),
  };
});
afterEach(async () => {
  await fake.close();
});

function deps(over: Partial<BrokerReceiveDeps> = {}): BrokerReceiveDeps {
  return {
    setup: m.deps,
    layouts,
    uid: () => 501,
    platform: "linux",
    home,
    authDir: (l) => l.authDir,
    exec: async (argv) => {
      if (argv[0] === "tar") {
        const r = spawnSync("tar", argv.slice(1), { encoding: "utf-8" });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      }
      svcCalls.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    },
    peer: async (argv): Promise<ExitCode> => {
      peerCalls.push(argv);
      return EXIT.OK;
    },
    now: () => new Date("2026-10-24T10:15:00.000Z"),
    ...over,
  };
}

/** A broker move's bundle as volleyd's roles/bundle.ts makes it. */
function bundle(o: { state?: string; lan?: boolean; role?: string } = {}): string {
  const stage = join(dir, "stage");
  mkdirSync(join(stage, "broker"), { recursive: true });
  mkdirSync(join(stage, "auth"), { recursive: true });
  const files: Record<string, string> = {
    "broker/dynamic-security.json": o.state ?? `${JSON.stringify(STATE, null, 2)}\n`,
    "broker/choices.json": `${JSON.stringify({ lan: o.lan ?? false })}\n`,
    "auth/admin.json": `${JSON.stringify(fake.admin)}\n`,
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(stage, p), text);
  const manifest = {
    version: 1,
    move_id: MOVE,
    role: o.role ?? "broker",
    from: "control",
    to: "box",
    with_broker: true,
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    })),
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
  const out = join(home, ".volley", "roles", "broker", "bundle.tgz");
  mkdirSync(join(home, ".volley", "roles", "broker"), { recursive: true });
  const r = spawnSync("tar", ["-czf", out, "-C", stage, "manifest.json", ...Object.keys(files)]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return out;
}

async function run(argv: string[], d: BrokerReceiveDeps = deps()) {
  const io = makeBufferIO();
  const code = await runBroker({ argv, env: {}, io }, d);
  return { code, out: io.readStdout(), err: io.readStderr() };
}

describe("volley broker receive (#470)", () => {
  it("places the state file, writes the config as `volley auth init` would (--lan), restarts and checks both listeners", async () => {
    const b = bundle();
    const r = await run(["receive", b, "--lan"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(EXIT.OK);
    // The state file first, exactly the bundle's; the admin login beside the auth dir.
    expect(JSON.parse(readFileSync(m.layout.stateFile, "utf-8"))).toEqual(STATE);
    expect(JSON.parse(readFileSync(join(m.layout.authDir, "admin.json"), "utf-8"))).toEqual(
      fake.admin,
    );
    // --lan: the WebSocket listener on every interface, as `volley setup --lan` writes it.
    const conf = readFileSync(m.layout.config, "utf-8");
    expect(conf).toBe(
      generateConfig({
        ...m.layout,
        stateFile: m.layout.stateFile,
        wsBind: "",
        by: "volley setup",
      }),
    );
    expect(conf).toMatch(/^listener 9001$/m);
    expect(m.execCalls.map((a) => a.join(" "))).toContain(m.layout.restart);
    expect(r.out).toContain("Listener 1883: refuses anonymous clients");
    expect(r.out).toContain("Listener 9001: refuses anonymous clients");
    expect(r.out).toMatch(/^mosquitto 2\.1\.\d+: 3 logins$/m);
    // The move waits on this marker (`--check`).
    expect(existsSync(receivedMarker(b))).toBe(true);
    expect((await run(["receive", b, "--check"])).code).toBe(EXIT.OK);
  });

  it("the bundle's choice decides without --lan / --no-lan", async () => {
    const b = bundle({ lan: false });
    const r = await run(["receive", b]);
    expect(r.code).toBe(EXIT.OK);
    expect(readFileSync(m.layout.config, "utf-8")).not.toMatch(/^listener 9001$/m);
  });

  it("--check before the receive ran exits 1", async () => {
    const b = bundle();
    expect((await run(["receive", b, "--check"])).code).toBe(EXIT.ERROR);
  });

  it("a root layout without root exits 2 with the sudo line, changing nothing", async () => {
    const b = bundle({ lan: true });
    const r = await run(["receive", b, "--layout", "snap"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain(`sudo volley broker receive ${b} --lan`);
    expect(existsSync(layouts.snap.stateFile)).toBe(false);
    expect(m.execCalls).toEqual([]);
  });

  it("a state file that is not Dynamic Security JSON is refused before anything is written", async () => {
    const b = bundle({ state: '{"listeners": []}\n' });
    const r = await run(["receive", b, "--lan"]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toMatch(/not a Dynamic Security state file/);
    expect(existsSync(m.layout.stateFile)).toBe(false);
    expect(existsSync(join(m.layout.authDir, "admin.json"))).toBe(false);
    expect(readFileSync(m.layout.config, "utf-8")).toBe(ANONYMOUS_CONFIG);
    expect(m.execCalls).toEqual([]);
  });

  it("refuses a bundle that is not a broker move's", async () => {
    const b = bundle({ role: "supervisor" });
    const r = await run(["receive", b]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toMatch(/not the broker/);
    expect(existsSync(m.layout.stateFile)).toBe(false);
  });
});

describe("volley broker probe (#470)", () => {
  it("prints the layout and the mosquitto version as one JSON line", async () => {
    const r = await run(["probe"]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({
      layout: "brew-arm64",
      needs_root: false,
      mosquitto: "2.1.2",
    });
  });

  it("no mosquitto: exit 1, the reason in the JSON", async () => {
    m.auth.binaryVersion = null;
    const r = await run(["probe", "--layout", "snap"]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out)).toMatchObject({
      layout: "snap",
      needs_root: true,
      mosquitto: null,
      error: expect.stringMatching(/no mosquitto/),
    });
  });
});

describe("volley broker tunnel (#470)", () => {
  const peerJson = () => join(home, ".volley", "peer.json");

  it("--to over a corrupt peer.json says so (exit 1), and leaves it as it was", async () => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    writeFileSync(peerJson(), "{ not json");
    const r = await run(["tunnel", "--to", "dev@box", "--port", "1883", "--name", "control"]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toMatch(/peer\.json is not JSON/);
    expect(readFileSync(peerJson(), "utf-8")).toBe("{ not json");
    expect(peerCalls).toEqual([]);
  });

  it("--to without a peer.json writes a tunnel-only one and retargets it; --off removes it", async () => {
    const r = await run([
      "tunnel",
      "--to",
      "dev@box",
      "--port",
      "1883",
      "--name",
      "control",
      "--broker-port",
      "1883",
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(EXIT.OK);
    const cfg = JSON.parse(readFileSync(peerJson(), "utf-8")) as Record<string, unknown>;
    expect(cfg).toMatchObject({
      name: "control",
      host: "dev@box",
      broker: { host: "127.0.0.1", port: 1883 },
      remote_port: 1883,
      tunnel: "ssh",
      heartbeat: false,
      tunnel_only: true,
    });
    expect(peerCalls).toEqual([
      ["retarget", "--to", "dev@box", "--port", "1883", "--tunnel", "ssh"],
    ]);
    const shown = await run(["tunnel", "--show"]);
    expect(JSON.parse(shown.out)).toEqual({ host: "dev@box", remote_port: 1883, tunnel: "ssh" });

    const off = await run(["tunnel", "--off"]);
    expect(off.code).toBe(EXIT.OK);
    expect(existsSync(peerJson())).toBe(false);
    expect(svcCalls.map((a) => a.join(" "))).toContain(
      "systemctl --user disable --now volley-peer.service",
    );
  });

  it("--to over an existing peer.json keeps it for --off, which puts it back", async () => {
    mkdirSync(join(home, ".volley"), { recursive: true });
    const before = `${JSON.stringify({
      name: "control",
      host: "dev@old",
      target: "me@control",
      namespace: "default",
      broker: { host: "127.0.0.1", port: 1883 },
      remote_port: 1883,
      username: "control",
      password: "pw",
      joined_at: "2026-10-01T00:00:00.000Z",
      tunnel: "none",
      heartbeat: false,
    })}\n`;
    writeFileSync(peerJson(), before);
    const r = await run([
      "tunnel",
      "--to",
      "dev@box",
      "--port",
      "1883",
      "--name",
      "control",
      "--broker-port",
      "1883",
    ]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(readFileSync(peerJson(), "utf-8"))).toMatchObject({ username: "control" });
    const off = await run(["tunnel", "--off"]);
    expect(off.code).toBe(EXIT.OK);
    expect(readFileSync(peerJson(), "utf-8")).toBe(before);
    expect(svcCalls.map((a) => a.join(" "))).toContain(
      "systemctl --user restart volley-peer.service",
    );
  });

  it("--off with nothing to put back exits 1", async () => {
    expect((await run(["tunnel", "--off"])).code).toBe(EXIT.ERROR);
  });
});
