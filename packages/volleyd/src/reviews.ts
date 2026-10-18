import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput } from "./decisions";
import { validator } from "./schemas";
import type { TaskId } from "./types";

/**
 * Review results (review-result.schema.json): parsing what reviewers and the fixup publish on
 * their `result` channel, reviewer-disagreement detection, and the fixup's findings brief.
 * Everything here is pure.
 */

export type Severity = "P1" | "P2" | "P3";

export interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  text: string;
}

export interface ReviewResult {
  findings: Finding[];
  verdict: "approve" | "changes_requested";
  summary?: string;
}

export interface FixupResult {
  resolved: { finding: string; how: string }[];
  summary?: string;
}

export const REVIEWER_ROLES = ["spec_reviewer", "quality_reviewer"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const isReviewerRole = (r: string): r is ReviewerRole =>
  (REVIEWER_ROLES as readonly string[]).includes(r);

/** Finding ids in the fixup brief: `S1`, `S2`, … for spec findings, `Q1`, … for quality. */
const ID_PREFIX: Record<ReviewerRole, string> = { spec_reviewer: "S", quality_reviewer: "Q" };

/** A reviewer's `result` payload, or null when it is not a review result. */
export function parseReviewResult(payload: unknown): ReviewResult | null {
  return validator("review-result.schema.json#/$defs/review")(payload)
    ? (payload as ReviewResult)
    : null;
}

/** A fixup's `result` payload, or null when it is not a fixup result. */
export function parseFixupResult(payload: unknown): FixupResult | null {
  return validator("review-result.schema.json#/$defs/fixup")(payload)
    ? (payload as FixupResult)
    : null;
}

export type Reviews = Partial<Record<ReviewerRole, ReviewResult>>;

/** One reviewer calls a hunk a blocker (P1), the other looked at it and calls it a nit (P3). */
export interface Disagreement {
  file: string;
  line?: number;
  blocker: { role: ReviewerRole; finding: Finding };
  fine: { role: ReviewerRole; finding: Finding };
}

/** Same file, and lines within `DAEMON_DEFAULTS.review_hunk_lines` (a line-less finding covers the file). */
function sameHunk(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (a.line === undefined || b.line === undefined) return true;
  return Math.abs(a.line - b.line) <= DAEMON_DEFAULTS.review_hunk_lines;
}

/** P1-vs-P3 conflicts on the same hunk between the two reviewers. */
export function findDisagreements(reviews: Reviews): Disagreement[] {
  const out: Disagreement[] = [];
  for (const role of REVIEWER_ROLES) {
    const other = REVIEWER_ROLES.find((r) => r !== role) as ReviewerRole;
    const mine = reviews[role]?.findings ?? [];
    const theirs = reviews[other]?.findings ?? [];
    for (const p1 of mine.filter((f) => f.severity === "P1")) {
      // The other reviewer agreeing (its own P1 on the hunk) settles it.
      if (theirs.some((f) => f.severity === "P1" && sameHunk(f, p1))) continue;
      const fine = theirs.find((f) => f.severity === "P3" && sameHunk(f, p1));
      if (fine === undefined) continue;
      out.push({
        file: p1.file,
        ...(p1.line !== undefined ? { line: p1.line } : {}),
        blocker: { role, finding: p1 },
        fine: { role: other, finding: fine },
      });
    }
  }
  return out;
}

const where = (f: { file: string; line?: number }) =>
  f.line !== undefined ? `${f.file}:${f.line}` : f.file;

/** The `reviewers_disagree` decision for a task's disagreements. */
export function disagreementDecision(
  task: TaskId,
  ds: Disagreement[],
): DecisionInput & { options: string[] } {
  const lines = ds.map(
    (d) =>
      `${where(d)}: ${d.blocker.role} says blocker ("${d.blocker.finding.text}"), ${d.fine.role} says fine ("${d.fine.finding.text}")`,
  );
  return {
    kind: "reviewers_disagree",
    task,
    question: `Reviewers disagree on ${ds.length === 1 ? "a P1" : `${ds.length} P1s`} — is it a blocker? ${lines.join("; ")}`,
    options: ["blocker", "fine"],
  };
}

/** An owner's answer to `reviewers_disagree`: anything but `fine`/`not …` keeps the blocker. */
export const answerIsFine = (answer: string) => /^\s*(fine|not\b|no\b)/i.test(answer);

export interface FixupItem {
  id: string;
  role: ReviewerRole;
  finding: Finding;
  note?: string;
}

/**
 * Every finding of both reviewers, numbered for the fixup. P1s the owner judged not blockers
 * (an answered disagreement) are handed over as P3s with a note.
 */
export function fixupItems(
  reviews: Reviews,
  o: { notBlockers?: Disagreement[] } = {},
): FixupItem[] {
  // By content, not identity: a cloned review still carries the owner's ruling.
  const key = (role: ReviewerRole, f: Finding) => JSON.stringify([role, f.file, f.line, f.text]);
  const downgraded = new Set(
    (o.notBlockers ?? []).map((d) => key(d.blocker.role, d.blocker.finding)),
  );
  return REVIEWER_ROLES.flatMap((role) =>
    (reviews[role]?.findings ?? []).map((f, i): FixupItem => {
      const id = `${ID_PREFIX[role]}${i + 1}`;
      return downgraded.has(key(role, f))
        ? { id, role, finding: { ...f, severity: "P3" }, note: "owner: not a blocker" }
        : { id, role, finding: f };
    }),
  );
}

/** `.volley/findings.md`: what the fixup must address, the rule, and where to push. */
export function renderFindingsMd(
  items: FixupItem[],
  ctx: { pr_branch: string; pr_url: string; head: string; release_branch: string },
): string {
  const lines = [
    "# Review findings",
    "",
    `PR: ${ctx.pr_url} (branch \`${ctx.pr_branch}\`, reviewed at \`${ctx.head}\`, base \`${ctx.release_branch}\`).`,
    "",
    "## The rule",
    "",
    "- Apply **every P1**. A P1 you believe is wrong still needs an answer: say why in `how`.",
    "- Apply a P2 or P3 only if the change is trivial (a few lines, no design change); otherwise leave it and say so in `how`.",
    "- Commit on this worktree's branch (it starts at the reviewed head), then publish the fix to the PR branch:",
    "",
    `      git push origin HEAD:${ctx.pr_branch}`,
    "",
    "## Findings",
    "",
  ];
  if (items.length === 0) lines.push("(none)");
  for (const it of items) {
    const note = it.note !== undefined ? ` _(${it.note})_` : "";
    lines.push(
      `- **${it.id} · ${it.finding.severity}** \`${where(it.finding)}\` (${it.role}): ${it.finding.text}${note}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
