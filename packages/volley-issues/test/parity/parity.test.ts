import { describe, expect, it } from "vitest";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runLegacyHarness } from "./legacy-harness";
import { type AgentResult, renderReport, summarize, writeReport } from "./report-writer";
import { type AgentScenario, runSyntheticAgent } from "./synthetic-agent";
import { runVolleyHarness } from "./volley-harness";

interface PairResult {
  agentId: string;
  harness: "legacy" | "volley";
  terminalPublishedAt: number;
  detectedAt: number;
}

/**
 * Run one synthetic agent + its harness in parallel. The harness starts first
 * (subscribing); after a brief wait the agent runs to its `doneAtMs` and
 * publishes terminal. Both promises resolve; we return the latency.
 */
async function runOne(
  tb: TestBroker,
  scenario: AgentScenario,
  harness: "legacy" | "volley",
): Promise<PairResult> {
  // For the legacy harness we keep the poll interval short so the test finishes
  // in reasonable time — 5s instead of the 270s real-world interval. The point
  // of the test is to MEASURE the latency, not run for 4 minutes.
  const legacyPollMs = 5000;

  const harnessPromise =
    harness === "legacy"
      ? runLegacyHarness(tb.url, scenario.namespace, scenario.agentId, legacyPollMs, 60000)
      : runVolleyHarness(tb.url, scenario.namespace, scenario.agentId, 60);
  // Give the harness a moment to subscribe before the agent publishes.
  await new Promise((r) => setTimeout(r, 200));
  const agentPromise = runSyntheticAgent(tb.url, scenario);
  const [agent, detection] = await Promise.all([agentPromise, harnessPromise]);
  return {
    agentId: scenario.agentId,
    harness,
    terminalPublishedAt: agent.terminalPublishedAt,
    detectedAt: detection.detectedAt,
  };
}

describe("parity test — 4 legacy vs 4 volley", () => {
  it("Volley median latency < 5s (UPDATE_PARITY=1 rewrites parity-report.md)", async () => {
    const tb = await startTestBroker();
    try {
      // 8 scenarios — same shape; the harness is what differs.
      const scenarios = (kind: "legacy" | "volley") =>
        [1, 2, 3, 4].map(
          (i): AgentScenario => ({
            agentId: `parity-${kind}-${String(i).padStart(2, "0")}`,
            namespace: "parity",
            // Stagger the agents so the legacy poller hits them at different points in its
            // 5s interval, producing a realistic spread of detection latencies (otherwise
            // every legacy detection would be ~poll-interval). Use 0/1000/2000/3000ms.
            doneAtMs: (i - 1) * 1000,
          }),
        );
      const legacyScenarios = scenarios("legacy");
      const volleyScenarios = scenarios("volley");

      const pairs = await Promise.all([
        ...legacyScenarios.map((s) => runOne(tb, s, "legacy")),
        ...volleyScenarios.map((s) => runOne(tb, s, "volley")),
      ]);

      const results: AgentResult[] = pairs.map((p) => ({
        ...p,
        latencyMs: p.detectedAt - p.terminalPublishedAt,
      }));
      const summary = summarize(results);

      // Acceptance criteria: Volley wakes a coordinator in under 5 s (median), 10 s (max).
      expect(summary.volley.median).toBeLessThan(5000);
      expect(summary.volley.max).toBeLessThan(10000);
      // The whole point of Volley: legacy median is bounded above by its poll
      // interval. With legacyPollMs=5000 and 4 staggered agents (0/1000/2000/3000ms),
      // legacy median lands near ~3500ms; Volley median is sub-100ms. This assertion
      // is robust for any legacyPollMs >= 1000ms. Do NOT reduce legacyPollMs below
      // 1000ms without adjusting the stagger formula, or the spread collapses and
      // the assertion can flake.
      expect(summary.legacy.median).toBeGreaterThan(summary.volley.median);
      // Sanity floor: legacy median must reflect actual polling (not artificially
      // fast). If this fails, someone reduced legacyPollMs without reading the
      // comment above.
      expect(summary.legacy.median).toBeGreaterThan(500);

      // The committed report is refreshed only on request (`bun run parity:update`, at tag
      // time); a plain test run must not rewrite a tracked file.
      if (process.env.UPDATE_PARITY === "1") {
        const reportPath = new URL("../../parity-report.md", import.meta.url);
        writeReport(reportPath.pathname, renderReport(results, summary));
      }
    } finally {
      await tb.close();
    }
  });
});
