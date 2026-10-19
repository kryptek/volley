import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { readJournalFile } from "../src/journal";
import type { MachineRecord } from "../src/machines";
import { PeerService, isPairingCode, normalizeCode } from "../src/peers";
import type { NewEvent, RemoteHostConfig } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
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
  let peers: PeerService;

  const make = () =>
    new PeerService({
      exec: auth.exec,
      now: () => now,
      file: join(dir, "peer-codes.json"),
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
      machines: (): MachineRecord[] => [],
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
    peers = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("codes are XXXX-XXXX; normalisation accepts lower case and a missing dash", () => {
    expect(isPairingCode("ABCD-EF23")).toBe(true);
    expect(isPairingCode("ABCD-EF2")).toBe(false);
    expect(normalizeCode(" abcd ef23 ")).toBe("ABCDEF23");
    expect(normalizeCode("abcd-ef23")).toBe("ABCDEF23");
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
      data: { by: "box-a", name: "box-a", target: "dev@box-a", os: "linux", cores: 8 },
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

  it("invite → join → the host is in the retained config; remove → gone, record cleared", async () => {
    const inv = await client.request("peer_invite", { reply_key: REPLY_KEY });
    expect(inv.ok).toBe(true);
    const code = unseal(inv.sealed).code as string;
    expect(isPairingCode(code)).toBe(true);

    const joined = await client.request("peer_join", {
      code,
      name: "box-a",
      target: "dev@box-a",
      volley_dir: "/opt/volley",
      reply_key: REPLY_KEY,
    });
    expect(joined).toMatchObject({
      ok: true,
      result: { name: "box-a", namespace: NS, remote_port: REMOTE_HOST_DEFAULTS.remote_port },
    });
    const port = Number(new URL(env.broker.url).port);
    expect((joined.result as { broker: unknown }).broker).toEqual({ host: "127.0.0.1", port });
    expect(unseal(joined.sealed)).toMatchObject({ username: "box-a" });
    const config = (await env.retained("volley/_waves/_config")) as {
      payload: { hosts: Record<string, RemoteHostConfig> };
    };
    expect(config.payload.hosts["box-a"]).toMatchObject({
      target: "dev@box-a",
      tunnel: { supervise: false },
    });
    const system = readJournalFile(join(env.home, "waves", "_system", "journal.jsonl"));
    expect(system.map((e) => e.type)).toEqual(
      expect.arrayContaining(["peer_invited", "config_changed", "peer_joined"]),
    );

    const removed = await client.request("peer_remove", { name: "box-a" });
    expect(removed).toMatchObject({ ok: true, result: { revoked: true, host_removed: true } });
    const after = (await env.retained("volley/_waves/_config")) as {
      payload: { hosts: Record<string, RemoteHostConfig> };
    };
    expect(after.payload.hosts).toEqual({});
    expect(readFileSync(join(env.home, "config.yaml"), "utf-8")).not.toContain("box-a");
  });
});
