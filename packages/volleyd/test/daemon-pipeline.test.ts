import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { decisionTopic } from "../src/decisions";
import { NS } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import {
  AGENT,
  ARTIFACTS_OK,
  PR_HEAD,
  type SupervisedEnv,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

/**
 * The daemon's side of the pipeline (T6): which statuses reach it, and how. The pipeline itself
 * is covered in pipeline.test.ts on the in-memory harness.
 */

let s: SupervisedEnv;
afterEach(async () => {
  await s?.cleanup();
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
