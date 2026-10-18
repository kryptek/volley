import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { NS } from "./helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

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
    s = await makeSupervisedEnv({ reapGraceMs: 200 });
    await s.status("reaped", { reason: "lwt" });
    await s.until(() => s.journal().some((e) => e.type === "decision_opened"), 5_000);
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
    await s.until(() => s.journal().some((e) => e.data.reason === "artifacts"));
    await s.agent.publish(topic, done, { qos: 1, retain: true });
    // Long enough for a second claim to be checked and escalated: onFinal and retire each probe
    // the retained result first.
    await new Promise((r) => setTimeout(r, 3 * DAEMON_DEFAULTS.probe_ms + 500));
    expect(s.journal().filter((e) => e.type === "steering_sent")).toHaveLength(1);
    expect(s.journal().some((e) => e.type === "decision_opened")).toBe(false);
  });
});
