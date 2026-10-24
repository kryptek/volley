import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { coordinatorFor, waveAttention } from "../src/attention";
import { createDemoSteerClient, demoReadControl } from "../src/steer/demoClient";
import {
  configuredMachines,
  deskAccountGroups,
  machineRows,
  pendingProfiles,
} from "../src/store/claude";
import {
  DEMO_AGENTS_MAX,
  DEMO_CLAUDE_REGISTRY,
  DEMO_ENDED_WAVE,
  DIGEST_WAVE,
  NARRATION_POOL,
  PLANNED_WAVE,
  demoAgentCount,
  demoAutopilot,
  demoClaudeAccounts,
  demoClaudeBalance,
  demoDigest,
  demoMessages,
  demoPlanned,
  demoReviewer,
  demoState,
  isDemoMode,
  machinesTick,
  tick,
} from "../src/store/fixtures";
import {
  UNASSIGNED,
  agentsByWave,
  initialState,
  reduceAll,
  routeTopic,
} from "../src/store/reducer";

const NOW = Date.parse("2026-10-18T15:00:00.000Z");

describe("fixtures — demo state", () => {
  it("produces 7 waves (3 stock, 2 autopilot, 1 planned, 1 ended) and 5 agents, all assigned", () => {
    const s = demoState(NOW);
    expect(Object.keys(s.waves)).toHaveLength(7);
    expect(Object.keys(s.agents)).toHaveLength(5);
    expect(agentsByWave(s)[UNASSIGNED]).toEqual([]);
    for (const w of Object.values(s.waves)) expect(w.state?.spec).toBeDefined();
  });

  it("shows autopilot: the releasing wave answered decisions on its own and escalated one", () => {
    const s = demoState(NOW);
    const ap = s.waves.autopilot?.state?.autopilot;
    expect(ap?.enabled).toBe(true);
    expect(ap?.auto_resolved).toBeGreaterThan(0);
    expect(s.waves.autopilot?.state?.merge_queue?.length).toBeGreaterThan(0);
    expect(s.waveFeed?.autopilot?.length).toBeGreaterThan(0);
  });

  it("fills the Needs-you inbox with a decision, a picker and a release item", () => {
    const kinds = new Set(Object.values(demoState(NOW).inbox ?? {}).map((i) => i.kind));
    for (const k of ["decision", "picker", "release"]) expect(kinds.has(k as never), k).toBe(true);
  });

  it("carries a digest for the ended wave, and none yet for the running one", () => {
    const s = demoState(NOW);
    expect(s.waves[DEMO_ENDED_WAVE]?.state?.status).toBe("complete");
    expect(s.digests?.[DEMO_ENDED_WAVE]?.trigger).toBe("wave_complete");
    expect(s.digests?.[DIGEST_WAVE]).toBeUndefined();
  });

  it("the running wave's morning digest lists its open decision as waiting", () => {
    const s = reduceAll(demoState(NOW), demoDigest(NOW + 40_000, DIGEST_WAVE));
    const d = s.digests?.[DIGEST_WAVE];
    expect(d?.trigger).toBe("escalation");
    const open = s.waves[DIGEST_WAVE]?.state?.open_decisions ?? [];
    expect(d?.waiting.some((w) => open.includes(w.id))).toBe(true);
  });

  it("has one coordinator per attention state, as in the prototype", () => {
    const s = demoState(NOW);
    expect(
      Object.values(s.coordinators)
        .map((c) => c.state)
        .sort(),
      // The ended wave's coordinator is gone too (it signed off), which needs nobody; the two
      // autopilot waves share one owner, reconnecting.
    ).toEqual(["awaiting_input", "gone", "gone", "reconnecting", "working"]);
    const waiting = Object.values(s.coordinators).find((c) => c.state === "awaiting_input");
    expect(waiting?.question).toMatch(/merge/i);
  });

  it("carries config, lease pools and an admission summary", () => {
    const s = demoState(NOW);
    expect(s.config?.hard_ceiling).toBe(12);
    expect(s.leases["heavy-it"]?.held).toHaveLength(3);
    expect(s.leases.build?.held).toHaveLength(1);
    expect(s.admission).not.toBeNull();
  });

  it("seeds feeds, screens, narration and old born times", () => {
    const s = demoState(NOW);
    for (const a of Object.values(s.agents)) {
      expect(a.feed.length).toBeGreaterThan(1);
      expect(a.screen?.lines.length).toBeGreaterThan(0);
      expect(a.narration).toBeTruthy();
      expect(NOW - (a.bornAt ?? NOW)).toBeGreaterThan(4_000);
    }
  });
});

describe("fixtures — tick", () => {
  it("advances narration from the pool for running agents (prototype parity)", () => {
    const s0 = demoState(NOW);
    const [id, pool] = Object.entries(NARRATION_POOL)[0] as [string, string[]];
    const before = s0.agents[id];
    const s1 = tick(s0, 1, NOW + 2_600);
    expect(s1.agents[id]?.narration).toBe(pool[1]);
    expect(s1.agents[id]?.progress).toBe(Math.min(97, (before?.progress ?? 0) + 3 + 1));
    expect(s1.agents[id]?.heartbeat).toBe(NOW + 2_600);
    expect(s1.agents[id]?.screen?.lines.length).toBe((before?.screen?.lines.length ?? 0) + 1);
    const s2 = tick(s1, 2, NOW + 5_200);
    expect(s2.agents[id]?.narration).toBe(pool[2]);
  });

  it("pauses narration for two steps after the pool runs out", () => {
    const s0 = demoState(NOW);
    const [id, pool] = Object.entries(NARRATION_POOL)[0] as [string, string[]];
    const quiet = tick(s0, pool.length, NOW + 1);
    expect(quiet.agents[id]?.narration).toBe(s0.agents[id]?.narration);
  });

  it("leaves agents without a pool, or not working, alone", () => {
    const s0 = demoState(NOW);
    const s1 = tick(s0, 1, NOW + 1);
    for (const [id, a] of Object.entries(s0.agents)) {
      if (NARRATION_POOL[id] && a.status?.type === "working") continue;
      expect(s1.agents[id]?.narration).toBe(a.narration);
      expect(s1.agents[id]?.feed).toHaveLength(a.feed.length);
    }
  });

  it("spawns a spec reviewer that joins its wave with a fresh born time", () => {
    const s0 = demoState(NOW);
    const s1 = reduceAll(s0, demoReviewer(NOW + 22_000));
    const added = Object.values(s1.agents).filter((a) => !s0.agents[a.id]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ role: "spec_reviewer", bornAt: NOW + 22_000 });
    expect(added[0]?.wave).not.toBe(UNASSIGNED);
  });
});

describe("fixtures — sized demo (?demo=1&agents=N, for the 20-agent fps check)", () => {
  it("reads the agent count from the query, clamped to the stock 5 … DEMO_AGENTS_MAX", () => {
    expect(demoAgentCount("?demo=1")).toBe(5);
    expect(demoAgentCount("?demo=1&agents=20")).toBe(20);
    expect(demoAgentCount("?demo=1&agents=2")).toBe(5);
    expect(demoAgentCount("?demo=1&agents=999")).toBe(DEMO_AGENTS_MAX);
    expect(demoAgentCount("?demo=1&agents=lots")).toBe(5);
  });

  it("adds working agents on a load wave, all assigned, keeping the stock demo", () => {
    const s = demoState(NOW, 20);
    expect(Object.keys(s.agents)).toHaveLength(20);
    expect(Object.keys(s.waves)).toHaveLength(8);
    expect(agentsByWave(s)[UNASSIGNED]).toEqual([]);
    const stock = demoState(NOW);
    for (const id of Object.keys(stock.agents)) expect(s.agents[id]).toBeDefined();
    const extra = Object.values(s.agents).filter((a) => !stock.agents[a.id]);
    expect(extra).toHaveLength(15);
    for (const a of extra) expect(a.status?.type).toBe("working");
  });

  it("every added agent narrates on tick, so every tether pulses", () => {
    const s = demoState(NOW, 20);
    const stock = demoState(NOW);
    const next = tick(s, 0, NOW + 2600);
    const extra = Object.keys(s.agents).filter((id) => !stock.agents[id]);
    for (const id of extra) {
      expect(next.agents[id]?.feed.length, id).toBeGreaterThan(s.agents[id]?.feed.length ?? 0);
    }
  });
});

describe("isDemoMode", () => {
  it("is on for ?demo=1 or VITE_VOLLEY_DEMO=1", () => {
    expect(isDemoMode("?demo=1", {})).toBe(true);
    expect(isDemoMode("?x=2&demo=1", {})).toBe(true);
    expect(isDemoMode("", { VITE_VOLLEY_DEMO: "1" })).toBe(true);
    expect(isDemoMode("?demo=0", {})).toBe(false);
    expect(isDemoMode("", {})).toBe(false);
  });
});

describe("fixtures — schema validity", () => {
  const SCHEMAS = path.resolve(__dirname, "../../../spec/schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMAS).filter((n) => n.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMAS, f), "utf8")), f);
  }

  /** Topic → schema, as `scripts/validate-schemas.ts` maps example prefixes. */
  function schemaFor(topic: string): string | null {
    const route = routeTopic(topic);
    switch (route?.kind) {
      case "registry":
        return "registry.schema.json";
      case "agent":
        return `${route.channel}.schema.json`;
      case "wave":
        return "wave-state.schema.json";
      case "waveEvent":
        return "wave-event.schema.json";
      case "decision":
        return "decision.schema.json";
      case "config":
        return "config.schema.json";
      case "lease":
        return "lease-pool.schema.json";
      case "digest":
        return "digest.schema.json";
      case "inbox":
        return "inbox-item.schema.json";
      case "machine":
        return "machine.schema.json";
      case "readiness":
        return "readiness.schema.json";
      default:
        return null; // admission: no schema yet
    }
  }

  it("every demo envelope validates against its T1 schema", () => {
    const failures: string[] = [];
    for (const m of [
      ...demoMessages(NOW),
      ...demoReviewer(NOW),
      ...demoDigest(NOW, DIGEST_WAVE),
      ...[1, 12, 30].flatMap((step) => machinesTick(NOW + step * 5_000, step)),
    ]) {
      const schema = schemaFor(m.topic);
      if (schema === null || m.envelope === null) continue;
      const validate = ajv.getSchema(schema);
      if (!validate) throw new Error(`missing schema ${schema}`);
      if (!validate(m.envelope)) failures.push(`${m.topic}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("fixtures — autopilot", () => {
  const s = reduceAll(initialState(), demoAutopilot(NOW));

  it("has a wave whose coordinator is reconnecting, which needs nobody", () => {
    const w = s.waves.relaunch;
    expect(w).toBeDefined();
    const ctx = { now: NOW, me: null, config: null, coordinators: s.coordinators, agents: {} };
    expect(coordinatorFor(w as NonNullable<typeof w>, ctx).state).toBe("reconnecting");
    expect(waveAttention(w as NonNullable<typeof w>, ctx)).toEqual({
      tier: "info",
      reason: "Coordinator reconnecting · 3m",
    });
  });

  it("has a releasing wave with a merge queue, a train, a fixer and both autopilot events", () => {
    const st = s.waves.autopilot?.state;
    expect(st?.status).toBe("releasing");
    expect(st?.merge_queue).toHaveLength(4);
    expect(st?.release?.stages).toHaveLength(3);
    expect(st?.tasks.some((t) => t.synthetic)).toBe(true);
    expect(s.waveFeed?.autopilot?.map((e) => e.envelope.type)).toEqual([
      "decision_auto_resolved",
      "decision_escalated",
    ]);
  });
});

describe("fixtures — the overlap plan (#388)", () => {
  const s = demoState(NOW);
  const st = s.waves[PLANNED_WAVE]?.state;

  it("demo mode shows a planned wave with two clusters, a bundle, a hold, a train and churn", () => {
    expect(st?.overlap_plan?.clusters.map((c) => [c.id, c.state])).toEqual([
      ["A", "planned"],
      ["B", "hold"],
    ]);
    expect(Object.values(st?.spec?.tasks ?? {}).some((t) => (t.issues?.length ?? 0) > 1)).toBe(
      true,
    );
    expect(st?.trains?.[0]?.state).toBe("integrating");
    expect(st?.tasks.some((t) => t.train)).toBe(true);
    expect(st?.spawns?.churn).toBeGreaterThan(0);
  });

  it("its state and events validate against their schemas", () => {
    const SCHEMAS = path.resolve(__dirname, "../../../spec/schemas");
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const f of readdirSync(SCHEMAS).filter((n) => n.endsWith(".schema.json"))) {
      ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMAS, f), "utf8")), f);
    }
    const msgs = demoPlanned(NOW);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      const schema = m.topic.endsWith("/state")
        ? "wave-state.schema.json"
        : "wave-event.schema.json";
      const validate = ajv.getSchema(schema);
      if (!validate) throw new Error(`missing ${schema}`);
      expect(validate(m.envelope), `${m.topic}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});

describe("fixtures — Claude accounts (#496)", () => {
  const s = demoState(NOW);
  const registry = demoClaudeAccounts().accounts;
  const groups = deskAccountGroups(s.claudeAccounts, registry, "max", s.machines, "studio");
  const configured = configuredMachines(["box-a", "box-b"], s.machines, "studio");

  it("the Team account is one group with one box-a row", () => {
    const team = groups.filter((g) => g.label === "Team account");
    expect(team).toHaveLength(1);
    const rows = machineRows(team[0] as never, configured);
    expect(rows.filter((r) => r.op === "box-a")).toHaveLength(1);
    expect(rows.map((r) => [r.op, r.state])).toEqual([
      ["local", "signed_in"],
      ["box-a", "signed_in"],
      ["box-b", "missing"],
    ]);
  });

  it("the owner's e-mail group spans this machine and box-a", () => {
    const owner = groups.find((g) => g.key === "owner@example.com");
    expect(owner?.members.map((m) => m.machine)).toEqual(["local", "box-a"]);
  });

  it("exactly one profile waits for sign-in, and it is no card", () => {
    expect(pendingProfiles(DEMO_CLAUDE_REGISTRY, s.claudeAccounts).map((r) => r.id)).toEqual([
      "pending-work",
    ]);
    expect(groups.some((g) => g.members.some((m) => m.account === "pending-work@box-a"))).toBe(
      false,
    );
  });

  it("claude_balance answers with picks per machine", () => {
    expect(demoClaudeBalance().machines.map((m) => [m.name, m.picks.fable])).toEqual([
      ["local", "team"],
      ["box-a", "team@box-a"],
    ]);
  });
});

describe("demo steering: volleyd's Claude answers", () => {
  it("claude_accounts and claude_balance answer from the demo registry", async () => {
    vi.useFakeTimers();
    try {
      const client = createDemoSteerClient(
        () => {},
        () => false,
      );
      const acks: Record<string, unknown> = {};
      client.onMessage((m) => {
        if (m.envelope?.type === "ack")
          acks[m.envelope.correlation_id ?? ""] = (
            m.envelope.payload as { result?: unknown }
          ).result;
      });
      for (const op of ["claude_accounts", "claude_balance", "claim"])
        await client.publish(
          "volley/default/volleyd/mailbox",
          JSON.stringify({ agent_id: "desk", type: "query", correlation_id: op, payload: { op } }),
        );
      await vi.runAllTimersAsync();
      expect(acks.claude_accounts).toEqual(demoClaudeAccounts());
      expect(acks.claude_balance).toEqual(demoClaudeBalance());
      expect(acks.claim).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("demo mode's read-only control", () => {
  it("passes claude_accounts and claude_balance on, refuses every other op", async () => {
    const control = vi.fn(async () => ({ ok: true, result: "answered" }));
    const reads = demoReadControl(control);
    expect(await reads("claude_accounts", {}, "volley claude list")).toEqual({
      ok: true,
      result: "answered",
    });
    expect((await reads("claude_balance", {})).ok).toBe(true);
    for (const op of ["claude_account_add", "claude_signin", "resolve"])
      expect((await reads(op, {})).ok).toBe(false);
    expect(control).toHaveBeenCalledTimes(2);
  });
});
