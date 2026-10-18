import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { claimVerdict, detectOwner, guardMutation, resolveCaller } from "../src/ownership";
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
async function heartbeat(agentId: string, sentAt?: Date) {
  const env = buildEnvelope({
    ...(sentAt !== undefined ? { now: () => sentAt } : {}),
    agentId,
    parentId: null,
    channel: "progress",
    type: "heartbeat",
    payload: { source: "harness-hook", seq: 1, hook_event: "PostToolUse" },
  });
  await pub.publish(`volley/${NS}/${agentId}/progress`, JSON.stringify(env), {
    qos: 0,
    retain: false,
  });
}
/** Move the wall clock (Date only; timers stay real so MQTT keeps working). */
function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}
const settle = () => new Promise((r) => setTimeout(r, 150));
const TWO_HOURS = 2 * 3600_000;

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
  vi.useRealTimers();
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

  it("refuses claim while the owner is working with a fresh status and registry entry", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "working");
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("coord-a");
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
  });

  it("refuses claim while the owner is working with a fresh heartbeat (stale status and registry)", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "working");
    advanceClock(TWO_HOURS); // registry, status, submit and daemon start are now 2 h old
    // Without the heartbeat the owner is claimable…
    const probe = claimVerdict({
      owner: "coord-a",
      by: "coord-b",
      status: { type: "working", at: new Date(Date.now() - TWO_HOURS).toISOString() },
      registryAt: new Date(Date.now() - TWO_HOURS).toISOString(),
      heartbeatAt: Date.now() - TWO_HOURS,
      ownedSince: new Date(Date.now() - TWO_HOURS).toISOString(),
      now: Date.now(),
      claimAfterS: 1800,
    });
    expect(probe.ok).toBe(true);
    // …but one heartbeat on its progress channel, seen by the daemon, keeps it alive.
    await heartbeat("coord-a");
    await settle();
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owned by coord-a .*last seen 0s ago/);
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
  });

  it("a heartbeat counts from its envelope wall_time, not its (late) arrival", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "working");
    const sent = new Date();
    advanceClock(TWO_HOURS);
    // A progress message queued while the daemon was down, delivered 2 h after it was sent.
    await heartbeat("coord-a", sent);
    await settle();
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.error).toBeUndefined();
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-b");
  });

  it("refuses claim of an owner the broker has never seen until claim_after_s has passed", async () => {
    // coord-a has no registry entry, no status and no heartbeat.
    const early = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(early.ok).toBe(false);
    expect(early.error).toContain("owned by coord-a");
    advanceClock(1801_000);
    const later = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(later.error).toBeUndefined();
    expect(later.result).toMatchObject({ owner: "coord-b", previous: "coord-a" });
    expect((later.result as { why: string }).why).toMatch(/silent for 18\d\ds/);
  });

  it("after a daemon restart, a live owner is not claimable until claim_after_s has passed", async () => {
    await agentRegistry("coord-a", "/work");
    await agentStatus("coord-a", "working");
    advanceClock(TWO_HOURS); // the owner lives on heartbeats only…
    await heartbeat("coord-a");
    await settle();
    await daemon.stop(); // …and the restarted daemon has not seen one yet
    daemon = await t.start();
    const res = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("owned by coord-a");
    advanceClock(1801_000); // still silent past claim_after_s after the restart → claimable
    const later = await client.request("claim", { wave: WAVE, by: "coord-b" });
    expect(later.error).toBeUndefined();
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-b");
  });

  it("refuses a claim that carries no caller identity", async () => {
    await agentStatus("coord-a", "reaped");
    const res = await client.request("claim", { wave: WAVE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("claim needs an identity");
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
  });

  it("refuses a claim whose new owner is not a valid agent id (the wave-state owner pattern)", async () => {
    await agentStatus("coord-a", "reaped");
    const res = await client.request("claim", { wave: WAVE, by: "Alice" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^"Alice" is not a valid agent id/); // the CLI adds its own "claim:" prefix
    expect(daemon.snapshot(WAVE)?.owner).toBe("coord-a");
    expect(daemon.journalEvents(WAVE).some((e) => e.type === "owner_claimed")).toBe(false);
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
    await agentRegistry("coord-a", "/work");
    advanceClock(TWO_HOURS);
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
    const stale = "2026-10-18T10:00:00.000Z";
    const base = { owner: "a", by: "b", now, claimAfterS: 1800, ownedSince: stale };
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
    // Nothing known about the owner: silence counts from when it got the wave.
    expect(claimVerdict({ ...base, status: null, registryAt: null, heartbeatAt: null }).ok).toBe(
      true,
    );
    expect(
      claimVerdict({
        ...base,
        ownedSince: fresh,
        status: null,
        registryAt: null,
        heartbeatAt: null,
      }).ok,
    ).toBe(false);
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

  it("detectOwner: VOLLEY_AGENT_ID first, else the newest top-level session in the caller's cwd", () => {
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

  it("detectOwner: the closest directory beats a newer session in a parent directory", () => {
    const entries = [
      {
        agent_id: "coord-repo",
        parent_id: null,
        cwd: "/srv/me/repo",
        started_at: "2026-10-18T09:00:00Z",
      },
      {
        agent_id: "coord-home",
        parent_id: null,
        cwd: "/srv/me/",
        started_at: "2026-10-18T11:00:00Z",
      },
    ];
    expect(detectOwner(entries, { cwd: "/srv/me/repo/packages/x" })).toBe("coord-repo");
    expect(detectOwner(entries, { cwd: "/srv/me/other" })).toBe("coord-home");
  });

  it("detectOwner: skips the daemon and sessions whose status is terminal", () => {
    const entries = [
      { agent_id: "volleyd", parent_id: null, cwd: "/srv/me", started_at: "2026-10-18T12:00:00Z" },
      {
        agent_id: "coord-dead",
        parent_id: null,
        cwd: "/srv/me/repo",
        started_at: "2026-10-18T11:00:00Z",
      },
      {
        agent_id: "coord-live",
        parent_id: null,
        cwd: "/srv/me/repo",
        started_at: "2026-10-18T09:00:00Z",
      },
    ];
    const statuses = new Map([
      ["coord-dead", "reaped"],
      ["coord-live", "working"],
    ]);
    expect(detectOwner(entries, { cwd: "/srv/me/repo" }, statuses)).toBe("coord-live");
    expect(detectOwner(entries.slice(0, 1), { cwd: "/srv/me" })).toBeNull();
  });

  it("detectOwner: only sessions of the caller's namespace qualify", () => {
    const entries = [
      {
        agent_id: "coord-other-ns",
        parent_id: null,
        namespace: "other",
        cwd: "/repo",
        started_at: "2026-10-18T11:00:00Z",
      },
      {
        agent_id: "coord-mine",
        parent_id: null,
        namespace: "mine",
        cwd: "/repo",
        started_at: "2026-10-18T09:00:00Z",
      },
    ];
    expect(detectOwner(entries, { cwd: "/repo", namespace: "mine" })).toBe("coord-mine");
    expect(detectOwner(entries, { cwd: "/repo", namespace: "none" })).toBeNull();
  });

  it("resolveCaller: a flag wins; VOLLEY_AGENT_ID is checked against the registry", async () => {
    const reg = (id: string) =>
      JSON.stringify(
        buildEnvelope({
          agentId: id,
          parentId: null,
          channel: "_system/registry",
          type: "registered",
          payload: { cwd: "/repo", started_at: "2026-10-18T09:00:00Z" },
        }),
      );
    const fake = {
      readRegistry: async () => [reg("coord-a")],
      readStatuses: async () => new Map<string, string>(),
    };
    expect(await resolveCaller(fake, "flagged", {})).toEqual({ id: "flagged", auto: false });
    expect(await resolveCaller(fake, undefined, { VOLLEY_AGENT_ID: "coord-a" })).toEqual({
      id: "coord-a",
      auto: true,
    });
    const ghost = await resolveCaller(fake, undefined, { VOLLEY_AGENT_ID: "ghost" });
    expect(ghost).toMatchObject({ id: "ghost", auto: true });
    expect(ghost.warning).toContain("VOLLEY_AGENT_ID=ghost has no registry entry");
    expect(await resolveCaller(fake, undefined, {}, "/repo/sub")).toEqual({
      id: "coord-a",
      auto: true,
    });
  });
});
