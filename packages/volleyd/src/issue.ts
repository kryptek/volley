import type { ExecFn } from "./exec";
import { SpawnError } from "./spawn-error";

/** The fields `gh issue view --json number,title,body,url` returns. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Where `gh` reads a repository's issues: in its checkout, or by its `owner/repo` name. */
export type IssueWhere = { cwd: string } | { slug: string };

/**
 * `gh issue view <issue> --json <fields>` (with `--repo` for a slug) and the parsed reply,
 * refused with ISSUE_MISMATCH when it is for any other number.
 */
async function viewIssue(
  exec: ExecFn,
  where: IssueWhere,
  issue: number,
  fields: string,
): Promise<Record<string, unknown>> {
  const repo = "slug" in where ? ["--repo", where.slug] : [];
  const r = await exec(
    ["gh", "issue", "view", String(issue), ...repo, "--json", fields],
    "cwd" in where ? { cwd: where.cwd } : {},
  );
  if (r.code !== 0) {
    throw new SpawnError(
      "ISSUE_FETCH_FAILED",
      `gh issue view ${issue} failed: ${r.stderr.trim()}`,
      {
        issue,
      },
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new SpawnError("ISSUE_FETCH_FAILED", `gh issue view ${issue} printed no JSON`, { issue });
  }
  if (data.number !== issue) {
    throw new SpawnError(
      "ISSUE_MISMATCH",
      `asked gh for issue ${issue}, got ${String(data.number)}`,
      { requested: issue, received: (data.number as number | undefined) ?? null },
    );
  }
  return data;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The fields of `fetchIssue`'s reply every view reads. */
const issueData = (issue: number, data: Record<string, unknown>): IssueData => ({
  number: issue,
  title: text(data.title),
  body: text(data.body),
  url: text(data.url),
});

/**
 * Fetch issue `issue` with `gh issue view` (run in the wave's repo, so gh picks its remote).
 * `issue` must come from the wave file: nothing else is trusted to name it. A reply for any other
 * number is refused with ISSUE_MISMATCH, so a wrong number can never reach an agent's brief.
 */
export async function fetchIssue(exec: ExecFn, repo: string, issue: number): Promise<IssueData> {
  return issueData(issue, await viewIssue(exec, { cwd: repo }, issue, "number,title,body,url"));
}

/** An issue with its state (`OPEN`, `CLOSED`) and its label names. */
export interface IssueFacts extends IssueData {
  state: string;
  labels: string[];
}

/**
 * `fetchIssue` plus the issue's state and labels (`volleyd add`: is it closed, is it merged to
 * the release), read in the repository's checkout or by its slug; the same mismatch check.
 */
export async function fetchIssueFacts(
  exec: ExecFn,
  where: IssueWhere,
  issue: number,
): Promise<IssueFacts> {
  const data = await viewIssue(exec, where, issue, "number,title,body,url,state,labels");
  const labels = Array.isArray(data.labels) ? data.labels : [];
  return {
    ...issueData(issue, data),
    state: text(data.state),
    labels: labels.flatMap((l) =>
      typeof (l as { name?: unknown })?.name === "string" ? [(l as { name: string }).name] : [],
    ),
  };
}

/**
 * Fetch every issue of a task, in order, each through `fetchIssue`: a bundle's mismatched reply
 * is refused for its own number, so no wrong issue reaches the brief either.
 */
export async function fetchIssues(
  exec: ExecFn,
  repo: string,
  issues: readonly number[],
): Promise<IssueData[]> {
  const out: IssueData[] = [];
  for (const n of issues) out.push(await fetchIssue(exec, repo, n));
  return out;
}

/** One issue's section: title, url, then the body verbatim. */
const issueSection = (issue: IssueData): string =>
  `# #${issue.number} — ${issue.title}\n\n${issue.url}\n\n${issue.body}\n`;

/**
 * `ISSUE.md`: one issue's section. A bundle's (several issues) opens with `# Bundle: #a, #b` and
 * the planner's `why`, then each issue's section, separated by `---` rules.
 */
export function renderIssueMd(issues: IssueData | readonly IssueData[], why?: string): string {
  const list = Array.isArray(issues) ? issues : [issues as IssueData];
  if (list.length === 1) return issueSection(list[0] as IssueData);
  const planner = why !== undefined && why !== "" ? ` Planner: ${why}` : "";
  const header = `# Bundle: ${list.map((i) => `#${i.number}`).join(", ")}\n\nOne task, one PR, for every issue below.${planner}`;
  return `${[header, ...list.map((i) => issueSection(i).trimEnd())].join("\n\n---\n\n")}\n`;
}
