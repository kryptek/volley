import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import type { MachineRecord } from "../src/machines";
import { PeerService, isPairingCode, normalizeCode } from "../src/peers";
import type { NewEvent, RemoteHostConfig } from "../src/types";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { type DaemonEnv, NO_PRESSURE, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const REPLY_KEY = publicKey.export({ format: "jwk" });
const unseal = (sealed: unknown) =>
  JSON.parse(
    privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed as string, "base64url"),
    ).toString(),
  ) as Record<string, string>;

/** `volley auth` in memory: what the daemon runs through the fenced exec (accounts.ts). */
function fakeAuth(): FakeExec & { accounts: Map<string, string> } {
  const accounts = new Map<string, string>([["admin-1", "admin"]]);
  let n = 0;
  const fake = fakeExec().on(["volley", "auth"], (argv) => {
    const flag = (f: string) => argv[argv.indexOf(f) + 1] as string;
    switch (argv[2]) {
      case "list":
        return {
          stdout: JSON.stringify({
            accounts: [...accounts].map(([name, role]) => ({
              name,
              role,
              kind: "machine",
              created: "2026-10-19T09:00:00.000Z",
            })),
          }),
        };
      case "add": {
        const name = argv[3] as string;
        if (accounts.has(name)) return { code: 1, stderr: `volley auth: "${name}" already exists` };
        accounts.set(name, flag("--role"));
        n++;
        return { stdout: JSON.stringify({ username: name, password: `pw-${n}`, role: "peer" }) };
      }
      case "revoke": {
        const name = argv[3] as string;
        if (!accounts.delete(name)) return { code: 1, stderr: `volley auth: no account "${name}"` };
        return {};
      }
      case "rotate": {
        const name = argv[3] as string;
        if (!accounts.has(name)) return { code: 1, stderr: `volley auth: no account "${name}"` };
        n++;
        return {
          stdout: JSON.stringify({ username: name, password: `pw-${n}`, role: accounts.get(name) }),
        };
      }
      default:
        return { code: 2, stderr: "unexpected" };
    }
  });
  return Object.assign(fake, { accounts });
}

describe("PeerService (pairing codes, peer accounts, host registration)", () => {
  let dir: string;
  let auth: ReturnType<typeof fakeAuth>;
  let now: number;
  let hosts: Record<string, RemoteHostConfig>;
  let events: NewEvent[];
  let cleared: string[];
  let codes: string[];
  let machines: MachineRecord[];
  let peers: PeerService;

  const make = () =>
    new PeerService({
      exec: auth.exec,
      now: () => now,
      file: join(dir, "peer-codes.json"),
      pairedFile: join(dir, "peers.json"),
      namespace: "default",
      broker: () => ({ host: "127.0.0.1", port: 1883 }),
      hosts: () => hosts,
      setHost: (name, host) => {
        hosts = { ...hosts, [name]: host };
        return { applied: true, rejected: [], version: 2 };
      },
      removeHost: (name) => {
        const { [name]: _gone, ...rest } = hosts;
        hosts = rest;
        return { applied: true, rejected: [], version: 3 };
      },
      clearMachine: async (name) => {
        cleared.push(name);
      },
      machines: () => machines,
      journal: (ev) => {
        events.push(ev);
      },
      randomCode: () => codes.shift() ?? "ZZZZ-ZZZZ",
    });

  const invite = async () => {
    const r = await peers.invite({ reply_key: REPLY_KEY }, "admin-1");
    expect(r.ok).toBe(true);
    return unseal(r.sealed).code as string;
  };
  const joinFields = (code: string, extra: Record<string, unknown> = {}) => ({
    code,
    name: "box-a",
    target: "dev@box-a",
    volley_dir: "/opt/volley",
    repo: "/srv/repo",
    os: "linux",
    cores: 8,
    reply_key: REPLY_KEY,
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volleyd-peers-"));
    auth = fakeAuth();
    now = Date.parse("2026-10-19T09:00:00.000Z");
    hosts = {};
    events = [];
    cleared = [];
    codes = ["ABCD-EFGH", "JKMN-PQRS"];
    machines = [];
    peers = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("codes are XXXX-XXXX; normalisation accepts lower case and a missing dash", () => {
    expect(isPairingCode("ABCD-EF23")).toBe(true);
    expect(isPairingCode("ABCD-EF2")).toBe(false);
    expect(normalizeCode(" abcd ef23 ")).toBe("ABCDEF23");
    expect(normalizeCode("abcd-ef23")).toBe("ABCDEF23");
    // Only the alphabet's characters: never I, L, O, 0 or 1.
    for (const bad of ["ABCD-EF01", "IJKM-NPQR", "ABCD-EFGL", "OABC-DEFG"]) {
      expect(isPairingCode(bad), bad).toBe(false);
    }
  });

  it("peer_invite yields a sealed code (never in clear) whose hash alone is stored", async () => {
    const r = await peers.invite({ reply_key: REPLY_KEY }, "admin-1");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.result)).not.toContain("ABCD");
    expect(unseal(r.sealed)).toEqual({ code: "ABCD-EFGH" });
    expect(r.result).toMatchObject({
      ttl_s: DAEMON_DEFAULTS.peer_code_ttl_s,
      expires_at: new Date(now + DAEMON_DEFAULTS.peer_code_ttl_s * 1000).toISOString(),
    });
    const file = join(dir, "peer-codes.json");
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("ABCD");
    expect(text).not.toContain("EFGH");
    expect(JSON.parse(text).codes).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Journaled without the code.
    expect(events).toEqual([
      { type: "peer_invited", data: { by: "admin-1", expires_at: expect.any(String) } },
    ]);
    expect(JSON.stringify(events)).not.toContain("ABCD");
  });

  it("peer_invite without a usable reply_key is refused before a code exists", async () => {
    const r = await peers.invite({}, "admin-1");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("reply_key") });
    expect(codes).toHaveLength(2);
  });

  it("join with a valid code creates a peer account, registers the host, returns the broker port, burns the code", async () => {
    const code = await invite();
    const r = await peers.join(joinFields(code.toLowerCase()), "volley-cli-x");
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({
      name: "box-a",
      namespace: "default",
      broker: { host: "127.0.0.1", port: 1883 },
      remote_port: REMOTE_HOST_DEFAULTS.remote_port,
    });
    expect(unseal(r.sealed)).toEqual({ username: "box-a", password: "pw-1" });
    expect(JSON.stringify(r.result)).not.toContain("pw-1");
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([
      ["volley", "auth", "add", "box-a", "--role", "peer", "--kind", "machine", "--json"],
    ]);
    expect(auth.accounts.get("box-a")).toBe("peer");
    // The peer keeps its own tunnel (a service on the machine): volleyd only checks it.
    expect(hosts["box-a"]).toEqual({
      target: "dev@box-a",
      repo: "/srv/repo",
      volley_dir: "/opt/volley",
      tunnel: { remote_port: REMOTE_HOST_DEFAULTS.remote_port, supervise: false },
    });
    expect(events.at(-1)).toEqual({
      type: "peer_joined",
      // `by` is who redeemed the code, not the machine (its name is `name`).
      data: { by: "volley-cli-x", name: "box-a", target: "dev@box-a", os: "linux", cores: 8 },
    });
    // Burned: the same code again is refused.
    const again = await peers.join(joinFields(code, { name: "box-b" }), "volley-cli-y");
    expect(again).toMatchObject({ ok: false, error: "invalid or expired pairing code" });
    expect(auth.accounts.has("box-b")).toBe(false);
  });

  it("an explicit port is the host's remote_port", async () => {
    const code = await invite();
    const r = await peers.join(joinFields(code, { port: 22883 }), "cli");
    expect(r.result).toMatchObject({ remote_port: 22883 });
    expect(hosts["box-a"]?.tunnel).toEqual({ remote_port: 22883, supervise: false });
  });

  it("an unknown code is refused and creates nothing", async () => {
    await invite();
    const r = await peers.join(joinFields("WXYZ-2345"), "cli");
    expect(r).toMatchObject({ ok: false, error: "invalid or expired pairing code" });
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([]);
    expect(hosts).toEqual({});
  });

  it("an expired code is refused, also after a daemon restart (the store is on disk)", async () => {
    const code = await invite();
    now += DAEMON_DEFAULTS.peer_code_ttl_s * 1000 + 1;
    peers = make();
    const r = await peers.join(joinFields(code), "cli");
    expect(r).toMatchObject({ ok: false, error: "invalid or expired pairing code" });
    expect(auth.accounts.has("box-a")).toBe(false);
  });

  it("a code survives a restart while it is valid", async () => {
    const code = await invite();
    peers = make();
    expect((await peers.join(joinFields(code), "cli")).ok).toBe(true);
  });

  it("too many wrong codes revoke every outstanding code", async () => {
    const code = await invite();
    for (let i = 0; i < DAEMON_DEFAULTS.peer_join_max_failures; i++) {
      expect((await peers.join(joinFields("WXYZ-2345"), "cli")).ok).toBe(false);
    }
    const r = await peers.join(joinFields(code), "cli");
    expect(r).toMatchObject({ ok: false, error: "invalid or expired pairing code" });
  });

  it("refuses a malformed join before touching the code", async () => {
    const code = await invite();
    for (const bad of [
      { name: "Bad Name" },
      { name: "local" },
      { name: "auto" },
      { name: "volleyd" },
      { target: undefined },
      { volley_dir: "relative/path" },
      { repo: "relative" },
      { port: 80 },
      { reply_key: undefined },
    ]) {
      const r = await peers.join(joinFields(code, bad), "cli");
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    // Still valid: none of those counted against it.
    expect((await peers.join(joinFields(code), "cli")).ok).toBe(true);
  });

  it("refuses a name that is already a configured host", async () => {
    hosts = { "box-a": { target: "dev@elsewhere" } };
    const code = await invite();
    const r = await peers.join(joinFields(code), "cli");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(auth.accounts.has("box-a")).toBe(false);
  });

  it("refuses the supervisor's own machine name before the code is burned", async () => {
    peers = new PeerService({
      ...(peers as unknown as { deps: ConstructorParameters<typeof PeerService>[0] }).deps,
      localName: () => "control",
    });
    const code = await invite();
    const r = await peers.join(joinFields(code, { name: "control" }), "cli");
    expect(r).toMatchObject({
      ok: false,
      error: '"control" is the supervisor\'s own machine name (fleet.local_name)',
    });
    expect(auth.accounts.has("control")).toBe(false);
    expect(hosts).toEqual({});
    // Not burned: the same code still pairs another name.
    expect(await peers.join(joinFields(code), "cli")).toMatchObject({ ok: true });
    expect(Object.keys(hosts)).toEqual(["box-a"]);
  });

  describe("re-pairing: invite --for and join { replace }", () => {
    const inviteFor = async (name: string) => {
      const r = await peers.invite({ reply_key: REPLY_KEY, for: name }, "admin-1");
      expect(r.ok, r.error).toBe(true);
      return unseal(r.sealed).code as string;
    };
    const paired = async () => {
      await peers.join(joinFields(await invite()), "cli");
      events = [];
    };

    it("a --for code redeemed with replace: true replaces the account's password and hosts.<name>", async () => {
      await paired();
      const code = await inviteFor("box-a");
      expect(events.at(-1)).toEqual({
        type: "peer_invited",
        data: { by: "admin-1", expires_at: expect.any(String), for: "box-a" },
      });
      const r = await peers.join(
        joinFields(code, { target: "dev@box-a.new", repo: "/srv/other", replace: true }),
        "cli",
      );
      expect(r.ok, r.error).toBe(true);
      // A new password for the same account: rotated, never added twice.
      expect(unseal(r.sealed)).toEqual({ username: "box-a", password: "pw-2" });
      expect(auth.argvs(["volley", "auth", "rotate"])).toEqual([
        ["volley", "auth", "rotate", "box-a", "--json"],
      ]);
      expect(auth.argvs(["volley", "auth", "add"])).toHaveLength(1);
      expect(hosts["box-a"]).toMatchObject({ target: "dev@box-a.new", repo: "/srv/other" });
      expect(events.at(-1)).toEqual({
        type: "peer_joined",
        data: {
          by: "cli",
          name: "box-a",
          target: "dev@box-a.new",
          os: "linux",
          cores: 8,
          replaced: true,
        },
      });
      // Burned like any code.
      const again = await peers.join(joinFields(code, { replace: true }), "cli");
      expect(again).toMatchObject({ ok: false, error: "invalid or expired pairing code" });
    });

    it("an unbound code for a configured name is still refused, replace or not, before it is burned", async () => {
      await paired();
      const code = await invite();
      for (const extra of [{}, { replace: true }]) {
        const r = await peers.join(joinFields(code, extra), "cli");
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining("already") });
      }
      expect(auth.argvs(["volley", "auth", "rotate"])).toEqual([]);
      // Not burned: it still pairs another name.
      expect((await peers.join(joinFields(code, { name: "box-b" }), "cli")).ok).toBe(true);
    });

    it("a --for code cannot join under another name (and stays usable for its own)", async () => {
      await paired();
      const code = await inviteFor("box-a");
      for (const name of ["box-b", "box-c"]) {
        const r = await peers.join(joinFields(code, { name, replace: true }), "cli");
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining("box-a") });
      }
      expect(auth.accounts.has("box-b")).toBe(false);
      expect((await peers.join(joinFields(code, { replace: true }), "cli")).ok).toBe(true);
    });

    it("a --for code without replace: true is refused for the configured name", async () => {
      await paired();
      const code = await inviteFor("box-a");
      const r = await peers.join(joinFields(code), "cli");
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("--replace") });
    });

    it("invite --for names a paired machine", async () => {
      for (const name of ["box-a", "Bad Name"]) {
        const r = await peers.invite({ reply_key: REPLY_KEY, for: name }, "admin-1");
        expect(r).toMatchObject({ ok: false });
      }
      expect(codes).toHaveLength(2);
    });

    it("replace never touches an account that is not a peer", async () => {
      hosts = { "admin-1": { target: "dev@x" } };
      // Paired by hand into peers.json: the name exists as an admin account.
      peers = make();
      (peers as unknown as { writePaired: (p: unknown) => void }).writePaired({
        "admin-1": { target: "dev@x", joined_at: "2026-10-19T09:00:00.000Z" },
      });
      const code = await inviteFor("admin-1");
      const r = await peers.join(joinFields(code, { name: "admin-1", replace: true }), "cli");
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not a peer") });
      expect(auth.argvs(["volley", "auth", "rotate"])).toEqual([]);
    });
  });

  it("a config the host entry cannot go into revokes the account it just created", async () => {
    peers = new PeerService({
      ...(peers as unknown as { deps: ConstructorParameters<typeof PeerService>[0] }).deps,
      setHost: () => ({ applied: false, rejected: [{ path: "hosts", reason: "too many" }] }),
    });
    const code = await invite();
    const r = await peers.join(joinFields(code), "cli");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("too many") });
    expect(auth.accounts.has("box-a")).toBe(false);
  });

  it("peer_remove revokes the account, removes the host entry and clears the machine record", async () => {
    const code = await invite();
    await peers.join(joinFields(code), "cli");
    const r = await peers.remove({ name: "box-a" }, "admin-1");
    expect(r).toMatchObject({
      ok: true,
      result: { name: "box-a", revoked: true, host_removed: true },
    });
    expect(auth.argvs(["volley", "auth", "revoke"])).toEqual([
      ["volley", "auth", "revoke", "box-a"],
    ]);
    expect(hosts).toEqual({});
    expect(cleared).toEqual(["box-a"]);
    expect(events.at(-1)).toEqual({
      type: "peer_removed",
      data: { by: "admin-1", name: "box-a", revoked: true, host_removed: true },
    });
  });

  it("peer_remove never revokes an account that is not a peer", async () => {
    const r = await peers.remove({ name: "admin-1" }, "admin-1");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not a peer") });
    expect(auth.accounts.get("admin-1")).toBe("admin");
  });

  it("peer_remove of an unknown name is refused", async () => {
    const r = await peers.remove({ name: "nobody" }, "admin-1");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("no peer") });
  });

  it("peer_remove never deletes a host configured by hand (no peer account, never paired)", async () => {
    const box: RemoteHostConfig = { target: "dev@box", tunnel: { remote_port: 21883 } };
    hosts = { box, mine: { target: "dev@mine", tunnel: { remote_port: 21884, supervise: false } } };
    for (const name of ["box", "mine"]) {
      const r = await peers.remove({ name }, "admin-1");
      expect(r).toMatchObject({
        ok: false,
        error: expect.stringContaining("not a paired machine"),
      });
    }
    expect(hosts).toEqual({
      box,
      mine: { target: "dev@mine", tunnel: { remote_port: 21884, supervise: false } },
    });
    expect(cleared).toEqual([]);
    expect(events.some((e) => e.type === "peer_removed")).toBe(false);
  });

  it("peer_remove of a paired machine whose account is gone still drops its host entry", async () => {
    const code = await invite();
    await peers.join(joinFields(code), "cli");
    auth.accounts.delete("box-a");
    const r = await peers.remove({ name: "box-a" }, "admin-1");
    expect(r).toMatchObject({ ok: true, result: { revoked: false, host_removed: true } });
    expect(hosts).toEqual({});
    // Unpaired: a second remove finds nothing.
    expect((await peers.remove({ name: "box-a" }, "admin-1")).ok).toBe(false);
  });

  it("peers lists only paired machines: not a hand-configured host, nor another account's record", async () => {
    hosts = { mine: { target: "dev@mine", tunnel: { remote_port: 21884, supervise: false } } };
    const code = await invite();
    await peers.join(joinFields(code), "cli");
    const record = (name: string): MachineRecord => ({
      name,
      os: "linux",
      cores: 4,
      tunnel: "up",
      load: [0, 0, 0],
      agents: 0,
      last_seen: "2026-10-19T09:00:00.000Z",
    });
    machines = [record("box-a"), record("mine"), record("steer-phone")];
    expect(peers.list().result).toEqual({ machines: [record("box-a")], hosts: ["box-a"] });
    // Kept across a restart (peers.json, mode 0600).
    expect(make().list().result).toMatchObject({ hosts: ["box-a"] });
    expect(statSync(join(dir, "peers.json")).mode & 0o777).toBe(0o600);
  });
});

describe("peer ops over volleyd's control channel", () => {
  let env: DaemonEnv;
  let client: ControlClient;
  let auth: ReturnType<typeof fakeAuth>;

  beforeEach(async () => {
    env = await makeDaemonEnv();
    auth = fakeAuth();
    await env.start({ authExec: auth.exec });
    client = await ControlClient.connect(env.broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await env.cleanup();
  });

  it("peer_invite and peer_remove are refused on the mailbox (it does not name the sender)", async () => {
    for (const [op, fields] of [
      ["peer_invite", { reply_key: REPLY_KEY }],
      ["peer_remove", { name: "box-a" }],
    ] as const) {
      const r = await client.request(op, fields);
      expect(r).toMatchObject({
        ok: false,
        error: expect.stringContaining("volley/_system/auth/ops/"),
      });
    }
    expect(auth.argvs(["volley", "auth"])).toEqual([]);
    expect(existsSync(join(env.home, "peer-codes.json"))).toBe(false);
  });
});

/** The broker ACL the shipped roles apply, reduced to the auth topics (control-accounts.test.ts). */
function canPublish(user: string | undefined, topic: string): boolean {
  if (user === "volleyd") return true;
  if (topic.startsWith("volley/_system/auth/ops/")) return topic === authOpsTopic(user ?? "");
  return !topic.startsWith("volley/_system/auth/");
}

describe("peer admin ops on the account-op topic (SPEC §4.6.14)", () => {
  const USERS = ["volleyd", "admin-1", "steer-1", "w1-t1-implementer-1"];
  const pw = (u: string) => `${u}-pw`;
  let broker: TestBroker;
  let home: string;
  let auth: ReturnType<typeof fakeAuth>;
  let daemon: Daemon;
  const clients: VolleyBroker[] = [];

  beforeEach(async () => {
    broker = await startTestBroker({
      users: Object.fromEntries(USERS.map((u) => [u, pw(u)])),
      canPublish,
    });
    home = mkdtempSync(join(tmpdir(), "volleyd-peer-ops-"));
    auth = fakeAuth();
    auth.accounts.set("steer-1", "steer");
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      auth: { username: "volleyd", password: pw("volleyd") },
      authExec: auth.exec,
    });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      // broker round-trip: a client the ACL refused may never complete its DISCONNECT.
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      c.simulateCrash();
    }
    await daemon.stop();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** One request as `user` on `topic`, answered on the account-op reply topic (or null). */
  async function op(
    user: string,
    payload: Record<string, unknown>,
    topic = authOpsTopic(user),
  ): Promise<Record<string, unknown> | null> {
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: `cli-${randomUUID().slice(0, 6)}`,
      username: user,
      password: pw(user),
    });
    clients.push(c);
    const cid = randomUUID();
    let resolve!: (p: Record<string, unknown> | null) => void;
    const reply = new Promise<Record<string, unknown> | null>((r) => {
      resolve = r;
    });
    await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const env = parseEnvelope(raw);
      if (env?.type === "ack" && env.agent_id === "volleyd" && env.correlation_id === cid) {
        resolve(env.payload as Record<string, unknown>);
      }
    });
    const env = buildEnvelope({
      agentId: user,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload,
    });
    // Not awaited: Aedes never PUBACKs a publish the ACL refuses.
    void c.publish(topic, JSON.stringify(env), { qos: 1, retain: false }).catch(() => {});
    // broker round-trip: a refused request is never answered; bound the wait.
    const timer = setTimeout(() => resolve(null), 3000);
    const r = await reply;
    clearTimeout(timer);
    return r;
  }

  it("an admin invites (sealed code), a join redeems it, the admin removes the machine", async () => {
    const inv = await op("admin-1", { op: "peer_invite", reply_key: REPLY_KEY });
    expect(inv).toMatchObject({
      ok: true,
      op: "peer_invite",
      result: { ttl_s: expect.any(Number) },
    });
    const code = unseal(inv?.sealed).code as string;
    expect(isPairingCode(code)).toBe(true);

    const client = await ControlClient.connect(broker.url, NS, {
      username: "steer-1",
      password: pw("steer-1"),
    });
    try {
      const joined = await client.request("peer_join", {
        code,
        name: "box-a",
        target: "dev@box-a",
        volley_dir: "/opt/volley",
        reply_key: REPLY_KEY,
      });
      expect(joined).toMatchObject({ ok: true, result: { name: "box-a" } });
    } finally {
      await client.close();
    }
    expect(readFileSync(join(home, "config.yaml"), "utf-8")).toContain("box-a");

    const removed = await op("admin-1", { op: "peer_remove", name: "box-a" });
    expect(removed).toMatchObject({ ok: true, result: { revoked: true, host_removed: true } });
    expect(readFileSync(join(home, "config.yaml"), "utf-8")).not.toContain("box-a");
    const system = readJournalFile(join(home, "waves", "_system", "journal.jsonl"));
    expect(system.map((e) => e.type)).toEqual(
      expect.arrayContaining(["peer_invited", "config_changed", "peer_joined", "peer_removed"]),
    );
    expect(system.find((e) => e.type === "peer_invited")?.data).toMatchObject({ by: "admin-1" });
    expect(system.find((e) => e.type === "peer_removed")?.data).toMatchObject({ by: "admin-1" });
  });

  it("a non-admin sender is refused with the account ops' reason, and nothing runs", async () => {
    const r = await op("steer-1", { op: "peer_invite", reply_key: REPLY_KEY });
    expect(r).toMatchObject({ ok: false, op: "peer_invite" });
    expect(r?.error).toMatch(/steer-1.*steer.*admin/);
    expect(existsSync(join(home, "peer-codes.json"))).toBe(false);
    const rm = await op("steer-1", { op: "peer_remove", name: "box-a" });
    expect(rm).toMatchObject({ ok: false });
    expect(auth.argvs(["volley", "auth", "revoke"])).toEqual([]);
  });

  it("a dispatched agent cannot remove a peer: refused on the mailbox, dropped on the ops topic", async () => {
    auth.accounts.set("box-a", "peer");
    const agent = "w1-t1-implementer-1";
    const client = await ControlClient.connect(broker.url, NS, {
      username: agent,
      password: pw(agent),
    });
    try {
      const r = await client.request("peer_remove", { name: "box-a" });
      expect(r).toMatchObject({ ok: false });
    } finally {
      await client.close();
    }
    // Its own ops topic: no account, refused. An admin's: the broker drops it.
    expect(await op(agent, { op: "peer_remove", name: "box-a" })).toMatchObject({ ok: false });
    expect(
      await op(agent, { op: "peer_remove", name: "box-a" }, authOpsTopic("admin-1")),
    ).toBeNull();
    expect(auth.accounts.get("box-a")).toBe("peer");
    expect(auth.argvs(["volley", "auth", "revoke"])).toEqual([]);
  });
});

describe("shared with volley-cli's peer.ts", () => {
  it("the peer service's mirrored defaults agree with volleyd's", async () => {
    // A test-only cross-check: the CLI cannot import volleyd (volleyd depends on it).
    const cli = await import(
      new URL("../../volley-cli/src/commands/peer.ts", import.meta.url).href
    );
    expect(cli.PEER_DEFAULTS.remote_port).toBe(REMOTE_HOST_DEFAULTS.remote_port);
    expect(cli.PEER_DEFAULTS.heartbeat_ms).toBe(DAEMON_DEFAULTS.machine_heartbeat_ms);
    expect(cli.PEER_DEFAULTS.heartbeat_ms).toBeLessThan(DAEMON_DEFAULTS.machine_down_after_ms);
    expect(cli.PEER_DEFAULTS.ssh_connect_timeout_s).toBe(DAEMON_DEFAULTS.ssh_connect_timeout_s);
    expect(cli.PEER_DEFAULTS.ssh_alive_interval_s).toBe(DAEMON_DEFAULTS.ssh_alive_interval_s);
    expect(cli.machineTopic("box-a")).toBe("volley/_system/machines/box-a");
  });
});
