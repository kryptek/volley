import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CiRun, RebaseCheck, SupersededRun } from "./artifacts";
import {
  type Disagreement,
  type FixupResult,
  REVIEWER_ROLES,
  type ReviewResult,
  type ReviewerRole,
  fixupItems,
} from "./reviews";
import type { TaskId, WaveId } from "./types";

/**
 * The merge-ready evidence package: `$VOLLEYD_HOME/waves/<wave>/evidence/<task>.md` + `.json`,
 * written when a task reaches the gate. It is what a human reads before merging — volleyd never
 * merges — so every line is a verified fact about one exact head.
 */

/**
 * A head pushed outside the pipeline. `accepted_by`: the owner kept the reviews for it (a
 * `fixup` answer, or `accept` of a merge of the release branch only: `how`, `parent`).
 */
export interface EvidenceMove {
  from: string;
  to: string;
  touched: string[];
  accepted_by?: string;
  how?: "release_merge";
  parent?: string;
}

export interface EvidenceInput {
  wave: WaveId;
  task: TaskId;
  issue: number;
  pr: { number: number; url: string };
  /** The head every fact below is about. */
  head: string;
  branch: string;
  release_branch: string;
  ci: "green" | "none";
  /** CI runs on exactly `head`. */
  ci_runs: CiRun[];
  /** Runs on `head` a newer run of the same workflow and event replaced: not `head`'s CI. */
  ci_superseded?: SupersededRun[];
  /** The latest review per reviewer. */
  reviews: Partial<Record<ReviewerRole, { round: number; head: string; result: ReviewResult }>>;
  /** Every fixup that ran, oldest first. */
  fixups: { round: number; from?: string; to: string; result?: FixupResult; diffstat?: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
  /** Heads pushed to the PR outside the pipeline after a verification (CI re-verified on each). */
  moves?: EvidenceMove[];
  /** Every head this task was gated at or moved to before this one, oldest first, then `head`. */
  head_history?: string[];
  /** P1s the owner ruled not blockers (`reviewers_disagree` → fine), and who ruled. */
  not_blockers?: Disagreement[];
  ruled_by?: string;
  /** The release-branch commit the task's worktree was cut from (its `base_sha`), when known. */
  base_sha?: string;
  /** The release-branch check the gate passed. */
  release: RebaseCheck;
  generated_at: string;
}

export interface EvidenceFinding {
  id: string;
  severity: string;
  file: string;
  line?: number;
  text: string;
  /** How the fixup resolved it (`how`), or null when no resolution was reported. */
  resolution: string | null;
  /** Why its severity is not the reviewer's (the owner's ruling). */
  note?: string;
}

export interface EvidenceJson {
  wave: WaveId;
  task: TaskId;
  issue: number;
  pr_url: string;
  pr_number: number;
  head_sha: string;
  branch: string;
  release_branch: string;
  /** `superseded`: present when a run on the head was replaced (kept as evidence only). */
  ci: { status: "green" | "none"; runs: CiRun[]; superseded?: SupersededRun[] };
  reviews: Partial<
    Record<
      ReviewerRole,
      { round: number; head_sha: string; verdict: string; findings: EvidenceFinding[] }
    >
  >;
  unresolved_p1: string[];
  fixups: { round: number; diffstat: string | null; from: string | null; to: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
  moves: EvidenceMove[];
  /** Present when the gate saw more than one head: each of them, oldest first. */
  head_history?: string[];
  /** Set when the PR head moved after this package was written: it no longer describes the PR. */
  stale?: { from: string; to: string; at: string };
  current_with_release_branch: boolean;
  behind_by: number;
  release_sha: string;
  /** The release-branch commit the task's worktree was cut from (absent when unknown). */
  base_sha?: string;
  generated_at: string;
}

/** The JSON half of the package (the markdown is rendered from it). Pure. */
export function evidenceJson(e: EvidenceInput): EvidenceJson {
  /** A finding's resolution comes from the fixup that worked on its review round. */
  const resolution = (round: number, id: string) =>
    e.fixups
      .filter((f) => f.round === round)
      .flatMap((f) => f.result?.resolved ?? [])
      .find((r) => r.finding === id)?.how ?? null;
  // Ids are numbered exactly as the fixup brief numbered them (S1…, Q1…); a P1 the owner ruled
  // not a blocker is a P3 here too, so it is not an unresolved P1.
  const items = fixupItems(
    Object.fromEntries(
      REVIEWER_ROLES.flatMap((r) => (e.reviews[r] ? [[r, e.reviews[r]?.result]] : [])),
    ),
    { notBlockers: e.not_blockers ?? [] },
  );
  const reviews: EvidenceJson["reviews"] = {};
  for (const role of REVIEWER_ROLES) {
    const rv = e.reviews[role];
    if (rv === undefined) continue;
    reviews[role] = {
      round: rv.round,
      head_sha: rv.head,
      verdict: rv.result.verdict,
      findings: items
        .filter((i) => i.role === role)
        .map((i) => ({
          id: i.id,
          severity: i.finding.severity,
          file: i.finding.file,
          ...(i.finding.line !== undefined ? { line: i.finding.line } : {}),
          text: i.finding.text,
          resolution: resolution(rv.round, i.id),
          ...(i.note !== undefined
            ? { note: e.ruled_by !== undefined ? `${i.note} (${e.ruled_by})` : i.note }
            : {}),
        })),
    };
  }
  const unresolved = Object.values(reviews).flatMap((r) =>
    (r?.findings ?? [])
      .filter((f) => f.severity === "P1" && f.resolution === null)
      .map((f) => f.id),
  );
  return {
    wave: e.wave,
    task: e.task,
    issue: e.issue,
    pr_url: e.pr.url,
    pr_number: e.pr.number,
    head_sha: e.head,
    branch: e.branch,
    release_branch: e.release_branch,
    ci: {
      status: e.ci,
      runs: e.ci_runs,
      ...((e.ci_superseded ?? []).length > 0 ? { superseded: e.ci_superseded } : {}),
    },
    reviews,
    unresolved_p1: unresolved,
    fixups: e.fixups.map((f) => ({
      round: f.round,
      diffstat: f.diffstat ?? null,
      from: f.from ?? null,
      to: f.to,
    })),
    rebases: e.rebases,
    moves: e.moves ?? [],
    ...((e.head_history ?? []).length > 1 ? { head_history: e.head_history } : {}),
    current_with_release_branch: e.release.behind === 0,
    behind_by: e.release.behind,
    release_sha: e.release.release_sha,
    ...(e.base_sha !== undefined ? { base_sha: e.base_sha } : {}),
    generated_at: e.generated_at,
  };
}

const where = (f: { file: string; line?: number }) =>
  f.line !== undefined ? `${f.file}:${f.line}` : f.file;

/** `yes` / `no (behind by N)`; with the task's base: `yes — cut from <sha7>, 0 behind`. */
function releaseLine(j: EvidenceJson): string {
  const current = j.current_with_release_branch ? "yes" : "no";
  if (j.base_sha === undefined)
    return j.current_with_release_branch ? current : `${current} (behind by ${j.behind_by})`;
  return `${current} — cut from ${j.base_sha.slice(0, 7)}, ${j.behind_by} behind`;
}

/** The human half. Pure. */
export function renderEvidenceMd(j: EvidenceJson): string {
  const out = [
    `# Merge-ready evidence: ${j.wave} / ${j.task} (issue #${j.issue})`,
    "",
    ...(j.stale !== undefined
      ? [
          `> **STALE**: the PR head moved from \`${j.stale.from}\` to \`${j.stale.to}\` at ${j.stale.at}, after this package was written. Nothing below describes the PR as it is now; volleyd re-gates it.`,
          "",
        ]
      : []),
    `- PR: ${j.pr_url}`,
    `- Head: \`${j.head_sha}\` (branch \`${j.branch}\` → \`${j.release_branch}\`)`,
    ...(j.head_history !== undefined
      ? [`- Head history: ${j.head_history.map((x) => `\`${x.slice(0, 12)}\``).join(" → ")}`]
      : []),
    `- CI on this exact head: **${j.ci.status}**`,
    ...j.ci.runs.map((r) => `  - ${r.name}: ${r.conclusion ?? r.status} — ${r.url}`),
    ...(j.ci.superseded ?? []).map(
      (r) => `  - superseded (not this head's CI): ${r.conclusion ?? "not finished"} — ${r.url}`,
    ),
    `- Branch current with release branch: ${releaseLine(j)} (\`${j.release_branch}\` at \`${j.release_sha}\`)`,
    "",
    "volleyd never merges. A human merges this PR after reading the above.",
    "",
    "## Reviews",
  ];
  if (Object.keys(j.reviews).length === 0) out.push("", "(no review stage in this pipeline)");
  for (const role of REVIEWER_ROLES) {
    const r = j.reviews[role];
    if (r === undefined) continue;
    out.push("", `### ${role} — ${r.verdict} (round ${r.round}, at \`${r.head_sha}\`)`, "");
    if (r.findings.length === 0) out.push("No findings.");
    for (const f of r.findings) {
      const res =
        f.resolution !== null
          ? ` → resolved: ${f.resolution}`
          : f.severity === "P1"
            ? " → **UNRESOLVED**"
            : "";
      const note = f.note !== undefined ? ` _(${f.note})_` : "";
      out.push(`- **${f.id} · ${f.severity}** \`${where(f)}\`: ${f.text}${note}${res}`);
    }
  }
  out.push("", "## Fixup", "");
  if (j.fixups.length === 0) out.push("No fixup ran (nothing to fix).");
  for (const f of j.fixups) {
    out.push(
      `Round ${f.round}: \`${f.from ?? "?"}\` → \`${f.to}\``,
      "",
      "```",
      f.diffstat ?? "(diffstat unavailable)",
      "```",
      "",
    );
  }
  if (j.unresolved_p1.length > 0) out.push("", `**Unresolved P1s: ${j.unresolved_p1.join(", ")}**`);
  if (j.rebases.length > 0) {
    out.push("", "## Rebases", "");
    for (const r of j.rebases) {
      out.push(
        `- \`${r.from ?? "?"}\` → \`${r.to}\`; touched: ${r.touched.length > 0 ? r.touched.join(", ") : "(nothing)"}`,
      );
    }
  }
  if (j.moves.length > 0) {
    out.push("", "## Pushes outside the pipeline", "");
    for (const m of j.moves) {
      const owner =
        m.accepted_by === undefined
          ? ""
          : m.how === "release_merge"
            ? ` Accepted by ${m.accepted_by}: a merge of the release branch only (touched: ${m.touched.join(", ") || "(nothing)"}).`
            : ` Accepted without a re-review by ${m.accepted_by} (fixup).`;
      out.push(
        `- \`${m.from}\` → \`${m.to}\`: pushed outside the pipeline after verification; CI re-verified on the new head, the reviews above stay at the heads they name; touched: ${m.touched.length > 0 ? m.touched.join(", ") : "(nothing)"}.${owner}`,
      );
    }
  }
  out.push("", `_Generated ${j.generated_at}._`, "");
  return out.join("\n");
}

/** Write `<home>/waves/<wave>/evidence/<task>.{md,json}` atomically; returns both paths. */
export function writeEvidence(home: string, e: EvidenceInput): { md: string; json: string } {
  return writeEvidenceJson(home, evidenceJson(e));
}

/**
 * The PR head moved after the gate: mark the task's package stale (both files rewritten with
 * the banner). No package yet: nothing to mark. Returns whether one was marked.
 */
export function markEvidenceStale(
  home: string,
  wave: WaveId,
  task: TaskId,
  stale: { from: string; to: string; at: string },
): boolean {
  const path = join(home, "waves", wave, "evidence", `${task}.json`);
  if (!existsSync(path)) return false;
  const j = JSON.parse(readFileSync(path, "utf-8")) as EvidenceJson;
  writeEvidenceJson(home, { ...j, stale });
  return true;
}

function writeEvidenceJson(home: string, j: EvidenceJson): { md: string; json: string } {
  const dir = join(home, "waves", j.wave, "evidence");
  mkdirSync(dir, { recursive: true });
  const md = join(dir, `${j.task}.md`);
  const json = join(dir, `${j.task}.json`);
  for (const [path, body] of [
    [json, `${JSON.stringify(j, null, 2)}\n`],
    [md, renderEvidenceMd(j)],
  ] as const) {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  }
  return { md, json };
}
