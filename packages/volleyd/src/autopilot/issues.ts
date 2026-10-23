import type { ExecFn } from "../exec";
import type { JournalEvent, NewEvent, TaskId, TaskStage, WaveId } from "../types";

/**
 * A wave's issue lifecycle (#416, SPEC §4.6.19), owned by volleyd. GitHub applies `Closes #N`
 * only when a PR merges into the default branch, so a task's PR into the release branch closes
 * nothing. At the task's merge volleyd labels its issue `merged-to-release` and comments once;
 * once the release reaches main it closes every done task's issue the release PR left open,
 * removes the label, and leaves a cancelled or deferred task's issue open with one comment
 * saying why. Pure planners over the journal and what `gh issue view` read, plus the gh runner.
 * Every comment carries a marker, so a replay (a restart, a journal that lost the event) finds
 * it on GitHub and never comments twice.
 */

export const MERGED_LABEL = "merged-to-release";
export const MERGED_LABEL_COLOR = "0e8a16";
export const MERGED_LABEL_DESCRIPTION =
  "Merged into a wave's release branch; closes when the release reaches main";

/** The marker of a task's merged-to-release comment. */
export const mergedMarker = (wave: WaveId, pr: number): string =>
  `<!-- volleyd:merged-to-release wave=${wave} pr=${pr} -->`;

/** The marker of the release's comment on an issue: closed by it, or left open (and why). */
export const settledMarker = (wave: WaveId, how: "closed" | "cancelled" | "deferred"): string =>
  `<!-- volleyd:${how} wave=${wave} -->`;

/** A comment's text with its marker on a line of its own. */
const marked = (text: string, marker: string): string => `${text}\n\n${marker}`;

export type GhAction =
  /** Create the label when `gh label list` lacks it (never `--force`). */
  | { kind: "ensure_label" }
  | { kind: "add_label"; issue: number }
  | { kind: "remove_label"; issue: number }
  | { kind: "comment"; issue: number; body: string; marker: string }
  | { kind: "close"; issue: number; comment: string; marker: string };

/** An issue as `gh issue view <n> --json state,labels,comments` reads it. */
export interface IssueView {
  state: "OPEN" | "CLOSED";
  labels: string[];
  /** Comment bodies. */
  comments: string[];
}

/** The argv that reads an issue's view. */
export const issueViewArgv = (issue: number): string[] => [
  "gh",
  "issue",
  "view",
  String(issue),
  "--json",
  "state,labels,comments",
];

/** `gh issue view --json state,labels,comments` output, or null when it is not one. */
export function parseIssueView(stdout: string): IssueView | null {
  let x: { state?: unknown; labels?: unknown; comments?: unknown };
  try {
    x = JSON.parse(stdout) as typeof x;
  } catch {
    return null;
  }
  if (typeof x !== "object" || x === null || (x.state !== "OPEN" && x.state !== "CLOSED"))
    return null;
  const names = (list: unknown, key: "name" | "body"): string[] =>
    Array.isArray(list)
      ? list
          .map((l) => (l as Record<string, unknown> | null)?.[key])
          .filter((v): v is string => typeof v === "string")
      : [];
  return { state: x.state, labels: names(x.labels, "name"), comments: names(x.comments, "body") };
}

/** The argv that finds the release branch's merged PR (the release reaching main). */
export const releasePrArgv = (releaseBranch: string): string[] => [
  "gh",
  "pr",
  "list",
  "--head",
  releaseBranch,
  "--state",
  "merged",
  "--json",
  "number,baseRefName",
];

/** `gh pr view <n>`: whether PR n is merged, and from which branch (`issues --verify --pr`). */
export const prViewArgv = (pr: number): string[] => [
  "gh",
  "pr",
  "view",
  String(pr),
  "--json",
  "state,headRefName",
];

/** True when `prViewArgv`'s output is a merged PR from `releaseBranch`. */
export function mergedFrom(stdout: string, releaseBranch: string): boolean {
  try {
    const p = JSON.parse(stdout) as { state?: unknown; headRefName?: unknown } | null;
    return p?.state === "MERGED" && p.headRefName === releaseBranch;
  } catch {
    return false;
  }
}

/** The merged release PR's number from `releasePrArgv`'s output: one into a non-release base. */
export function releasedPr(stdout: string): number | null {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const p of list as { number?: unknown; baseRefName?: unknown }[]) {
    if (typeof p.number !== "number" || typeof p.baseRefName !== "string") continue;
    if (!p.baseRefName.startsWith("release/")) return p.number;
  }
  return null;
}

/** What the journal says volleyd already did to each issue. */
export interface IssueLedger {
  /** The issue's label is on (added, not removed since). */
  labeled: Set<number>;
  /** The label was removed (after the release). */
  unlabeled: Set<number>;
  /** `<issue> <marker>` of every comment made. */
  comments: Set<string>;
  closed: Set<number>;
  /** The release PR the issues were verified against, once they were. */
  verified?: number;
}

export function issueLedger(events: Iterable<JournalEvent>): IssueLedger {
  const l: IssueLedger = {
    labeled: new Set(),
    unlabeled: new Set(),
    comments: new Set(),
    closed: new Set(),
  };
  for (const e of events) {
    const issue = typeof e.data.issue === "number" ? e.data.issue : undefined;
    if (e.type === "issues_verified" && typeof e.data.release_pr === "number")
      l.verified = e.data.release_pr;
    if (issue === undefined) continue;
    if (e.type === "issue_labeled") {
      l.labeled.add(issue);
      l.unlabeled.delete(issue);
    } else if (e.type === "issue_unlabeled") {
      l.labeled.delete(issue);
      l.unlabeled.add(issue);
    } else if (e.type === "issue_commented" && typeof e.data.marker === "string") {
      l.comments.add(`${issue} ${e.data.marker}`);
    } else if (e.type === "issue_closed") {
      l.closed.add(issue);
      // Closing comments carry their marker too.
      if (typeof e.data.marker === "string") l.comments.add(`${issue} ${e.data.marker}`);
    }
  }
  return l;
}

const commented = (l: IssueLedger, v: IssueView | undefined, issue: number, marker: string) =>
  l.comments.has(`${issue} ${marker}`) || (v?.comments.some((c) => c.includes(marker)) ?? false);

/**
 * At a task's merge into the release branch: the label (ensured, then added) and one comment,
 * each skipped when the journal or GitHub (`view`, when read) shows it done. A closed issue
 * (closed by hand) is left alone.
 */
export function mergedActions(o: {
  wave: WaveId;
  release_branch: string;
  issue: number;
  pr: number;
  ledger: IssueLedger;
  view?: IssueView | null;
}): GhAction[] {
  const v = o.view ?? undefined;
  // Released: the label came off for good (or the issue is closed), never put back.
  if (v?.state === "CLOSED" || o.ledger.closed.has(o.issue) || o.ledger.unlabeled.has(o.issue))
    return [];
  const out: GhAction[] = [];
  const labeled = o.ledger.labeled.has(o.issue) || (v?.labels.includes(MERGED_LABEL) ?? false);
  if (!labeled) out.push({ kind: "ensure_label" }, { kind: "add_label", issue: o.issue });
  const marker = mergedMarker(o.wave, o.pr);
  if (!commented(o.ledger, v, o.issue, marker))
    out.push({
      kind: "comment",
      issue: o.issue,
      marker,
      body: marked(
        `Merged into \`${o.release_branch}\` in PR #${o.pr}; closes when the release reaches main.`,
        marker,
      ),
    });
  return out;
}

/** One task's issue as the release step sees it. */
export interface TaskIssue {
  task: TaskId;
  issue: number;
  stage: TaskStage;
  pr?: number;
  /** A cancelled task's reason. */
  why?: string;
}

/**
 * One task per issue, in first-seen order: the wave file lets two tasks share an issue, and the
 * issue gets one outcome. A done task wins over one that is not (the work landed).
 */
export function issueOutcomes(tasks: readonly TaskIssue[]): TaskIssue[] {
  const by = new Map<number, TaskIssue>();
  for (const t of tasks) {
    const had = by.get(t.issue);
    if (had === undefined || (had.stage !== "done" && t.stage === "done")) by.set(t.issue, t);
  }
  return [...by.values()];
}

/**
 * Once the release reached main (`release_pr` merged): every done task's issue still open is
 * closed with a comment, and the label comes off every issue that has it; a cancelled or
 * deferred (not done) task's issue stays open with one comment saying why. An issue gh could not
 * read (`views` lacks it) is left alone: the next check plans it. Tasks sharing an issue give it
 * one outcome (`issueOutcomes`).
 */
export function releaseActions(o: {
  wave: WaveId;
  release_pr: number;
  tasks: readonly TaskIssue[];
  ledger: IssueLedger;
  views: ReadonlyMap<number, IssueView>;
}): GhAction[] {
  const out: GhAction[] = [];
  for (const t of issueOutcomes(o.tasks)) {
    const v = o.views.get(t.issue);
    if (v === undefined) continue;
    if (t.stage === "done") {
      if (v.state === "OPEN" && !o.ledger.closed.has(t.issue)) {
        const marker = settledMarker(o.wave, "closed");
        out.push({
          kind: "close",
          issue: t.issue,
          marker,
          comment: marked(`closed by the release PR #${o.release_pr} (wave ${o.wave})`, marker),
        });
      }
    } else if (v.state === "OPEN") {
      const how = t.stage === "cancelled" ? "cancelled" : "deferred";
      const marker = settledMarker(o.wave, how);
      const why =
        t.stage === "cancelled"
          ? (t.why ?? "cancelled")
          : `not done when the release reached main (stage ${t.stage})`;
      if (!commented(o.ledger, v, t.issue, marker))
        out.push({
          kind: "comment",
          issue: t.issue,
          marker,
          body: marked(`${how} in wave ${o.wave}: ${why}`, marker),
        });
    }
    if (v.labels.includes(MERGED_LABEL) && !o.ledger.unlabeled.has(t.issue))
      out.push({ kind: "remove_label", issue: t.issue });
  }
  return out;
}

export type IssueRowState = "open" | "merged-to-release" | "closed" | "cancelled" | "deferred";

/**
 * `volleyd issues <wave>`: each task's issue state from the journal, one line each
 * (`T3 #412 merged-to-release (PR #418)`). After the release (`released`) a task not done is
 * `deferred`. The rows are the journal's view, not GitHub's: `closed` is a done task's issue once
 * the release was verified (an issue reopened by hand still reads `closed`), and `open` a done
 * task's issue whose label has not been added yet.
 */
export function issueRows(
  tasks: readonly TaskIssue[],
  ledger: IssueLedger,
  o: { released: boolean },
): {
  task: TaskId;
  issue: number;
  state: IssueRowState;
  pr?: number;
  why?: string;
  line: string;
}[] {
  return tasks.map((t) => {
    // After the release every done task's issue is closed (by its Closes line, or by volleyd).
    const state: IssueRowState =
      t.stage === "cancelled"
        ? "cancelled"
        : t.stage !== "done"
          ? o.released
            ? "deferred"
            : "open"
          : ledger.closed.has(t.issue) || o.released
            ? "closed"
            : ledger.labeled.has(t.issue)
              ? "merged-to-release"
              : "open";
    const pr = t.pr !== undefined && state !== "open" ? ` (PR #${t.pr})` : "";
    const why = state === "cancelled" && t.why !== undefined ? `: ${t.why}` : "";
    return {
      task: t.task,
      issue: t.issue,
      state,
      ...(t.pr !== undefined ? { pr: t.pr } : {}),
      ...(t.why !== undefined ? { why: t.why } : {}),
      line: `${t.task} #${t.issue} ${state}${state === "cancelled" ? "" : pr}${why}`,
    };
  });
}

/** The argv of one action (`ensure_label` reads first: see `runIssueActions`). */
function actionArgv(a: Exclude<GhAction, { kind: "ensure_label" }>): string[] {
  const n = String(a.issue);
  switch (a.kind) {
    case "add_label":
      return ["gh", "issue", "edit", n, "--add-label", MERGED_LABEL];
    case "remove_label":
      return ["gh", "issue", "edit", n, "--remove-label", MERGED_LABEL];
    case "comment":
      return ["gh", "issue", "comment", n, "--body", a.body];
    case "close":
      return ["gh", "issue", "close", n, "--comment", a.comment];
  }
}

/** The journal event of an action that ran. */
function actionEvent(
  a: Exclude<GhAction, { kind: "ensure_label" }>,
  ctx: { task: TaskId; pr?: number; release_pr?: number },
): NewEvent {
  const base = { task: ctx.task };
  switch (a.kind) {
    case "add_label":
      return {
        ...base,
        type: "issue_labeled",
        data: {
          issue: a.issue,
          label: MERGED_LABEL,
          ...(ctx.pr !== undefined ? { pr: ctx.pr } : {}),
        },
      };
    case "remove_label":
      return { ...base, type: "issue_unlabeled", data: { issue: a.issue, label: MERGED_LABEL } };
    case "comment":
      return { ...base, type: "issue_commented", data: { issue: a.issue, marker: a.marker } };
    case "close":
      return {
        ...base,
        type: "issue_closed",
        data: {
          issue: a.issue,
          marker: a.marker,
          ...(ctx.release_pr !== undefined ? { release_pr: ctx.release_pr } : {}),
        },
      };
  }
}

/**
 * Run `actions` with gh in `cwd` (the wave's repo), in order: the events to journal for the ones
 * that ran, and why each failed one did not. A failed action is not journaled, so the next pass
 * plans it again; one failure never stops the others (a label that cannot be ensured skips only
 * the add).
 */
export async function runIssueActions(
  exec: ExecFn,
  cwd: string,
  actions: readonly GhAction[],
  ctx: { task: TaskId; pr?: number; release_pr?: number },
): Promise<{ events: NewEvent[]; failed: string[] }> {
  const events: NewEvent[] = [];
  const failed: string[] = [];
  let label = true;
  const run = async (argv: string[]): Promise<boolean> => {
    const r = await exec(argv, { cwd }).catch((e: unknown) => ({
      code: 1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    }));
    if (r.code === 0) return true;
    failed.push(`\`${argv.slice(0, 4).join(" ")}\` failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return false;
  };
  for (const a of actions) {
    if (a.kind === "ensure_label") {
      label = await ensureLabel(exec, cwd, failed);
      continue;
    }
    if (a.kind === "add_label" && !label) continue;
    if (await run(actionArgv(a))) events.push(actionEvent(a, ctx));
  }
  return { events, failed };
}

/** The label exists, or was created (only when `gh label list` lacks it). */
async function ensureLabel(exec: ExecFn, cwd: string, failed: string[]): Promise<boolean> {
  const list = await exec(["gh", "label", "list", "--search", MERGED_LABEL, "--json", "name"], {
    cwd,
  }).catch(() => null);
  let names: unknown;
  try {
    names = list?.code === 0 ? JSON.parse(list.stdout) : undefined;
  } catch {
    names = undefined;
  }
  if (!Array.isArray(names)) {
    failed.push(`\`gh label list\` read no labels: ${list?.stderr.trim() ?? "not run"}`);
    return false;
  }
  if (names.some((l) => (l as { name?: unknown } | null)?.name === MERGED_LABEL)) return true;
  const argv = [
    "gh",
    "label",
    "create",
    MERGED_LABEL,
    "--description",
    MERGED_LABEL_DESCRIPTION,
    "--color",
    MERGED_LABEL_COLOR,
  ];
  const r = await exec(argv, { cwd }).catch(() => null);
  // Created meanwhile (another wave of the repo): the label is there either way.
  if (r?.code === 0 || /already exists/i.test(r?.stderr ?? "")) return true;
  failed.push(`\`gh label create\` failed: ${r?.stderr.trim() ?? "not run"}`);
  return false;
}

/**
 * Each task's issue as the lifecycle sees it, from the journal and the reduced state: a done task
 * only once its merge is verified (with its PR), a cancelled one with why. Issue 0 (a flake's
 * fixer, a synthetic task) has no issue to keep.
 */
export function taskIssues(
  events: Iterable<JournalEvent>,
  tasks: readonly { id: TaskId; issue: number; stage: TaskStage; pr?: { number: number } }[],
): TaskIssue[] {
  const merged = new Map<TaskId, number | undefined>();
  const why = new Map<TaskId, string>();
  for (const e of events) {
    if (e.task === undefined) continue;
    if (e.type === "artifact_verified" && e.data.role === "merged") {
      const n = (e.data.pr as { number?: unknown } | undefined)?.number;
      merged.set(e.task, typeof n === "number" ? n : undefined);
    } else if (e.type === "task_cancelled") {
      const w = typeof e.data.why === "string" ? e.data.why : undefined;
      const by = typeof e.data.by === "string" ? `cancelled by ${e.data.by}` : undefined;
      why.set(e.task, w ?? by ?? "cancelled");
    }
  }
  const out: TaskIssue[] = [];
  for (const t of tasks) {
    if (t.issue <= 0) continue;
    if (t.stage === "done") {
      if (!merged.has(t.id)) continue;
      const pr = merged.get(t.id) ?? t.pr?.number;
      out.push({ task: t.id, issue: t.issue, stage: t.stage, ...(pr !== undefined ? { pr } : {}) });
    } else if (t.stage === "cancelled") {
      out.push({ task: t.id, issue: t.issue, stage: t.stage, why: why.get(t.id) ?? "cancelled" });
    } else out.push({ task: t.id, issue: t.issue, stage: t.stage });
  }
  return out;
}
