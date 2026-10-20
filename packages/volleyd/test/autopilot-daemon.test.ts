import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { ControlClient, waveStateTopic } from "../src/control";
import { decisionTopic } from "../src/decisions";
import type { WaveState } from "../src/types";
import { AUTOPILOT_ON, NS } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

let s: SupervisedEnv;
afterEach(async () => {
  await s.cleanup();
});

/** Every attention envelope the notify bridge publishes, from now on. */
async function bridge(): Promise<{ ids: () => string[]; close: () => Promise<void> }> {
  const sub = new VolleyBroker();
  await sub.connect({ url: s.env.broker.url, agentId: "test-notify" });
  const seen: string[] = [];
  // Subscribed (SUBACKed) before any decision is opened, so no event can be missed.
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

const disagree = {
  kind: "reviewers_disagree" as const,
  task: "T1",
  question: "Reviewers disagree on a P1 — is it a blocker?",
  options: ["blocker", "fine"],
};

const types = () => s.journal().map((e) => e.type);

describe("autopilot in the daemon (SPEC §4.6.16)", () => {
  it("answers a reviewers_disagree in the same turn: journaled, resolved by volleyd, never rings", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
    const b = await bridge();
    const d = await s.daemon.openDecision("w1", disagree);
    await s.settled();
    await s.consumed();

    const rec = s.daemon.record("w1");
    expect(rec?.decisions[d.decision_id]?.resolved).toMatchObject({
      answer: "blocker",
      by: "volleyd",
    });
    const ev = s.journal();
    const auto = ev.findIndex((e) => e.type === "decision_auto_resolved");
    const resolved = ev.findIndex((e) => e.type === "decision_resolved");
    expect(auto).toBeGreaterThan(-1);
    expect(resolved).toBe(auto + 1);
    expect(ev[auto]?.data).toMatchObject({
      decision_id: d.decision_id,
      kind: "reviewers_disagree",
      policy: "reviewers_disagree/blocker",
      answer: "blocker",
    });
    expect(ev[resolved]?.data).toMatchObject({ decision_id: d.decision_id, by: "volleyd" });
    expect(await s.env.retained(decisionTopic("w1", d.decision_id))).toBeNull();
    expect(b.ids()).not.toContain(d.decision_id);
    await b.close();

    const state = ((await s.env.retained(waveStateTopic("w1"))) as { payload: WaveState }).payload;
    expect(state.autopilot).toEqual({ enabled: true, auto_resolved: 1, escalated: 0, budgets: {} });
    expect(
      schemaErrors("wave-state.schema.json", {
        ...((await s.env.retained(waveStateTopic("w1"))) as object),
      }),
    ).toEqual([]);
  });

  it("leaves an owner_only plan_change open: decision_escalated, one ring, prefixed question", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
    const b = await bridge();
    const d = await s.daemon.openDecision("w1", {
      kind: "plan_change",
      task: null,
      question: "Add a task T2?",
      options: ["apply", "cancel"],
    });
    await s.settled();
    await s.consumed();

    expect(s.daemon.record("w1")?.state?.open_decisions).toContain(d.decision_id);
    const esc = s.journal().filter((e) => e.type === "decision_escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]?.data).toEqual({
      decision_id: d.decision_id,
      kind: "plan_change",
      why: "owner_only",
    });
    expect(b.ids().filter((id) => id === d.decision_id)).toHaveLength(1);
    await b.close();
    const retained = (await s.env.retained(decisionTopic("w1", d.decision_id))) as {
      payload: { question: string };
    };
    expect(retained.payload.question).toBe(
      "Autopilot could not resolve this (owner_only): Add a task T2?",
    );
    expect(schemaErrors("decision.schema.json", retained)).toEqual([]);
    expect(types()).not.toContain("decision_auto_resolved");
  });

  it("disabled by the wave's config: nothing is answered and nothing is escalated", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON, config: "autopilot: { enabled: false }" });
    const b = await bridge();
    const d = await s.daemon.openDecision("w1", disagree);
    await s.settled();
    await s.consumed();
    expect(s.daemon.record("w1")?.state?.open_decisions).toContain(d.decision_id);
    expect(types()).not.toContain("decision_auto_resolved");
    expect(types()).not.toContain("decision_escalated");
    expect(b.ids()).toContain(d.decision_id);
    await b.close();
    const retained = (await s.env.retained(decisionTopic("w1", d.decision_id))) as {
      payload: { question: string };
    };
    expect(retained.payload.question).toBe(disagree.question);
    expect(s.daemon.snapshot("w1")?.autopilot?.enabled).toBe(false);
  });

  it("config_set autopilot.enabled false takes effect at the next decision", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
    const first = await s.daemon.openDecision("w1", disagree);
    expect(s.daemon.record("w1")?.decisions[first.decision_id]?.resolved?.by).toBe("volleyd");

    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      await client.request(
        "config_set",
        { patch: { autopilot: { enabled: false } }, by: "tester" },
        { text: "autopilot off" },
      );
    } finally {
      await client.close();
    }
    const second = await s.daemon.openDecision("w1", disagree);
    await s.settled();
    expect(s.daemon.record("w1")?.state?.open_decisions).toContain(second.decision_id);
    expect(types().filter((t) => t === "decision_auto_resolved")).toHaveLength(1);
    expect(types()).not.toContain("decision_escalated");
  });

  it("raises the spawn budget within budget_raise_max, and escalates a raise past it", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
    const ask = (n: number) => ({
      kind: "spawn_budget_exhausted" as const,
      task: null,
      question: `raise by ${n}, or cancel?`,
      options: [`raise by ${n}`, "cancel"],
    });
    const small = await s.daemon.openDecision("w1", ask(1));
    expect(s.daemon.record("w1")?.decisions[small.decision_id]?.resolved?.answer).toBe(
      "raise by 1",
    );
    expect(s.daemon.record("w1")?.budget_raised).toBe(1);

    const big = await s.daemon.openDecision("w1", ask(1000));
    expect(s.daemon.record("w1")?.state?.open_decisions).toContain(big.decision_id);
    const esc = s.journal().filter((e) => e.type === "decision_escalated");
    expect(esc.at(-1)?.data).toMatchObject({
      decision_id: big.decision_id,
      why: "budget_exhausted",
      budget: { key: "budget_raise_max" },
    });
    expect(s.daemon.snapshot("w1")?.autopilot).toMatchObject({
      enabled: true,
      auto_resolved: 1,
      escalated: 1,
      budgets: { budget_raise_max: { used: 1 } },
    });
  });
});
