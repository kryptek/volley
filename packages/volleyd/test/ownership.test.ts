import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { claimVerdict, detectOwner, guardMutation } from "../src/ownership";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";

const WAVE = "w-owned";
const yaml = (wave: string) => `wave: ${wave}
repo: example-org/example-repo
release_branch: release/${wave}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
  B: { issue: 2, after: [A] }
`;

let t: DaemonEnv;
let daemon: Daemon;
let client: ControlClient;
let pub: VolleyBroker;

async function agentStatus(agentId: string, type: string) {
  const env = buildEnvelope({ agentId, parentId: null, channel: "status", type, payload: {} });
  await pub.publish(`volley/${NS}/${agentId}/status`, JSON.stringify(env), {
    qos: 1,
    retain: true,
  });
}
async function agentRegistry(agentId: string, cwd: string, wallTime?: string) {
  const env = buildEnvelope({
    agentId,
    parentId: null,
    channel: "_system/registry",
    type: "registered",
    payload: { capabilities: [], cwd, started_at: wallTime ?? new Date().toISOString() },
  });
  await pub.publish(
    registryTopic(agentId),
    JSON.stringify({
      ...env,
      ...(wallTime !== undefined ? { wall_time: wallTime } : {}),
      namespace: NS,
    }),
    { qos: 1, retain: true },
  );
}

beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start();
  client = await ControlClient.connect(t.broker.url, NS);
  pub = new VolleyBroker();
  await pub.connect({ url: t.broker.url, agentId: "test-pub" });
  const res = await client.request("run", { wave_yaml: yaml(WAVE), owner: "coord-a" });
  expect(res.error).toBeUndefined();
});
afterEach(async () => {
  await pub.disconnect();
  await client.close();
  await t.cleanup();
});

describe("wave ownership", () => {
  it("records the submitting owner in the wave state", () => {
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
  });

  it("refuses a non-owner resolve, naming the owner", async () => {
    const d = await daemon.openDecision(WAVE, {
      kind: "plan_change",
      task: "A",
      question: "Split A?",
      pointers: {},
    });
    const res = await client.request("resolve", {
      wave: WAVE,
      decision_id: d.decision_id,
      answer: "yes",
      by: "coord-b",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("owned by coord-a");
    expect(daemon.snapshot(WAVE)?.open_decisions).toEqual([d.decision_id]);
  });

  it("refuses claim while the owner is working with a fresh heartbeat", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "working");
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("coord-a");
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
  });

  it("claim succeeds after the owner is reaped, and is journaled", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "reaped");
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-b");
    const events = daemon.journalEvents(WAVE).filter((e) => e.type === "owner_claimed");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ owner: "coord-b", previous: "coord-a" });

    // The new owner can now act; the old one cannot.
    expect((await client.request("pause", { wave: WAVE, by: "coord-a" })).error).toContain(
      "owned by coord-b",
    );
    expect((await client.request("pause", { wave: WAVE, by: "coord-b" })).ok).toBe(true);
  });

  it("claim succeeds when the owner's registry entry is older than claim_after_s with no heartbeat", async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    await agentRegistry("coord-a", "/work", old);
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.error).toBeUndefined();
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-b");
  });

  it("refuses run of a wave id already running under another owner", async () => {
    const res = await client.request("run", { wave_yaml: yaml(WAVE), owner: "coord-b" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`wave '${WAVE}' is already running under owner coord-a`);
  });
});

describe("ownership (pure)", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const fresh = "2026-10-18T11:59:00.000Z";

  it("guardMutation: owner or unowned may act; anyone else is refused", () => {
    expect(guardMutation({ wave: "w", owner: "a" }, "a", "pause")).toBeNull();
    expect(guardMutation({ wave: "w", owner: null }, "b", "pause")).toBeNull();
    expect(guardMutation({ wave: "w", owner: "a" }, "b", "pause")).toContain(
      "wave 'w' is owned by a",
    );
  });

  it("claimVerdict: terminal status, silence past claim_after_s, and fresh heartbeats", () => {
    const base = { owner: "a", by: "b", now, claimAfterS: 1800 };
    expect(
      claimVerdict({
        ...base,
        status: { type: "reaped", at: fresh },
        registryAt: fresh,
        heartbeatAt: null,
      }).ok,
    ).toBe(true);
    expect(
      claimVerdict({
        ...base,
        status: { type: "done", at: fresh },
        registryAt: fresh,
        heartbeatAt: null,
      }).ok,
    ).toBe(true);
    const working = claimVerdict({
      ...base,
      status: { type: "working", at: fresh },
      registryAt: fresh,
      heartbeatAt: null,
    });
    expect(working.ok).toBe(false);
    expect(working.ok === false && working.reason).toContain("owned by a");
    const stale = "2026-10-18T10:00:00.000Z";
    expect(
      claimVerdict({
        ...base,
        status: { type: "working", at: stale },
        registryAt: stale,
        heartbeatAt: null,
      }).ok,
    ).toBe(true);
    // A heartbeat keeps a stale registry entry alive.
    expect(
      claimVerdict({
        ...base,
        status: { type: "working", at: stale },
        registryAt: stale,
        heartbeatAt: now - 1000,
      }).ok,
    ).toBe(false);
    // Nothing known about the owner at all → it is gone.
    expect(claimVerdict({ ...base, status: null, registryAt: null, heartbeatAt: null }).ok).toBe(
      true,
    );
    // Unowned waves and the owner re-claiming always succeed.
    expect(
      claimVerdict({ ...base, owner: null, status: null, registryAt: null, heartbeatAt: null }).ok,
    ).toBe(true);
    expect(
      claimVerdict({
        ...base,
        by: "a",
        status: { type: "working", at: fresh },
        registryAt: fresh,
        heartbeatAt: null,
      }).ok,
    ).toBe(true);
  });

  it("detectOwner: VOLLEY_AGENT_ID first, else the newest top-level live session in the caller's cwd", () => {
    const entries = [
      { agent_id: "coord-old", parent_id: null, cwd: "/repo", started_at: "2026-10-18T09:00:00Z" },
      { agent_id: "coord-new", parent_id: null, cwd: "/repo", started_at: "2026-10-18T10:00:00Z" },
      {
        agent_id: "worker-x",
        parent_id: "coord-new",
        cwd: "/repo",
        started_at: "2026-10-18T11:00:00Z",
      },
      { agent_id: "elsewhere", parent_id: null, cwd: "/other", started_at: "2026-10-18T11:00:00Z" },
    ];
    expect(detectOwner(entries, { agentId: "elsewhere", cwd: "/repo" })).toBe("elsewhere");
    expect(detectOwner(entries, { cwd: "/repo" })).toBe("coord-new");
    expect(detectOwner(entries, { cwd: "/nowhere" })).toBeNull();
  });
});
