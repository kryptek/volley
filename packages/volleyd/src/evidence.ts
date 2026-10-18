import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CiRun, RebaseCheck } from "./artifacts";
import {
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
  /** The latest review per reviewer. */
  reviews: Partial<Record<ReviewerRole, { round: number; head: string; result: ReviewResult }>>;
  /** Every fixup that ran, oldest first. */
  fixups: { round: number; from?: string; to: string; result?: FixupResult; diffstat?: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
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
  ci: { status: "green" | "none"; runs: CiRun[] };
  reviews: Partial<
    Record<
      ReviewerRole,
      { round: number; head_sha: string; verdict: string; findings: EvidenceFinding[] }
    >
  >;
  unresolved_p1: string[];
  fixups: { round: number; diffstat: string | null; from: string | null; to: string }[];
  rebases: { from?: string; to: string; touched: string[] }[];
  current_with_release_branch: boolean;
  behind_by: number;
  release_sha: string;
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
  // Ids are numbered exactly as the fixup brief numbered them (S1…, Q1…).
  const items = fixupItems(
    Object.fromEntries(
      REVIEWER_ROLES.flatMap((r) => (e.reviews[r] ? [[r, e.reviews[r]?.result]] : [])),
    ),
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
    ci: { status: e.ci, runs: e.ci_runs },
    reviews,
    unresolved_p1: unresolved,
    fixups: e.fixups.map((f) => ({
      round: f.round,
      diffstat: f.diffstat ?? null,
      from: f.from ?? null,
      to: f.to,
    })),
    rebases: e.rebases,
    current_with_release_branch: e.release.behind === 0,
    behind_by: e.release.behind,
    release_sha: e.release.release_sha,
    generated_at: e.generated_at,
  };
}

const where = (f: { file: string; line?: number }) =>
  f.line !== undefined ? `${f.file}:${f.line}` : f.file;

/** The human half. Pure. */
export function renderEvidenceMd(j: EvidenceJson): string {
  const out = [
    `# Merge-ready evidence: ${j.wave} / ${j.task} (issue #${j.issue})`,
    "",
    `- PR: ${j.pr_url}`,
    `- Head: \`${j.head_sha}\` (branch \`${j.branch}\` → \`${j.release_branch}\`)`,
    `- CI on this exact head: **${j.ci.status}**`,
    ...j.ci.runs.map((r) => `  - ${r.name}: ${r.conclusion ?? r.status} — ${r.url}`),
    `- Branch current with release branch: ${j.current_with_release_branch ? "yes" : `no (behind by ${j.behind_by})`} (\`${j.release_branch}\` at \`${j.release_sha}\`)`,
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
      out.push(`- **${f.id} · ${f.severity}** \`${where(f)}\`: ${f.text}${res}`);
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
  out.push("", `_Generated ${j.generated_at}._`, "");
  return out.join("\n");
}

/** Write `<home>/waves/<wave>/evidence/<task>.{md,json}` atomically; returns both paths. */
export function writeEvidence(home: string, e: EvidenceInput): { md: string; json: string } {
  const dir = join(home, "waves", e.wave, "evidence");
  mkdirSync(dir, { recursive: true });
  const j = evidenceJson(e);
  const md = join(dir, `${e.task}.md`);
  const json = join(dir, `${e.task}.json`);
  for (const [path, body] of [
    [json, `${JSON.stringify(j, null, 2)}\n`],
    [md, renderEvidenceMd(j)],
  ] as const) {
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  }
  return { md, json };
}
