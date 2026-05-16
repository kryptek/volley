import { writeFileSync } from "node:fs";

export interface AgentResult {
  agentId: string;
  harness: "legacy" | "volley";
  terminalPublishedAt: number;
  detectedAt: number;
  latencyMs: number;
}

export interface ParitySummary {
  legacy: { median: number; p95: number; max: number; count: number };
  volley: { median: number; p95: number; max: number; count: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function summarize(results: AgentResult[]): ParitySummary {
  const legacyLat = results
    .filter((r) => r.harness === "legacy")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  const volleyLat = results
    .filter((r) => r.harness === "volley")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  return {
    legacy: {
      median: percentile(legacyLat, 50),
      p95: percentile(legacyLat, 95),
      max: legacyLat[legacyLat.length - 1] ?? 0,
      count: legacyLat.length,
    },
    volley: {
      median: percentile(volleyLat, 50),
      p95: percentile(volleyLat, 95),
      max: volleyLat[volleyLat.length - 1] ?? 0,
      count: volleyLat.length,
    },
  };
}

export function renderReport(
  results: AgentResult[],
  summary: ParitySummary,
  generatedAt = new Date(),
): string {
  const headerDate = generatedAt.toISOString().slice(0, 10);
  const fmt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const table = results
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((r) => `| ${r.agentId} | ${r.harness} | ${fmt(r.latencyMs)} |`)
    .join("\n");
  return `# Volley v0.1 — parity test report

Generated: ${headerDate}

The parity test (design doc §8.5) compares wake latency between the legacy
claude-peers + ScheduleWakeup polling loop and the Volley \`volley wait\`
notification model. 4 synthetic agents are run through each harness on an
in-process Aedes broker; latency is measured from each agent's terminal
status publish to its coordinator's detection.

## Summary

| harness | median | p95 | max | count |
|---|---|---|---|---|
| legacy | ${fmt(summary.legacy.median)} | ${fmt(summary.legacy.p95)} | ${fmt(summary.legacy.max)} | ${summary.legacy.count} |
| volley | ${fmt(summary.volley.median)} | ${fmt(summary.volley.p95)} | ${fmt(summary.volley.max)} | ${summary.volley.count} |

**Acceptance:** Volley median < 5s; legacy bounded above by the 270s fallback poll.

## Per-agent

| agent_id | harness | latency |
|---|---|---|
${table}
`;
}

export function writeReport(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}
