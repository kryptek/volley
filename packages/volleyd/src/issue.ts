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

/** `ISSUE.md`: title, url, then the body verbatim. */
export function renderIssueMd(issue: IssueData): string {
  return `# #${issue.number} — ${issue.title}\n\n${issue.url}\n\n${issue.body}\n`;
}
