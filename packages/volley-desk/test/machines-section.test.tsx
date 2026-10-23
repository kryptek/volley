import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInGate } from "../src/auth/SignInGate";
import { Machines, type MachinesProps, sshHost } from "../src/settings/Machines";
import { CREDENTIALS_STORAGE_KEY } from "../src/store/context";
import { type ReplyKey, createAuthOps } from "../src/store/control";
import { DESK_SUBSCRIPTIONS } from "../src/store/mqtt-client";
import {
  ADMIN_PROBE_TIMEOUT_MS,
  type AdminStatus,
  type PeerInvite,
  type PeerOps,
  createPeerOps,
  joinCommand,
  pairingSupported,
} from "../src/store/peerOps";
import { initialState, localAgentCount, reduceAll, resync } from "../src/store/reducer";
import type { DeskMessage, Envelope, MachinePayload } from "../src/store/types";
import { connectingFactory } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";

const NOW = Date.parse("2026-10-19T09:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/**
 * For a test that makes a real lib/rsa key: the prime search is random, so its time has a long
 * tail, and on a loaded CI runner (1–4 s typical there) it went past the default 10 s.
 */
const KEYGEN_TIMEOUT_MS = 60_000;

const boxA: MachinePayload = {
  name: "box-a",
  os: "linux",
  arch: "x64",
  cores: 16,
  tunnel: "up",
  load: [1.25, 0.9, 0.7],
  agents: 3,
  remote_port: 21883,
  last_seen: iso(NOW - 20_000),
};

const boxB: MachinePayload = {
  name: "box-b",
  os: "darwin",
  cores: 8,
  tunnel: "down",
  reason: "heartbeat_timeout",
  load: [0.4, 0.3, 0.2],
  agents: 0,
  last_seen: iso(NOW - 5 * 60_000),
};

const boxC: MachinePayload = {
  name: "box-c",
  os: "linux",
  cores: 4,
  tunnel: "up",
  load: [0.1, 0.1, 0.1],
  agents: 0,
  last_seen: iso(NOW),
};

function machineMsg(p: MachinePayload | null, name = p?.name ?? "", agentId = name): DeskMessage {
  return {
    topic: `volley/_system/machines/${name}`,
    envelope:
      p === null
        ? null
        : {
            schema_version: "0.1",
            agent_id: agentId,
            channel: "_system/machines",
            type: "machine",
            wall_time: iso(NOW),
            payload: p,
          },
    receivedAt: NOW,
    retained: true,
  };
}

describe("reducer: the machines slice", () => {
  it("keeps one retained record per machine and forgets a cleared one (peer_remove)", () => {
    const s = reduceAll(initialState(), [machineMsg(boxA), machineMsg(boxB)]);
    expect(Object.keys(s.machines ?? {})).toEqual(["box-a", "box-b"]);
    expect(s.machines?.["box-a"]).toEqual(boxA);
    const cleared = reduceAll(s, [machineMsg(null, "box-a")]);
    expect(Object.keys(cleared.machines ?? {})).toEqual(["box-b"]);
  });

  it("takes volleyd's own down record for a machine, but nobody else's", () => {
    const down = { ...boxA, tunnel: "down" as const, reason: "heartbeat_timeout" as const };
    let s = reduceAll(initialState(), [machineMsg(boxA), machineMsg(down, "box-a", "volleyd")]);
    expect(s.machines?.["box-a"]?.tunnel).toBe("down");
    s = reduceAll(s, [machineMsg({ ...boxA, agents: 99 }, "box-a", "box-b")]);
    expect(s.machines?.["box-a"]?.agents).toBe(3);
  });

  it("drops a record whose name is not its topic's or that is not a machine record", () => {
    const s = reduceAll(initialState(), [
      machineMsg({ ...boxA, name: "box-z" }, "box-a", "box-a"),
      { ...machineMsg(boxC), envelope: { ...(machineMsg(boxC).envelope as Envelope), type: "x" } },
    ]);
    expect(s.machines ?? {}).toEqual({});
  });

  it("a disconnect record (the LWT, built at connect time) keeps the last heartbeat's load, agents and last_seen", () => {
    const lwt: MachinePayload = {
      ...boxA,
      tunnel: "down",
      reason: "disconnect",
      load: [0, 0, 0],
      agents: 0,
      last_seen: iso(NOW - 5 * 3600_000),
    };
    const s = reduceAll(initialState(), [machineMsg(boxA), machineMsg(lwt)]);
    expect(s.machines?.["box-a"]).toEqual({
      ...boxA,
      tunnel: "down",
      reason: "disconnect",
    });
    // A later down record (volleyd's, after the heartbeat stops) still moves last_seen on.
    const later = { ...lwt, reason: "heartbeat_timeout" as const, last_seen: iso(NOW + 60_000) };
    const s2 = reduceAll(s, [machineMsg(later, "box-a", "volleyd")]);
    expect(s2.machines?.["box-a"]).toMatchObject({
      reason: "heartbeat_timeout",
      load: boxA.load,
      agents: 3,
      last_seen: iso(NOW + 60_000),
    });
    // With no up record before it (a page loaded after the drop) it is taken as is.
    expect(reduceAll(initialState(), [machineMsg(lwt)]).machines?.["box-a"]).toEqual(lwt);
  });

  it("counts this machine's agents: live ones whose task names no remote host", () => {
    const wave = (tasks: Record<string, unknown>[]): DeskMessage => ({
      topic: "volley/_waves/w1/state",
      envelope: {
        schema_version: "0.1",
        agent_id: "volleyd",
        channel: "_waves/state",
        type: "wave-state",
        wall_time: iso(NOW),
        payload: {
          wave: "w1",
          version: 1,
          owner: null,
          repo: "r",
          release_branch: "b",
          status: "running",
          tasks,
          open_decisions: [],
          gates: [],
          updated_at: iso(NOW),
        },
      },
      receivedAt: NOW,
      retained: true,
    });
    const status = (id: string, type: string): DeskMessage => ({
      topic: `volley/default/${id}/status`,
      envelope: {
        schema_version: "0.1",
        agent_id: id,
        channel: "status",
        type,
        wall_time: iso(NOW),
        payload: {},
      },
      receivedAt: NOW,
      retained: true,
    });
    const s = reduceAll(initialState(), [
      wave([
        { id: "t1", issue: 1, stage: "implementing", agents: { implementer: "w1-t1-impl" } },
        {
          id: "t2",
          issue: 2,
          stage: "implementing",
          host: "box-a",
          agents: { implementer: "w1-t2-impl" },
        },
        { id: "t3", issue: 3, stage: "done", agents: { implementer: "w1-t3-impl" } },
      ]),
      status("w1-t1-impl", "working"),
      status("w1-t2-impl", "working"),
      status("w1-t3-impl", "done"),
    ]);
    expect(localAgentCount(s)).toBe(1);
  });

  it("is retained state: a reconnect resync forgets it until the replay", () => {
    const s = resync(reduceAll(initialState(), [machineMsg(boxA)]));
    expect(s.machines).toEqual({});
  });

  it("the Desk subscribes to the machine records and the account-op answers", () => {
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_system/machines/#");
    expect(DESK_SUBSCRIPTIONS).toContain("volley/_system/auth/replies/+");
  });
});

// ------------------------------------------------------------- the op client

/** A SteerClient stand-in: records publishes, delivers what the test plays as volleyd. */
function fakeClient() {
  const handlers = new Set<(m: DeskMessage) => void>();
  const published: { topic: string; env: Envelope }[] = [];
  const waiters = new Set<() => void>();
  return {
    published,
    /** Resolves once `n` requests have been published; event-driven, so key generation may take any time. */
    until(n: number): Promise<void> {
      if (published.length >= n) return Promise.resolve();
      return new Promise((resolve) => {
        const w = () => {
          if (published.length < n) return;
          waiters.delete(w);
          resolve();
        };
        waiters.add(w);
      });
    },
    publish: vi.fn(async (topic: string, payload: string) => {
      published.push({ topic, env: JSON.parse(payload) as Envelope });
      for (const w of [...waiters]) w();
    }),
    onMessage(h: (m: DeskMessage) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    /** Answer the last request as `from` (volleyd by default). */
    answer(payload: Record<string, unknown>, from = "volleyd") {
      const req = published.at(-1)?.env as Envelope;
      const msg: DeskMessage = {
        topic: `volley/_system/auth/replies/${req.correlation_id}`,
        envelope: {
          schema_version: "0.1",
          agent_id: from,
          channel: "_system/auth",
          type: "ack",
          wall_time: iso(NOW),
          correlation_id: req.correlation_id as string,
          payload: { text: "ACKED", acked_type: "query", ...payload },
        },
        receivedAt: NOW,
      };
      for (const h of handlers) h(msg);
    },
  };
}

/** Seal `secret` to the request's reply_key exactly as volleyd does (accounts.ts `seal`). */
function sealTo(req: Envelope, secret: Record<string, unknown>): string {
  const jwk = (req.payload as { reply_key: unknown }).reply_key;
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(JSON.stringify(secret)),
  ).toString("base64url");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Wait until the client has published `n` requests. Key generation is async and, with real RSA keys,
 * its duration depends on the machine (a loaded CI runner took longer than any fixed tick count),
 * so this waits on the publish itself; the test's own timeout bounds it.
 */
async function published(c: ReturnType<typeof fakeClient>, n: number) {
  await c.until(n);
  expect(c.published.length).toBe(n);
  return c.published[n - 1] as { topic: string; env: Envelope };
}

/** A reply key that opens nothing: for requests whose answers carry no secret. */
const stubKey = async (): Promise<ReplyKey> => ({
  jwk: { kty: "RSA", n: "n", e: "AQAB" },
  open: async () => ({}),
});

/** The pairing ops as App builds them: over the Desk's admin channel (`createAuthOps`). */
function peerOps(
  c: ReturnType<typeof fakeClient>,
  o: {
    identity?: string;
    role?: string;
    probeTimeoutMs?: number;
    replyKey?: () => Promise<ReplyKey>;
  } = {},
) {
  const auth = createAuthOps(c, {
    identity: o.identity ?? "owner-desk",
    now: () => new Date(NOW),
    ...(o.replyKey ? { replyKey: o.replyKey } : {}),
  });
  return createPeerOps(auth, {
    now: () => new Date(NOW),
    ...(o.role !== undefined ? { role: o.role } : {}),
    ...(o.probeTimeoutMs !== undefined ? { probeTimeoutMs: o.probeTimeoutMs } : {}),
  });
}

/** A page without WebCrypto, as a phone on plain http sees it: only `getRandomValues`. */
function plainHttp() {
  const { getRandomValues } = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(globalThis.crypto) });
  vi.stubGlobal("isSecureContext", false);
}

describe("peer ops: admin requests on the Desk's admin channel", () => {
  it("peer_invite goes to volley/_system/auth/ops/<identity> with a reply_key; the sealed code is opened", async () => {
    const c = fakeClient();
    const ops = peerOps(c);
    const pending = ops.invite();
    const req = await published(c, 1);
    expect(req.topic).toBe("volley/_system/auth/ops/owner-desk");
    expect(req.env).toMatchObject({
      agent_id: "owner-desk",
      channel: "_system/auth",
      type: "query",
      payload: { op: "peer_invite" },
    });
    expect(req.env.correlation_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const key = (req.env.payload as { reply_key: Record<string, unknown> }).reply_key;
    expect(key).toMatchObject({ kty: "RSA", n: expect.any(String), e: expect.any(String) });
    // The public half only.
    for (const k of ["d", "p", "q", "dp", "dq", "qi"]) expect(key).not.toHaveProperty(k);
    // A forged answer from anyone but volleyd is ignored.
    c.answer(
      { op: "peer_invite", ok: true, sealed: sealTo(req.env, { code: "XXXX-XXXX" }) },
      "box-a",
    );
    const expires = iso(NOW + 600_000);
    c.answer({
      op: "peer_invite",
      ok: true,
      result: { expires_at: expires, ttl_s: 600 },
      sealed: sealTo(req.env, { code: "MXQ4-7KDP" }),
    });
    await expect(pending).resolves.toEqual({ ok: true, code: "MXQ4-7KDP", expiresAt: expires });
  });

  it("rides the same admin channel as the account ops: one reply key per session", async () => {
    const c = fakeClient();
    const auth = createAuthOps(c, { identity: "owner-desk", timeoutMs: 20 });
    await auth.request("account_list");
    const pending = createPeerOps(auth).invite();
    const req = await published(c, 2);
    const keyOf = (env: Envelope) => (env.payload as { reply_key: unknown }).reply_key;
    expect(keyOf(req.env)).toEqual(keyOf((c.published[0] as { env: Envelope }).env));
    c.answer({ op: "peer_invite", ok: true, sealed: sealTo(req.env, { code: "MXQ4-7KDP" }) });
    await expect(pending).resolves.toMatchObject({ ok: true, code: "MXQ4-7KDP" });
  });

  it("a refused invite, and one whose answer carries no code, say why", async () => {
    const c = fakeClient();
    const ops = peerOps(c);
    const refused = ops.invite();
    await published(c, 1);
    c.answer({ op: "peer_invite", ok: false, error: "owner-desk is not an admin account" });
    await expect(refused).resolves.toEqual({
      ok: false,
      error: "owner-desk is not an admin account",
    });
    const empty = ops.invite();
    await published(c, 2);
    c.answer({ op: "peer_invite", ok: true, result: {} });
    await expect(empty).resolves.toMatchObject({ ok: false, error: /no pairing code/ });
  });

  it("peer_remove sends the name and resolves with volleyd's answer", async () => {
    const c = fakeClient();
    const ops = peerOps(c, { replyKey: stubKey });
    const r = ops.remove("box-a");
    const req = await published(c, 1);
    expect(req.env.payload).toMatchObject({ op: "peer_remove", name: "box-a" });
    c.answer({ op: "peer_remove", ok: true, result: { revoked: true, host_removed: true } });
    await expect(r).resolves.toEqual({ ok: true });
  });

  it("peer_remove with drain or now sends that flag and reports what volleyd started", async () => {
    const c = fakeClient();
    const ops = peerOps(c, { replyKey: stubKey });
    const drain = ops.remove("box-a", "drain");
    const req = await published(c, 1);
    expect(req.env.payload).toMatchObject({ op: "peer_remove", name: "box-a", drain: true });
    expect(req.env.payload).not.toHaveProperty("now");
    c.answer({
      op: "peer_remove",
      ok: true,
      result: { name: "box-a", removing: "drain", agents: 2, revoked: false, host_removed: false },
    });
    await expect(drain).resolves.toEqual({ ok: true, removing: "drain", agents: 2 });
    const now = ops.remove("box-a", "now");
    const req2 = await published(c, 2);
    expect(req2.env.payload).toMatchObject({ op: "peer_remove", name: "box-a", now: true });
    c.answer({ op: "peer_remove", ok: true, result: { revoked: true, host_removed: true } });
    await expect(now).resolves.toEqual({ ok: true });
  });

  it("a re-pairing invite names the machine (`for`)", async () => {
    const c = fakeClient();
    const pending = peerOps(c).invite("box-a");
    const req = await published(c, 1);
    expect(req.env.payload).toMatchObject({ op: "peer_invite", for: "box-a" });
    c.answer({ op: "peer_invite", ok: true, sealed: sealTo(req.env, { code: "MXQ4-7KDP" }) });
    await expect(pending).resolves.toMatchObject({ ok: true, code: "MXQ4-7KDP" });
  });

  it("peer_doctor runs the doctor (dry run or fix) and returns its checks and plan", async () => {
    const c = fakeClient();
    const ops = peerOps(c, { replyKey: stubKey });
    const dry = ops.doctor("box-a", { fix: false });
    const req = await published(c, 1);
    expect(req.env.payload).toMatchObject({
      op: "peer_doctor",
      name: "box-a",
      fix: false,
      clone: false,
    });
    const check = { id: "gh.auth", ok: false, severity: "block", detail: "gh is not signed in" };
    c.answer({
      op: "peer_doctor",
      ok: true,
      result: {
        name: "box-a",
        fix: false,
        checks: [check],
        doctor_at: iso(NOW),
        plan: [{ ...check, fix: "gh auth login" }],
      },
    });
    await expect(dry).resolves.toEqual({
      ok: true,
      checks: [check],
      plan: [{ ...check, fix: "gh auth login" }],
      doctorAt: iso(NOW),
    });
    const fix = ops.doctor("box-a", { fix: true, clone: true });
    const req2 = await published(c, 2);
    expect(req2.env.payload).toMatchObject({ op: "peer_doctor", fix: true, clone: true });
    c.answer({ op: "peer_doctor", ok: false, error: "ssh: connect to host box-a: timed out" });
    await expect(fix).resolves.toEqual({
      ok: false,
      error: "ssh: connect to host box-a: timed out",
    });
  });

  it("admin(): an answered account_list proves an admin; it asks once and then knows", async () => {
    const c = fakeClient();
    const ops = peerOps(c, { replyKey: stubKey });
    expect(ops.known()).toBeNull();
    const yes = ops.admin();
    const req = await published(c, 1);
    expect(req.env.payload).toMatchObject({ op: "account_list" });
    c.answer({ op: "account_list", ok: true, result: { accounts: [] } });
    await expect(yes).resolves.toBe("admin");
    expect(ops.known()).toBe("admin");
    await expect(ops.admin()).resolves.toBe("admin");
    expect(c.published).toHaveLength(1);
  });

  it("admin(): a yes is stored with the sign-in, so Setup & Security knows it too", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "owner-desk", password: "pw" }),
    );
    try {
      const c = fakeClient();
      const yes = peerOps(c, { replyKey: stubKey }).admin();
      await published(c, 1);
      c.answer({ op: "account_list", ok: true, result: { accounts: [] } });
      await expect(yes).resolves.toBe("admin");
      expect(JSON.parse(localStorage.getItem(CREDENTIALS_STORAGE_KEY) ?? "{}")).toMatchObject({
        username: "owner-desk",
        role: "admin",
      });
    } finally {
      localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
    }
  });

  it("admin(): volleyd's refusal is a definite no, and it is kept", async () => {
    const refusing = fakeClient();
    const ops = peerOps(refusing, { identity: "watcher", replyKey: stubKey });
    const no = ops.admin();
    await published(refusing, 1);
    refusing.answer({ op: "account_list", ok: false, error: "watcher is not an admin account" });
    await expect(no).resolves.toBe("not-admin");
    await expect(ops.admin()).resolves.toBe("not-admin");
    expect(refusing.published).toHaveLength(1);
  });

  it("admin(): no answer is not a no; it is not kept, so the next ask asks again", async () => {
    const quiet = fakeClient();
    const ops = peerOps(quiet, { probeTimeoutMs: 20, replyKey: stubKey });
    await expect(ops.admin()).resolves.toBe("no-answer");
    expect(ops.known()).toBeNull();
    const again = ops.admin();
    await published(quiet, 2);
    quiet.answer({ op: "account_list", ok: true, result: { accounts: [] } });
    await expect(again).resolves.toBe("admin");
  });

  it("admin(): an unsent probe is not a no either", async () => {
    const c = fakeClient();
    c.publish.mockRejectedValueOnce(new Error("not connected"));
    const ops = peerOps(c, { replyKey: stubKey });
    await expect(ops.admin()).resolves.toBe("no-answer");
    expect(ops.known()).toBeNull();
  });

  it("admin(): the probe waits seconds, not the 30 s an op waits (account_list is a local read)", async () => {
    vi.useFakeTimers();
    try {
      const ops = peerOps(fakeClient(), { replyKey: stubKey });
      const r = ops.admin();
      await vi.advanceTimersByTimeAsync(ADMIN_PROBE_TIMEOUT_MS);
      await expect(r).resolves.toBe("no-answer");
      expect(ADMIN_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admin(): the fixed identities are never admins (SPEC §4.6.13): no ask, known at once", async () => {
    for (const identity of ["desk", "coordinator", "volleyd"]) {
      const c = fakeClient();
      const ops = peerOps(c, { identity });
      expect(ops.known()).toBe("not-admin");
      await expect(ops.admin()).resolves.toBe("not-admin");
      expect(c.published).toHaveLength(0);
    }
  });

  it("admin(): a role known from sign-in wins over the probe", async () => {
    const c = fakeClient();
    const admin = peerOps(c, { role: "admin" });
    expect(admin.known()).toBe("admin");
    await expect(admin.admin()).resolves.toBe("admin");
    const steer = peerOps(c, { identity: "phone", role: "steer" });
    expect(steer.known()).toBe("not-admin");
    await expect(steer.admin()).resolves.toBe("not-admin");
    expect(c.published).toHaveLength(0);
  });

  it("the code's expiry is counted from when the answer arrived (ttl_s), not volleyd's clock", async () => {
    const c = fakeClient();
    const ops = peerOps(c);
    const pending = ops.invite();
    const req = await published(c, 1);
    // volleyd's clock runs 4 minutes ahead of this browser's.
    c.answer({
      op: "peer_invite",
      ok: true,
      result: { expires_at: iso(NOW + 14 * 60_000), ttl_s: 600 },
      sealed: sealTo(req.env, { code: "MXQ4-7KDP" }),
    });
    await expect(pending).resolves.toMatchObject({ expiresAt: iso(NOW + 600_000) });
  });

  it(
    "on plain http (no WebCrypto, a phone on the LAN) pairing works: the reply key is lib/rsa's",
    async () => {
      plainHttp();
      try {
        expect(pairingSupported()).toBe(true);
        const c = fakeClient();
        const ops = peerOps(c);
        const pending = ops.invite();
        const req = await published(c, 1);
        expect(req.env.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
        c.answer({
          op: "peer_invite",
          ok: true,
          result: { ttl_s: 600 },
          sealed: sealTo(req.env, { code: "MXQ4-7KDP" }),
        });
        await expect(pending).resolves.toMatchObject({ ok: true, code: "MXQ4-7KDP" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it("a browser that cannot make a reply key at all: nothing throws, invite says why", async () => {
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("isSecureContext", false);
    try {
      expect(pairingSupported()).toBe(false);
      const c = fakeClient();
      const ops = peerOps(c, { probeTimeoutMs: 20 });
      await expect(ops.admin()).resolves.toBe("no-answer");
      await expect(ops.invite()).resolves.toMatchObject({ ok: false, error: /volley peer invite/ });
      expect(c.published).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(pairingSupported()).toBe(true);
  });

  it("the join command names the code and the ssh destination; never a shell placeholder", () => {
    expect(joinCommand("MXQ4-7KDP", "owner@hub.local")).toBe(
      "volley peer join MXQ4-7KDP --to owner@hub.local",
    );
    expect(joinCommand("MXQ4-7KDP", "  ")).toBe("volley peer join MXQ4-7KDP --to …");
  });
});

// ------------------------------------------------------------------ the section

type Known = ReturnType<PeerOps["known"]>;

function fakeOps(over: Partial<PeerOps> = {}) {
  return fakePeerOps({
    invite: vi.fn(async () => ({
      ok: true as const,
      code: "MXQ4-7KDP",
      expiresAt: iso(NOW + 600_000),
    })),
    ...over,
  });
}

function setup(props: Partial<MachinesProps> = {}) {
  const ops = fakeOps();
  const base: MachinesProps = {
    machines: { "box-a": boxA, "box-b": boxB },
    hosts: ["box-a", "box-b", "box-c"],
    hubUp: true,
    hubAgents: 2,
    ops,
    now: NOW,
    host: "hub.local",
    ...props,
  };
  const r = render(<Machines {...base} />);
  const rerender = (more: Partial<MachinesProps>) => r.rerender(<Machines {...base} {...more} />);
  return { ...r, ops: (props.ops as ReturnType<typeof fakeOps>) ?? ops, rerender };
}

const card = (name: string) => screen.getByRole("article", { name });
/** The join command as shown (its flags are wrapped so they never break at a hyphen). */
const command = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "CODE" && el.textContent === text);
const address = () => screen.getByLabelText("This machine's ssh address");

/** + Add a machine: the code is created at once (prototype), then the Join step shows. */
async function addMachine() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
  });
}

describe("Settings › Machines", () => {
  it("two retained machine records render two cards with their health, beside this machine", async () => {
    setup();
    await act(flush);
    const a = within(card("box-a"));
    expect(a.getByText("linux x64 · 16 cores")).toBeInTheDocument();
    expect(a.getByText("tunnel up")).toBeInTheDocument();
    expect(a.getByText("load 1.25")).toBeInTheDocument();
    expect(a.getByText("3 agents")).toBeInTheDocument();
    expect(a.getByText(/seen 20s ago/)).toBeInTheDocument();
    const b = within(card("box-b"));
    expect(b.getByText("darwin · 8 cores")).toBeInTheDocument();
    expect(b.getByText("tunnel down")).toHaveClass("hb", "hb--stale");
    expect(b.getByText("down · last seen 5m ago · no heartbeat")).toBeInTheDocument();
    expect(b.getByText(/new agents for it wait/i)).toBeInTheDocument();
    const hub = within(card("This machine"));
    expect(hub.getByText("this one")).toBeInTheDocument();
    expect(hub.getByText("local")).toBeInTheDocument();
    expect(hub.getByText("2 agents")).toBeInTheDocument();
    expect(hub.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("only configured hosts are machines (SPEC §4.6.14): another account's own record is not shown", async () => {
    const rogue: MachinePayload = { ...boxC, name: "phone" };
    setup({ machines: { "box-a": boxA, phone: rogue } });
    await act(flush);
    expect(card("box-a")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "phone" })).toBeNull();
  });

  it("+ Add a machine creates the code at once (peer_invite) and shows the command with a countdown", async () => {
    const { ops } = setup();
    await act(flush);
    await addMachine();
    expect(ops.invite).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Run this on the other machine")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the machine to join/)).toBeInTheDocument();
    // The ssh destination is this machine's, which only the owner knows: never a bare host guess.
    expect(address()).toHaveValue("");
    expect(address()).toHaveAttribute("placeholder", "you@hub.local");
    fireEvent.change(address(), { target: { value: "me@hub" } });
    expect(command("volley peer join MXQ4-7KDP --to me@hub")).toBeInTheDocument();
  });

  it("with no ssh address yet the command cannot be copied, and shows no shell placeholder", async () => {
    setup({ host: "" });
    await act(flush);
    await addMachine();
    expect(address()).toBeRequired();
    expect(address()).toHaveAttribute("placeholder", "you@hub-hostname");
    expect(command("volley peer join MXQ4-7KDP --to …")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeDisabled();
    expect(screen.getByText(/Enter this machine’s ssh address/)).toBeInTheDocument();
    fireEvent.change(address(), { target: { value: "owner@hub" } });
    expect(screen.getByRole("button", { name: /Copy/ })).toBeEnabled();
  });

  it("Cancel is off while the code is being created (closing would still mint one)", async () => {
    let answer: (v: PeerInvite) => void = () => {};
    const ops = fakeOps({
      invite: vi.fn(
        () =>
          new Promise<PeerInvite>((r) => {
            answer = r;
          }),
      ),
    });
    setup({ ops });
    await act(flush);
    await addMachine();
    expect(screen.getByText(/Creating a one-time pairing code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => answer({ ok: true, code: "MXQ4-7KDP", expiresAt: iso(NOW + 600_000) }));
    expect(screen.getByText("Run this on the other machine")).toBeInTheDocument();
  });

  it("the countdown runs out into an expired code that is no longer shown and offers a new one", async () => {
    const { rerender } = setup();
    await act(flush);
    await addMachine();
    fireEvent.change(address(), { target: { value: "me@hub" } });
    rerender({ now: NOW + 9 * 60_000 + 55_000 });
    expect(screen.getByText("0:05")).toBeInTheDocument();
    rerender({ now: NOW + 601_000 });
    expect(screen.getByText(/The code expired/)).toBeInTheDocument();
    expect(screen.queryByText(/MXQ4-7KDP/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeInTheDocument();
  });

  it("a new machine record flips the Stepper to Joined, which stays; Done (step 5) closes it", async () => {
    const { rerender } = setup();
    await act(flush);
    await addMachine();
    // A record that was already there is not the new machine.
    rerender({ machines: { "box-a": { ...boxA, agents: 4 }, "box-b": boxB } });
    expect(screen.queryByText(/joined/)).toBeNull();
    rerender({ machines: { "box-a": boxA, "box-b": boxB, "box-c": boxC } });
    expect(screen.getByRole("heading", { name: /box-c joined/ })).toBeInTheDocument();
    // Its record going away again does not send the Stepper back to a spent code.
    rerender({ machines: { "box-a": boxA, "box-b": boxB } });
    expect(screen.getByRole("heading", { name: /box-c joined/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(screen.queryByRole("heading", { name: /box-c joined/ })).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
  });

  it("a record from an account that is not a configured host does not flip Joined", async () => {
    const { rerender } = setup();
    await act(flush);
    await addMachine();
    rerender({ machines: { "box-a": boxA, "box-b": boxB, phone: { ...boxC, name: "phone" } } });
    expect(screen.queryByText(/joined/)).toBeNull();
    expect(screen.getByText(/Waiting for the machine to join/)).toBeInTheDocument();
  });

  it("a refused invite says why and offers to try again", async () => {
    const ops = fakeOps({
      invite: vi.fn(async () => ({
        ok: false as const,
        error: "volleyd did not answer within 10s",
      })),
    });
    setup({ ops });
    await act(flush);
    await addMachine();
    expect(screen.getByRole("alert")).toHaveTextContent("volleyd did not answer within 10s");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("Remove… opens the Remove sheet first, then calls peer_remove", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    expect(ops.remove).not.toHaveBeenCalled();
    const sheet = within(screen.getByRole("dialog", { name: "Remove box-a" }));
    expect(sheet.getByText(/revoke box-a's broker account/)).toBeInTheDocument();
    fireEvent.click(sheet.getByRole("button", { name: "Close" }));
    expect(ops.remove).not.toHaveBeenCalled();
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    await act(async () => {
      fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove box-a" }));
    });
    expect(ops.remove).toHaveBeenCalledWith("box-a", "drain");
    expect(screen.getByRole("status")).toHaveTextContent("box-a removed: its account was revoked");
  });

  it("a refused remove says why on the card", async () => {
    const ops = fakeOps({
      remove: vi.fn(async () => ({ ok: false, error: "box-a is not paired" })),
    });
    setup({ ops });
    await act(flush);
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove…" }));
    await act(async () => {
      fireEvent.click(within(card("box-a")).getByRole("button", { name: "Remove box-a" }));
    });
    expect(within(card("box-a")).getByRole("alert")).toHaveTextContent("box-a is not paired");
  });

  it("a non-admin session sees the machines but no buttons, the terminal commands and how to pair here", async () => {
    const ops = fakeOps({ admin: vi.fn(async (): Promise<AdminStatus> => "not-admin") });
    setup({ ops });
    await act(flush);
    expect(card("box-a")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByText(/sign in to the Desk with an admin account/i)).toBeInTheDocument();
    expect(screen.getByText("volley peer invite")).toBeInTheDocument();
    expect(ops.invite).not.toHaveBeenCalled();
  });

  it("a role known at sign-in shows at once: no 'Checking…' for a known admin or non-admin", () => {
    setup({ ops: fakeOps({ known: vi.fn((): Known => "admin") }) });
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
    expect(screen.queryByText(/Checking/)).toBeNull();
    cleanup();
    setup({ ops: fakeOps({ known: vi.fn((): Known => "not-admin") }) });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });

  it("volleyd not answering is said as such, and the section asks again when volleyd comes up", async () => {
    const admin = vi.fn(async (): Promise<AdminStatus> => "no-answer");
    const ops = fakeOps({ admin });
    const { rerender } = setup({ ops, hubUp: false });
    await act(flush);
    expect(screen.getByText(/volleyd did not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/takes an admin account/)).toBeNull();
    admin.mockResolvedValue("admin");
    rerender({ hubUp: true });
    await act(flush);
    expect(admin).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
  });

  it("without an op channel (not signed in, demo) it is read-only too", async () => {
    setup({ ops: null });
    await act(flush);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });

  it("on a plain-http page (no WebCrypto) an admin can still pair", async () => {
    plainHttp();
    try {
      setup({ ops: fakeOps({ known: vi.fn((): Known => "admin") }) });
      await act(flush);
      expect(card("box-a")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
      expect(screen.queryByText(/Read-only/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a browser that cannot make a reply key at all renders read-only, and says why", async () => {
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("isSecureContext", false);
    try {
      const c = fakeClient();
      setup({ ops: peerOps(c, { probeTimeoutMs: 20 }) });
      await act(flush);
      expect(card("box-a")).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText(/cannot make the key/)).toBeInTheDocument();
      expect(screen.getByText("volley peer invite")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the ssh address hint is the broker's host, none when the Desk is on this machine", () => {
    expect(sshHost("ws://hub.local:9001")).toBe("hub.local");
    expect(sshHost("ws://127.0.0.1:9001")).toBe("");
    expect(sshHost("ws://localhost:9001")).toBe("");
    expect(sshHost(null)).toBe("");
  });

  it("no paired machines yet: says how pairing works", async () => {
    setup({ machines: {} });
    await act(flush);
    expect(screen.getByText(/No other machines yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add a machine" })).toBeInTheDocument();
  });
});

describe("Machines: each card lists its repositories read-only (#438)", () => {
  it("a repository per row with where it stands, and a link to Settings › Repositories", async () => {
    const onOpenRepos = vi.fn();
    setup({
      machines: { "box-a": boxA },
      onOpenRepos,
      readiness: {
        "box-a": {
          name: "box-a",
          ready: true,
          reasons: [],
          drain: false,
          max_agents: 4,
          placed: 0,
          path_ok: { claude: true, bun: true },
          requirements: { volley: "0.7.0" },
          heavy: {},
          usage: { account: null, five_hour_pct: null },
          eligible: true,
          checked_at: iso(NOW),
          repos: {
            "example-org/app": { state: "ready", path: "/srv/work/app", reasons: [] },
            "example-org/lib": {
              state: "blocked",
              reasons: ["java not installed (needed by example-org/lib)"],
            },
          },
        },
      },
    });
    await act(flush);
    const list = within(within(card("box-a")).getByRole("list", { name: "Repositories on box-a" }));
    expect(list.getByRole("listitem", { name: "example-org/app: ready" })).toBeInTheDocument();
    expect(
      list.getByRole("listitem", {
        name: "example-org/lib: blocked: java not installed (needed by example-org/lib)",
      }),
    ).toBeInTheDocument();
    // Read-only: the card adds and removes nothing; the section does.
    expect(list.queryByRole("button")).toBeNull();
    fireEvent.click(within(card("box-a")).getByRole("button", { name: "Repositories…" }));
    expect(onOpenRepos).toHaveBeenCalledTimes(1);
  });
});

describe("Machines: a repository config just assigned shows before any verdict (#438)", () => {
  it("the card lists it as waiting for volleyd", async () => {
    setup({
      machines: { "box-a": boxA },
      waveConfig: {
        version: 3,
        updated_at: iso(NOW),
        updated_by: "volleyd",
        hosts: { "box-a": { target: "you@box-a" } },
        repos: { "example-org/docs": { machines: ["box-a"] } },
      },
    });
    await act(flush);
    const list = within(within(card("box-a")).getByRole("list", { name: "Repositories on box-a" }));
    expect(
      list.getByRole("listitem", { name: "example-org/docs: waiting for volleyd" }),
    ).toBeInTheDocument();
  });
});

describe("Machines: the read-only notice links to an admin sign-in (#328)", () => {
  afterEach(() => localStorage.clear());

  it("a steer session's notice has 'Switch to an admin account', which opens the token entry", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({ username: "steer-0123abcd", password: "pw", role: "steer" }),
    );
    const ops = fakeOps({ admin: vi.fn(async (): Promise<AdminStatus> => "not-admin") });
    render(
      <SignInGate
        demo={false}
        env={{}}
        brokerUrl="ws://broker.test:9001"
        clientFactory={connectingFactory().make}
      >
        <Machines machines={{ "box-a": boxA }} hubUp ops={ops} now={NOW} host="hub.local" />
      </SignInGate>,
    );
    await act(flush);
    const notice = screen.getByText(/takes an admin account/).closest("p") as HTMLElement;
    const link = within(notice).getByRole("button", { name: "Switch to an admin account" });
    fireEvent.click(link);
    expect(screen.getByRole("dialog", { name: "Switch account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sign-in link or token")).toBeInTheDocument();
  });

  it("without a sign-in gate (demo) the notice has no link", async () => {
    setup({ ops: fakeOps({ admin: vi.fn(async (): Promise<AdminStatus> => "not-admin") }) });
    await act(flush);
    expect(screen.queryByRole("button", { name: "Switch to an admin account" })).toBeNull();
  });
});
