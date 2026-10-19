import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { ConfigStore } from "../src/config-store";
import { ControlClient, leasePoolTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import { Journal, readJournalFile } from "../src/journal";
import {
  type LeaseBook,
  type LeaseInput,
  type LeaseStepContext,
  emptyBook,
  poolPayload,
  replayLeases,
  step,
} from "../src/leases";
import { type JournalEvent, type LeasePoolConfig, SYSTEM_WAVE } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { envelope, schemaErrors } from "./helpers/schema";

const T0 = Date.parse("2026-10-18T15:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000);

/** Drive `step` like the daemon does, keeping the book and every journaled event. */
function harness(pools: Record<string, LeasePoolConfig>) {
  let book: LeaseBook = emptyBook();
  const journal: JournalEvent[] = [];
  const ctx = (now: Date): LeaseStepContext => ({ pools, now, defaultTtlS: 3600 });
  const run = (input: LeaseInput, now = at(0)) => {
    const r = step(book, input, ctx(now));
    book = r.book;
    for (const e of r.events) {
      journal.push({ ...e, seq: journal.length + 1, at: e.at ?? now.toISOString() });
    }
    return r;
  };
  const acquire = (pool: string, lease_id: string, holder: string, now?: Date, ttl_s?: number) =>
    run(
      {
        kind: "request",
        pool,
        req: { op: "acquire", lease_id, holder, ...(ttl_s !== undefined ? { ttl_s } : {}) },
      },
      now,
    );
  const release = (pool: string, lease_id: string, holder: string, now?: Date) =>
    run({ kind: "request", pool, req: { op: "release", lease_id, holder } }, now);
  return {
    pools,
    run,
    acquire,
    release,
    tick: (now: Date) => run({ kind: "tick" }, now),
    get book() {
      return book;
    },
    journal,
    held: (pool: string) => book[pool]?.held.map((h) => h.lease_id) ?? [],
    queued: (pool: string) => book[pool]?.queue.map((q) => q.lease_id) ?? [],
    payload: (pool: string) => poolPayload(pool, book, pools),
  };
}

describe("leases: FIFO grant within capacity", () => {
  it("capacity 2, three acquires → two held, one queued with a reason; release grants the queued one", () => {
    const h = harness({ "backend-it": { capacity: 2 } });
    h.acquire("backend-it", "l-1", "agent-a");
    h.acquire("backend-it", "l-2", "agent-b", at(1));
    h.acquire("backend-it", "l-3", "agent-c", at(2));
    expect(h.held("backend-it")).toEqual(["l-1", "l-2"]);
    expect(h.queued("backend-it")).toEqual(["l-3"]);

    const p = h.payload("backend-it");
    expect(p.reasons).toEqual(["queued: 2/2 backend-it leases held"]);
    expect(p).toMatchObject({ pool: "backend-it", capacity: 2 });
    expect(p.queue).toEqual([{ lease_id: "l-3", holder: "agent-c", since: at(2).toISOString() }]);
    expect(
      schemaErrors("lease-pool.schema.json", envelope("_system/leases", "lease_pool", p)),
    ).toEqual([]);

    h.release("backend-it", "l-1", "agent-a", at(5));
    expect(h.held("backend-it")).toEqual(["l-2", "l-3"]);
    expect(h.queued("backend-it")).toEqual([]);
    expect(h.payload("backend-it").reasons).toEqual([]);
    // The grant from the queue starts the lease (and its TTL) at grant time.
    expect(h.book["backend-it"]?.held[1]).toMatchObject({
      lease_id: "l-3",
      since: at(5).toISOString(),
    });
  });

  it("journals lease_requested / lease_granted / lease_released, and replay rebuilds the book", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b", at(1));
    h.release("build", "l-1", "agent-a", at(2));
    expect(h.journal.map((e) => `${e.type}:${e.data.lease_id}`)).toEqual([
      "lease_requested:l-1",
      "lease_granted:l-1",
      "lease_requested:l-2",
      "lease_released:l-1",
      "lease_granted:l-2",
    ]);
    expect(replayLeases(h.journal)).toEqual(h.book);
  });

  it("a duplicate acquire with the same lease_id is idempotent (held or queued)", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b");
    const n = h.journal.length;
    expect(h.acquire("build", "l-1", "agent-a").events).toEqual([]);
    expect(h.acquire("build", "l-2", "agent-b").events).toEqual([]);
    expect(h.journal).toHaveLength(n);
    expect(h.held("build")).toEqual(["l-1"]);
    expect(h.queued("build")).toEqual(["l-2"]);
  });

  it("release of a queued lease cancels the request; release by another holder is ignored", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b");
    expect(h.release("build", "l-1", "agent-b").events).toEqual([]);
    expect(h.held("build")).toEqual(["l-1"]);
    h.release("build", "l-2", "agent-b");
    expect(h.queued("build")).toEqual([]);
    expect(h.journal.at(-1)).toMatchObject({
      type: "lease_released",
      data: { lease_id: "l-2", reason: "cancelled" },
    });
  });
});

describe("leases: expiry and holder exit", () => {
  it("TTL expiry frees the lease and grants the next request", () => {
    const h = harness({ "backend-it": { capacity: 1, ttl_s: 600 } });
    h.acquire("backend-it", "l-1", "agent-a");
    h.acquire("backend-it", "l-2", "agent-b", at(10));
    h.tick(at(599));
    expect(h.held("backend-it")).toEqual(["l-1"]);
    h.tick(at(600));
    expect(h.held("backend-it")).toEqual(["l-2"]);
    expect(h.journal.map((e) => e.type)).toContain("lease_expired");
  });

  it("the request's ttl_s beats the pool's, and the pool's beats the default", () => {
    const h = harness({ a: { capacity: 2, ttl_s: 600 }, b: { capacity: 1 } });
    h.acquire("a", "l-1", "agent-a", at(0), 120);
    h.acquire("a", "l-2", "agent-a");
    h.acquire("b", "l-3", "agent-a");
    expect(h.book.a?.held.map((x) => x.ttl_s)).toEqual([120, 600]);
    expect(h.book.b?.held.map((x) => x.ttl_s)).toEqual([3600]);
  });

  it("renew extends the expiry from the renewal time", () => {
    const h = harness({ build: { capacity: 1, ttl_s: 600 } });
    h.acquire("build", "l-1", "agent-a");
    h.run(
      { kind: "request", pool: "build", req: { op: "renew", lease_id: "l-1", holder: "agent-a" } },
      at(500),
    );
    h.tick(at(700));
    expect(h.held("build")).toEqual(["l-1"]);
    h.tick(at(1100));
    expect(h.held("build")).toEqual([]);
  });

  it("a holder whose status turns reaped frees its held and queued leases", () => {
    const h = harness({ build: { capacity: 1 }, browser: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b");
    h.acquire("browser", "l-3", "agent-c");
    h.acquire("browser", "l-4", "agent-a");
    h.run({ kind: "holder_status", holder: "agent-a", status: "reaped" }, at(30));
    expect(h.held("build")).toEqual(["l-2"]);
    expect(h.queued("browser")).toEqual([]);
    expect(h.held("browser")).toEqual(["l-3"]);
    expect(h.journal.filter((e) => e.type === "lease_released").map((e) => e.data.reason)).toEqual([
      "holder reaped",
      "holder reaped",
    ]);
  });

  it("a non-terminal holder status frees nothing", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    expect(h.run({ kind: "holder_status", holder: "agent-a", status: "blocked" }).events).toEqual(
      [],
    );
  });
});

describe("leases: hot-reloaded pool config", () => {
  it("capacity hot-reduced 3 → 1 with 3 holders: no preemption, no grant until the pool is under capacity", () => {
    const h = harness({ "backend-it": { capacity: 3 } });
    for (const [id, who] of [
      ["l-1", "agent-a"],
      ["l-2", "agent-b"],
      ["l-3", "agent-c"],
      ["l-4", "agent-d"],
    ] as const)
      h.acquire("backend-it", id, who);
    expect(h.held("backend-it")).toEqual(["l-1", "l-2", "l-3"]);

    h.pools["backend-it"] = { capacity: 1 };
    h.tick(at(1));
    expect(h.held("backend-it")).toEqual(["l-1", "l-2", "l-3"]); // never preempted
    expect(h.payload("backend-it").reasons).toEqual(["queued: 3/1 backend-it leases held"]);

    h.release("backend-it", "l-1", "agent-a", at(2));
    h.release("backend-it", "l-2", "agent-b", at(3));
    expect(h.held("backend-it")).toEqual(["l-3"]); // 1/1: still full
    expect(h.queued("backend-it")).toEqual(["l-4"]);
    h.release("backend-it", "l-3", "agent-c", at(4));
    expect(h.held("backend-it")).toEqual(["l-4"]);
  });

  it("capacity hot-increased → the queued request is granted at the next tick", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b");
    expect(h.queued("build")).toEqual(["l-2"]);
    h.pools.build = { capacity: 2 };
    h.tick(at(1));
    expect(h.held("build")).toEqual(["l-1", "l-2"]);
  });

  it("a removed pool releases nothing, rejects new acquires with a reason, still accepts releases", () => {
    const h = harness({ build: { capacity: 2 } });
    h.acquire("build", "l-1", "agent-a");
    // biome-ignore lint/performance/noDelete: removing a key is the config change under test
    delete h.pools.build;
    h.tick(at(1));
    expect(h.held("build")).toEqual(["l-1"]);

    const r = h.acquire("build", "l-2", "agent-b", at(2));
    expect(r.events).toEqual([]);
    expect(r.rejected).toBe("pool build is not configured");
    expect(h.payload("build")).toMatchObject({
      capacity: 0,
      reasons: ["pool build removed from config: new requests rejected"],
    });

    h.release("build", "l-1", "agent-a", at(3));
    expect(h.book.build).toBeUndefined();
  });
});

describe("leases: a pool removed with requests still queued", () => {
  it("drops the queued request (it never started: not preemption) and the pool leaves the book once its holders release", () => {
    const h = harness({ build: { capacity: 1 } });
    h.acquire("build", "l-1", "agent-a");
    h.acquire("build", "l-2", "agent-b");
    expect(h.queued("build")).toEqual(["l-2"]);
    // biome-ignore lint/performance/noDelete: removing a key is the config change under test
    delete h.pools.build;

    const r = h.tick(at(1));
    expect(r.events).toEqual([
      {
        type: "lease_released",
        at: at(1).toISOString(),
        data: { pool: "build", lease_id: "l-2", holder: "agent-b", reason: "pool removed" },
      },
    ]);
    expect(h.held("build")).toEqual(["l-1"]);
    expect(h.queued("build")).toEqual([]);

    h.release("build", "l-1", "agent-a", at(2));
    expect(h.book.build).toBeUndefined();
    expect(replayLeases(h.journal)).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// The daemon over MQTT (in-process Aedes broker)
// ---------------------------------------------------------------------------------------------

describe("volleyd daemon: lease requests over MQTT", () => {
  let t: DaemonEnv;
  let daemon: Daemon;
  const clients: VolleyBroker[] = [];

  const connect = async (agentId: string) => {
    const b = new VolleyBroker();
    await b.connect({ url: t.broker.url, agentId });
    clients.push(b);
    return b;
  };
  const request = async (
    from: VolleyBroker,
    sender: string,
    pool: string,
    payload: Record<string, unknown>,
  ) => {
    const env = buildEnvelope({
      agentId: sender,
      parentId: null,
      channel: "_system/leases/requests",
      type: "lease_request",
      payload,
    });
    await from.publish(`${leasePoolTopic(pool)}/requests`, JSON.stringify(env), {
      qos: 1,
      retain: false,
    });
  };
  const pool = async (name: string) =>
    (
      (await t.retained(leasePoolTopic(name))) as {
        payload: { held: { lease_id: string }[]; queue: { lease_id: string }[]; reasons: string[] };
      } | null
    )?.payload;
  /** Re-read the retained pool state (it arrives over MQTT) until `pred` holds. */
  const until = async (
    name: string,
    pred: (p: NonNullable<Awaited<ReturnType<typeof pool>>>) => boolean,
  ) => {
    let p: Awaited<ReturnType<typeof pool>>;
    await eventually(async () => {
      p = await pool(name);
      return p !== undefined && p !== null && pred(p);
    });
    return p as NonNullable<Awaited<ReturnType<typeof pool>>>;
  };
  const ids = (xs: { lease_id: string }[]) => xs.map((x) => x.lease_id);
  const systemEvents = () =>
    readJournalFile(join(t.home, "waves", SYSTEM_WAVE, "journal.jsonl")).map((e) => e.type);

  beforeEach(async () => {
    t = await makeDaemonEnv();
    writeFileSync(join(t.home, "config.yaml"), "lease_pools:\n  build: { capacity: 1 }\n");
    daemon = await t.start();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
    await t.cleanup();
  });

  it("publishes configured pools at startup, grants FIFO, and journals in _system", async () => {
    const empty = await pool("build");
    expect(empty).toMatchObject({ capacity: 1, held: [], queue: [], reasons: [] });

    const a = await connect("agent-a");
    const b = await connect("agent-b");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => ids(p.held).includes("l-a"));
    await request(b, "agent-b", "build", { op: "acquire", lease_id: "l-b", holder: "agent-b" });
    const queued = await until("build", (p) => ids(p.queue).includes("l-b"));
    expect(queued.reasons).toEqual(["queued: 1/1 build leases held"]);

    await request(a, "agent-a", "build", { op: "release", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => ids(p.held).join() === "l-b" && p.queue.length === 0);
    expect(systemEvents()).toEqual([
      "lease_requested",
      "lease_granted",
      "lease_requested",
      "lease_released",
      "lease_granted",
    ]);
  });

  it("ignores a request whose holder is not the sender", async () => {
    const a = await connect("agent-a");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-x", holder: "agent-z" });
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    const p = await until("build", (x) => ids(x.held).includes("l-a"));
    expect(ids(p.queue)).toEqual([]);
  });

  it("frees the leases of a holder whose status turns reaped", async () => {
    const a = await connect("agent-a");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => p.held.length === 1);
    const status = buildEnvelope({
      agentId: "agent-a",
      parentId: null,
      channel: "status",
      type: "reaped",
      payload: {},
    });
    await a.publish(`volley/${NS}/agent-a/status`, JSON.stringify(status), {
      qos: 1,
      retain: true,
    });
    await until("build", (p) => p.held.length === 0);
    expect(systemEvents().at(-1)).toBe("lease_released");
  });

  it("rebuilds held leases from the journal after a restart", async () => {
    const a = await connect("agent-a");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => p.held.length === 1);
    await daemon.stop();
    // Clear the retained state, so what we read next is what the new daemon published.
    await a.publish(leasePoolTopic("build"), "", { qos: 1, retain: true });
    await t.start();
    const p = await until("build", (x) => x.held.length === 1);
    expect(ids(p.held)).toEqual(["l-a"]);
  });

  it("a release sent while volleyd is down is processed on restart", async () => {
    const a = await connect("agent-a");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => ids(p.held).includes("l-a"));
    await daemon.stop();
    // Queued by the broker in volleyd's persistent session while it is down.
    await request(a, "agent-a", "build", { op: "release", lease_id: "l-a", holder: "agent-a" });
    daemon = await t.start();
    await daemon.tick();
    await until("build", (p) => p.held.length === 0);
    expect(systemEvents().at(-1)).toBe("lease_released");
  });

  it("a hot capacity increase grants the queued request on the next tick", async () => {
    const a = await connect("agent-a");
    const b = await connect("agent-b");
    await request(a, "agent-a", "build", { op: "acquire", lease_id: "l-a", holder: "agent-a" });
    await until("build", (p) => p.held.length === 1);
    await request(b, "agent-b", "build", { op: "acquire", lease_id: "l-b", holder: "agent-b" });
    await until("build", (p) => p.queue.length === 1);

    const client = await ControlClient.connect(t.broker.url, NS);
    try {
      const ack = await client.request(
        "config_set",
        { patch: { lease_pools: { build: { capacity: 2 } } }, by: "tester" },
        { text: "grow build pool" },
      );
      expect(ack.applied).toBe(true);
    } finally {
      await client.close();
    }
    await daemon.tick();
    const p = await until("build", (x) => x.held.length === 2);
    expect(ids(p.held)).toEqual(["l-a", "l-b"]);
  });
});

describe("config.example.yaml", () => {
  const example = readFileSync(new URL("../config.example.yaml", import.meta.url), "utf-8");
  const load = (yaml: string) => {
    const home = mkdtempSync(join(tmpdir(), "volleyd-example-"));
    try {
      writeFileSync(join(home, "config.yaml"), yaml);
      return ConfigStore.load({ home, system: Journal.open(join(home, "waves", SYSTEM_WAVE)) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  /** Uncomment every commented-out YAML key (prose comment lines are left alone). */
  const uncommented = example.replace(/^# (\s*[a-z_-]+:(?: |$).*)$/gm, "$1");

  it("loads as shipped (everything commented: the built-in defaults)", () => {
    expect(load(example).effective()).toEqual(CONFIG_DEFAULTS);
  });

  it("documents every top-level tunable", () => {
    for (const key of Object.keys(CONFIG_DEFAULTS))
      expect(example).toMatch(new RegExp(`^# ${key}:`, "m"));
  });

  it("uncommented, it is valid, documents the real defaults, and defines the example pools", () => {
    const eff = load(uncommented).effective();
    expect({ ...eff, lease_pools: {}, hosts: {} }).toEqual(CONFIG_DEFAULTS);
    expect(eff.hosts.buildbox).toMatchObject({
      target: "me@buildbox",
      repo: "/home/me/src/myrepo",
    });
    expect(Object.keys(eff.lease_pools)).toEqual(["backend-it", "build", "browser"]);
    expect(eff.lease_pools["backend-it"]).toMatchObject({ capacity: 3, ttl_s: 3600 });
    expect(eff.lease_pools.build?.match).toEqual(["npm run build", "vite build"]);
  });
});
