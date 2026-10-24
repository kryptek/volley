import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { Daemon } from "../src/daemon";
import { decisionTopic } from "../src/decisions";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import {
  AGENT,
  ARTIFACTS_OK,
  PR_HEAD,
  type SupervisedEnv,
  makeSupervisedEnv,
} from "./helpers/supervised-env";
import { tempDir } from "./helpers/tmp";

/**
 * The daemon's side of the pipeline (T6): which statuses reach it, and how. The pipeline itself
 * is covered in pipeline.test.ts on the in-memory harness.
 */

let s: SupervisedEnv;
let cleaned: SupervisedEnv | undefined;
afterEach(async () => {
  // Once each: a test that builds no supervised env leaves the last one's (already cleaned up).
  if (s === undefined || s === cleaned) return;
  cleaned = s;
  await s.cleanup();
});

describe("daemon → pipeline", () => {
  it("a reaped agent goes through the pipeline: retired, then its respawn / cancel decision", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ reapGraceMs: 200, daemon: { clock } });
    await s.status("reaped", { reason: "lwt" });
    // The daemon holds the reap for its grace; past it, the reap is accepted.
    await clock.armed(200);
    await clock.advance(200);
    await s.event("decision_opened");
    expect(s.journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "reaped",
    });
    expect(s.journal().find((e) => e.type === "decision_opened")?.data).toMatchObject({
      kind: "agent_blocked",
      options: ["respawn", "cancel"],
      pipeline: { on: "agent_failed", role: "implementer" },
    });
  });

  it("a re-delivered done (same envelope) is not a second claim", { timeout: 15_000 }, async () => {
    s = await makeSupervisedEnv();
    // No artifacts in the fake world: the first done is steered once ("push + open PR").
    const done = JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: "volleyd",
        channel: "status",
        type: "done",
        payload: { summary: "ok" },
      }),
    );
    const topic = buildTopic(NS, AGENT, "status");
    await s.agent.publish(topic, done, { qos: 1, retain: true });
    await s.event((e) => e.data.reason === "artifacts");
    await s.agent.publish(topic, done, { qos: 1, retain: true });
    // Long enough for a second claim to be checked and escalated: onFinal and retire each probe
    // the retained result first. A re-delivery the daemon ignores journals nothing to await.
    // broker round-trip: the duplicate's delivery and the retained-result probes (probe_ms each).
    await new Promise((r) => setTimeout(r, 3 * DAEMON_DEFAULTS.probe_ms + 500));
    await s.settled();
    expect(s.journal().filter((e) => e.type === "steering_sent")).toHaveLength(1);
    expect(s.journal().some((e) => e.type === "decision_opened")).toBe(false);
  });

  it("a PR merged on GitHub while its task is parked on a decision (in review): superseded_by_merge, then done", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      exec: ARTIFACTS_OK,
      daemon: { clock },
      pipeline: "[implement, spec_review, merge_ready]",
    });
    // Its result first: onFinal and retire each read it back, and a missing one waits out
    // probe_ms (real time), twice, inside the wait for spec_review below.
    await s.pub(buildTopic(NS, AGENT, "result"), "result", "result", { summary: "ok" });
    await s.status("done");
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "spec_review");
    await s.settled();
    const d = await s.daemon.openDecision("w1", {
      kind: "agent_blocked",
      task: "T1",
      question: "anything?",
      options: ["yes", "no"],
    });
    expect(s.daemon.record("w1")?.state?.tasks[0]?.stage).toBe("awaiting_decision");
    s.host.fake.on(["gh", "pr", "view"], {
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-10-20T12:00:00Z",
        mergeCommit: { oid: "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" },
        baseRefName: "release/w1",
        headRefOid: PR_HEAD,
      }),
    });
    await clock.advance(DAEMON_DEFAULTS.ci_poll_ms);
    await s.daemon.tick();
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "done");
    await s.settled();
    const j = s.journal();
    const at = (pred: (e: (typeof j)[number]) => boolean) => j.findIndex(pred);
    const resolved = at((e) => e.type === "decision_resolved");
    expect(j[resolved]?.data).toMatchObject({
      decision_id: d.decision_id,
      answer: "superseded_by_merge",
      by: "volleyd",
      rationale: "PR #7 merged into release/w1 at 5a5a5a5",
    });
    expect(resolved).toBeLessThan(
      at((e) => e.type === "artifact_verified" && e.data.role === "merged"),
    );
    expect(s.daemon.record("w1")?.state?.tasks[0]?.stage).toBe("done");
    expect(s.daemon.record("w1")?.state?.open_decisions).toEqual([]);
    expect(await s.env.retained(decisionTopic("w1", d.decision_id))).toBeNull();
  });
});

describe("submit journals the footprints and the overlap plan (SPEC §4.6.22)", () => {
  let broker: TestBroker;
  let daemon: Daemon;
  let client: ControlClient;
  afterEach(async () => {
    await client?.close();
    await daemon?.stop();
    await broker?.close();
  });
  const start = async (issueBody?: (repo: string, issue: number) => Promise<string | null>) => {
    broker = await startTestBroker();
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home: tempDir("volleyd-plan-"),
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      ...(issueBody !== undefined ? { issueBody } : {}),
    });
    client = await ControlClient.connect(broker.url, NS);
  };

  it("a wave with files: journals task_queued with issues/files/footprint/plan, then one wave_planned", async () => {
    await start(async () => "never read: every task has files");
    const text = readFileSync(new URL("./fixtures/bundle.yaml", import.meta.url), "utf-8");
    const res = await client.request("run", { wave_yaml: text });
    expect(res.error).toBeUndefined();
    const events = daemon.journalEvents("w-bundle");
    const queued = events.filter((e) => e.type === "task_queued");
    expect(queued.map((e) => e.task)).toEqual(["i1", "i3", "i4"]);
    expect(queued[0]?.data).toEqual({
      issue: 1,
      issues: [1, 2],
      files: ["packages/app/src/pipeline.ts", "packages/app/src/retry.ts"],
      footprint: { confidence: "listed" },
      plan: {
        cluster: "A",
        by: "collapse",
        why: "collapsed #1 + #2: i1 + i2 share packages/app/src/pipeline.ts (coupling 0.90)",
      },
    });
    expect(queued[1]?.data).toMatchObject({ footprint: { unresolved: ["helpers.ts"] } });
    const planned = events.filter((e) => e.type === "wave_planned");
    expect(planned).toHaveLength(1);
    expect(planned[0]?.seq).toBe((queued.at(-1)?.seq ?? 0) + 1);
    expect((planned[0]?.data.clusters as { id: string }[]).map((c) => c.id)).toEqual(["A"]);
    expect(daemon.snapshot("w-bundle")?.overlap_plan?.clusters[0]?.tasks).toEqual(["i1", "i3"]);
    expect(events.some((e) => e.data.alarm === "footprint_unavailable")).toBe(false);
  });

  it("a task without files whose issue cannot be read: footprint_unavailable, and run warns", async () => {
    await start(async (_repo, issue) => {
      if (issue === 5) throw new Error("gh: HTTP 502");
      return null;
    });
    const res = await client.request("run", {
      wave_yaml: `wave: w-fp
repo: /path/to/example-repo
release_branch: release/w-fp
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  T1: { issue: 5 }
  T2: { issue: 6 }
  T3: { issue: 7, files: [src/c.ts] }
`,
    });
    expect(res.error).toBeUndefined();
    const alarms = daemon
      .journalEvents("w-fp")
      .filter((e) => e.type === "alarm_raised" && e.data.alarm === "footprint_unavailable");
    expect(alarms.map((e) => e.data)).toEqual([
      {
        alarm: "footprint_unavailable",
        task: "T1",
        why: "issue #5 could not be read: gh: HTTP 502",
      },
      { alarm: "footprint_unavailable", task: "T2", why: "issue #6 could not be read" },
    ]);
    expect(res.warnings).toEqual([
      "footprint unavailable for T1 (#5): issue #5 could not be read: gh: HTTP 502",
      "footprint unavailable for T2 (#6): issue #6 could not be read",
    ]);
    // Without a footprint the task still queues; with files: it was never fetched.
    const queued = daemon.journalEvents("w-fp").filter((e) => e.type === "task_queued");
    expect(queued.map((e) => e.data)).toEqual([
      { issue: 5 },
      { issue: 6 },
      { issue: 7, files: ["src/c.ts"] },
    ]);
  });
});
