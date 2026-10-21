import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { summaryLine } from "../src/autopilot/digest";
import { ControlClient, waveDigestTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import { eventually } from "./helpers/broker-wait";
import { AUTOPILOT_ON, type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { schemaErrors } from "./helpers/schema";

const WAVE = "w-dig";
const OWNER = "coord-a";
const YAML = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
  B: { issue: 2 }
`;

let t: DaemonEnv;
let clock: FakeClock;
let daemon: Daemon;
let client: ControlClient;
let sub: VolleyBroker;
let pushes: { type: string; payload: Record<string, unknown> }[];
let markers: string[];

beforeEach(async () => {
  clock = fakeClock(Date.parse("2026-10-20T22:00:00.000Z"));
  t = await makeDaemonEnv();
  daemon = await t.start({ ...AUTOPILOT_ON, clock });
  client = await ControlClient.connect(t.broker.url, NS);
  pushes = [];
  markers = [];
  sub = new VolleyBroker();
  await sub.connect({ url: t.broker.url, agentId: "test-notify" });
  await sub.subscribeStream(`volley/${NS}/volleyd/progress`, (m) => {
    const env = JSON.parse(m.payload);
    if (env.type === "digest") pushes.push(env);
    if (env.type === "marker") markers.push(env.id);
  });
  expect((await client.request("run", { wave_yaml: YAML, owner: OWNER })).error).toBeUndefined();
});
afterEach(async () => {
  await sub.disconnect();
  await client.close();
  await t.cleanup();
});

const published = () =>
  daemon
    .journalEvents(WAVE)
    .filter((e) => e.type === "digest_published")
    .map((e) => e.data.trigger);

/**
 * Every push the notify bridge would see: once `n` arrived, a marker the test publishes after them
 * on the same topic comes back, so any push the daemon sent before it has arrived too.
 */
async function pushed(n: number): Promise<typeof pushes> {
  await eventually(() => pushes.length >= n);
  const id = `marker-${n}-${pushes.length}`;
  await sub.publish(`volley/${NS}/volleyd/progress`, JSON.stringify({ type: "marker", id }), {
    qos: 1,
    retain: false,
  });
  await eventually(() => markers.includes(id));
  return pushes;
}

async function retainedDigest(): Promise<{ payload: Record<string, unknown> }> {
  const env = (await t.retained(waveDigestTopic(WAVE))) as { payload: Record<string, unknown> };
  expect(schemaErrors("digest.schema.json", env)).toEqual([]);
  return env;
}

const escalate = (question: string) =>
  daemon.openDecision(WAVE, { kind: "plan_change", task: null, question, options: ["apply"] });

describe("the morning digest in the daemon (SPEC §4.6.16)", () => {
  it("wave_complete → retained digest, digest_published, exactly one digest push", async () => {
    for (const task of ["A", "B"])
      await daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: "done" } });
    await daemon.tick();
    await daemon.tick();
    expect(daemon.record(WAVE)?.state?.status).toBe("complete");

    expect(published()).toEqual(["wave_complete"]);
    const env = await retainedDigest();
    expect(env.payload).toMatchObject({ wave: WAVE, trigger: "wave_complete", shipped: [] });
    const p = await pushed(1);
    expect(p).toHaveLength(1);
    expect(p[0]?.payload).toMatchObject({
      wave: WAVE,
      trigger: "wave_complete",
      msg: summaryLine(env.payload as never),
    });
    expect(String(p[0]?.payload.msg)).toMatch(/^w-dig complete: 0 shipped/);
    expect(schemaErrors("progress.schema.json", p[0])).toEqual([]);

    // The digest op returns the retained payload.
    const r = await client.request("digest", { wave: WAVE });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(env.payload);
  });

  it("the first escalation pushes once; a second inside digest_min_interval_s does not; after it, one more", async () => {
    await escalate("Add a task T3?");
    expect(published()).toEqual(["escalation"]);
    expect((await retainedDigest()).payload.waiting).toHaveLength(1);

    await clock.advance(60_000);
    await escalate("Add a task T4?");
    expect(published()).toEqual(["escalation"]);

    await clock.advance(1800_000);
    await escalate("Add a task T5?");
    expect(published()).toEqual(["escalation", "escalation"]);
    expect((await retainedDigest()).payload.waiting).toHaveLength(3);
    expect(await pushed(2)).toHaveLength(2);
  });

  it("release_go opening → trigger release_go, and its own escalation adds none", async () => {
    await daemon.openDecision(WAVE, {
      kind: "release_go",
      task: null,
      question: "Every stage verified. go?",
      options: ["go", "hold"],
    });
    expect(daemon.journalEvents(WAVE).some((e) => e.type === "decision_escalated")).toBe(true);
    expect(published()).toEqual(["release_go"]);
    expect(await pushed(1)).toHaveLength(1);
  });

  it("a stop → trigger stopped", async () => {
    expect((await client.request("stop", { wave: WAVE, by: OWNER })).ok).toBe(true);
    expect(published()).toEqual(["stopped"]);
    expect((await retainedDigest()).payload.trigger).toBe("stopped");
  });

  it("archiving the wave clears its retained digest", async () => {
    expect((await client.request("stop", { wave: WAVE, by: OWNER })).ok).toBe(true);
    expect(await t.retained(waveDigestTopic(WAVE))).not.toBeNull();
    expect((await client.request("archive", { wave: WAVE, by: OWNER })).ok).toBe(true);
    expect(await t.retained(waveDigestTopic(WAVE))).toBeNull();
  });

  it("the digest op refuses a wave with no digest yet, and an unknown wave", async () => {
    const r = await client.request("digest", { wave: WAVE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no digest yet");
    expect((await client.request("digest", { wave: "nope" })).error).toContain("unknown wave");
  });
});
