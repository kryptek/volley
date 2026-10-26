import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { ControlClient, waveStateTopic } from "../src/control";
import { holdReason } from "../src/controls";
import type { Daemon } from "../src/daemon";
import { decisionTopic, waveDecisionId } from "../src/decisions";
import { emptyRecord } from "../src/reducer";
import type { JournalEvent } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { AUTOPILOT_ON, type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

// The release train (SPEC §4.6.19): a settled wave whose repo ships a playbook starts releasing
// instead of opening the wave_complete decision, and asks the owner release_go once every stage
// is verified. Running a stage is A8's; here the stage events are journaled by hand.

const WAVE = "w-rel";
const PLAYBOOK =
  "version: 1\nstages:\n  - { name: smoke, brief: Run the smoke. }\n  - { name: notes, brief: Draft the notes., gate: owner }\n";

let t: DaemonEnv | undefined;
let daemon: Daemon;
let client: ControlClient | undefined;
let repo: string;

const waveYaml = (extra = "") => `wave: ${WAVE}
repo: ${repo}
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
${extra}tasks:
  A: { issue: 1 }
  B: { issue: 2 }
`;

/** The env this test started; every daemon test calls start() first. */
const testEnv = (): DaemonEnv => {
  if (t === undefined) throw new Error("start() first");
  return t;
};
const ctl = (): ControlClient => {
  if (client === undefined) throw new Error("start() first");
  return client;
};

async function start(extra: Parameters<DaemonEnv["start"]>[0] = AUTOPILOT_ON): Promise<void> {
  t = await makeDaemonEnv();
  daemon = await t.start(extra);
  client = await ControlClient.connect(t.broker.url, NS);
}

async function submit(extra = ""): Promise<void> {
  const res = await ctl().request("run", { wave_yaml: waveYaml(extra), owner: "coord-a" });
  expect(res.error).toBeUndefined();
}

async function settle(): Promise<void> {
  for (const task of ["A", "B"])
    await daemon.recordEvent(WAVE, { type: "stage_entered", task, data: { stage: "done" } });
  await daemon.tick();
}

const journal = (): JournalEvent[] => daemon.journalEvents(WAVE);
const ofType = (type: string) => journal().filter((e) => e.type === type);

async function retainedState(): Promise<Record<string, unknown>> {
  const env = (await testEnv().retained(waveStateTopic(WAVE))) as {
    payload: Record<string, unknown>;
  };
  expect(schemaErrors("wave-state.schema.json", env)).toEqual([]);
  return env.payload;
}

/** Every attention envelope the notify bridge publishes, from now on. */
async function bridge(): Promise<{ ids: () => string[]; close: () => Promise<void> }> {
  const sub = new VolleyBroker();
  await sub.connect({ url: testEnv().broker.url, agentId: "test-notify" });
  const seen: string[] = [];
  const unsub = await sub.subscribeStream(`volley/${NS}/volleyd/progress`, (m) => {
    const env = JSON.parse(m.payload);
    if (env.type === "blocked" && env.payload?.attention === "decision_opened")
      seen.push(env.payload.decision_id as string);
  });
  return {
    ids: () => seen,
    close: async () => {
      await unsub();
      await sub.disconnect();
    },
  };
}

beforeEach(() => {
  repo = tempDir("volleyd-release-repo-");
  mkdirSync(join(repo, ".volley"));
  writeFileSync(join(repo, ".volley", "release.yaml"), PLAYBOOK);
});
afterEach(async () => {
  await client?.close();
  await t?.cleanup();
  client = undefined;
  t = undefined;
});

const verify = (stage: string, evidence?: string) =>
  daemon.recordEvent(WAVE, {
    type: "release_stage_verified",
    data: { stage, ...(evidence !== undefined ? { evidence } : {}) },
  });

describe("a settled wave whose repo has a playbook", () => {
  it("journals release_started (path, sha256, stages) instead of the wave_complete decision; status releasing", async () => {
    await start();
    await submit();
    await settle();
    await daemon.tick();
    const started = ofType("release_started");
    expect(started).toHaveLength(1);
    expect(started[0]?.data).toMatchObject({
      done: ["A", "B"],
      cancelled: [],
      playbook: {
        path: join(repo, ".volley", "release.yaml"),
        sha256: createHash("sha256").update(PLAYBOOK).digest("hex"),
        stages: [
          { name: "smoke", gate: "auto" },
          { name: "notes", gate: "owner" },
        ],
      },
    });
    expect(ofType("wave_complete")).toHaveLength(0);
    expect(ofType("decision_opened")).toHaveLength(0);
    const state = await retainedState();
    expect(state.status).toBe("releasing");
    expect(state.open_decisions).toEqual([]);
    // No tag, no default branch read here: the day only (the playbook needs no variable).
    expect(state.release).toEqual({
      stage: null,
      phase: "prepare",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      stages: [
        { name: "smoke", state: "pending" },
        { name: "notes", state: "pending" },
      ],
    });
  });

  it("every stage verified → release_go (owner-only: escalated, rings once); go → release_done, complete", async () => {
    await start();
    await submit();
    await settle();
    const ring = await bridge();
    try {
      await verify("smoke", "/ev/smoke.md");
      expect(ofType("decision_opened")).toHaveLength(0);
      await verify("notes");
      const opened = ofType("decision_opened");
      expect(opened).toHaveLength(1);
      const id = waveDecisionId("release_go", WAVE);
      expect(opened[0]?.task).toBeUndefined();
      expect(opened[0]?.data).toMatchObject({
        decision_id: id,
        kind: "release_go",
        options: ["go", "hold"],
        stages: [{ name: "smoke", evidence: "/ev/smoke.md" }, { name: "notes" }],
      });
      expect(ofType("decision_escalated")[0]?.data).toMatchObject({
        decision_id: id,
        why: "owner_only",
      });
      const d = (await testEnv().retained(decisionTopic(WAVE, id))) as {
        payload: { task: string | null; stages: unknown };
      };
      expect(schemaErrors("decision.schema.json", d)).toEqual([]);
      expect(d.payload.task).toBeNull();
      expect(d.payload.stages).toEqual([
        { name: "smoke", evidence: "/ev/smoke.md" },
        { name: "notes" },
      ]);
      await daemon.tick();
      expect(ofType("decision_opened")).toHaveLength(1);
      // Not expect.poll: the bun test runner (one of CI's two runners) does not provide it.
      await eventually(() => JSON.stringify(ring.ids()) === JSON.stringify([id]));
      expect(ring.ids()).toEqual([id]);

      const r = await ctl().request("resolve", { decision_id: id, answer: "go", by: "coord-a" });
      expect(r.error).toBeUndefined();
      expect(ofType("release_done")[0]?.data).toMatchObject({ by: "coord-a", decision_id: id });
      const state = await retainedState();
      expect(state.status).toBe("complete");
      expect(state.open_decisions).toEqual([]);
    } finally {
      await ring.close();
    }
  });

  it("hold keeps it releasing with release_go open again (class held); go on that one completes it", async () => {
    await start();
    await submit();
    await settle();
    await verify("smoke");
    await verify("notes");
    const first = waveDecisionId("release_go", WAVE);
    expect(
      (await ctl().request("resolve", { decision_id: first, answer: "hold", by: "coord-a" })).error,
    ).toBeUndefined();
    expect(ofType("release_done")).toHaveLength(0);
    const state = await retainedState();
    expect(state.status).toBe("releasing");
    const open = state.open_decisions as string[];
    expect(open).toHaveLength(1);
    expect(open[0]).not.toBe(first);
    const again = daemon.record(WAVE)?.decisions[open[0] as string] as unknown as Record<
      string,
      unknown
    >;
    expect(again).toMatchObject({ kind: "release_go", class: "held", options: ["go", "hold"] });
    // A tick does not open a third.
    await daemon.tick();
    expect(ofType("decision_opened")).toHaveLength(2);
    await ctl().request("resolve", { decision_id: open[0], answer: "go", by: "coord-a" });
    expect((await retainedState()).status).toBe("complete");
  });

  it("release_go answered go but release_done not journaled: the next tick journals it", async () => {
    await start();
    await submit();
    await settle();
    await verify("smoke");
    await verify("notes");
    const id = waveDecisionId("release_go", WAVE);
    // The resolution journaled by hand: the append of release_done that follows it is dropped.
    await daemon.recordEvent(WAVE, {
      type: "decision_resolved",
      data: { decision_id: id, answer: "go", by: "coord-a", at: "2026-10-20T00:00:00.000Z" },
    });
    expect(ofType("release_done")).toHaveLength(0);
    await daemon.tick();
    expect(ofType("release_done").map((e) => e.data)).toEqual([{ by: "coord-a", decision_id: id }]);
    expect((await retainedState()).status).toBe("complete");
    expect(ofType("decision_opened")).toHaveLength(1);
  });

  it("a stopped releasing wave asks nothing", async () => {
    await start();
    await submit();
    await settle();
    expect((await ctl().request("stop", { wave: WAVE, by: "coord-a" })).ok).toBe(true);
    await verify("smoke");
    await verify("notes");
    expect(ofType("decision_opened")).toHaveLength(0);
  });

  it("a releasing wave pauses and resumes releasing; paused, it asks nothing; resume when releasing is a no-op", async () => {
    await start();
    await submit();
    await settle();
    const noop = await ctl().request("resume", { wave: WAVE, by: "coord-a" });
    expect(noop.error).toBeUndefined();
    expect(noop.result).toMatchObject({ status: "releasing", changed: false });
    expect(ofType("wave_resumed")).toHaveLength(0);
    const paused = await ctl().request("pause", { wave: WAVE, by: "coord-a" });
    expect(paused.error).toBeUndefined();
    expect((await retainedState()).status).toBe("paused");
    await verify("smoke");
    await verify("notes");
    await daemon.tick();
    expect(ofType("decision_opened")).toHaveLength(0);
    const resumed = await ctl().request("resume", { wave: WAVE, by: "coord-a" });
    expect(resumed.error).toBeUndefined();
    expect((await retainedState()).status).toBe("releasing");
    expect(ofType("decision_opened")[0]?.data).toMatchObject({ kind: "release_go" });
  });

  it("an invalid playbook refuses the wave with RELEASE_PLAYBOOK_INVALID and its errors", async () => {
    writeFileSync(
      join(repo, ".volley", "release.yaml"),
      "version: 1\nstages:\n  - { name: smoke, brief: a, gate: later }\n",
    );
    await start();
    const res = await ctl().request("run", { wave_yaml: waveYaml(), owner: "coord-a" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^RELEASE_PLAYBOOK_INVALID: /);
    expect(res.errors).toEqual([expect.objectContaining({ path: "stages[0].gate" })]);
    expect(daemon.record(WAVE)).toBeUndefined();
  });
});

describe("without a release train", () => {
  it("no playbook: today's wave_complete decision, auto-acknowledged under autopilot", async () => {
    await start();
    await submit("playbook: none\n");
    await settle();
    expect(ofType("release_started")).toHaveLength(0);
    expect(ofType("wave_complete")).toHaveLength(1);
    expect(ofType("decision_auto_resolved")[0]?.data).toMatchObject({ kind: "wave_complete" });
    const state = await retainedState();
    expect(state.status).toBe("complete");
    expect(state.release).toBeUndefined();
  });

  it("autopilot off: the playbook does not run; the wave_complete decision waits for the owner", async () => {
    await start({});
    await submit();
    await settle();
    expect(ofType("release_started")).toHaveLength(0);
    const state = await retainedState();
    expect(state.status).toBe("complete");
    expect(state.open_decisions).toEqual([waveDecisionId("wave_complete", WAVE)]);
  });
  it("a playbook that stops validating before the wave settles: complete, and the question says why on one line", async () => {
    await start();
    await submit();
    writeFileSync(
      join(repo, ".volley", "release.yaml"),
      "version: 1\nstages:\n  - { name: smoke, brief: a, gate: later }\n  - { name: notes }\n",
    );
    await settle();
    expect(ofType("release_started")).toHaveLength(0);
    expect(ofType("wave_complete")).toHaveLength(1);
    const question = ofType("decision_opened")[0]?.data.question as string;
    expect(question).toContain(
      " Its release playbook was not run: RELEASE_PLAYBOOK_INVALID: .volley/release.yaml: invalid release playbook: stages[0].gate: ",
    );
    expect(question).toContain("; stages[1]");
    expect(question).not.toContain("\n");
    expect(question).not.toContain(repo);
    expect((await retainedState()).status).toBe("complete");
  });
  it("an invalid playbook is logged once per wave, however often a tick reads it", async () => {
    const lines: string[] = [];
    await start({ ...AUTOPILOT_ON, log: (line) => lines.push(line) });
    await submit();
    writeFileSync(
      join(repo, ".volley", "release.yaml"),
      "version: 1\nstages:\n  - { name: smoke, brief: a, gate: later }\n",
    );
    const read = (daemon as unknown as { releasePlaybook: (w: string) => unknown }).releasePlaybook;
    for (let i = 0; i < 3; i++) expect(typeof read.call(daemon, WAVE)).toBe("string");
    expect(lines.filter((l) => l.includes("release playbook not run"))).toHaveLength(1);
  });
});

describe("a releasing wave holds admission and new versions", () => {
  it("holdReason: a releasing wave admits nothing", () => {
    const rec = emptyRecord();
    rec.state = {
      wave: WAVE,
      version: 1,
      owner: null,
      repo: "r",
      release_branch: "release/r",
      status: "releasing",
      tasks: [],
      open_decisions: [],
      gates: [],
      updated_at: "2026-10-20T00:00:00.000Z",
    };
    expect(holdReason(rec, false)).toBe("wave releasing");
  });

  it("a new version of a releasing wave is refused", async () => {
    await start();
    await submit();
    await settle();
    const res = await ctl().request("run", {
      wave_yaml: waveYaml().replace("B: { issue: 2 }", "B: { issue: 2 }\n  C: { issue: 3 }"),
      owner: "coord-a",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`wave '${WAVE}' is releasing`);
  });
});
