/**
 * The morning digest (SPEC §4.6.16): one answer per wave to "what shipped, what did autopilot
 * handle on its own, and what is waiting for me", computed from the wave's journal. Pure: the
 * daemon publishes it retained on `volley/_waves/<wave>/digest` (digest.schema.json) and pushes
 * `summaryLine` once; `volleyd digest` prints `renderDigestMd`.
 */
import type { JournalEvent, ReleaseState, TaskId, WaveId, WaveState } from "../types";

/** Why a digest was published. */
export type DigestTrigger = "wave_complete" | "release_go" | "escalation" | "stopped";

/** Who merged a shipped task: volleyd (autopilot merging), the owner (`volleyd merged`), or GitHub. */
export type MergedBy = "supervisor" | "operator" | "github";

export interface DigestShipped {
  task: TaskId;
  issue: number;
  title?: string;
  pr: { number: number; url: string };
  merge_sha: string | null;
  merged_by: MergedBy;
}

export interface DigestWaiting {
  id: string;
  kind: string;
  task?: TaskId;
  question: string;
  since: string;
  /** Escalated because only the owner answers its kind (`autopilot.owner_only`). */
  owner_only: boolean;
}

/** The retained digest payload (digest.schema.json). */
export interface Digest {
  wave: WaveId;
  release_branch: string;
  generated_at: string;
  trigger: DigestTrigger;
  shipped: DigestShipped[];
  auto: {
    decisions_resolved: number;
    flakes_fixed: { test: string; fixer: TaskId; prs_released: number }[];
    /** Rebase (branch update) steps that verified. */
    conflicts_resolved: number;
    /** `spawn_recovered` + `relaunched`. */
    retries: number;
    /** PRs volleyd merged itself. */
    merges: number;
  };
  waiting: DigestWaiting[];
  release?: ReleaseState;
  failures: { task: TaskId; why: string }[];
}

const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** The digest of a wave from its journal and its reduced state, as of `now` (ISO). */
export function digestOf(
  events: readonly JournalEvent[],
  state: WaveState,
  now: string,
  trigger: DigestTrigger,
): Digest {
  const titles = new Map<TaskId, string>();
  const merges = new Map<TaskId, JournalEvent>();
  const bySupervisor = new Set<TaskId>();
  const byOperator = new Set<TaskId>();
  const opened = new Map<string, JournalEvent>();
  const ownerOnly = new Set<string>();
  const cancelled = new Map<TaskId, JournalEvent>();
  const auto: Digest["auto"] = {
    decisions_resolved: 0,
    flakes_fixed: [],
    conflicts_resolved: 0,
    retries: 0,
    merges: 0,
  };
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case "wave_submitted":
      case "wave_versioned": {
        const tasks = (d.wave as { tasks?: Record<TaskId, { title?: unknown }> } | undefined)
          ?.tasks;
        for (const [id, t] of Object.entries(tasks ?? {})) {
          const title = str(t.title);
          if (title !== undefined) titles.set(id, title);
        }
        break;
      }
      case "task_queued": {
        const title = str(d.title);
        if (e.task !== undefined && title !== undefined) titles.set(e.task, title);
        break;
      }
      case "artifact_verified":
        if (e.task === undefined) break;
        if (d.role === "merged") merges.set(e.task, e);
        else if (d.role === "rebase") auto.conflicts_resolved += 1;
        break;
      case "merged_by_supervisor":
        if (e.task !== undefined) bySupervisor.add(e.task);
        break;
      case "merged_by_operator":
        if (e.task !== undefined) byOperator.add(e.task);
        break;
      case "spawn_recovered":
      case "relaunched":
        auto.retries += 1;
        break;
      case "decision_auto_resolved":
        auto.decisions_resolved += 1;
        break;
      case "decision_opened":
        if (typeof d.decision_id === "string") opened.set(d.decision_id, e);
        break;
      case "decision_escalated":
        if (d.why === "owner_only" && typeof d.decision_id === "string")
          ownerOnly.add(d.decision_id);
        break;
      case "remediation_closed":
        if (d.outcome === "landed" && e.task !== undefined)
          auto.flakes_fixed.push({
            test: String(d.test),
            fixer: e.task,
            prs_released: Array.isArray(d.released) ? d.released.length : 0,
          });
        break;
      case "task_cancelled":
        if (e.task !== undefined) cancelled.set(e.task, e);
        break;
      default:
        break;
    }
  }

  const shipped: DigestShipped[] = [];
  const done = state.tasks.filter((t) => t.stage === "done" && merges.has(t.id));
  done.sort((a, b) => (merges.get(a.id)?.seq ?? 0) - (merges.get(b.id)?.seq ?? 0));
  for (const t of done) {
    const d = (merges.get(t.id) as JournalEvent).data;
    const pr = (d.pr as { number?: unknown; url?: unknown } | undefined) ?? {};
    const via = d.via;
    const merged_by: MergedBy =
      via === "supervisor" || bySupervisor.has(t.id)
        ? "supervisor"
        : via === "operator" || via === "outside_github" || byOperator.has(t.id)
          ? "operator"
          : "github";
    if (merged_by === "supervisor") auto.merges += 1;
    const title = titles.get(t.id);
    shipped.push({
      task: t.id,
      issue: t.issue,
      ...(title !== undefined ? { title } : {}),
      pr: {
        number: Number(pr.number ?? t.pr?.number ?? 0),
        url: String(pr.url ?? t.pr?.url ?? ""),
      },
      merge_sha: str(d.merge_sha) ?? str(d.sha) ?? null,
      merged_by,
    });
  }

  const waiting: DigestWaiting[] = [];
  for (const id of state.open_decisions) {
    const e = opened.get(id);
    if (e === undefined) continue;
    waiting.push({
      id,
      kind: String(e.data.kind),
      ...(e.task !== undefined ? { task: e.task } : {}),
      question: String(e.data.question ?? ""),
      since: str(e.data.opened_at) ?? e.at,
      owner_only: ownerOnly.has(id),
    });
  }

  const failures = state.tasks
    .filter((t) => t.stage === "cancelled")
    .map((t) => {
      const d = cancelled.get(t.id)?.data ?? {};
      const by = str(d.by);
      return {
        task: t.id,
        why: str(d.why) ?? (by !== undefined ? `cancelled by ${by}` : "cancelled"),
      };
    });

  return {
    wave: state.wave,
    release_branch: state.release_branch,
    generated_at: now,
    trigger,
    shipped,
    auto,
    waiting,
    ...(state.release !== undefined ? { release: structuredClone(state.release) } : {}),
    failures,
  };
}

const VERB: Record<DigestTrigger, string> = {
  wave_complete: "complete",
  release_go: "ready to release",
  escalation: "needs you",
  stopped: "stopped",
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The one-line summary the push carries: `w1 complete: 27 shipped, 3 flakes fixed, 2 conflicts
 * resolved, 1 waiting for you (release_go)`. Counts that are zero are left out (shipped never is).
 */
export function summaryLine(d: Digest): string {
  const parts = [`${d.shipped.length} shipped`];
  const flakes = d.auto.flakes_fixed.length;
  if (flakes > 0) parts.push(`${count(flakes, "flake", "flakes")} fixed`);
  const conflicts = d.auto.conflicts_resolved;
  if (conflicts > 0) parts.push(`${count(conflicts, "conflict", "conflicts")} resolved`);
  if (d.auto.retries > 0) parts.push(count(d.auto.retries, "retry", "retries"));
  const answered = d.auto.decisions_resolved;
  if (answered > 0) parts.push(`${count(answered, "decision", "decisions")} answered`);
  if (d.failures.length > 0) parts.push(`${d.failures.length} failed`);
  if (d.waiting.length > 0) {
    const kinds = [...new Set(d.waiting.map((w) => w.kind))].join(", ");
    parts.push(`${d.waiting.length} waiting for you (${kinds})`);
  }
  return `${d.wave} ${VERB[d.trigger]}: ${parts.join(", ")}`;
}

/** The digest as markdown: `## Shipped`, `## Autopilot handled`, `## Waiting for you` (and `## Failed`). */
export function renderDigestMd(d: Digest): string {
  const out = [
    `# ${summaryLine(d)}`,
    "",
    `Release branch: ${d.release_branch} · ${d.generated_at}`,
  ];
  out.push("", "## Shipped", "");
  if (d.shipped.length === 0) out.push("Nothing shipped.");
  for (const s of d.shipped) {
    const title = s.title !== undefined ? ` ${s.title}` : "";
    out.push(
      `- ${s.task} (#${s.issue})${title}: PR #${s.pr.number} ${s.pr.url} (merged by ${s.merged_by})`,
    );
  }
  const a = d.auto;
  out.push("", "## Autopilot handled", "");
  out.push(`- ${count(a.decisions_resolved, "decision", "decisions")} answered`);
  out.push(`- ${count(a.merges, "PR", "PRs")} merged`);
  out.push(`- ${count(a.conflicts_resolved, "conflict", "conflicts")} resolved`);
  out.push(`- ${count(a.retries, "retry", "retries")} (relaunches, recovered spawns)`);
  out.push(`- ${count(a.flakes_fixed.length, "flake", "flakes")} fixed`);
  for (const f of a.flakes_fixed)
    out.push(
      `  - ${f.test}: fixed by ${f.fixer}, ${count(f.prs_released, "task", "tasks")} released`,
    );
  if (d.release !== undefined) {
    const stages = d.release.stages.map((s) => `${s.name} ${s.state}`).join(", ");
    out.push(`- release: ${stages}`);
  }
  out.push("", "## Waiting for you", "");
  if (d.waiting.length === 0) out.push("Nothing is waiting for you.");
  for (const w of d.waiting) {
    const on = w.task !== undefined ? ` on ${w.task}` : "";
    const only = w.owner_only ? " (owner only)" : "";
    out.push(`- ${w.id} ${w.kind}${on}${only}: ${w.question}`);
  }
  if (d.failures.length > 0) {
    out.push("", "## Failed", "");
    for (const f of d.failures) out.push(`- ${f.task}: ${f.why}`);
  }
  return `${out.join("\n")}\n`;
}
