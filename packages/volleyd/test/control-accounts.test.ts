import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { AUTH_REDEEM_TOPIC, authOpsTopic, authReplyTopic } from "../src/accounts";
import type { Daemon } from "../src/daemon";
import { Daemon as DaemonClass } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE } from "./helpers/daemon-env";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";

const NS = "accounts-test";
const pw = (u: string) => `${u}-pw`;
const USERS = ["volleyd", "admin-1", "steer-1", "redeem-0000abcd", "redeem-0000beef"];

/**
 * What `volley auth` does, in memory: the daemon only ever runs it through the fenced exec, so
 * the fake answers its argv the way the real CLI prints (volley-cli's auth.test.ts covers that).
 */
function fakeAuth(): FakeExec & { accounts: Map<string, string>; tokens: Map<string, Tok> } {
  const accounts = new Map<string, string>([
    ["admin-1", "admin"],
    ["steer-1", "steer"],
  ]);
  const tokens = new Map<string, Tok>([
    ["vly_admin_0000abcd_secret", { id: "0000abcd", role: "admin", state: "fresh" }],
    ["vly_admin_0000beef_old", { id: "0000beef", role: "admin", state: "expired" }],
  ]);
  let n = 0;
  const fail = (stderr: string) => ({ code: 1, stderr });
  const ok = (o: unknown) => ({ stdout: `${JSON.stringify(o)}\n` });
  const fake = fakeExec().on(["volley", "auth"], (argv, opts) => {
    const verb = argv[2];
    const flag = (f: string) => argv[argv.indexOf(f) + 1] as string;
    switch (verb) {
      case "list":
        return ok({
          accounts: [...accounts].map(([name, role]) => ({
            name,
            role,
            kind: "device",
            created: "2026-10-18T12:00:00.000Z",
          })),
        });
      case "add": {
        const name = argv[3] as string;
        if (accounts.has(name)) return fail(`volley auth: "${name}" already exists`);
        accounts.set(name, flag("--role"));
        n++;
        return ok({ username: name, password: `minted-${n}`, role: flag("--role") });
      }
      case "rotate": {
        const name = argv[3] as string;
        if (!accounts.has(name)) return fail(`volley auth: no account "${name}"`);
        n++;
        return ok({ username: name, password: `minted-${n}`, role: accounts.get(name) });
      }
      case "revoke": {
        const name = argv[3] as string;
        if (!accounts.delete(name)) return fail(`volley auth: no account "${name}"`);
        return {};
      }
      case "signin-link": {
        n++;
        const id = `5160000${n}`;
        const token = `vly_signin_${id}_s${n}`;
        tokens.set(token, { id, role: flag("--role"), state: "fresh" });
        return ok({
          token,
          username: `redeem-${id}`,
          expires_at: "2026-10-18T12:10:00.000Z",
        });
      }
      case "redeem": {
        const t = tokens.get((opts.input ?? "").trim());
        if (t === undefined) return fail("volley auth: invalid token");
        if (t.state === "used") return fail(`volley auth: token ${t.id} was already used`);
        if (t.state === "expired") return fail(`volley auth: token ${t.id} expired`);
        t.state = "used";
        const name = `${t.role}-${t.id}`;
        accounts.set(name, t.role);
        n++;
        return ok({
          username: name,
          password: `minted-${n}`,
          role: t.role,
          label: flag("--label"),
          token_id: t.id,
        });
      }
      default:
        return fail(`unexpected ${argv.join(" ")}`);
    }
  });
  return Object.assign(fake, { accounts, tokens });
}

interface Tok {
  id: string;
  role: string;
  state: "fresh" | "used" | "expired";
}

/** The broker ACL the shipped acl.conf would apply, reduced to the auth topics. */
function canPublish(user: string | undefined, topic: string): boolean {
  if (user === "volleyd") return true;
  if (topic.startsWith("volley/_system/auth/ops/")) return topic === authOpsTopic(user ?? "");
  if (topic === AUTH_REDEEM_TOPIC) return user?.startsWith("redeem-") === true;
  if (user?.startsWith("redeem-")) return false;
  return !topic.startsWith("volley/_system/auth/");
}

describe("account control ops (admin role, sealed secrets, journaled)", () => {
  let broker: TestBroker;
  let home: string;
  let auth: ReturnType<typeof fakeAuth>;
  let daemon: Daemon;
  const clients: VolleyBroker[] = [];
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const replyKey = keys.publicKey.export({ format: "jwk" });
  const unseal = (sealed: unknown) =>
    JSON.parse(
      privateDecrypt(
        { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(sealed as string, "base64url"),
      ).toString("utf-8"),
    );

  beforeEach(async () => {
    broker = await startTestBroker({
      users: Object.fromEntries(USERS.map((u) => [u, pw(u)])),
      canPublish,
    });
    home = mkdtempSync(join(tmpdir(), "volleyd-accounts-"));
    auth = fakeAuth();
    daemon = await DaemonClass.start({
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
      // A client the ACL refused was disconnected by Aedes: do not wait on its clean DISCONNECT.
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      c.simulateCrash();
    }
    await daemon.stop();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Publish one auth request as `user` on `topic`; resolve with the reply payload (or null). */
  async function request(
    user: string,
    topic: string,
    payload: Record<string, unknown>,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown> | null> {
    const c = new VolleyBroker();
    const agentId = `desk-${randomUUID().slice(0, 6)}`;
    await c.connect({ url: broker.url, agentId, username: user, password: pw(user) });
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
      agentId,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload,
    });
    // Not awaited: a publish the broker ACL refuses is never PUBACKed by Aedes.
    void c.publish(topic, JSON.stringify(env), { qos: 1, retain: false }).catch(() => {});
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const r = await reply;
    clearTimeout(timer);
    return r;
  }
  const op = (user: string, payload: Record<string, unknown>, timeoutMs?: number) =>
    request(user, authOpsTopic(user), { reply_key: replyKey, ...payload }, timeoutMs);
  const systemEvents = () => readJournalFile(join(home, "waves", "_system", "journal.jsonl"));

  it("account_create from an admin returns the password once, sealed, and journals `by`", async () => {
    const r = await op("admin-1", { op: "account_create", name: "phone", role: "steer" });
    expect(r).toMatchObject({
      ok: true,
      op: "account_create",
      result: { name: "phone", role: "steer" },
    });
    expect(JSON.stringify(r)).not.toContain("minted-1"); // only inside the sealed blob
    expect(unseal(r?.sealed)).toEqual({ username: "phone", password: "minted-1" });
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([
      ["volley", "auth", "add", "phone", "--role", "steer", "--json"],
    ]);
    const ev = systemEvents().find((e) => e.type === "account_created");
    expect(ev?.data).toEqual({ by: "admin-1", name: "phone", role: "steer" });
    expect(typeof ev?.at).toBe("string");
  });

  it("the same op from a steer sender is refused with a reason, and nothing runs", async () => {
    const r = await op("steer-1", { op: "account_create", name: "phone", role: "steer" });
    expect(r).toMatchObject({ ok: false, op: "account_create" });
    expect(r?.error).toMatch(/steer-1.*steer.*admin/);
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([]);
    expect(systemEvents().some((e) => e.type === "account_created")).toBe(false);
  });

  it("a sender with no account is refused", async () => {
    auth.accounts.delete("admin-1");
    const r = await op("admin-1", { op: "account_list" });
    expect(r).toMatchObject({ ok: false });
    expect(r?.error).toContain("no account");
  });

  it("a steer client cannot impersonate an admin: the broker drops its publish on another's ops topic", async () => {
    const r = await request(
      "steer-1",
      authOpsTopic("admin-1"),
      {
        op: "account_create",
        name: "phone",
        role: "admin",
        reply_key: replyKey,
      },
      600,
    );
    expect(r).toBeNull();
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([]);
  });

  it("account_list, account_rotate and account_revoke (journaled)", async () => {
    const list = await op("admin-1", { op: "account_list" });
    expect(list).toMatchObject({ ok: true });
    expect((list?.result as { accounts: { name: string }[] }).accounts.map((a) => a.name)).toEqual([
      "admin-1",
      "steer-1",
    ]);

    const rot = await op("admin-1", { op: "account_rotate", name: "steer-1" });
    expect(rot).toMatchObject({ ok: true, result: { name: "steer-1" } });
    expect(unseal(rot?.sealed)).toEqual({ username: "steer-1", password: "minted-1" });

    const rev = await op("admin-1", { op: "account_revoke", name: "steer-1" });
    expect(rev).toMatchObject({ ok: true, result: { name: "steer-1" } });
    expect(rev?.sealed).toBeUndefined();
    expect(auth.accounts.has("steer-1")).toBe(false);

    const gone = await op("admin-1", { op: "account_revoke", name: "steer-1" });
    expect(gone).toMatchObject({ ok: false });
    expect(gone?.error).toContain("no account");

    const types = systemEvents().map((e) => [e.type, e.data]);
    expect(types).toContainEqual(["account_rotated", { by: "admin-1", name: "steer-1" }]);
    expect(types).toContainEqual(["account_revoked", { by: "admin-1", name: "steer-1" }]);
  });

  it("refuses an op that returns a secret without a usable reply_key, before running anything", async () => {
    for (const reply_key of [undefined, { kty: "oct", k: "abc" }, "not-a-key"]) {
      const r = await request("admin-1", authOpsTopic("admin-1"), {
        op: "account_create",
        name: "phone",
        role: "steer",
        ...(reply_key !== undefined ? { reply_key } : {}),
      });
      expect(r).toMatchObject({ ok: false });
      expect(r?.error).toContain("reply_key");
    }
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([]);
  });

  it("rejects invalid op arguments with a reason", async () => {
    for (const p of [
      { op: "account_create", name: "Bad Name", role: "steer" },
      { op: "account_create", name: "phone", role: "agent" },
      { op: "account_rotate" },
      { op: "nope" },
    ]) {
      const r = await op("admin-1", p);
      expect(r, JSON.stringify(p)).toMatchObject({ ok: false });
      expect(typeof r?.error).toBe("string");
    }
    expect(auth.argvs(["volley", "auth", "add"])).toEqual([]);
  });

  describe("token_redeem", () => {
    const redeem = (user: string, token: string) =>
      request(user, AUTH_REDEEM_TOPIC, {
        op: "token_redeem",
        token,
        label: "Desk on mac",
        reply_key: replyKey,
      });

    it("a valid token mints an admin credential bound to the label and burns the token", async () => {
      const r = await redeem("redeem-0000abcd", "vly_admin_0000abcd_secret");
      expect(r).toMatchObject({
        ok: true,
        op: "token_redeem",
        result: { username: "admin-0000abcd", role: "admin", label: "Desk on mac" },
      });
      expect(unseal(r?.sealed)).toEqual({ username: "admin-0000abcd", password: "minted-1" });
      expect(JSON.stringify(r)).not.toContain("vly_admin_0000abcd_secret");
      // The token reaches `volley auth redeem` on stdin, never on its argv.
      const call = auth.calls.find((c) => c.argv[2] === "redeem");
      expect(call?.argv).toEqual(["volley", "auth", "redeem", "--label", "Desk on mac", "--json"]);
      expect(call?.opts.input).toBe("vly_admin_0000abcd_secret\n");
      expect(systemEvents().find((e) => e.type === "token_redeemed")?.data).toEqual({
        by: "redeem-0000abcd",
        name: "admin-0000abcd",
        role: "admin",
        label: "Desk on mac",
      });

      const again = await redeem("redeem-0000abcd", "vly_admin_0000abcd_secret");
      expect(again).toMatchObject({ ok: false });
      expect(again?.error).toContain("already used");
    });

    it("an expired or unknown token is refused", async () => {
      const expired = await redeem("redeem-0000beef", "vly_admin_0000beef_old");
      expect(expired).toMatchObject({ ok: false });
      expect(expired?.error).toContain("expired");
      const unknown = await redeem("redeem-0000beef", "vly_admin_0000beef_guess");
      expect(unknown?.error).toContain("invalid token");
      expect(systemEvents().some((e) => e.type === "token_redeemed")).toBe(false);
    });

    it("token_redeem is answered only on the redeem topic, never as an account op", async () => {
      const r = await op("admin-1", {
        op: "token_redeem",
        token: "vly_admin_0000abcd_secret",
        label: "x",
      });
      expect(r).toMatchObject({ ok: false });
      expect(auth.calls.some((c) => c.argv[2] === "redeem")).toBe(false);
    });
  });

  it("signin_link yields a single-use link whose redemption is a steer credential", async () => {
    const r = await op("admin-1", {
      op: "signin_link",
      role: "steer",
      label: "Alfred's phone",
      ttl_s: 300,
      desk_url: "https://desk.example/",
    });
    expect(r).toMatchObject({ ok: true, result: { role: "steer", label: "Alfred's phone" } });
    const secret = unseal(r?.sealed) as { token: string; link: string };
    expect(secret.link).toBe(`https://desk.example/#signin=${secret.token}`);
    expect(auth.argvs(["volley", "auth", "signin-link"])).toEqual([
      [
        "volley",
        "auth",
        "signin-link",
        "--role",
        "steer",
        "--label",
        "Alfred's phone",
        "--ttl",
        "300",
        "--json",
      ],
    ]);
    expect(systemEvents().find((e) => e.type === "signin_link_issued")?.data).toMatchObject({
      by: "admin-1",
      role: "steer",
      label: "Alfred's phone",
    });

    // Who publishes the redeem request does not matter to the daemon, only the token: the
    // token's own `redeem-<id>` login is the CLI's to mint, so use a known one here.
    const redeemAs = () =>
      request("redeem-0000abcd", AUTH_REDEEM_TOPIC, {
        op: "token_redeem",
        token: secret.token,
        label: "iPhone",
        reply_key: replyKey,
      });
    const redeemed = await redeemAs();
    expect(redeemed).toMatchObject({ ok: true, result: { role: "steer" } });
    const twice = await redeemAs();
    expect(twice).toMatchObject({ ok: false });
  });

  it("signin_link refuses an operator-level role", async () => {
    for (const role of ["admin", "supervisor", "peer"]) {
      const r = await op("admin-1", { op: "signin_link", role, label: "x" });
      expect(r).toMatchObject({ ok: false });
    }
    expect(auth.argvs(["volley", "auth", "signin-link"])).toEqual([]);
  });
});
