import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

const CLI_ENTRY = `${dirname(dirname(dirname(fileURLToPath(import.meta.url))))}/src/cli.ts`;

interface Req {
  op: string;
  lease_id: string;
  holder: string;
  sender: string;
}

/**
 * A minimal in-process supervisor: a live retained `volleyd` status, a retained `_config` with
 * the pools, and a FIFO grant loop over lease requests that re-publishes the retained pool
 * state after every request (SPEC §4.6.5). Enough to drive the client; the real one is volleyd.
 */
async function fakeVolleyd(
  url: string,
  capacities: Record<string, number>,
  opts: { ignoreRequests?: boolean } = {},
) {
  const b = new VolleyBroker();
  await b.connect({ url, agentId: "volleyd" });
  const env = (channel: string, type: string, payload: unknown) =>
    JSON.stringify(buildEnvelope({ agentId: "volleyd", parentId: null, channel, type, payload }));
  await b.publish("volley/test/volleyd/status", env("status", "working", {}), {
    qos: 1,
    retain: true,
  });
  const lease_pools = Object.fromEntries(
    Object.entries(capacities).map(([p, capacity]) => [p, { capacity }]),
  );
  await b.publish("volley/_waves/_config", env("_waves/_config", "config", { lease_pools }), {
    qos: 1,
    retain: true,
  });
  const pools: Record<string, { held: Req[]; queue: Req[] }> = {};
  const requests: Req[] = [];
  const publishPool = async (pool: string) => {
    const p = pools[pool] ?? { held: [], queue: [] };
    const cap = capacities[pool] ?? 0;
    const at = new Date().toISOString();
    await b.publish(
      `volley/_system/leases/${pool}`,
      env("_system/leases", "lease_pool", {
        pool,
        capacity: cap,
        held: p.held.map((h) => ({
          lease_id: h.lease_id,
          holder: h.holder,
          since: at,
          ttl_s: 3600,
        })),
        queue: p.queue.map((q) => ({ lease_id: q.lease_id, holder: q.holder, since: at })),
        reasons: p.queue.length > 0 ? [`queued: ${p.held.length}/${cap} ${pool} leases held`] : [],
      }),
      { qos: 1, retain: true },
    );
  };
  const handle = async (pool: string, r: Req) => {
    const p = pools[pool] ?? { held: [], queue: [] };
    pools[pool] = p;
    const known = [...p.held, ...p.queue].some((x) => x.lease_id === r.lease_id);
    if (r.op === "acquire" && !known) p.queue.push(r);
    if (r.op === "release") {
      p.held = p.held.filter((x) => x.lease_id !== r.lease_id);
      p.queue = p.queue.filter((x) => x.lease_id !== r.lease_id);
    }
    while (p.queue.length > 0 && p.held.length < (capacities[pool] ?? 0)) {
      p.held.push(p.queue.shift() as Req);
    }
    await publishPool(pool);
  };
  for (const pool of Object.keys(capacities)) await publishPool(pool);
  await b.subscribeStream("volley/_system/leases/+/requests", (m) => {
    const e = parseEnvelope(m.payload);
    if (e === null) return;
    const r = { ...(e.payload as Omit<Req, "sender">), sender: e.agent_id };
    requests.push(r);
    if (opts.ignoreRequests !== true) void handle(m.topic.split("/")[3] ?? "", r);
  });
  return {
    requests,
    pools,
    /** Die like volleyd's LWT would say: retained status reaped, then drop the connection. */
    die: async () => {
      await b.publish("volley/test/volleyd/status", env("status", "reaped", {}), {
        qos: 1,
        retain: true,
      });
      await b.disconnect();
    },
    /** Remove a pool from config with requests still queued: drop them, clear the pool topic. */
    removePool: async (pool: string) => {
      delete capacities[pool];
      await b.publish(
        "volley/_waves/_config",
        env("_waves/_config", "config", { lease_pools: {} }),
        {
          qos: 1,
          retain: true,
        },
      );
      delete pools[pool];
      await b.publish(`volley/_system/leases/${pool}`, "", { qos: 1, retain: true });
    },
    /** Hold a lease on behalf of someone else (as if granted earlier). */
    hold: (pool: string, lease_id: string, holder: string) =>
      handle(pool, { op: "acquire", lease_id, holder, sender: holder }),
    release: (pool: string, lease_id: string) =>
      handle(pool, { op: "release", lease_id, holder: "", sender: "" }),
    close: () => b.disconnect(),
  };
}

/** Run the CLI as a real process (for signals), collecting stderr. */
function spawnCli(args: string[], env: Record<string, string> = {}) {
  const proc = spawn("bun", ["run", CLI_ENTRY, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const out = { stderr: "" };
  proc.stderr.on("data", (c: Buffer) => {
    out.stderr += c.toString();
  });
  const exited = new Promise<number | null>((r) => proc.on("close", (code) => r(code)));
  return { proc, out, exited };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const eventually = async (fn: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("volley lease", () => {
  let tb: TestBroker;
  let sup: Awaited<ReturnType<typeof fakeVolleyd>>;
  beforeEach(async () => {
    tb = await startTestBroker();
    sup = await fakeVolleyd(tb.url, { p: 1, build: 2 });
  });
  afterEach(async () => {
    await sup.close();
    await tb.close();
  });

  const base = () => ["--broker-url", tb.url];

  it("run: acquires, runs, exits with the command's code (7) and releases", async () => {
    const r = await runCli({
      argv: [
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 7",
      ],
    });
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toMatch(/p lease granted after \d+ s/);
    await eventually(() => sup.requests.length === 2);
    expect(sup.requests.map((q) => q.op)).toEqual(["acquire", "release"]);
    expect(sup.requests[0]?.lease_id).toBe(sup.requests[1]?.lease_id);
    expect(sup.requests.every((q) => q.holder === "agent-a" && q.sender === "agent-a")).toBe(true);
    expect(sup.pools.p?.held).toEqual([]);
  });

  it("run: waits while the pool is full, says why, and runs once the holder releases", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const run = runCli({
      argv: [
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 0",
      ],
    });
    await eventually(() => (sup.pools.p?.queue.length ?? 0) === 1);
    await sup.release("p", "l-other");
    const r = await run;
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("queued for a p lease (queued: 1/1 p leases held)");
    expect(r.stderr).toMatch(/p lease granted after \d+ s/);
  });

  it("run: SIGTERM during the wait cancels the request and exits 143", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const proc = spawn(
      "bun",
      [
        "run",
        CLI_ENTRY,
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const exited = new Promise<number | null>((r) => proc.on("close", (code) => r(code)));
    await eventually(() => (sup.pools.p?.queue.length ?? 0) === 1, 10_000);
    proc.kill("SIGTERM");
    expect(await exited).toBe(143);
    await eventually(() => sup.requests.some((q) => q.op === "release" && q.holder === "agent-a"));
    expect(sup.pools.p?.queue).toEqual([]);
    expect(sup.pools.p?.held.map((h) => h.lease_id)).toEqual(["l-other"]);
    expect(stderr).not.toContain("granted");
  });

  it("run: SIGHUP during the wait cancels the request and exits 129", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const c = spawnCli([
      "lease",
      "run",
      "--pool",
      "p",
      "--holder",
      "agent-a",
      ...base(),
      "--",
      "true",
    ]);
    await eventually(() => (sup.pools.p?.queue.length ?? 0) === 1, 10_000);
    c.proc.kill("SIGHUP");
    expect(await c.exited).toBe(129);
    await eventually(() => sup.requests.some((q) => q.op === "release" && q.holder === "agent-a"));
  });

  it("run: SIGTERM while the command runs reaches the whole process group, not just the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-pg-"));
    const pidFile = join(dir, "pid");
    try {
      const c = spawnCli([
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        `sleep 60 & echo $! > ${pidFile}; wait`,
      ]);
      await eventually(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() !== "",
        10_000,
      );
      const grandchild = Number(readFileSync(pidFile, "utf-8").trim());
      c.proc.kill("SIGTERM");
      expect(await c.exited).toBe(143);
      await eventually(() => !pidAlive(grandchild));
      await eventually(() => sup.requests.some((q) => q.op === "release"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run: killed outright (SIGKILL) while holding, its will releases the lease", async () => {
    const c = spawnCli([
      "lease",
      "run",
      "--pool",
      "p",
      "--holder",
      "agent-a",
      ...base(),
      "--",
      "sleep",
      "30",
    ]);
    await eventually(() => (sup.pools.p?.held.length ?? 0) === 1, 10_000);
    c.proc.kill("SIGKILL");
    await c.exited;
    await eventually(() => sup.requests.some((q) => q.op === "release" && q.sender === "agent-a"));
    expect(sup.pools.p?.held).toEqual([]);
  });

  it("run: queued when volleyd dies → notices at the next probe and runs unleased", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const run = runCli({
      argv: [
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 4",
      ],
      env: { VOLLEY_LEASE_RESEND_MS: "200" },
    });
    await eventually(() => (sup.pools.p?.queue.length ?? 0) === 1);
    await sup.die();
    const r = await run;
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("volleyd went away; running without a lease");
  });

  it("run: queued when its pool is removed from config → runs unleased", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const run = runCli({
      argv: [
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 6",
      ],
    });
    await eventually(() => (sup.pools.p?.queue.length ?? 0) === 1);
    await sup.removePool("p");
    const r = await run;
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toMatch(/pool p removed.*; running without a lease/);
  });

  it("run: --timeout gives up with 124 and cancels", async () => {
    await sup.hold("p", "l-other", "agent-z");
    const r = await runCli({
      argv: [
        "lease",
        "run",
        "--pool",
        "p",
        "--holder",
        "agent-a",
        "--timeout",
        "1",
        ...base(),
        "--",
        "sh",
        "-c",
        "exit 0",
      ],
    });
    expect(r.exitCode).toBe(124);
    await eventually(() => (sup.pools.p?.queue.length ?? 1) === 0);
  });

  it("run: an unconfigured pool runs the command unleased, with a warning", async () => {
    const r = await runCli({
      argv: ["lease", "run", "--pool", "nope", ...base(), "--", "sh", "-c", "exit 3"],
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("no lease pool 'nope' configured; running without a lease");
    expect(sup.requests).toEqual([]);
  });

  it("acquire prints the lease; release frees it; status lists the pools", async () => {
    const a = await runCli({
      argv: [
        "lease",
        "acquire",
        "--pool",
        "build",
        "--holder",
        "agent-a",
        "--lease-id",
        "l-1",
        ...base(),
      ],
    });
    expect(a.exitCode).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({
      pool: "build",
      lease_id: "l-1",
      holder: "agent-a",
    });

    const st = await runCli({ argv: ["lease", "status", ...base()] });
    expect(st.stdout).toContain("build  1/2 held  0 queued");
    expect(st.stdout).toContain("held    l-1  agent-a");
    const json = JSON.parse(
      (await runCli({ argv: ["lease", "status", "--pool", "build", "--json", ...base()] })).stdout,
    );
    expect(json[0]).toMatchObject({ pool: "build", capacity: 2 });

    const rel = await runCli({
      argv: [
        "lease",
        "release",
        "--pool",
        "build",
        "--holder",
        "agent-a",
        "--lease-id",
        "l-1",
        ...base(),
      ],
    });
    expect(rel.exitCode).toBe(0);
    expect(sup.pools.build?.held).toEqual([]);
  });

  it("release: defaults --holder to the lease id's prefix, and an emptied pool counts as released", async () => {
    await sup.hold("build", "agent-a.x1", "agent-a");
    await sup.removePool("build");
    const rel = await runCli({
      argv: ["lease", "release", "--pool", "build", "--lease-id", "agent-a.x1", ...base()],
    });
    expect(rel.stderr).toBe("");
    expect(rel.exitCode).toBe(0);
    await eventually(() => sup.requests.some((q) => q.op === "release"));
    expect(sup.requests.at(-1)).toMatchObject({ holder: "agent-a", sender: "agent-a" });
  });

  it("acquire fails fast on an unconfigured pool", async () => {
    const r = await runCli({ argv: ["lease", "acquire", "--pool", "nope", ...base()] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no lease pool 'nope' configured (pools: p, build)");
  });

  it("usage errors exit 2", async () => {
    expect((await runCli({ argv: ["lease"] })).exitCode).toBe(2);
    expect((await runCli({ argv: ["lease", "frob"] })).exitCode).toBe(2);
    expect((await runCli({ argv: ["lease", "run", "--", "true"] })).stderr).toContain(
      "--pool is required",
    );
    expect((await runCli({ argv: ["lease", "run", "--pool", "p"] })).stderr).toContain(
      "missing command",
    );
    expect((await runCli({ argv: ["lease", "release", "--pool", "p"] })).stderr).toContain(
      "--lease-id is required",
    );
    expect(
      (await runCli({ argv: ["lease", "run", "--pool", "Bad!", "--", "true"] })).exitCode,
    ).toBe(2);
  });
});

describe("volley lease with a supervisor that never answers", () => {
  it("run: gives up after three unanswered re-sends and runs unleased", async () => {
    const tb = await startTestBroker();
    const sup = await fakeVolleyd(tb.url, { p: 1 }, { ignoreRequests: true });
    try {
      const r = await runCli({
        argv: [
          "lease",
          "run",
          "--pool",
          "p",
          "--holder",
          "agent-a",
          "--broker-url",
          tb.url,
          "--",
          "sh",
          "-c",
          "exit 9",
        ],
        env: { VOLLEY_LEASE_RESEND_MS: "100" },
      });
      expect(r.exitCode).toBe(9);
      expect(r.stderr).toContain("never queued");
      expect(sup.requests.filter((q) => q.op === "acquire")).toHaveLength(4);
    } finally {
      await sup.close();
      await tb.close();
    }
  });
});

describe("volley lease without a supervisor", () => {
  it("run: no live volleyd → runs unleased with a warning", async () => {
    const tb = await startTestBroker();
    try {
      const r = await runCli({
        argv: ["lease", "run", "--pool", "p", "--broker-url", tb.url, "--", "sh", "-c", "exit 5"],
      });
      expect(r.exitCode).toBe(5);
      expect(r.stderr).toContain("no live volleyd; running without a lease");
    } finally {
      await tb.close();
    }
  });
});
