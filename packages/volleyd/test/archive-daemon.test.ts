import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { ARCHIVE_TOPIC, ControlClient, waveEventsTopic, waveStateTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import { decisionTopic, waveDecisionId } from "../src/decisions";
import type { WaveState } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { fakeExec } from "./helpers/fake-exec";
import { schemaErrors } from "./helpers/schema";

const WAVE = "w-arch";
const OWNER = "coord-a";
const H = 3_600_000;
const yaml = (wave: string) => `wave: ${wave}
repo: example-org/example-repo
release_branch: release/${wave}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
  B: { issue: 2 }
`;

/** `volley auth list` knows admin-1 (admin) and steer-1. */
const auth = fakeExec().on(["volley", "auth", "list"], {
  stdout: JSON.stringify({
    accounts: [
      { name: "admin-1", role: "admin", kind: "human", created: "2026-10-19T09:00:00.000Z" },
      { name: "steer-1", role: "steer", kind: "human", created: "2026-10-19T09:00:00.000Z" },
    ],
  }),
});

let t: DaemonEnv;
let clock: FakeClock;
let daemon: Daemon;
let client: ControlClient;

const start = () => t.start({ clock, authExec: auth.exec });

beforeEach(async () => {
  clock = fakeClock(Date.parse("2026-10-20T10:00:00.000Z"));
  t = await makeDaemonEnv();
  daemon = await start();
  client = await ControlClient.connect(t.broker.url, NS);
  const res = await client.request("run", { wave_yaml: yaml(WAVE), owner: OWNER });
  expect(res.error).toBeUndefined();
});
afterEach(async () => {
  await client.close();
  await t.cleanup();
});

const req = (op: Parameters<ControlClient["request"]>[0], fields: Record<string, unknown>) =>
  client.request(op, fields);
const types = () => daemon.journalEvents(WAVE).map((e) => e.type);
const statusWaves = async (all?: boolean) => {
  const r = await req("status", all === true ? { all: true } : {});
  return ((r.result as { waves: (WaveState | null)[] }).waves ?? []).filter(
    (w): w is WaveState => w !== null,
  );
};

/** Open a blocking decision on task A, then stop the wave as its owner. */
async function stopWithDecision(): Promise<string> {
  const d = await daemon.openDecision(WAVE, {
    kind: "agent_blocked",
    task: "A",
    question: "blocked?",
    options: ["retry"],
  });
  expect((await req("stop", { wave: WAVE, by: OWNER })).ok).toBe(true);
  return d.decision_id;
}

/** Drive the wave to complete: both tasks done, two ticks. */
async function complete(): Promise<void> {
  for (const task of ["A", "B"])
    await daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: "done" } });
  await daemon.tick();
  await daemon.tick();
  expect(daemon.record(WAVE)?.state?.status).toBe("complete");
}

describe("volleyd archive (control op)", () => {
  it("refuses a running wave, naming its status", async () => {
    const r = await req("archive", { wave: WAVE, by: OWNER });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("running");
    expect(types()).not.toContain("wave_archived");
  });

  it("dry_run lists what would close and journals nothing", async () => {
    const id = await stopWithDecision();
    const before = daemon.journalEvents(WAVE).length;
    const r = await req("archive", { wave: WAVE, by: OWNER, dry_run: true });
    expect(r).toMatchObject({
      ok: true,
      result: { wave: WAVE, status: "stopped", would_close: [id] },
    });
    expect(daemon.journalEvents(WAVE)).toHaveLength(before);
  });

  it("owner only; closes decisions, clears retained topics, writes the index, leaves status", async () => {
    const id = await stopWithDecision();
    expect((await req("archive", { wave: WAVE, by: "someone-else" })).error).toContain("owned by");

    const tap = new VolleyBroker();
    await tap.connect({ url: t.broker.url, agentId: "test-tap" });
    const mirrored: unknown[] = [];
    await tap.subscribeStream(waveEventsTopic(WAVE), ({ payload }) => {
      const e = parseEnvelope(payload);
      if (e?.type === "wave_archived") mirrored.push(e);
    });
    try {
      const r = await req("archive", { wave: WAVE, by: OWNER });
      expect(r).toMatchObject({ ok: true, result: { wave: WAVE, closed: [id] } });
      const evs = daemon.journalEvents(WAVE);
      expect(evs.at(-2)).toMatchObject({
        type: "decision_resolved",
        data: { decision_id: id, answer: "archived", by: OWNER },
      });
      expect(evs.at(-1)).toMatchObject({
        type: "wave_archived",
        data: { by: OWNER, reason: "volleyd archive", closed_decisions: [id] },
      });
      expect(await t.retained(waveStateTopic(WAVE))).toBeNull();
      expect(await t.retained(decisionTopic(WAVE, id))).toBeNull();
      const index = (await t.retained(ARCHIVE_TOPIC)) as { payload: { archived: unknown[] } };
      expect(schemaErrors("archive.schema.json", index)).toEqual([]);
      expect(index.payload.archived).toEqual([
        expect.objectContaining({ wave: WAVE, status: "stopped", by: OWNER }),
      ]);
      await eventually(async () => mirrored.length === 1);
      expect(schemaErrors("wave-event.schema.json", mirrored[0])).toEqual([]);
    } finally {
      await tap.disconnect();
    }

    expect((await statusWaves()).map((w) => w.wave)).not.toContain(WAVE);
    const all = (await statusWaves(true)).find((w) => w.wave === WAVE);
    expect(all).toMatchObject({
      status: "archived",
      archived: { by: OWNER, reason: "volleyd archive" },
    });
    expect((await req("status", { wave: WAVE })).result).toMatchObject({ status: "archived" });
    // Out of the live set: decisions are not listed, mutating ops say it is archived.
    const ds = (await req("decisions", {})).result as { decisions: unknown[] };
    expect(ds.decisions).toEqual([]);
    expect((await req("resume", { wave: WAVE, by: OWNER })).error).toContain("archived");
    // A second archive: refused, nothing more journaled.
    expect((await req("archive", { wave: WAVE, by: OWNER })).error).toContain("archived");
  });

  it("a re-run of an archived wave id is refused", async () => {
    await stopWithDecision();
    expect((await req("archive", { wave: WAVE, by: OWNER })).ok).toBe(true);
    const r = await req("run", { wave_yaml: yaml(WAVE), owner: OWNER });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`wave '${WAVE}' is archived; pick another id`);
  });

  it("a restarted daemon keeps it out of the live set and republishes nothing for it", async () => {
    await stopWithDecision();
    expect((await req("archive", { wave: WAVE, by: OWNER })).ok).toBe(true);
    await client.close();
    await daemon.stop();
    daemon = await start();
    client = await ControlClient.connect(t.broker.url, NS);
    expect((await statusWaves()).map((w) => w.wave)).not.toContain(WAVE);
    expect((await statusWaves(true)).find((w) => w.wave === WAVE)?.status).toBe("archived");
    expect(await t.retained(waveStateTopic(WAVE))).toBeNull();
    const index = (await t.retained(ARCHIVE_TOPIC)) as { payload: { archived: unknown[] } };
    expect(index.payload.archived).toHaveLength(1);
  });

  it("a restart clears what a crash between journaling and clearing left retained", async () => {
    const id = await stopWithDecision();
    expect((await req("archive", { wave: WAVE, by: OWNER })).ok).toBe(true);
    await client.close();
    await daemon.stop();
    // The crash window: wave_archived is journaled, the retained topics are not yet cleared.
    const tap = new VolleyBroker();
    await tap.connect({ url: t.broker.url, agentId: "test-tap" });
    try {
      for (const topic of [waveStateTopic(WAVE), decisionTopic(WAVE, id)])
        await tap.publish(topic, JSON.stringify({ stale: true }), { qos: 1, retain: true });
    } finally {
      await tap.disconnect();
    }
    daemon = await start();
    client = await ControlClient.connect(t.broker.url, NS);
    expect(await t.retained(waveStateTopic(WAVE))).toBeNull();
    expect(await t.retained(decisionTopic(WAVE, id))).toBeNull();
  });

  it("status of an archived wave reports the config it ran with, across a restart", async () => {
    const w = "w-arch-cfg";
    const run = await req("run", {
      wave_yaml: `${yaml(w)}config: { archive_ended_after_h: 48 }\n`,
      owner: OWNER,
    });
    expect(run.error).toBeUndefined();
    expect((await req("stop", { wave: w, by: OWNER })).ok).toBe(true);
    expect((await req("archive", { wave: w, by: OWNER })).ok).toBe(true);
    const cfgOf = async () =>
      (await statusWaves(true)).find((s) => s.wave === w)?.effective_config?.archive_ended_after_h;
    expect(await cfgOf()).toBe(48);
    await client.close();
    await daemon.stop();
    daemon = await start();
    client = await ControlClient.connect(t.broker.url, NS);
    expect(await cfgOf()).toBe(48);
  });

  it("refuses a stopped wave whose agents are still in their stop grace", async () => {
    await daemon.tick();
    await daemon.recordEvent(WAVE, {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "agent-a1" },
    });
    expect((await req("stop", { wave: WAVE, by: OWNER })).ok).toBe(true);
    const r = await req("archive", { wave: WAVE, by: OWNER });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stop grace");
    expect(types()).not.toContain("wave_archived");
  });
});

describe("auto-archive", () => {
  it("archive_ended_after_h: a stopped wave is archived 24 h after its stop, by volleyd", async () => {
    await stopWithDecision();
    await clock.advance(23 * H);
    await daemon.tick();
    expect(types()).not.toContain("wave_archived");
    await clock.advance(H);
    await daemon.tick();
    const last = daemon.journalEvents(WAVE).at(-1);
    expect(last).toMatchObject({ type: "wave_archived", data: { by: "volleyd" } });
    expect(String(last?.data.reason)).toContain("archive_ended_after_h");
    expect(await t.retained(waveStateTopic(WAVE))).toBeNull();
  });

  it("archive_ended_after_h: 0 never archives", async () => {
    const set = await req("config_set", {
      patch: { archive_ended_after_h: 0 },
      by: OWNER,
      text: "never archive",
    });
    expect(set.ok).toBe(true);
    await stopWithDecision();
    await clock.advance(48 * H);
    await daemon.tick();
    expect(types()).not.toContain("wave_archived");
  });

  it("archive_on_ack: answering wave_complete archives the wave in the same request", async () => {
    await complete();
    const id = waveDecisionId("wave_complete", WAVE);
    const r = await req("resolve", {
      wave: WAVE,
      decision_id: id,
      answer: "acknowledged",
      by: OWNER,
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const last = daemon.journalEvents(WAVE).at(-1);
    expect(last).toMatchObject({ type: "wave_archived", data: { by: "volleyd" } });
    expect(String(last?.data.reason)).toContain("archive_on_ack");
    const index = (await t.retained(ARCHIVE_TOPIC)) as { payload: { archived: unknown[] } };
    expect(index.payload.archived).toEqual([
      expect.objectContaining({ wave: WAVE, status: "complete" }),
    ]);
  });

  it("archive_on_ack: false waits for the TTL", async () => {
    const set = await req("config_set", {
      patch: { archive_on_ack: false },
      by: OWNER,
      text: "keep complete waves",
    });
    expect(set.ok).toBe(true);
    await complete();
    const id = waveDecisionId("wave_complete", WAVE);
    await req("resolve", { wave: WAVE, decision_id: id, answer: "acknowledged", by: OWNER });
    await daemon.tick();
    expect(types()).not.toContain("wave_archived");
    await clock.advance(24 * H);
    await daemon.tick();
    expect(types()).toContain("wave_archived");
  });
});

describe("archive as an admin (account-op topic)", () => {
  /** `archive` as `user` on its account-op topic, answered on its reply topic. */
  async function adminArchive(user: string): Promise<Record<string, unknown>> {
    const admin = new VolleyBroker();
    await admin.connect({ url: t.broker.url, agentId: `admin-${randomUUID().slice(0, 6)}` });
    try {
      const cid = randomUUID();
      let resolve!: (p: Record<string, unknown>) => void;
      const reply = new Promise<Record<string, unknown>>((r) => {
        resolve = r;
      });
      await admin.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
        const e = parseEnvelope(raw);
        if (e?.type === "ack" && e.correlation_id === cid)
          resolve(e.payload as Record<string, unknown>);
      });
      const env = buildEnvelope({
        agentId: user,
        parentId: null,
        channel: "_system/auth",
        type: "query",
        correlationId: cid,
        payload: { op: "archive", wave: WAVE },
      });
      await admin.publish(authOpsTopic(user), JSON.stringify(env), { qos: 1, retain: false });
      return await reply;
    } finally {
      await admin.disconnect();
    }
  }

  it("an admin archives an ended wave it does not own; a non-admin is refused", async () => {
    await stopWithDecision();
    const refused = await adminArchive("steer-1");
    expect(refused).toMatchObject({ ok: false, op: "archive" });
    expect(types()).not.toContain("wave_archived");
    const r = await adminArchive("admin-1");
    expect(r).toMatchObject({ ok: true, op: "archive" });
    expect(daemon.journalEvents(WAVE).at(-1)).toMatchObject({
      type: "wave_archived",
      data: { by: "admin-1", reason: "volleyd archive (admin)" },
    });
  });
});
