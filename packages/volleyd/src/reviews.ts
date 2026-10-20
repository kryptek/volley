import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput } from "./decisions";
import { validator } from "./schemas";
import type { PublicHygiene, RepoVisibility, TaskId } from "./types";

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
  /**
   * The reviewer's hygiene check (required at level `p1`, optional at `p3`, dropped at `off`;
   * absent on a review the owner skipped). Its findings are also in `findings`.
   */
  hygiene?: { checked: true; findings: Finding[] };
  summary?: string;
}

/**
 * The P1 check line both reviewer briefs carry for a public repository (`hygieneText("p1")`;
 * test/reviews.test.ts holds the templates to it).
 */
export const HYGIENE_CHECK =
  "Public hygiene: flag as P1 any person name, local username, machine path (home directories, temp paths), private hostname or IP in the diff, commit messages or PR text.";

/**
 * How the reviewers treat public hygiene: `p1` (every hit blocks the merge, the result's
 * `hygiene` block is required), `p3` (hits are non-blocking notes, the block optional) or `off`.
 */
export type HygieneLevel = "p1" | "p3" | "off";

/** The `public_hygiene` tunable and the repo's visibility (null/unknown: as public). */
export function hygieneLevel(mode: PublicHygiene, visibility: RepoVisibility | null): HygieneLevel {
  if (mode === "on") return "p1";
  if (mode === "off") return "off";
  return visibility === "private" || visibility === "internal" ? "p3" : "p1";
}

/**
 * The reviewer briefs' `{{hygiene_rule}}` and `{{hygiene_contract}}` for a level (the contract
 * names the commits to check against `release_branch`).
 */
export function hygieneText(
  level: HygieneLevel,
  release_branch = "<release branch>",
): { rule: string; contract: string } {
  const commits = `every commit message (\`git log origin/${release_branch}..HEAD\`) and the PR title and body`;
  const shape =
    "same shape as a finding; `file` is `COMMIT` or `PR` for a commit message or the PR text";
  switch (level) {
    case "p1":
      return {
        rule: HYGIENE_CHECK,
        contract: `- \`hygiene\` is required: add \`"hygiene": { "checked": true, "findings": [] }\` to the payload once you have checked the diff, ${commits} for the public-hygiene line above; \`findings\` lists each hit as a P1 (${shape}). A result without it is not accepted.`,
      };
    case "p3":
      return {
        rule: "Hygiene (private repository): note as P3 any person name, local username, machine path, private hostname or IP in the diff, commit messages or PR text; it will not block the merge.",
        contract: `- \`hygiene\` is optional (a private repository): if you checked the diff, ${commits} for the hygiene line above, add \`"hygiene": { "checked": true, "findings": [] }\` with each hit as a P3 (${shape}). Hits never block the merge.`,
      };
    case "off":
      return { rule: "", contract: "" };
  }
}

/** The steer for a reviewer whose `done` came without a result this level would parse. */
export function resultSteerText(level: HygieneLevel): string {
  const hygiene =
    level === "p1"
      ? ', "hygiene": { "checked": true, "findings": [<public-hygiene P1s, same shape>] }'
      : level === "p3"
        ? ' (optional: , "hygiene": { "checked": true, "findings": [<hygiene P3s, same shape>] })'
        : "";
  return `Your done arrived without a parseable review result. Publish it first — vol_publish(channel="result", type="review", payload={ "findings": [{ "severity": "P1"|"P2"|"P3", "file": "<path>", "line": <n>, "text": "<finding>" }], "verdict": "approve"|"changes_requested"${hygiene} }) — then publish done again.`;
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

/**
 * A reviewer's `result` payload, or null when it is not a review result. At level `p1` one
 * without `hygiene.checked` is not, and every hygiene hit is a P1 whatever severity the reviewer
 * gave it; at `p3` the block is optional and every hit is a P3; at `off` the block is dropped.
 * Hygiene findings are folded into `findings` (once, at the level's severity, if the reviewer
 * listed them in both), so the fixup and the disagreement check see them like any other.
 */
export function parseReviewResult(
  payload: unknown,
  level: HygieneLevel = "p1",
): ReviewResult | null {
  if (!validator("review-result.schema.json#/$defs/review")(payload)) return null;
  const { hygiene, ...r } = payload as ReviewResult;
  if (level === "off") return r;
  if (hygiene === undefined) return level === "p1" ? null : r;
  const severity: Severity = level === "p1" ? "P1" : "P3";
  const key = (f: Finding) => JSON.stringify([f.file, f.line, f.text]);
  const hits = hygiene.findings.map((f): Finding => ({ ...f, severity }));
  const hit = new Set(hits.map(key));
  const listed = new Set(r.findings.map(key));
  return {
    ...r,
    findings: [
      ...r.findings.map((f): Finding => (hit.has(key(f)) ? { ...f, severity } : f)),
      ...hits.filter((f) => !listed.has(key(f))),
    ],
    hygiene: { ...hygiene, findings: hits },
  };
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
  // Hygiene hits in the PR text or a commit message: not in any file of the diff.
  if (items.some((it) => it.finding.file === "PR" || it.finding.file === "COMMIT")) {
    lines.push(
      "",
      "## Hits outside the diff",
      "",
      `- \`PR\`: the PR's title or body. Fix it with \`gh pr edit ${ctx.pr_url} --title …\` / \`--body …\`, and say so in \`how\`.`,
      "- `COMMIT`: a commit message. You never rewrite pushed history (no amend, no force-push), so say in `how` that the owner must edit that message when squash-merging the PR.",
    );
  }
  return `${lines.join("\n")}\n`;
}
