import pkg from "../../package.json";
import { lastSetup } from "./journal";
import type { Planner, SetupContext, SetupDeps, StepName, StepPlan } from "./step";

/**
 * `volley setup --check`: every step's planner run read-only (planning never changes anything),
 * each reported as done, pending (with the changes it would make), blocked (and why) or skipped
 * (and why). It asks nothing: a question a planner would ask is answered no, a secret is not
 * asked for. Exit 0 only when nothing is pending or blocked. `--json` prints the rows for CI.
 */

export type CheckStatus = "done" | "pending" | "blocked" | "skipped";

export interface CheckRow {
  name: StepName;
  title: string;
  status: CheckStatus;
  /** The summaries of the changes a run would make (pending only; empty otherwise). */
  changes: string[];
  blocked?: string;
  skipped?: string;
  /** The step's own status lines (`StepPlan.row`), text only: never in the JSON. */
  lines: string[];
}

/** The JSON `volley setup --check --json` prints: exactly these keys. */
export interface CheckReport {
  version: string;
  steps: {
    name: StepName;
    title: string;
    status: CheckStatus;
    changes: string[];
    blocked?: string;
    skipped?: string;
  }[];
  /** When `volley setup` last ran (setup.log's newest line), or null. */
  setup_at: string | null;
}

/** A plan's status: blocked and skipped win over its changes. */
export function statusOf(plan: StepPlan): CheckStatus {
  if (plan.blocked !== undefined) return "blocked";
  if (plan.skipped !== undefined) return "skipped";
  return plan.changes.length > 0 ? "pending" : "done";
}

export function rowOf(name: StepName, plan: StepPlan): CheckRow {
  const status = statusOf(plan);
  return {
    name,
    title: plan.title,
    status,
    changes: status === "pending" ? plan.changes.map((c) => c.summary) : [],
    ...(plan.blocked !== undefined ? { blocked: plan.blocked } : {}),
    ...(plan.blocked === undefined && plan.skipped !== undefined ? { skipped: plan.skipped } : {}),
    lines: (plan.row ?? "").split("\n").filter((l) => l !== ""),
  };
}

/** The deps a check plans with: nobody is asked anything. */
export function checkDeps(deps: SetupDeps): SetupDeps {
  const { askSecret: _secret, ask: _ask, ...rest } = deps;
  return { ...rest, confirm: async () => false };
}

/** Each step's row, in order. A planner that throws is blocked by what it threw. */
export async function checkSteps(
  ctx: SetupContext,
  steps: readonly [StepName, Planner][],
): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const [name, planner] of steps) {
    try {
      rows.push(rowOf(name, await planner(ctx)));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      rows.push({ name, title: name, status: "blocked", changes: [], blocked: why, lines: [] });
    }
  }
  return rows;
}

/** 0 when every step is done or skipped, else 1. */
export const checkExit = (rows: readonly CheckRow[]): 0 | 1 =>
  rows.some((r) => r.status === "pending" || r.status === "blocked") ? 1 : 0;

const MARK: Record<CheckStatus, string> = { done: "✓", pending: "→", blocked: "✗", skipped: "–" };

/** The rows as the terminal shows them. */
export function renderCheck(rows: readonly CheckRow[], command = "volley setup"): string {
  const width = Math.max(...rows.map((r) => r.title.length));
  const out: string[] = [];
  for (const r of rows) {
    const status =
      r.status === "blocked"
        ? `blocked: ${(r.blocked ?? "").split("\n")[0]}`
        : r.status === "skipped"
          ? `skipped: ${r.skipped ?? ""}`
          : r.status;
    out.push(`  ${MARK[r.status]} ${r.title.padEnd(width)}  ${status}`);
    for (const l of r.lines) out.push(`      ${l}`);
    for (const c of r.changes) out.push(`      → ${c}`);
  }
  const pending = rows.filter((r) => r.status === "pending").length;
  const blocked = rows.filter((r) => r.status === "blocked").length;
  out.push(
    "",
    pending + blocked === 0
      ? "Nothing is missing."
      : `${[pending > 0 ? `${pending} pending` : "", blocked > 0 ? `${blocked} blocked` : ""].filter((s) => s !== "").join(", ")}: run \`${command}\` to apply.`,
    "",
  );
  return out.join("\n");
}

/** The JSON report (`--check --json`). */
export function checkReport(rows: readonly CheckRow[], volleydHome: string): CheckReport {
  return {
    version: pkg.version,
    steps: rows.map((r) => ({
      name: r.name,
      title: r.title,
      status: r.status,
      changes: r.changes,
      ...(r.blocked !== undefined ? { blocked: r.blocked } : {}),
      ...(r.skipped !== undefined ? { skipped: r.skipped } : {}),
    })),
    setup_at: lastSetup(volleydHome) ?? null,
  };
}
