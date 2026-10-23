import type { ExecFn } from "./exec";
import { SpawnError } from "./spawn-error";

/** The fields `gh issue view --json number,title,body,url` returns. */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  url: string;
}

/**
 * Fetch issue `issue` with `gh issue view` (run in the wave's repo, so gh picks its remote).
 * `issue` must come from the wave file: nothing else is trusted to name it. A reply for any other
 * number is refused with ISSUE_MISMATCH, so a wrong number can never reach an agent's brief.
 */
export async function fetchIssue(exec: ExecFn, repo: string, issue: number): Promise<IssueData> {
  const r = await exec(["gh", "issue", "view", String(issue), "--json", "number,title,body,url"], {
    cwd: repo,
  });
  if (r.code !== 0) {
    throw new SpawnError(
      "ISSUE_FETCH_FAILED",
      `gh issue view ${issue} failed: ${r.stderr.trim()}`,
      {
        issue,
      },
    );
  }
  let data: Partial<IssueData>;
  try {
    data = JSON.parse(r.stdout) as Partial<IssueData>;
  } catch {
    throw new SpawnError("ISSUE_FETCH_FAILED", `gh issue view ${issue} printed no JSON`, { issue });
  }
  if (data.number !== issue) {
    throw new SpawnError(
      "ISSUE_MISMATCH",
      `asked gh for issue ${issue}, got ${String(data.number)}`,
      { requested: issue, received: data.number ?? null },
    );
  }
  return {
    number: issue,
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
    url: typeof data.url === "string" ? data.url : "",
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
